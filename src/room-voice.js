import { ack } from './lib.js';
import { createRoomcastPeerConnection, DEFAULT_STUN_ICE } from './ice-policy.js';

export const clampVolume = value => Number.isFinite(Number(value)) ? Math.max(0, Math.min(1, Number(value))) : 0.5;
export function normalizeVoiceSettings(value = {}) {
  return { microphoneVolume: clampVolume(value?.microphoneVolume ?? 0.5), outputVolume: clampVolume(value?.outputVolume ?? 0.5),
    defaultMicrophone: value?.defaultMicrophone === true, defaultOutput: value?.defaultOutput === true };
}

// Follow LiveKit's track-level Web Audio metering; hold the ring briefly between syllables.
export function createSpeakingDetector() {
  let lastVoice = -Infinity;
  return (samples, now) => {
    const rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / Math.max(1, samples.length));
    if (rms >= 0.015) lastVoice = now;
    return { level: Math.min(1, rms * 5), speaking: now - lastVoice < 400 };
  };
}

export function meterStream(stream, onLevel, context = new AudioContext()) {
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser(); analyser.fftSize = 1024;
  source.connect(analyser);
  const samples = new Float32Array(analyser.fftSize), detect = createSpeakingDetector();
  const timer = setInterval(() => { analyser.getFloatTimeDomainData(samples); onLevel(detect(samples, performance.now())); }, 50);
  void context.resume().catch(() => {});
  return () => { clearInterval(timer); source.disconnect(); analyser.disconnect(); void context.close().catch(() => {}); };
}

export async function captureMicrophone(inputId, volume, onLevel) {
  let input, context, stopMeter;
  try {
    input = await navigator.mediaDevices.getUserMedia({ audio: {
      ...(inputId ? { deviceId: { exact: inputId } } : {}),
      echoCancellation: true, noiseSuppression: true, autoGainControl: true,
    }, video: false });
    context = new AudioContext();
    const source = context.createMediaStreamSource(input), gain = context.createGain(), destination = context.createMediaStreamDestination();
    gain.gain.value = clampVolume(volume);
    source.connect(gain); gain.connect(destination);
    await context.resume();
    // One context for capture, a separate meter context with explicit cleanup.
    stopMeter = meterStream(destination.stream, onLevel);
    let stopped = false;
    return { stream: destination.stream,
      setVolume: value => gain.gain.setTargetAtTime(clampVolume(value), context.currentTime, 0.02),
      stop() {
        if (stopped) return; stopped = true;
        stopMeter(); input.getTracks().forEach(track => track.stop()); destination.stream.getTracks().forEach(track => track.stop());
        source.disconnect(); gain.disconnect(); void context.close().catch(() => {});
      },
      onEnded: fn => input.getAudioTracks().forEach(track => track.addEventListener('ended', fn, { once: true })),
    };
  } catch (error) {
    stopMeter?.(); input?.getTracks().forEach(track => track.stop()); void context?.close().catch(() => {}); throw error;
  }
}

// Monitor the processed microphone locally; this never changes room mute state
// or owns the capture tracks. Ending a test must not stop an open room mic.
export function monitorMicrophone(stream, deviceId, onError) {
  const audio = document.createElement('audio');
  audio.autoplay = true; audio.srcObject = stream; audio.volume = 1; audio.muted = false;
  let active = true;
  void (async () => {
    if (audio.setSinkId) await audio.setSinkId(deviceId || 'default');
    if (active) await audio.play();
  })().catch(error => { if (active) onError(`麦克风耳返播放失败：${error.message}`); });
  return () => { active = false; audio.muted = true; audio.pause(); audio.srcObject = null; };
}

