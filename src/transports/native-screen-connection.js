import { NativeEndpoint, nativeNetworkReport } from './native-endpoint.js';
import { withScreenStartBitrate } from '../video-sender-settings.js';

// Network SDP/candidates belong to Pion. The Chromium PC is only the local
// H.264/Opus bridge. Never signal its addresses, fingerprint or ICE credentials.
export class NativeScreenConnection extends EventTarget {
  constructor(receive, bitrateKbps = 4500, audioOnly = false) {
    super();
    this.receive = receive;
    this.audioOnly = audioOnly;
    this.bitrateLimit = Math.max(128000, (bitrateKbps || 4500) * 1000);
    this.local = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle', roomcastLocalBridge: true });
    this.endpoint = new NativeEndpoint();
    this.pending = [];
    this.localCandidates = [];
    this.local.onicecandidate = ({ candidate }) => {
      if (!candidate || this.closed) return;
      if (!this.bridgeReady) this.localCandidates.push(candidate.toJSON());
      else void this.endpoint.command('local-candidate', { candidate: candidate.toJSON() }).catch(error => this.endpoint.fail(error));
    };
    this.endpoint.oncandidate = candidate => {
      if (this.localDescription) this.emitCandidate(candidate);
      else this.pending.push(candidate);
    };
    this.endpoint.onfeedback = sample => {
      this.feedback = { fractionLost: sample.fractionLost / 256, jitter: sample.jitter / 90000, timestamp: performance.now() };
    };
    this.local.ontrack = event => this.ontrack?.(event);
    this.local.onconnectionstatechange = () => this.changed();
    this.endpoint.addEventListener('connectionstatechange', () => this.changed());
    this.endpoint.onfailure = () => { this.failed = true; this.changed(); };
  }
  get connectionState() {
    if (this.closed) return 'closed';
    const states = [this.local.connectionState, this.endpoint.connectionState];
    if (this.failed || states.includes('failed') || states.includes('closed')) return 'failed';
    if (states.includes('disconnected')) return 'disconnected';
    return states.every(s => s === 'connected') ? 'connected' : 'connecting';
  }
  changed() {
    this.onconnectionstatechange?.();
    this.dispatchEvent(new Event('connectionstatechange'));
  }
  emitCandidate(candidate) { this.onicecandidate?.({ candidate: { toJSON: () => candidate } }); }
  addTrack(...args) { return this.local.addTrack(...args); }
  addTransceiver(...args) { return this.local.addTransceiver(...args); }
  getSenders() { return this.local.getSenders(); }
  getReceivers() { return this.local.getReceivers(); }
  async describe(type) {
    const localOffer = await this.local.createOffer();
    await this.local.setLocalDescription(localOffer);
    const [sdp, localAnswer] = await this.endpoint.negotiate({
      offer: this.remoteDescription?.sdp, localOffer: this.local.localDescription.sdp,
      receive: this.receive, bitrate: this.bitrateLimit, video: !this.audioOnly,
      audio: this.receive || this.getSenders().some(s => s.track?.kind === 'audio'),
    });
    this.bridgeReady = true;
    for (const candidate of this.localCandidates.splice(0)) await this.endpoint.command('local-candidate', { candidate });
    const bridgeAnswer = this.receive ? localAnswer : withScreenStartBitrate(localAnswer, this.bitrateLimit / 1000);
    await this.local.setRemoteDescription({ type: 'answer', sdp: bridgeAnswer });
    return { type, sdp };
  }
  createOffer() { return this.describe('offer'); }
  createAnswer() { return this.describe('answer'); }
  async setLocalDescription(description) {
    this.localDescription = description;
    for (const candidate of this.pending.splice(0)) this.emitCandidate(candidate);
  }
  async setRemoteDescription(description) {
    if (description.type === 'answer') await this.endpoint.answer(description.sdp);
    this.remoteDescription = description;
  }
  addIceCandidate(candidate) { return this.endpoint.candidate(candidate); }
  async getStats() {
    const [local, network] = await Promise.all([this.local.getStats(), this.endpoint.stats()]);
    if (!this.receive && network.availableBitrate > 0) {
      const sender = this.getSenders().find(value => value.track?.kind === 'video');
      const params = sender?.getParameters();
      const limit = Math.min(this.bitrateLimit, network.availableBitrate);
      if (params?.encodings?.[0] && Math.abs((params.encodings[0].maxBitrate || 0) - limit) > limit * 0.05) {
        params.encodings[0].maxBitrate = limit;
        await sender.setParameters(params).catch(() => {});
      }
    }
    const result = new Map(local);
    // Preserve actual decoder/encoder counters, and remove loopback path metrics.
    for (const [id, item] of local) {
      if (['local-candidate','remote-candidate','candidate-pair','transport','remote-inbound-rtp'].includes(item.type)) result.delete(id);
      if (item.type === 'outbound-rtp' && item.kind === 'video' && this.feedback && !this.receive) {
        const remoteId = item.remoteId || 'native-receiver';
        result.set(id, { ...item, remoteId });
        result.set(remoteId, { ...this.feedback, type: 'remote-inbound-rtp', kind: 'video', id: remoteId, localId: id });
      }
    }
    for (const [id, item] of nativeNetworkReport(network)) result.set(id, item);
    for (const [id, item] of result) {
      if (item.type === 'inbound-rtp' || item.type === 'outbound-rtp') result.set(id, { ...item, transportId: 'native-transport' });
    }
    return result;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.endpoint.close();
    this.local.onicecandidate = this.local.ontrack = this.local.onconnectionstatechange = null;
    this.local.close();
  }
}
