import VDONinjaSDK from '@vdoninja/sdk/browser';

export const VDO_TRANSPORT_BUILD_PROBE = typeof VDONinjaSDK === 'function';

const DEFAULT_HOST = 'wss://wss.vdo.ninja';
const DEFAULT_SALT = 'roomcast_vdo_v1';

function requireText(value, name) {
  const text = String(value ?? '').trim();
  if (!text) throw new TypeError(`${name} is required`);
  return text;
}

function isMediaStreamLike(stream) {
  return Boolean(
    stream
    && typeof stream.getTracks === 'function'
    && typeof stream.getAudioTracks === 'function'
    && typeof stream.getVideoTracks === 'function'
  );
}

function replaceTrackByKind(stream, track) {
  for (const current of stream.getTracks()) {
    if (current.kind === track.kind && current.id !== track.id) {
      stream.removeTrack(current);
    }
  }
  if (!stream.getTracks().some(current => current.id === track.id)) {
    stream.addTrack(track);
  }
}

/**
 * Thin VDO.Ninja transport for Roomcast.
 *
 * Important:
 * - This module has no side effects on import.
 * - It never captures media itself; Roomcast owns the source MediaStream.
 * - VDO TURN/relay is disabled. Cloudflare TURN remains a separate Roomcast route.
 * - Peer recovery is left to the future Roomcast race coordinator.
 */
export class VdoTransport extends EventTarget {
  #sdk = null;
  #room;
  #password;
  #host;
  #salt;
  #label;
  #debug;

  #state = 'idle';
  #connectPromise = null;
  #closed = false;

  #publishedStreamId = null;
  #viewingStreamId = null;
  #viewPeerConnection = null;
  #remoteStream = null;

  #sdkListeners = [];

  constructor({
    room,
    password,
    host = DEFAULT_HOST,
    salt = DEFAULT_SALT,
    label = 'Roomcast',
    debug = false,
  } = {}) {
    super();

    this.#room = requireText(room, 'room');
    this.#password = requireText(password, 'password');
    this.#host = requireText(host, 'host');
    this.#salt = requireText(salt, 'salt');
    this.#label = String(label || 'Roomcast');
    this.#debug = Boolean(debug);
  }

  get state() {
    return this.#state;
  }

  get room() {
    return this.#room;
  }

  get publishedStreamId() {
    return this.#publishedStreamId;
  }

  get viewingStreamId() {
    return this.#viewingStreamId;
  }

  get remoteStream() {
    return this.#remoteStream;
  }

  get viewPeerConnection() {
    return this.#viewPeerConnection;
  }

  get isClosed() {
    return this.#closed;
  }

