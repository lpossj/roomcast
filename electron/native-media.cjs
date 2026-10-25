// OBS owns capture/encoding; the bundled libdatachannel owns each remote SRTP
// transport. This process boundary carries compressed access units only.
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID, createHash } = require('node:crypto');

function iceUrls(servers) {
  const result = [];
  for (const server of (Array.isArray(servers) ? servers : []).slice(0, 32)) {
    for (const raw of (Array.isArray(server.urls) ? server.urls : [server.urls])) {
      if (typeof raw !== 'string' || raw.length > 4096 || !/^(stun|stuns|turn|turns):/i.test(raw)) continue;
      const colon = raw.indexOf(':');
      const scheme = raw.slice(0, colon).toLowerCase();
      const address = raw.slice(colon + 1).replace(/^\/\//, '');
      const credentials = scheme.startsWith('turn') && server.username
        ? `${encodeURIComponent(server.username)}:${encodeURIComponent(server.credential || '')}@` : '';
      result.push(`${scheme}:${credentials}${address}`);
    }
  }
  return result;
}

class NativeMedia extends EventEmitter {
  constructor({ engine, runtimeRoot, captureId, bitrateKbps = 6500 }) {
    super();
    this.engine = engine;
    this.runtimeRoot = runtimeRoot;
    this.captureId = captureId;
    this.session = randomUUID();
    this.bitrateKbps = Math.max(300, Math.min(6500, Number(bitrateKbps) || 6500));
    this.peers = new Map();
    this.closed = false;
    this.lastKeyframe = 0;
    this.needKeyframe = false;
    this.lastAudioPts = -1;
  }

  async start() {
    const exe = path.join(this.runtimeRoot, 'runtime/native-media/RoomcastNativeMedia.exe');
    const dll = path.join(this.engine.bundleDir, 'bin/64bit/datachannel.dll');
    if (!fs.existsSync(exe) || !fs.existsSync(dll)) throw new Error('原生媒体组件不可用。');
    // The helper's C ABI is bound to this bundled binary, not a system DLL or
    // a future OBS replacement with a possibly different struct layout.
    if (createHash('sha256').update(fs.readFileSync(dll)).digest('hex') !== 'fab6be28221b31b65650deb3e2b994711916b85a5c89d3582f10b742665b7652') throw new Error('原生媒体运行库版本不匹配。');
    this.child = spawn(exe, [dll], {
      cwd: path.dirname(dll), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PATH: `${path.dirname(dll)};${process.env.PATH || ''}` },
    });
    this.child.stdin.on('error', () => this.fail(new Error('原生媒体输入已关闭。')));
    this.child.once('error', error => this.fail(error));
    this.child.once('exit', () => this.fail(new Error('原生媒体进程已结束。')));
    let buffered = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => {
      buffered += chunk;
      if (buffered.length > 2 * 1024 * 1024) return this.fail(new Error('原生媒体响应过长。'));
      let newline;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
        try { this.handle(JSON.parse(line)); } catch { /* Ignore a malformed diagnostic, never evaluate it. */ }
      }
    });
    // Drain diagnostics without publishing SDP, candidate addresses or secrets.
    this.child.stderr.resume();
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('原生媒体组件启动超时。')), 3000);
        this.helperReady = () => { clearTimeout(timer); resolve(); };
        this.helperError = error => { clearTimeout(timer); reject(error); };
      });
      if (this.closed) throw new Error('原生媒体启动已取消。');
      const profile = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('原生编码参数等待超时。')), 3000);
        this.encoderProfileReady = value => { clearTimeout(timer); resolve(value); };
        this.encoderProfileError = error => { clearTimeout(timer); reject(error); };
      });
      this.frameListener = packet => this.video(packet);
      this.engine.onNativeMediaFrame(this.frameListener);
      const [encoder, profileLevelId] = await Promise.all([
        this.engine.startNativeMedia({ session: this.session, bitrateKbps: this.bitrateKbps }), profile,
      ]);
      this.encoder = { ...encoder, profileLevelId };
      this.encoderProfileReady = this.encoderProfileError = null;
      if (this.closed) throw new Error('原生媒体启动已取消。');
      return this.encoder;
    } catch (error) { await this.close(); throw error; }
  }

  send(message) {
    if (this.closed || !this.child?.stdin?.writable) throw new Error('原生媒体已关闭。');
    if (message.type) { message.cmd = message.type; delete message.type; }
    return this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  video(packet) {
    if (this.closed || packet?.session !== this.session) return;
    if (typeof packet.data !== 'string' || packet.data.length > 4 * 1024 * 1024) return;
    // NVENC exposes SPS only with its first encoded frame. Read the actual
    // Annex-B profile/level before answering, including for lower resolutions.
    if (this.encoderProfileReady && packet.keyframe) {
      const bytes = Buffer.from(packet.data, 'base64');
      for (let i = 0; i + 6 < bytes.length; i++) {
        if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1 && (bytes[i + 3] & 31) === 7) {
          this.encoderProfileReady(bytes.subarray(i + 4, i + 7).toString('hex'));
          this.encoderProfileReady = null;
          break;
        }
      }
    }
    if (!this.peers.size) return;
    // Never forward a dependent P frame after dropping its reference. Resume at
    // an IDR and request one; do not let local IPC backpressure grow unbounded.
    if (this.child.stdin.writableLength > 128 * 1024) {
      this.needKeyframe = true; this.requestKeyframe(); return;
    }
    if (this.needKeyframe && !packet.keyframe) { this.requestKeyframe(); return; }
    this.needKeyframe = false;
    try { this.send({ type: 'video', data: packet.data, ptsUs: packet.epochUs, keyframe: !!packet.keyframe }); } catch { }
  }

  audio(packet) {
    if (this.closed || !this.peers.size || this.child?.stdin.writableLength > 128 * 1024) return;
    const bytes = packet?.data;
    const ptsUs = Number(packet?.ptsUs);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > 8192 || !Number.isFinite(ptsUs) || ptsUs <= this.lastAudioPts) return;
    this.lastAudioPts = ptsUs;
    try { this.send({ type: 'audio', data: Buffer.from(bytes).toString('base64'), ptsUs }); } catch { }
  }

  requestKeyframe() {
    if (this.closed || Date.now() - this.lastKeyframe < 500) return;
    this.lastKeyframe = Date.now();
    void this.engine.nativeMediaKeyframe({ session: this.session }).catch(() => {});
  }

  handle(message) {
    message.type = message.event;
    if (message.event === 'ready') { this.helperReady?.(); return; }
    if (message.event === 'error' && !message.id) { this.fail(new Error('原生媒体组件错误。')); return; }
    if (message.event === 'state' && Number.isInteger(message.state)) message.state = ['new', 'connecting', 'connected', 'disconnected', 'failed', 'closed'][message.state] || 'failed';
    const peer = this.peers.get(message.id);
    if (!peer) return;
    if (message.type === 'answer') {
      clearTimeout(peer.timer); peer.resolve(Buffer.from(message.sdp, 'base64').toString('utf8'));
      this.requestKeyframe();
    } else if (message.type === 'error') {
      clearTimeout(peer.timer); peer.reject(new Error('原生媒体协商失败。'));
      this.emit('peer', { id: message.id, event: 'state', state: 'failed' });
    } else if (message.type === 'candidate' || message.type === 'state') {
      this.emit('peer', message);
      if (message.type === 'state' && message.state === 'connected') this.requestKeyframe();
    } else if (message.type === 'feedback') {
      if (message.keyframe) this.requestKeyframe();
      // Receiver estimates can follow application-limited static traffic. Do
      // not feed that value back into a shared encoder and starve all viewers.
      // This low-latency native path is fixed-budget. Chromium remains the
      // congestion-adaptive path for a viewer with sustained observed loss.
      if (message.kind === 'video' && Number.isInteger(message.reportSequence) && message.reportSequence !== peer.lastReport) {
        peer.lastReport = message.reportSequence;
        peer.lossReports = message.fractionLost >= 26 ? (peer.lossReports || 0) + 1 : 0;
        if (peer.lossReports >= 3) {
          this.emit('peer', { event: 'state', id: message.id, state: 'failed', reason: 'native-network-fallback' });
          this.closePeer(message.id);
        }
      }
    }
  }

  answer({ id, offer, iceServers, audio = false }) {
    if (this.closed || typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,95}$/.test(id) || typeof offer !== 'string' || offer.length > 512 * 1024 || this.peers.size >= 16 || this.peers.has(id)) throw new Error('原生媒体会话无效。');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.closePeer(id); reject(new Error('原生媒体协商超时。')); }, 8000);
      this.peers.set(id, { resolve, reject, timer });
      try { this.send({ type: 'create', id, offer: Buffer.from(offer).toString('base64'), iceServers: iceUrls(iceServers), relay: false, video: true, audio: !!audio, profileLevelId: this.encoder?.profileLevelId }); }
      catch (error) { this.closePeer(id); reject(error); }
    });
  }

  candidate(id, candidate) {
    if (!this.peers.has(id) || !candidate?.candidate || candidate.candidate.length > 8192) return;
    this.send({ type: 'candidate', id, candidate: candidate.candidate, mid: String(candidate.sdpMid ?? '0') });
  }

  closePeer(id) {
    const peer = this.peers.get(id);
    if (!peer) return;
    clearTimeout(peer.timer); peer.reject(new Error('原生媒体会话已关闭。'));
    this.peers.delete(id);
    if (!this.closed) { try { this.send({ type: 'close', id }); } catch { } }
  }

  fail(error) {
    if (this.closed) return;
    this.helperError?.(error);
    for (const [id, peer] of this.peers) { peer.reject(error); this.emit('peer', { id, event: 'state', state: 'failed' }); }
    void this.close();
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.encoderProfileError?.(new Error('原生媒体启动已取消。'));
    this.encoderProfileReady = this.encoderProfileError = null;
    for (const peer of this.peers.values()) { clearTimeout(peer.timer); peer.reject(new Error('原生媒体已停止。')); }
    this.peers.clear();
    this.engine.offNativeMediaFrame?.(this.frameListener);
    this.child?.stdin.end();
    const child = this.child;
    const timer = setTimeout(() => child?.kill(), 1500); timer.unref();
    child?.once('exit', () => clearTimeout(timer));
    await this.engine.stopNativeMedia({ session: this.session }).catch(() => {});
  }
}

module.exports = { NativeMedia, iceUrls };
