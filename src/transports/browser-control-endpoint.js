import { createRoomcastPeerConnection, mediaIceServers } from '../ice-policy.js';

// The beta.6 desktop engine's roomcast-v2 channel uses a one-byte final flag
// followed by up to 12 KiB of PeerJS binary data (native/ice-engine/desktop.go).
const fragmentSize = 12 * 1024;
const maxMessageSize = 8 * 1024 * 1024;

export class BrowserControlEndpoint {
  constructor(iceServers) {
    this.pc = createRoomcastPeerConnection({ iceServers: mediaIceServers(iceServers) });
    this.pendingCandidates = [];
    this.partial = null;
    this.receivedBytes = 0;
    this.pc.ondatachannel = ({ channel }) => this.bindChannel(channel);
    this.pc.onconnectionstatechange = () => {
      if (this.pc.connectionState === 'failed') this.onfailure?.(new Error('房间控制连接失败。'));
    };
    this.pc.onicecandidate = ({ candidate }) => {
      if (candidate?.candidate) this.oncandidate?.(candidate.toJSON());
    };
  }

  bindChannel(channel) {
    if (this.channel || channel.label !== 'roomcast-v2' || !channel.ordered
      || channel.maxRetransmits != null || channel.maxPacketLifeTime != null) {
      channel.close();
      return;
    }
    this.channel = channel;
    channel.binaryType = 'arraybuffer';
    const opened = () => {
      channel.onopen = null;
      this.onevent?.({ event: 'open' });
    };
    channel.onopen = opened;
    channel.onmessage = ({ data }) => this.receive(data);
    channel.onclose = () => this.onfailure?.(new Error('房间控制通道已关闭。'));
    channel.onerror = () => this.onfailure?.(new Error('房间控制通道出错。'));
    if (channel.readyState === 'open') opened();
  }

  async negotiate({ offer } = {}) {
    if (offer) {
      await this.setRemote('offer', offer);
      await this.pc.setLocalDescription(await this.pc.createAnswer());
    } else {
      this.bindChannel(this.pc.createDataChannel('roomcast-v2', { ordered: true }));
      await this.pc.setLocalDescription(await this.pc.createOffer());
    }
    return [this.pc.localDescription.sdp];
  }

  answer(sdp) {
    return this.setRemote('answer', sdp);
  }

  async setRemote(type, sdp) {
    await this.pc.setRemoteDescription({ type, sdp });
    const pending = this.pendingCandidates;
    this.pendingCandidates = null;
    await Promise.all(pending.map(candidate => this.candidate(candidate)));
  }

  async candidate(candidate) {
    if (!candidate?.candidate || candidate.candidate.length > 2048) return;
    // Trickle ICE can precede verification of the signed SDP on either side.
    if (this.pendingCandidates) {
      if (this.pendingCandidates.length < 128) this.pendingCandidates.push(candidate);
      return;
    }
    try { await this.pc.addIceCandidate(candidate); }
    catch { /* ICE can still nominate another candidate. */ }
  }

  sendControl(buffer) {
    const bytes = new Uint8Array(buffer);
    if (!bytes.length || bytes.length > maxMessageSize || this.channel.bufferedAmount + bytes.length > 2 * maxMessageSize) {
      throw new Error('房间控制消息超出发送上限。');
    }
    for (let offset = 0; offset < bytes.length; offset += fragmentSize) {
      const payload = bytes.subarray(offset, offset + fragmentSize);
      const frame = new Uint8Array(1 + payload.length);
      frame[0] = offset + payload.length === bytes.length ? 1 : 0;
      frame.set(payload, 1);
      this.channel.send(frame);
    }
  }

  receive(data) {
    const frame = data instanceof ArrayBuffer ? new Uint8Array(data) : null;
    if (!frame || frame.length < 2 || frame.length > fragmentSize + 1 || frame[0] > 1
      || this.receivedBytes + frame.length - 1 > maxMessageSize) {
      this.onfailure?.(new Error('房间控制消息格式无效。'));
      return;
    }
    const payload = frame.subarray(1);
    if (frame[0] === 1 && this.receivedBytes === 0) {
      this.onevent?.({ event: 'data', bytes: data.slice(1) });
      return;
    }
    const size = this.receivedBytes + payload.length;
    if (!this.partial || size > this.partial.length) {
      const capacity = Math.max(size, this.partial ? this.partial.length * 2 : fragmentSize);
      const buffer = new Uint8Array(Math.min(capacity, maxMessageSize));
      if (this.partial) buffer.set(this.partial.subarray(0, this.receivedBytes));
      this.partial = buffer;
    }
    this.partial.set(payload, this.receivedBytes);
    this.receivedBytes = size;
    if (frame[0] === 0) return;
    const message = this.partial.buffer.slice(0, size);
    this.partial = null;
    this.receivedBytes = 0;
    this.onevent?.({ event: 'data', bytes: message });
  }

  close() {
    this.onfailure = null;
    this.onevent = null;
    this.oncandidate = null;
    this.partial = null;
    this.receivedBytes = 0;
    this.pendingCandidates?.splice(0);
    this.pc.close();
  }
}
