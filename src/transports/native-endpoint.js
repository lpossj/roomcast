import { recordNativeTransport } from '../lifecycle-diagnostics.js';
import { DEFAULT_STUN_ICE } from '../ice-policy.js';
import { offeredVideoCodecs } from '../video-codec-policy.js';

export const nativeAvailable = () => typeof globalThis.window?.roomcast?.nativeIce === 'function';
export function encodeBytes(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
export function decodeBytes(value) {
  return Uint8Array.from(atob(value), char => char.charCodeAt(0)).buffer;
}
export const encodeSDP = value => encodeBytes(new TextEncoder().encode(value));
const decodeSDP = value => new TextDecoder().decode(decodeBytes(value));

export function nativeNetworkReport(network) {
  const report = new Map();
  if (!network.protocol) return report;
  report.set('native-local', { type: 'local-candidate', id: 'native-local', candidateType: network.localType, protocol: network.protocol });
  report.set('native-remote', { type: 'remote-candidate', id: 'native-remote', candidateType: network.remoteType, protocol: network.protocol });
  report.set('native-pair', { type: 'candidate-pair', id: 'native-pair', state: 'succeeded', nominated: true,
    localCandidateId: 'native-local', remoteCandidateId: 'native-remote', currentRoundTripTime: network.rttMs / 1000 });
  report.set('native-transport', { type: 'transport', id: 'native-transport', selectedCandidatePairId: 'native-pair' });
  return report;
}

// One local id owns one prepared UDP socket, one network PC and (for media)
// one loopback PC. Wire connection ids and member ids never select IPC sessions.
export class NativeEndpoint extends EventTarget {
  constructor() {
    super();
    this.id = crypto.randomUUID();
    this.connectionState = 'new';
    this.waiting = new Map();
    this.remoteCandidates = [];
    this.unsubscribe = window.roomcast.onNativeIce(message => {
      if (message.id !== this.id || this.closed) return;
      if (['prepared','state','open','local-answer','error','stats'].includes(message.event)) {
        recordNativeTransport(this.id, this.role, message);
      }
      switch (message.event) {
        case 'state':
          this.connectionState = message.state;
          this.dispatchEvent(new Event('connectionstatechange'));
          if (message.state === 'failed' || message.state === 'closed') this.fail(new Error('原生连接已断开。'));
          break;
        case 'channel-close': case 'error':
          this.fail(new Error(message.reason || '原生数据通道已关闭。')); break;
        case 'offer': case 'answer': case 'local-answer':
          this.resolve(message.event, decodeSDP(message.sdp)); break;
        case 'prepared': this.resolve('prepared'); break;
        case 'candidate': this.oncandidate?.(message.candidate); break;
        case 'feedback': this.onfeedback?.(message); break;
        case 'stats': this.resolve('stats', message); break;
        default: this.onevent?.(message);
      }
    });
  }
  command(cmd, args = {}) {
    if (this.closed) return Promise.reject(new Error('原生连接已关闭。'));
    return window.roomcast.nativeIce({ ...args, cmd, id: this.id });
  }
  sendControl(bytes) {
    return this.command('send', { data: encodeBytes(bytes) });
  }
  wait(event) {
    if (this.closed) throw new Error('原生连接已关闭。');
    const current = this.waiting.get(event);
    if (current) return current.promise;
    const pending = Promise.withResolvers();
    pending.promise.catch(() => {});
    pending.timer = setTimeout(() => this.fail(new Error('原生连接响应超时。')), 12000);
    this.waiting.set(event, pending);
    return pending.promise;
  }
  resolve(event, value) {
    const pending = this.waiting.get(event);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.waiting.delete(event);
    pending.resolve(value);
  }
  async negotiate({ offer, localOffer, receive, audio, video = !!localOffer, control, bitrate }) {
    this.role = control ? (offer ? 'host' : 'guest') : (receive ? 'viewer' : 'publisher');
    const prepared = this.wait('prepared');
    await this.command('prepare', { iceServers: DEFAULT_STUN_ICE.map(s => ({ urls: [].concat(s.urls) })) });
    await prepared;
    const description = this.wait(offer ? 'answer' : 'offer');
    const local = localOffer ? this.wait('local-answer') : null;
    const localCodecs = localOffer && video ? offeredVideoCodecs(localOffer) : [];
    const motionVP8 = receive ? localCodecs[0] === 'vp8'
      : localCodecs.includes('vp8') && offeredVideoCodecs(offer)[0] === 'vp8';
    await this.command('create', {
      bitrate, control: !!control, video, audio: !!audio, receive: !!receive, motionVP8,
      offer: offer ? encodeSDP(offer) : '', localOffer: localOffer ? encodeSDP(localOffer) : '',
      profileLevelId: localOffer ? '42e01f' : '',
    });
    if (offer) await this.flushRemote();
    return Promise.all([description, local]);
  }
  async answer(sdp) {
    await this.command('answer', { answer: encodeSDP(sdp) });
    await this.flushRemote();
  }
  async flushRemote() {
    this.remoteReady = true;
    for (const candidate of this.remoteCandidates.splice(0)) await this.command('candidate', { candidate });
  }
  async candidate(candidate) {
    if (!candidate?.candidate) return;
    if (candidate.candidate.length > 2048) throw new Error('原生 ICE 候选无效。');
    if (this.remoteReady) await this.command('candidate', { candidate });
    else if (this.remoteCandidates.length < 128) this.remoteCandidates.push(candidate);
  }
  async stats() {
    const pending = this.wait('stats');
    await this.command('stats');
    return pending;
  }
  fail(error) {
    if (this.closed) return;
    this.close(error);
    this.onfailure?.(error);
  }
  close(error = new DOMException('原生连接已结束。', 'AbortError')) {
    if (this.closed) return;
    this.closed = true;
    recordNativeTransport(this.id, this.role, { event: 'closed' });
    this.unsubscribe();
    void window.roomcast.nativeIce({ cmd: 'close', id: this.id }).catch(() => {});
    for (const pending of this.waiting.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.waiting.clear();
  }
}