  #emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  #setState(nextState, detail = {}) {
    this.#state = nextState;
    this.#emit('statechange', { state: nextState, ...detail });
  }

  #listenSdk(type, handler) {
    this.#sdk.addEventListener(type, handler);
    this.#sdkListeners.push([type, handler]);
  }

  #unbindSdk() {
    if (!this.#sdk) return;
    for (const [type, handler] of this.#sdkListeners) {
      this.#sdk.removeEventListener(type, handler);
    }
    this.#sdkListeners = [];
  }

  #ensureOpen() {
    if (this.#closed) throw new Error('VDO transport is closed');
  }

  #createSdk() {
    this.#ensureOpen();
    if (this.#sdk) return this.#sdk;

    const sdk = new VDONinjaSDK({
      host: this.#host,
      salt: this.#salt,
      password: this.#password,
      label: this.#label,
      debug: this.#debug,

      // Roomcast owns relay routing. The VDO race lane must stay direct-only.
      turnServers: false,
      forceTURN: false,
      autoRelay: false,

      // The future Roomcast race coordinator owns retry/fallback timing.
      autoRecover: false,
    });

    this.#sdk = sdk;

    this.#listenSdk('connected', event => {
      this.#emit('signalingconnected', event?.detail || {});
    });

    this.#listenSdk('roomJoined', event => {
      this.#emit('roomjoined', event?.detail || {});
    });

    this.#listenSdk('track', event => {
      const detail = event?.detail || {};
      const track = detail.track;
      if (!track) return;

      // A transport instance views at most one Roomcast share stream.
      if (
        this.#viewingStreamId
        && detail.streamID
        && detail.streamID !== this.#viewingStreamId
      ) {
        return;
      }

      if (!this.#remoteStream) this.#remoteStream = new MediaStream();
      replaceTrackByKind(this.#remoteStream, track);

      this.#emit('track', {
        ...detail,
        track,
        stream: this.#remoteStream,
      });
    });

    this.#listenSdk('peerConnected', event => {
      this.#emit('peerconnected', event?.detail || {});
    });

    this.#listenSdk('connectionFailed', event => {
      const detail = event?.detail || {};
      this.#emit('connectionfailed', detail);
    });

    this.#listenSdk('error', event => {
      const detail = event?.detail || {};
      this.#emit('error', detail);
    });

    this.#listenSdk('disconnected', event => {
      const detail = event?.detail || {};
      this.#emit('disconnected', detail);
    });

    return sdk;
  }

  async connect() {
    this.#ensureOpen();

    if (this.#state === 'connected' || this.#state === 'ready') return;
    if (this.#connectPromise) return this.#connectPromise;

    const sdk = this.#createSdk();

    this.#connectPromise = (async () => {
      this.#setState('connecting');
      try {
        await sdk.connect();
        await sdk.joinRoom({
          room: this.#room,
          password: this.#password,
        });
        this.#setState('ready');
      } catch (error) {
        this.#setState('failed', { error });
        throw error;
      } finally {
        this.#connectPromise = null;
      }
    })();

    return this.#connectPromise;
  }

  async publish(stream, {
    streamId,
    label = this.#label,
    media,
  } = {}) {
    this.#ensureOpen();

    if (!isMediaStreamLike(stream)) {
      throw new TypeError('stream must be a MediaStream');
    }

    const id = requireText(streamId, 'streamId');

    await this.connect();

    const publishedId = await this.#sdk.publish(stream, {
      streamID: id,
      room: this.#room,
      label,
      password: this.#password,
      ...(media ? { media } : {}),
    });

    this.#publishedStreamId = publishedId || id;
    this.#emit('publishing', { streamId: this.#publishedStreamId });
    return this.#publishedStreamId;
  }

  async view(streamId, {
    audio = true,
    video = true,
    label = this.#label,
  } = {}) {
    this.#ensureOpen();

    const id = requireText(streamId, 'streamId');

    if (this.#viewingStreamId && this.#viewingStreamId !== id) {
      this.stopViewing();
    }

    this.#viewingStreamId = id;
    this.#remoteStream = new MediaStream();

    await this.connect();

    try {
      this.#viewPeerConnection = await this.#sdk.view(id, {
        audio: Boolean(audio),
        video: Boolean(video),
        label,
        downloads: false,
        allowresources: false,
      });
    } catch (error) {
      this.#viewingStreamId = null;
      this.#viewPeerConnection = null;
      this.#remoteStream = null;
      this.#emit('connectionfailed', { streamID: id, reason: error?.message, error });
      throw error;
    }

    return this.#viewPeerConnection;
  }

  stopViewing() {
    if (!this.#sdk || !this.#viewingStreamId) return;

    const id = this.#viewingStreamId;
    this.#viewingStreamId = null;
    this.#viewPeerConnection = null;
    this.#remoteStream = null;

    try {
      this.#sdk.stopViewing(id);
    } catch {
      // Full disconnect below remains the final cleanup path.
    }

    this.#emit('viewingstopped', { streamId: id });
  }

  stopPublishing() {
    if (!this.#sdk || !this.#publishedStreamId) return;

    const id = this.#publishedStreamId;
    this.#publishedStreamId = null;

    try {
      this.#sdk.stopPublishing();
    } catch {
      // Full disconnect below remains the final cleanup path.
    }

    this.#emit('publishingstopped', { streamId: id });
  }

  async getStats(uuid) {
    if (!this.#sdk) return {};
    return this.#sdk.getStats(uuid);
  }

  getPublisherConnections() {
    if (this.#closed || !this.#publishedStreamId) return [];
    // SDK 1.6.1 stores separate publisher/viewer connections under each peer.
    return [...(this.#sdk?.connections?.values() || [])]
      .map(connections => connections.publisher?.pc)
      .filter(pc => pc && pc.connectionState !== 'closed');
  }

  async getPeerQuality(uuid) {
    if (!this.#sdk) return null;
    return this.#sdk.getPeerQuality(uuid);
  }

  async close() {
    if (this.#closed) return;

    this.#closed = true;
    this.#setState('closing');

    this.stopViewing();
    this.stopPublishing();

    const sdk = this.#sdk;
    if (sdk) {
      try {
        await sdk.disconnect();
      } finally {
        this.#unbindSdk();
        this.#sdk = null;
      }
    }

    this.#remoteStream = null;
    this.#viewPeerConnection = null;
    this.#setState('closed');
  }
}

export function createVdoTransport(options) {
  return new VdoTransport(options);
}
