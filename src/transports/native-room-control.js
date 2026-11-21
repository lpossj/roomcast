import { Emitter } from '@socket.io/component-emitter';
import { util } from 'peerjs';
import { NativeEndpoint, nativeAvailable, nativeNetworkReport, encodeBytes, decodeBytes } from './native-endpoint.js';

const label = 'roomcast-native-v1';
const encoder = new TextEncoder();

async function signedDescription(room, source, destination, id, type, sdp, signature) {
  const at = signature ? signature.at : Date.now();
  if (!room.inviteSecret || typeof sdp !== 'string' || sdp.length > 65536 || !Number.isSafeInteger(at)
    || Math.abs(Date.now() - at) > 120000) throw new Error('原生协商凭据已失效。');
  const key = await crypto.subtle.importKey('raw', encoder.encode(room.inviteSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign','verify']);
  const bytes = encoder.encode(JSON.stringify([label, room.roomId, source, destination, id, type, at, sdp]));
  if (!signature) return { at, mac: encodeBytes(await crypto.subtle.sign('HMAC', key, bytes)) };
  if (typeof signature.mac !== 'string' || signature.mac.length !== 44
    || !await crypto.subtle.verify('HMAC', key, decodeBytes(signature.mac), bytes)) throw new Error('原生协商签名无效。');
  if (type === 'offer') {
    const seen = room.nativeOffers ||= new Map();
    for (const [key, expires] of seen) if (expires < Date.now()) seen.delete(key);
    if (seen.has(id) || seen.size >= 128) throw new Error('原生协商请求已失效。');
    seen.set(id, at + 120000);
  }
}

class NativeControl extends Emitter {
  constructor(room, peerId, provider, options) {
    super();
    this.room = room;
    this.peer = peerId;
    this.provider = provider;
    this.type = 'data';
    this.connectionId = options.connectionId || crypto.randomUUID();
    const { protocol, authMode, joinAttemptId, networkCapabilities } = options.metadata || {};
    this.metadata = { protocol, authMode, joinAttemptId, networkCapabilities };
    this.peerConnection = this;
    this.roomcastNative = true;
    this.dataChannel = { bufferedAmount: 0 };
    this.connectionState = 'connecting';
    this.signalingState = 'stable';
    this.sendTail = Promise.resolve();
    this.early = [];
    queueMicrotask(() => this.start(options._payload).catch(error => this.fail(error)));
  }
  async start(incoming) {
    if (this.closed) return;
    const { provider, peer, room, connectionId } = this;
    const secret = room.inviteSecret;
    if (incoming) {
      if (!room.isHost || !incoming.signature || !/^[a-f0-9-]{36}$/.test(connectionId)) throw new Error('原生协商请求无效。');
      await signedDescription(room, peer, provider.id, connectionId, 'offer', incoming.sdp?.sdp, incoming.signature);
    }
    if (this.closed || room.closed || secret !== room.inviteSecret) return this.close();
    const endpoint = this.endpoint = new NativeEndpoint();
    const outgoing = [];
    let signaled = false;
    endpoint.oncandidate = candidate => {
      if (signaled) this.signal('CANDIDATE', { candidate });
      else outgoing.push(candidate);
    };
    endpoint.onfailure = error => this.fail(error);
    endpoint.addEventListener('connectionstatechange', () => {
      this.connectionState = endpoint.connectionState;
      this.emit('connectionstatechange');
    });
    endpoint.onevent = value => {
      if (value.event === 'data' && this.open) {
        try { this.emit('data', util.unpack(decodeBytes(value.data))); } catch (error) { this.fail(error); }
      } else if (value.event === 'open') {
        this.open = true; this.emit('open');
      } else if (value.event === 'buffer') this.dataChannel.bufferedAmount = value.amount;
    };
    const type = incoming ? 'answer' : 'offer';
    const [sdp] = await endpoint.negotiate({ control: true, offer: incoming?.sdp?.sdp });
    const signature = await signedDescription(room, provider.id, peer, connectionId, type, sdp);
    if (this.closed || secret !== room.inviteSecret) return this.close();
    this.signal(type.toUpperCase(), { sdp: { type, sdp }, signature, label, reliable: true,
      serialization: 'binary', metadata: this.metadata });
    signaled = true;
    for (const candidate of outgoing) this.signal('CANDIDATE', { candidate });
    for (const candidate of this.early.splice(0)) await endpoint.candidate(candidate);
  }
  signal(type, payload) {
    if (!this.closed) this.provider.socket.send({ type, dst: this.peer, payload: { type: 'data', connectionId: this.connectionId, ...payload } });
  }
  handleMessage({ type, payload }) {
    void this.receiveSignal(type, payload).catch(error => this.fail(error));
  }
  async receiveSignal(type, payload) {
    if (this.closed) return;
    if (type === 'ANSWER') {
      if (this.answerReceived || !payload.signature || !this.endpoint) throw new Error('房主未确认原生连接。');
      this.answerReceived = true;
      await signedDescription(this.room, this.peer, this.provider.id, this.connectionId, 'answer', payload.sdp?.sdp, payload.signature);
      if (!this.closed) await this.endpoint.answer(payload.sdp.sdp);
    } else if (type === 'CANDIDATE') {
      if (this.endpoint) await this.endpoint.candidate(payload.candidate);
      else if (this.early.length < 128) this.early.push(payload.candidate);
    }
  }
  send(value) {
    if (!this.open) return;
    const packed = util.pack(value);
    const size = packed.byteLength || 0;
    this.queued = (this.queued || 0) + size;
    if (this.queued > 16 * 1024 * 1024) { this.fail(new Error('原生发送队列已满。')); return; }
    this.sendTail = this.sendTail.then(async () => {
      if (!this.closed) await this.endpoint.command('send', { data: encodeBytes(await packed) });
    }).catch(error => this.fail(error)).finally(() => { this.queued -= size; });
  }
  get bufferSize() { return this.queued || 0; }
  get iceConnectionState() { return this.connectionState; }
  addEventListener(type, fn) { this.on(type, fn); }
  removeEventListener(type, fn) { this.off(type, fn); }
  async getStats() { return this.open ? nativeNetworkReport(await this.endpoint.stats()) : new Map(); }
  fail(error) { if (!this.closed) { this.emit('error', error); this.close(); } }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    this.signalingState = this.connectionState = 'closed';
    this.provider._removeConnection(this);
    this.endpoint?.close();
    this.emit('close');
  }
}

// PeerJS 1.5.5 selects an incoming DataConnection by serialization. Keep its
// standard binary wire envelope so old hosts can process an outdated invitation.
export function installNativeControl(provider, room) {
  if (!nativeAvailable()) return;
  const Binary = provider._serializers.binary;
  provider._serializers.binary = function(peerId, peer, options) {
    return options.label === label ? new NativeControl(room, peerId, peer, options) : new Binary(peerId, peer, options);
  };
}
export function openNativeControl(room, metadata) {
  return room.peer.connect('roomcast-v1-' + room.roomId, { serialization: 'binary', reliable: true, label, metadata });
}