// A listener offers one recvonly audio connection per active microphone. This is
// the existing screen subscribe/answer model, without coupling to screen viewing.
export class RoomVoice {
  constructor({ socket, selfId, iceServers, onSpeaking, onError }) {
    Object.assign(this, { socket, selfId, iceServers: iceServers?.length ? iceServers : DEFAULT_STUN_ICE, onSpeaking, onError });
    this.connections = new Map(); this.localStream = null; this.room = null; this.closed = false;
    this.output = { enabled: false, volume: 0.5, deviceId: '' };
    this.memberVolumes = {};
    this.signal = message => { void this.receive(message).catch(error => { if (!this.closed) this.onError(error.message); }); };
    socket.on('voice:signal', this.signal);
  }
  send(entry, kind, extra = {}) {
    if (this.closed || !this.socket.connected) return Promise.resolve();
    return ack(this.socket, 'voice:signal', { to: entry.memberId, requestId: entry.id, kind, ...extra }, 5000);
  }
  create(memberId, id, side) {
    const pc = createRoomcastPeerConnection({ iceServers: this.iceServers });
    const entry = { memberId, id, side, pc, candidates: [], localCandidates: [], signaled: false, ready: false };
    this.connections.set(id, entry);
    pc.onicecandidate = event => {
      if (!event.candidate) return;
      const candidate = event.candidate.toJSON();
      if (!entry.signaled) entry.localCandidates.push(candidate);
      else void this.send(entry, 'candidate', { side, candidate }).catch(() => {});
    };
    pc.ontrack = event => {
      if (side !== 'listener' || this.closed || entry.audio) return;
      const stream = new MediaStream([event.track]);
      const audio = document.createElement('audio'); audio.autoplay = true; audio.srcObject = stream; entry.audio = audio;
      entry.stopMeter = meterStream(stream, value => this.onSpeaking(memberId, value.speaking));
      this.applyOutput(entry);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') { this.remove(entry); }
    };
    entry.timer = setTimeout(() => { if (pc.connectionState !== 'connected') this.remove(entry); }, 20_000);
    return entry;
  }
  remove(entry, notify = true) {
    if (this.connections.get(entry.id) !== entry) return;
    this.connections.delete(entry.id); clearTimeout(entry.timer);
    entry.pc.onconnectionstatechange = null; entry.pc.close(); entry.stopMeter?.();
    if (entry.audio) { entry.audio.pause(); entry.audio.srcObject = null; }
    if (entry.side === 'listener') this.onSpeaking(entry.memberId, false);
    if (notify) void this.send(entry, 'close').catch(() => {});
  }
  update(room, localStream) {
    this.room = room; this.localStream = localStream;
    const members = new Map((room?.members || []).map(member => [member.id, member]));
    for (const entry of [...this.connections.values()]) {
      if (!members.has(entry.memberId) || (entry.side === 'listener' ? !members.get(entry.memberId).voiceEnabled : !localStream)) this.remove(entry);
    }
    for (const member of members.values()) {
      if (member.id === this.selfId || !member.voiceEnabled || [...this.connections.values()].some(entry => entry.memberId === member.id && entry.side === 'listener')) continue;
      const entry = this.create(member.id, crypto.randomUUID(), 'listener');
      entry.pc.addTransceiver('audio', { direction: 'recvonly' });
      void (async () => {
        await entry.pc.setLocalDescription(await entry.pc.createOffer());
        if (this.connections.get(entry.id) === entry) {
          await this.send(entry, 'offer', { sdp: entry.pc.localDescription.sdp });
          await this.flushLocalCandidates(entry);
        }
      })().catch(error => {
        const active = this.connections.get(entry.id) === entry;
        this.remove(entry); if (active && !this.closed) this.onError(error.message);
      });
    }
  }
  async receive(message) {
    if (this.closed || !this.room?.members.some(member => member.id === message.from)) return;
    let entry = this.connections.get(message.requestId);
    if (message.kind === 'offer') {
      if (!this.localStream || entry) return;
      // Bound a peer to one publisher connection, even with repeated request IDs.
      for (const old of [...this.connections.values()]) if (old.memberId === message.from && old.side === 'publisher') this.remove(old);
      entry = this.create(message.from, message.requestId, 'publisher');
      try {
        await entry.pc.setRemoteDescription({ type: 'offer', sdp: message.sdp });
        if (this.connections.get(entry.id) !== entry || !this.localStream) return;
        entry.ready = true;
        this.localStream.getAudioTracks().forEach(track => entry.pc.addTrack(track, this.localStream));
        await entry.pc.setLocalDescription(await entry.pc.createAnswer());
        if (this.connections.get(entry.id) !== entry) return;
        await this.send(entry, 'answer', { sdp: entry.pc.localDescription.sdp });
        await this.flushLocalCandidates(entry);
        await this.flushCandidates(entry);
      } catch (error) {
        const active = this.connections.get(entry.id) === entry;
        this.remove(entry); if (active && !this.closed) throw error;
      }
      return;
    }
    if (!entry || entry.memberId !== message.from) return;
    if (message.kind === 'close') { this.remove(entry, false); return; }
    if (message.kind === 'answer' && entry.side === 'listener' && !entry.ready) {
      await entry.pc.setRemoteDescription({ type: 'answer', sdp: message.sdp }); entry.ready = true; await this.flushCandidates(entry);
    } else if (message.kind === 'candidate') {
      if (message.side === entry.side) return;
      if (entry.pc.remoteDescription) await entry.pc.addIceCandidate(message.candidate);
      else if (entry.candidates.length < 64) entry.candidates.push(message.candidate);
    }
  }
  async flushCandidates(entry) {
    for (const candidate of entry.candidates.splice(0)) await entry.pc.addIceCandidate(candidate);
  }
  async flushLocalCandidates(entry) {
    entry.signaled = true;
    for (const candidate of entry.localCandidates.splice(0)) await this.send(entry, 'candidate', { side: entry.side, candidate });
  }
  applyOutput(entry) {
    const audio = entry.audio; if (!audio) return;
    audio.muted = !this.output.enabled;
    audio.volume = clampVolume(this.output.volume) * clampVolume(this.memberVolumes[entry.memberId] ?? 1);
    if (audio.setSinkId) void audio.setSinkId(this.output.deviceId || 'default').catch(error => this.onError(`无法切换播放设备：${error.message}`));
    if (this.output.enabled) void audio.play().catch(error => { if (error.name === 'NotAllowedError') this.onError('浏览器阻止了声音播放，请再次点击开启成员声音。'); });
  }
  setOutput(output) { this.output = output; for (const entry of this.connections.values()) this.applyOutput(entry); }
  setMemberVolumes(volumes) { this.memberVolumes = volumes; for (const entry of this.connections.values()) this.applyOutput(entry); }
  close() {
    this.socket.off('voice:signal', this.signal);
    for (const entry of [...this.connections.values()]) this.remove(entry);
    this.closed = true;
  }
}
