import { configureScreenVideoSender } from './video-sender-settings.js';
import { createNativeScreenPublisher } from './transports/native-screen-publisher.js';
import { configureCampusSession, prepareCampusConnection, stopCampusSession, campusRequestProof, verifyCampusRequest, campusStatsRoute } from './campus-session.js';
import { Peer } from 'peerjs';
import { io } from 'socket.io-client';
import { createRoomcastPeerConnection, DEFAULT_STUN_ICE, mediaIceServers, turnIceServers } from './ice-policy.js';
import { ack, recordLifecycle } from './lib.js';
import { createPeerAuthProof, MAX_UNAUTHENTICATED_PEERS, PEER_AUTH_PROTOCOL, PEER_AUTH_TIMEOUT_MS, randomPeerAuthNonce, verifyPeerAuthProof } from './p2p-auth.js';
import { encodeRelayInvite, optionalRelayIce } from './relay.js';
import { createP2pVideoPolicy, p2pResolutionScale } from './p2p-video-policy.js';
import { CAMPUS_ANSWER_TIMEOUT_MS } from './fallback-policy.js';
import { recordFailure } from './lifecycle-diagnostics.js';

export const P2P_ICE = DEFAULT_STUN_ICE;

const forwarded = [
  'room:state',
  'room:kicked',
  'room:owner-token',
  'room:credential-revoke',
  'chat:message',
  'chat:recalled',
  'laser:stroke',
  'image:start',
  'image:chunk',
  'image:complete',
  'image:abort',
  'screen:signal',
  'voice:signal',
  'voice:muted',
  'member:left',
  'share:expired',
];

const allowed = new Set([
  'room:join',
  'room:leave',
  'room:ping',
  'room:migration-confirm',
  'member:role',
  'member:profile',
  'member:voice',
  'member:mute',
  'member:share-permission',
  'laser:member-permission',
  'laser:global-permission',
  'laser:stroke',
  'member:kick',
  'chat:send',
  'chat:recall',
  'chat:history',
  'image:init',
  'image:chunk',
  'image:complete',
  'screen:signal',
  'voice:signal',
  'view:start',
  'view:heartbeat',
  'view:stop',
  'share:claim',
  'share:started',
  'share:stop',
]);

const beforeJoin = new Set(['room:join']);
const INVITE_SECRET = /^[A-Za-z0-9_-]{43}$/;
const LASER_QUEUE_MAX_BYTES = 16 * 1024;
const LASER_MESSAGE_MAX_BYTES = 2048;
const LASER_PACKETS_PER_SECOND = 24;
const recoveryMemberKey = room => JSON.stringify([room?.laserEnabled !== false, room?.members?.map(member => [
  member.id, member.role, member.canShare, member.canLaser,
]) || []]);

function laserQueueBusy(connection) {
  return Number(connection?.dataChannel?.bufferedAmount || 0) > LASER_QUEUE_MAX_BYTES
    || Number(connection?.bufferSize || 0) > 0;
}

// The host does not start the authentication clock until the data channel is
// actually open (see accept()). The viewer must therefore wait for
// PEER_AUTH_ICE_TIMEOUT_MS + PEER_AUTH_TIMEOUT_MS, otherwise a first join whose
// ICE setup is slow fails on the viewer side even though the host is still
// waiting and able to authenticate.
const PEER_AUTH_ICE_TIMEOUT_MS = 25_000;
const PEER_AUTH_TOTAL_TIMEOUT_MS = PEER_AUTH_ICE_TIMEOUT_MS + PEER_AUTH_TIMEOUT_MS;

const defaultScreenSettings = {
  width: 1920,
  height: 1080,
  fps: 30,
  bitrate: 4500,
  performanceMode: 'quality',
};

function lockVideoBitrate(sdp, kbps) {
  const bits = Math.max(200, Number(kbps) || 0) * 1000;
  if (!bits) return sdp;

  return sdp.replace(
    /(m=video[^]*?)(?=\r\nm=|$)/,
    section => {
      const lines = section
        .split('\r\n')
        .filter(line => !/^b=(AS|TIAS):/.test(line));

      const connection = lines.findIndex(
        line => line.startsWith('c='),
      );

      lines.splice(
        connection >= 0 ? connection + 1 : 1,
        0,
        `b=AS:${Math.round(bits / 1000)}`,
        `b=TIAS:${bits}`,
      );

      const payloads = lines
        .map(line => (
          line.match(
            /^a=rtpmap:(\d+) (H264|VP8|VP9|AV1)\//i,
          )?.[1]
        ))
        .filter(Boolean);

      for (const payload of payloads) {
        const index = lines.findIndex(
          line => line.startsWith(`a=fmtp:${payload} `),
        );

        const controls =
          `x-google-start-bitrate=${Math.round(bits / 1000)};` +
          `x-google-max-bitrate=${Math.round(bits / 1000)}`;

        if (index >= 0) {
          // Keep the target ceiling, but never pin congestion control to a floor.
          const existing = lines[index].slice(lines[index].indexOf(' ') + 1)
            .split(';').map(value => value.trim())
            .filter(value => value && !/^x-google-(?:start|min|max)-bitrate\s*=/i.test(value));
          lines[index] = `a=fmtp:${payload} ${[...existing, controls].join(';')}`;
        } else {
          lines.push(`a=fmtp:${payload} ${controls}`);
        }
      }

      return lines.join('\r\n');
    },
  );
}

const withTimeout = (promise, ms, text) => {
  let timer;

  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(text)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
};

const withAbort = (promise, signal) => {
  if (!signal) return promise;

  let abort;

  return Promise.race([
    promise,
    new Promise((_, reject) => {
      abort = () => reject(
        new DOMException(
          '媒体连接已取消。',
          'AbortError',
        ),
      );

      if (signal.aborted) {
        abort();
      } else {
        signal.addEventListener(
          'abort',
          abort,
          { once: true },
        );
      }
    }),
  ]).finally(() => {
    signal.removeEventListener(
      'abort',
      abort,
    );
  });
};

const waitForDataQueue = async connection => {
  const started = performance.now();

  while (
    connection?.open
    && Number(
      connection.dataChannel?.bufferedAmount || 0,
    ) > 512 * 1024
  ) {
    if (
      performance.now() - started
      > 5000
    ) {
      throw new Error(
        '图片发送队列拥塞，请稍后重试。',
      );
    }

    await new Promise(
      resolve => setTimeout(resolve, 20),
    );
  }
};

const randomSecret = () => {
  const bytes = crypto.getRandomValues(
    new Uint8Array(32),
  );

  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
};

const pause = ms => new Promise(
  resolve => setTimeout(resolve, ms),
);

/**
 * Public PeerServer exchanges ICE metadata only.
 * Room RPCs travel over an encrypted peer data channel
 * to the host's local authoritative room server.
 */
export class P2PRoom {
  constructor() {
    this.id = '';
    this.connected = false;
    this.p2p = true;
    this.mediaP2P = true;
    this.roomConnection = 'P2P';

    this.listeners = new Map();

    this.guests = new Set();
    this.unauthenticated = new Set();
    this.guestMembers = new Map();

    this.pending = new Map();
    this.controlPending = new Map();
    this.screenPending = new Map();

    this.screenViewers = new Map();
    this.screenSessions = new Map();
    this.vdoPending = new Map();

    this.vdoPublisher = null;
    this.vdoPublisherReady = null;
    this.vdoPublisherGeneration = 0;

    this.screenStream = null;
    this.screenSettings = defaultScreenSettings;

    this.closed = false;

    this.controlIceServers = [...P2P_ICE];
    this.mediaIceServers = [...P2P_ICE];
    this.iceServers = this.controlIceServers;

    this.relayInvite = '';
    this.inviteSecret = '';
    this.authFailures = new Map();

    this.migrating = false;
    this.peerReconnectTimer = null;
    this.delayedTimers = new Set();
    this.recoveryBackup = null;
    this.recoveryPromise = null;
    this.recoveryCandidate = null;
    this.backupTimer = null;
    this.backupBusy = false;
    this.backupDirty = false;
    this.lastBackupAt = 0;
  }

  on(event, fn) {
    if (!this.listeners.has(event)) {
      this.listeners.set(
        event,
        new Set(),
      );
    }

    this.listeners
      .get(event)
      .add(fn);

    return this;
  }

  off(event, fn) {
    this.listeners
      .get(event)
      ?.delete(fn);

    return this;
  }

  once(event, fn) {
    const wrapper = (...args) => {
      this.off(
        event,
        wrapper,
      );

      fn(...args);
    };

    return this.on(
      event,
      wrapper,
    );
  }

  removeAllListeners() {
    this.listeners.clear();
  }

  dispatch(event, value) {
    const criticalRecoveryChange = event === 'room:credential'
      || (event === 'room:state' && recoveryMemberKey(this.room) !== recoveryMemberKey(value));
    if (event === 'room:kicked') this.recoveryBackup = null;
    if (event === 'room:resumed'
      && value?.room?.streams?.some(stream => stream.memberId === this.id)
      && !this.screenStream?.active) {
      // Local capture may have stopped while writes to the old host were paused.
      void Promise.resolve().then(() => this.request('share:stop')).catch(() => {});
    }
    if (event === 'room:credential-revoke') {
      if (this.isHost) this.rotateInviteCredential(value?.memberId);
      return;
    }
    if (event === 'room:credential') {
      if (!INVITE_SECRET.test(value?.inviteSecret || '')) return;
      const changed = this.inviteSecret !== value.inviteSecret;
      if (changed) this.recoveryBackup = null;
      this.inviteSecret = value.inviteSecret;
      if (this.pendingMigrationCommit) this.pendingMigrationCommit.inviteSecret = value.inviteSecret;
      if (changed && this.screenStream?.active) {
        this.stopVdoPublisher();
        void this.startVdoPublisher(this.screenStream).catch(() => { });
      }
    }
    if (event === 'room:state') {
      this.refreshCachedRecovery(value);
      this.room = value;
      if (value?.members?.find(member => member.id === this.id)?.canShare === false) this.stopScreenStream();
    }
    if (this.isHost && ['room:state', 'chat:message', 'chat:recalled', 'room:credential', 'room:resumed'].includes(event)) {
      this.scheduleRecoveryBackup(criticalRecoveryChange);
    }

    if (
      event === 'room:owner-token'
      && typeof value?.ownerToken === 'string'
    ) {
      this.ownerToken = value.ownerToken;
    }

    if (event === 'screen:signal') {
      void this.screenSignal(value);
    }

    if (event === 'member:left') {
      this.closeScreenOwner(
        value.memberId,
      );
    }

    for (
      const fn
      of this.listeners.get(event) || []
    ) {
      fn(value);
    }
  }

  rotateInviteCredential(kickedId) {
    if (!kickedId || this.closed) return;
    const kicked = this.guestMembers.get(kickedId);
    this.guestMembers.delete(kickedId);
    this.dispatch('room:credential', { inviteSecret: randomSecret() });
    const admitted = new Set(this.guestMembers.values());
    for (const connection of [...this.unauthenticated, ...this.guests]) {
      if (connection === kicked || !admitted.has(connection)) {
        if (connection === kicked && connection.open) connection.send({ event: 'room:kicked', data: { error: '你已被移出房间。' } });
        connection.close();
      } else if (connection.open) {
        connection.send({ event: 'room:credential', data: { inviteSecret: this.inviteSecret } });
      }
    }
  }

  timeout(ms) {
    return {
      emit: (
        event,
        payload,
        callback,
      ) => (
        withTimeout(
          this.request(
            event,
            payload,
          ),
          ms,
          'P2P 房主响应超时',
        ).then(
          result => callback(
            null,
            result,
          ),
          error => callback(error),
        )
      ),
    };
  }

  emit(
    event,
    payload = {},
    callback,
  ) {
    this.request(
      event,
      payload,
    )
      .then(
        value => callback?.(value),
      )
      .catch(() => { });

    return this;
  }

  sendLaser(payload) {
    // Never replay transient coordinates after migration or reconnection, and
    // never allocate RPC replies/timeouts for every movement packet.
    if (this.closed || !this.connected || this.migrating) return false;
    try {
      if (this.isHost) {
        if (!this.local?.connected) return false;
        (this.local.volatile || this.local).emit('laser:stroke', payload);
      } else {
        if (!this.remote?.open || laserQueueBusy(this.remote)) return false;
        this.remote.send({ event: 'laser:stroke', payload });
      }
      return true;
    } catch {
      return false;
    }
  }

  assertOpen() {
    if (this.closed) throw new DOMException('操作已取消', 'AbortError');
  }

  async localSocket() {
    this.assertOpen();
    if (typeof document !== 'undefined' && !window.roomcast?.desktop) {
      if (!this.browserService) {
        const { createBrowserRoomService } = await import('./browser-room-service.js');
        this.assertOpen();
        this.browserService = createBrowserRoomService();
      }
      return this.browserService.connect();
    }
    const socket = io(
      window.location.origin,
      {
        reconnection: false,
        autoConnect: false,
        transports: ['websocket'],
      },
    );

    await withTimeout(
      new Promise(
        (resolve, reject) => {
          socket.once(
            'connect',
            resolve,
          );

          socket.once(
            'connect_error',
            reject,
          );

          socket.connect();
        },
      ),
      10000,
      '本机房间服务未启动',
    ).catch(error => {
      socket.disconnect();
      throw error;
    });

    if (this.closed) socket.disconnect();
    this.assertOpen();
    return socket;
  }

  async openPeer(id, override, { adopt = true, timeout = 20000 } = {}) {
    this.assertOpen();
    const options = {
      config: {
        iceServers:
          this.controlIceServers,
        iceTransportPolicy: 'all',
        roomcastIcePolicy: true,
      },
      debug: 0,
    };

    if (override) {
      const url = new URL(override);

      Object.assign(
        options,
        {
          host: url.hostname,
          port: Number(
            url.port
            || (
              url.protocol === 'https:'
                ? 443
                : 80
            ),
          ),
          secure:
            url.protocol === 'https:',
          path: url.pathname,
        },
      );
    }

    const peer = id
      ? new Peer(id, options)
      : new Peer(options);

    try { await withTimeout(
      new Promise(
        (resolve, reject) => {
          peer.once(
            'open',
            resolve,
          );

          peer.on(
            'error',
            error => {
              const failure = new Error(
                `公共信令连接失败：${error.type || 'unknown'}。检查网络或稍后重试。`,
              );
              failure.type = error.type;
              reject(failure);
              // A broker ID is a registration fence, not a consensus protocol.
              // A former host must retire if a new coordinator holds that ID.
              if (this.peer === peer && this.isHost && error.type === 'unavailable-id') {
                this.disconnect('房间已由其他成员接管，请重新加入。');
              }
            },
          );
        },
      ),
      timeout,
      '公共信令服务连接超时；当前网络可能无法访问该服务。',
    ); } catch (error) { peer.destroy(); throw error; }

    if (this.closed) { peer.destroy(); this.assertOpen(); }
    if (adopt) this.peer = peer;
    peer.on(
      'disconnected',
      () => {
        if (!this.closed && this.peer === peer) {
          clearTimeout(
            this.peerReconnectTimer,
          );

          this.peerReconnectTimer =
            setTimeout(
              () => {
                if (
                  !this.closed
                  && this.peer === peer
                  && peer.disconnected
                  && !peer.destroyed
                ) {
                  peer.reconnect();
                }
              },
              2500,
            );
        }
      },
    );
    return peer;
  }

  async enter(
    mode,
    details,
    config,
  ) {
    this.assertOpen();
    this.peerServer =
      config.peerServer;

    this.joinDetails = {
      nickname: String(
        details.nickname || '',
      ).trim(),
    };

    this.isHost =
      mode === 'create';

    if (this.isHost) {
      this.inviteSecret =
        randomSecret();

      const preparing = performance.now();
      const [relayResult, local] = await Promise.all([
        optionalRelayIce({
          settings:
            details.relaySettings
            || { enabled: false },
        }),
        this.localSocket(),
      ]);
      this.local = local;
      if (this.closed) local.disconnect();
      recordLifecycle('create-prepare', 'completed', performance.now() - preparing);

      this.assertOpen();
      const relay =
        relayResult.iceServers;

      this.controlIceServers = [
        ...P2P_ICE,
        ...relay,
      ];

      this.mediaIceServers =
        mediaIceServers(
          this.controlIceServers,
        );

      this.iceServers =
        this.controlIceServers;

      this.relayInvite =
        relay.length
          ? encodeRelayInvite(relay)
          : '';

      for (
        const event
        of forwarded
      ) {
        this.local.on(
          event,
          data => this.dispatch(
            event,
            data,
          ),
        );
      }

      this.local.on(
        'disconnect',
        () => {
          if (!this.closed) {
            this.disconnect(
              '本机房间服务已断开',
            );
          }
        },
      );

      const creating = performance.now();
      const result = await ack(
        this.local,
        'room:create',
        {
          name: details.name,
          nickname:
            details.nickname,
          createKey:
            details.createKey || '',
          iceServers:
            this.iceServers,
        },
      );
      recordLifecycle('create-local', 'completed', performance.now() - creating);

      this.assertOpen();
      this.id =
        result.selfId;

      this.roomId =
        result.room.id;

      this.room =
        result.room;

      this.ownerToken =
        result.ownerToken || '';

      await configureCampusSession(this, window.roomcast?.startCampusNetwork ? randomSecret() : '');
      this.assertOpen();
      const signaling = performance.now();
      await this.openPeer(
        `roomcast-v1-${this.roomId}`,
        config.peerServer,
      );
      recordLifecycle('create-signal', 'completed', performance.now() - signaling);
      this.assertOpen();

      this.peer.on(
        'connection',
        connection => (
          this.accept(connection)
        ),
      );

      this.connected = true;

      return {
        ...result,
        roomConnection: 'P2P',
        campusSecret: this.campusSecret || '',
        iceServers:
          this.controlIceServers,
        controlIceServers:
          this.controlIceServers,
        mediaIceServers:
          this.mediaIceServers,
        relayInvite:
          this.relayInvite,
        inviteSecret:
          this.inviteSecret,
        // Non-owner members must re-share the same signaling server they joined through,
        // otherwise a web link built from their invite silently falls back to public PeerJS.
        peerServer:
          this.peerServer
          || '',
        turnUnavailable:
          relayResult.unavailable,
      };
    }

    const raw =
      details.roomId.trim();

    let roomId = raw;
    let relayValue = '';
    let inviteSecret = '';
    let signalServer = '';
    let campusSecret = '';

    if (/^roomcast:\/\//i.test(raw)) {
      let parsed;

      try {
        parsed = new URL(raw);
      } catch {
        throw new Error(
          'P2P 邀请链接格式无效。',
        );
      }

      if (
        parsed.protocol
        !== 'roomcast:'
        || parsed.hostname
        !== 'join'
      ) {
        throw new Error(
          'P2P 邀请链接格式无效。',
        );
      }

      roomId = parsed.pathname
        .replace(
          /^\/+|\/+$/g,
          '',
        );

      relayValue =
        parsed.searchParams
          .get('relay')
        || '';

      inviteSecret =
        parsed.searchParams
          .get('secret')
        || '';

      signalServer = parsed.searchParams.get('signal') || '';
      campusSecret = parsed.searchParams.get('campus') || '';
      if (parsed.searchParams.has('campus') && !INVITE_SECRET.test(campusSecret)) throw new Error('校园互联邀请密钥无效。');

      if (
        !INVITE_SECRET.test(
          inviteSecret,
        )
        || (
          relayValue
          && !/^[A-Za-z0-9_-]{1,6000}$/.test(
            relayValue,
          )
        )
        || (signalServer && !/^https:\/\/[^\s]+$/i.test(signalServer))
      ) {
        throw new Error(
          'P2P 邀请缺少有效的安全密钥。',
        );
      }
    } else {
      throw new Error(
        '加入房间必须使用完整的 roomcast:// 安全邀请链接。',
      );
    }

    this.roomId =
      roomId.toUpperCase();

    if (
      !/^[A-F0-9]{8}$/.test(
        this.roomId,
      )
    ) {
      throw new Error(
        '邀请链接中的房间号无效。',
      );
    }

    this.inviteSecret =
      inviteSecret;
    this.peerServer = signalServer || config.peerServer;

    const relayResult =
      await optionalRelayIce({
        encoded:
          relayValue,
        settings:
          details.relaySettings
          || { enabled: false },
      });

    this.assertOpen();
    const relay =
      relayResult.iceServers;

    this.controlIceServers = [
      ...P2P_ICE,
      ...relay,
    ];

    this.mediaIceServers =
      mediaIceServers(
        this.controlIceServers,
      );

    this.iceServers =
      this.controlIceServers;

    this.relayInvite =
      relayValue
      || (
        relay.length
          ? encodeRelayInvite(relay)
          : ''
      );

    await configureCampusSession(this, campusSecret);
    this.assertOpen();
    await this.openPeer(
      undefined,
      this.peerServer,
    );
    this.assertOpen();

    this.peer.on(
      'connection',
      connection => (
        connection.close()
      ),
    );

    await this.connectRemote();
    this.assertOpen();

    this.connected = true;

    const result =
      await this.request(
        'room:join',
        {
          roomId:
            this.roomId,
          nickname:
            details.nickname,
        },
      );

    this.assertOpen();
    if (!result.ok) {
      throw new Error(
        result.error,
      );
    }

    this.id =
      result.selfId;

    this.room =
      result.room;

    const connectionStats = await this.remote?.peerConnection?.getStats().catch(() => null);
    this.assertOpen();
    return {
      ...result,
      roomConnection: connectionStats ? campusStatsRoute(connectionStats) : '路线检测中',
      campusSecret: this.campusSecret || '',
      iceServers:
        this.controlIceServers,
      controlIceServers:
        this.controlIceServers,
      mediaIceServers:
        this.mediaIceServers,
      relayInvite:
        this.relayInvite,
      inviteSecret:
        this.inviteSecret,
      peerServer:
        this.peerServer
        || '',
      turnUnavailable:
        relayResult.unavailable,
    };
  }

  async connectRemote(timeout) {
    try {
      return await this.connectRemoteAttempt(false, timeout);
    } catch (error) {
      this.assertOpen();
      if (!this.campusSecret || !window.roomcast?.startCampusNetwork || !error.campusRetryable) throw error;
      return this.connectRemoteAttempt(true, timeout);
    }
  }

  async connectRemoteAttempt(campus, timeout) {
    const authMode = 'invite';
    const campusRequest = campus ? await campusRequestProof(this) : undefined;
    this.assertOpen();

    const remote =
      this.peer.connect(
        `roomcast-v1-${this.roomId}`,
        {
          reliable: true,
          serialization: 'binary',
          metadata: {
            protocol:
              PEER_AUTH_PROTOCOL,
            authMode,
            ...(campusRequest ? { campusRequest } : {}),
          },
        },
      );

    this.remote = remote;
    if (campus) void prepareCampusConnection(this, remote.peerConnection);

    let ready;
    let rejectReady;

    const hostReady =
      new Promise(
        (resolve, reject) => {
          ready = resolve;
          rejectReady = reject;
        },
      );

    const peer =
      this.peer;

    let authChallenge = null;
    let authVerified = false;
    let authResponseSeen = false;
    const clientNonce = randomPeerAuthNonce();

    const failed = error => {
      recordFailure('join-connection', error, { pc: remote.peerConnection, campus });
      const stage = {
        createOffer: '发起连接',
        createAnswer: '回应连接',
        setLocalDescription: '准备连接',
        setRemoteDescription: '确认远端连接',
        addIceCandidate: '交换连接信息',
        prepareCampus: '准备备用连接',
      }[error?.roomcastOperation];
      const failure = new Error(
        error?.type === 'webrtc'
          ? `房间连接协商失败${stage ? `（${stage}）` : ''}，请重新加入。`
          : error?.message || error?.type || '房间连接已关闭',
        { cause: error },
      );
      if (error?.type) failure.type = error.type;
      rejectReady(failure);
    };

    const peerFailed = error => {
      if (error?.type === 'webrtc' && error.roomcastPeerConnection) {
        const pc = error.roomcastPeerConnection;
        if (pc !== remote.peerConnection || (pc.signalingState === 'closed' && error.roomcastOperation !== 'prepareCampus')) return;
        // A rejected candidate does not establish that every ICE path failed.
        // Keep waiting for this connection's final state or existing deadline.
        if (error.roomcastOperation === 'addIceCandidate') return;
      }
      failed(error);
    };

    peer.on(
      'error',
      peerFailed,
    );

    remote.on(
      'error',
      failed,
    );

    remote.once(
      'close',
      failed,
    );

    remote.on(
      'data',
      data => {
        if (
          !data
          || typeof data
          !== 'object'
        ) {
          return;
        }

        if (
          data.authChallenge?.protocol
          === PEER_AUTH_PROTOCOL
          && data.authChallenge.mode
          === authMode
        ) {
          if (authChallenge || data.authChallenge.roomId !== this.roomId) { remote.close(); failed(new Error('P2P 鉴权挑战无效。')); return; }
          authChallenge = { protocol: PEER_AUTH_PROTOCOL, roomId: this.roomId, mode: authMode, nonce: data.authChallenge.nonce };
          const secret =
            this.inviteSecret;

          void createPeerAuthProof(
            secret,
            authChallenge,
          )
            .then(
              proof => {
                if (remote.open) {
                  remote.send({
                    authProof:
                      proof,
                    authNonce: clientNonce,
                  });
                }
              },
            )
            .catch(failed);
        }

        if (
          data.authenticated
          === true
        ) {
          if (authResponseSeen || authVerified) return;
          if (!authChallenge) { remote.close(); failed(new Error('P2P 鉴权状态无效。')); return; }
          authResponseSeen = true;
          void verifyPeerAuthProof(this.inviteSecret, { ...authChallenge, role: 'host', clientNonce }, data.hostProof)
            .then(valid => {
              if (!valid) { remote.close(); failed(new Error('P2P 房主鉴权失败。')); return; }
              if (!remote.open || this.closed) return;
              authVerified = true;
              ready();
            }).catch(failed);
          return;
        }

        if (!authVerified) return;
        if (this.remote !== remote) return;
        if (data.event === 'room:credential') { this.dispatch(data.event, data.data); return; }

        if (data.control) {
          void this.handleControl(
            data,
            remote,
          );
        }

        if (
          data.event
          && forwarded.includes(
            data.event,
          )
          && !this.migrating
        ) {
          this.dispatch(
            data.event,
            data.data,
          );
        }

        if (
          data.reply
          && this.pending.has(
            data.reply,
          )
        ) {
          this.pending
            .get(data.reply)(
              data.result,
            );

          this.pending.delete(
            data.reply,
          );
        }
      },
    );

    remote.on(
      'close',
      () => {
        // The successor stays in the old room until its host actually leaves.
        // A lost arm acknowledgement can therefore still be safely aborted.
        if (!this.closed && this.remote === remote && this.pendingMigrationCommit) {
          const payload = this.pendingMigrationCommit;
          this.pendingMigrationCommit = null;
          this.migrating = true;
          this.migrationCompletion = new Promise(resolve => { this.resolveMigration = resolve; });
          this.failPending();
          void this.finishMigration(payload).catch(error => this.disconnect(
            '房间迁移失败：' + error.message,
          ));
          return;
        }
        if (
          !this.closed
          && this.connected
          && !this.migrating
          && this.remote
          === remote
        ) {
          if (this.recoveryBackup) this.beginRecovery();
          else this.disconnect('房主连接已结束，尚未收到可恢复的房间状态。');
        }
      },
    );

    // Give ordinary ICE and authentication their full existing deadline.
    // PeerJS still rejects a definitive ICE failure immediately; merely having
    // a campus fallback must not cut a still-checking ordinary attempt short.
    try {
      await withTimeout(
        hostReady,
        timeout || (campus ? 220000 : PEER_AUTH_TOTAL_TIMEOUT_MS),
        '无法与房主建立 P2P 连接。',
      );
    } catch (error) {
      // A shorter recovery connection deadline is not an ordinary ICE failure.
      // Keep the existing fallback ordering; only a definitive failure may
      // accelerate the campus route during this recovery attempt.
      error.campusRetryable = (!timeout || error?.type === 'webrtc') && !authChallenge && !authVerified && !this.closed
        && !['peer-unavailable', 'network', 'server-error', 'socket-error', 'socket-closed'].includes(error.type || error.message);
      if (!this.connected && this.remote === remote) this.remote = null;
      remote.close();
      throw error;
    } finally {
      peer.off(
        'error',
        peerFailed,
      );

      remote.off(
        'error',
        failed,
      );

      remote.off(
        'close',
        failed,
      );
    }

    return remote;
  }

  refreshCachedRecovery(room) {
    const transfer = this.recoveryBackup?.transfer;
    if (!transfer || room?.id !== transfer.roomId) return;
    transfer.laserEnabled = room.laserEnabled !== false;
    const current = new Map(room.members.map(member => [member.id, member]));
    transfer.members = transfer.members.filter(member => current.has(member.id)).map(member => {
      const latest = current.get(member.id);
      return { ...member, role: latest.role === 'owner' ? member.role : latest.role,
        canShare: latest.canShare !== false, canLaser: latest.canLaser !== false };
    });
    transfer.successorIds = [...transfer.members].sort((left, right) =>
      Number(right.role === 'admin') - Number(left.role === 'admin') || left.joinedAt - right.joinedAt)
      .map(member => member.id);
  }

  scheduleRecoveryBackup(urgent = false) {
    if (this.closed || !this.isHost || !this.local?.connected) return;
    this.backupDirty = true;
    this.backupUrgent ||= urgent;
    if (urgent && this.backupTimer) { clearTimeout(this.backupTimer); this.backupTimer = null; }
    if (this.backupTimer || this.backupBusy) return;
    this.backupTimer = setTimeout(() => {
      this.backupTimer = null;
      void this.sendRecoveryBackup();
    }, this.backupUrgent ? 0 : Math.max(80, 500 - (performance.now() - this.lastBackupAt)));
  }

  async sendRecoveryBackup() {
    if (this.closed || !this.isHost || !this.local?.connected || !this.guestMembers.size) return;
    this.backupBusy = true;
    this.backupDirty = false;
    this.backupUrgent = false;
    this.lastBackupAt = performance.now();
    const exportSecret = this.inviteSecret;
    const exportMembers = recoveryMemberKey(this.room);
    try {
      const result = await ack(this.local, 'room:recovery-export', {}, 3000);
      if (!result.ok || this.closed || !this.isHost) return;
      if (exportSecret !== this.inviteSecret || exportMembers !== recoveryMemberKey(this.room)) {
        this.backupDirty = true;
        this.backupUrgent = true;
        return;
      }
      for (const [memberId, connection] of this.guestMembers) {
        if (!connection.open || !result.tickets[memberId]) continue;
        if (Number(connection.dataChannel?.bufferedAmount || 0) > 64 * 1024 || connection.bufferSize > 0) {
          this.backupDirty = true;
          continue;
        }
        connection.send({ control: 'recovery:backup', payload: {
          transfer: result.transfer, ticket: result.tickets[memberId], inviteSecret: exportSecret,
        } });
      }
    } catch {
      // Backup failure never freezes the live room or delays local exit.
    } finally {
      this.backupBusy = false;
      if (this.backupDirty) this.scheduleRecoveryBackup();
    }
  }

  beginRecovery() {
    if (this.closed || this.recoveryPromise || !this.recoveryBackup) return;
    const backup = this.recoveryBackup;
    this.migrating = true;
    this.migrationCompletion = new Promise(resolve => { this.resolveMigration = resolve; });
    this.failPending();
    const pending = this.recoverRoom(backup);
    this.recoveryPromise = pending;
    void pending.catch(error => {
      if (!this.closed) this.disconnect(`房间接任失败：${error.message}`);
    }).finally(() => {
      if (this.recoveryPromise === pending) this.recoveryPromise = null;
    });
  }

  async recoverRoom(backup) {
    const rank = backup.transfer.successorIds.indexOf(this.id);
    const deadline = performance.now() + 45_000;
    // All surviving members have the same ordered candidate list. A slow or
    // unavailable administrator must not prevent the following member taking over.
    await pause(250 + Math.max(0, rank) * 900);
    let lastError;
    let mayClaim = rank >= 0;
    while (!this.closed && performance.now() < deadline) {
      let candidate = null;
      let local = null;
      const arrivals = new Set();
      const queueArrival = connection => {
        if (this.closed || arrivals.size >= MAX_UNAUTHENTICATED_PEERS) connection.close();
        else arrivals.add(connection);
      };
      try {
        if (mayClaim) {
          candidate = await this.openPeer(`roomcast-v1-${this.roomId}`, this.peerServer, { adopt: false, timeout: 5000 });
          this.recoveryCandidate = candidate;
          candidate.on('connection', queueArrival);
          this.assertOpen();
          local = await this.localSocket();
          if (this.closed) { local.disconnect(); this.assertOpen(); }
          const result = await ack(local, 'room:migration-create', {
            transfer: backup.transfer, ticket: backup.ticket, memberId: this.id,
          });
          if (!result.ok) throw new Error(result.error || '无法恢复房间状态。');
          // Once consumed by a local import, this ticket may only follow another
          // winner if startup fails; do not replay the same authority token.
          mayClaim = false;
          this.assertOpen();
          if (candidate.destroyed || candidate.disconnected) throw new Error('接任信令已断开。');
          const committed = await ack(local, 'room:migration-commit');
          if (!committed.ok) throw new Error(committed.error || '无法启用恢复房间。');
          this.assertOpen();
          this.local = local;
          local = null;
          const previousPeer = this.peer;
          this.peer = candidate;
          this.recoveryCandidate = null;
          candidate = null;
          previousPeer?.destroy();
          this.isHost = true;
          this.connected = true;
          this.migrating = false;
          this.recoveryBackup = null;
          this.ownerToken = result.ownerToken || '';
          this.room = result.room;
          for (const event of forwarded) this.local.on(event, data => this.dispatch(event, data));
          this.local.on('disconnect', () => { if (!this.closed) this.disconnect('本机房间服务已断开'); });
          this.peer.off('connection', queueArrival);
          this.peer.on('connection', connection => { void this.accept(connection); });
          for (const connection of arrivals) void this.accept(connection);
          arrivals.clear();
          this.resolveMigration?.();
          this.dispatch('room:resumed', result);
          return;
        }
      } catch (error) {
        lastError = error;
      } finally {
        for (const connection of arrivals) connection.close();
        candidate?.destroy();
        this.recoveryCandidate = null;
        if (local) {
          // Closing this temporary trusted socket drops any incomplete import.
          local.removeAllListeners?.();
          local.disconnect();
        }
      }
      if (this.closed) return;
      try {
        if (!this.peer || this.peer.destroyed || this.peer.disconnected) {
          this.peer?.destroy();
          await this.openPeer(undefined, this.peerServer, { timeout: 5000 });
        }
        await this.connectRemote(Math.min(PEER_AUTH_TOTAL_TIMEOUT_MS, Math.max(1000, deadline - performance.now())));
        if (this.closed) return;
        const result = await this.request('room:join', { roomId: this.roomId, ticket: backup.ticket });
        if (!result.ok) throw new Error(result.error || '新房主尚未完成接任。');
        this.assertOpen();
        this.id = result.selfId;
        this.room = result.room;
        this.connected = true;
        this.migrating = false;
        this.recoveryBackup = null;
        this.resolveMigration?.();
        this.dispatch('room:resumed', result);
        void this.request('room:migration-confirm').catch(() => {});
        return;
      } catch (error) {
        lastError = error;
        this.remote?.close();
      }
      await pause(500 + Math.floor(Math.random() * 200));
    }
    if (!this.closed) throw lastError || new Error('没有可连接的接任成员。');
  }

  async sendControl(
    connection,
    control,
    payload,
    timeout = 8000,
  ) {
    if (this.closed || !connection?.open) throw new Error('P2P 连接已结束');
    if (this.controlPending.size >= 64 || (connection.dataChannel?.bufferedAmount || 0) > 1024 * 1024) {
      recordLifecycle('control', 'rejected');
      throw new Error('房间协调请求积压，请稍后再试。');
    }
    const id =
      crypto.randomUUID();
    const started = performance.now();
    recordLifecycle('control', 'started');

    return withTimeout(
      new Promise(
        (resolve, reject) => {
          this.controlPending
            .set(id, { connection, resolve, reject, started });

          connection.send({
            control,
            controlId: id,
            payload,
          });
        },
      ),
      timeout,
      '房间协调器迁移响应超时',
    ).catch(error => {
      recordLifecycle('control', 'failed', performance.now() - started);
      throw error;
    }).finally(
      () => (
        this.controlPending
          .delete(id)
      ),
    );
  }

  finishControlReply(connection, message) {
    const id = message?.controlReply;
    if (typeof id !== 'string' || id.length > 96) return;
    const pending = this.controlPending.get(id);
    if (!pending || pending.connection !== connection) return;
    const result = message.result;
    if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.ok !== 'boolean') return;
    try { if (JSON.stringify(message).length > 65536) return; } catch { return; }
    this.controlPending.delete(id);
    recordLifecycle('control', 'completed', performance.now() - pending.started);
    pending.resolve(result);
  }

  failControlPending(connection = null) {
    for (const [id, pending] of this.controlPending) {
      if (connection && pending.connection !== connection) continue;
      this.controlPending.delete(id);
      pending.reject(new Error('P2P 连接已结束'));
    }
  }

  failPending(
    reason = '房间协调器正在切换',
  ) {
    for (
      const resolve
      of this.pending.values()
    ) {
      resolve({
        ok: false,
        error: reason,
      });
    }

    for (
      const resolve
      of this.screenPending.values()
    ) {
      resolve({
        kind: 'error',
        error: reason,
      });
    }

    this.pending.clear();
    this.screenPending.clear();
  }

  async abortPreparedMigration() {
    this.pendingMigrationCommit = null;
    if (
      !this.preparedMigration
      || !this.local
    ) {
      return;
    }

    await ack(
      this.local,
      'room:migration-abort',
    ).catch(() => { });

    this.local
      .removeAllListeners?.();

    this.local.disconnect();

    this.local = null;
    this.preparedMigration = null;
    this.ownerToken = '';
  }

  async handleControl(
    message,
    connection,
  ) {
    if (message.control === 'recovery:backup') {
      const payload = message.payload || {};
      const transfer = payload.transfer;
      if (connection !== this.remote || this.isHost || this.closed
        || transfer?.version !== 3 || transfer.roomId !== this.roomId
        || !/^[a-f0-9]{64}$/.test(transfer.epoch || '')
        || !Number.isSafeInteger(transfer.revision) || transfer.revision < 0
        || !Array.isArray(transfer.members) || transfer.members.length > 9
        || !Array.isArray(transfer.successorIds) || !transfer.successorIds.includes(this.id)
        || !transfer.members.some(member => member.id === this.id)
        || !INVITE_SECRET.test(payload.ticket || '')
        || payload.inviteSecret !== this.inviteSecret) return;
      try { if (new TextEncoder().encode(JSON.stringify(transfer)).length > 48 * 1024) return; } catch { return; }
      const previous = this.recoveryBackup?.transfer;
      if (previous?.epoch === transfer.epoch && previous.revision > transfer.revision) return;
      this.recoveryBackup = payload;
      this.refreshCachedRecovery(this.room);
      return;
    }
    const reply =
      result => {
        if (
          connection.open
          && message.controlId
        ) {
          connection.send({
            controlReply:
              message.controlId,
            result,
          });
        }
      };

    if (message.control === 'migration:probe') {
      reply({ ok: !this.closed && !this.migrating });
      return;
    }

    if (
      message.control
      === 'migration:prepare'
    ) {
      const preparation = {};
      this.migrationPreparation = preparation;
      let preparingLocal = null;

      try {
        const {
          transfer,
          ticket,
          inviteSecret,
        } = message.payload || {};

        if (
          !transfer
          || transfer.roomId
          !== this.roomId
          || !transfer.members
            ?.find(
              candidate => (
                candidate.id
                === this.id
                && candidate.role
                === 'owner'
              ),
            )
        ) {
          throw new Error(
            '房间迁移数据与当前成员不匹配。',
          );
        }

        if (
          !INVITE_SECRET.test(
            inviteSecret || '',
          )
        ) {
          throw new Error(
            '迁移邀请密钥无效。',
          );
        }

        this.inviteSecret =
          inviteSecret;

        preparingLocal =
          await this.localSocket();

        const local =
          preparingLocal;

        for (
          const event
          of forwarded
        ) {
          local.on(
            event,
            data => {
              if (
                this.isHost
                && (!this.migrating
                  || event !== 'room:state')
              ) {
                this.dispatch(
                  event,
                  data,
                );
              }
            },
          );
        }

        local.on(
          'disconnect',
          () => {
            if (
              !this.closed
              && this.isHost
            ) {
              this.disconnect(
                '本机房间服务已断开',
              );
            }
          },
        );

        const result =
          await ack(
            local,
            'room:migration-create',
            {
              transfer,
              ticket,
              memberId:
                this.id,
            },
          );

        if (!result.ok) {
          throw new Error(
            result.error,
          );
        }

        if (this.closed || this.migrationPreparation !== preparation) {
          await ack(local, 'room:migration-abort').catch(() => { });
          throw new Error('房间迁移准备已取消。');
        }

        this.local =
          local;

        preparingLocal =
          null;

        this.preparedMigration =
          result;

        this.ownerToken =
          result.ownerToken || '';

        reply({
          ok: true,
        });
      } catch (error) {
        await this
          .abortPreparedMigration();

        if (preparingLocal) {
          preparingLocal
            .removeAllListeners?.();

          preparingLocal
            .disconnect();

          preparingLocal =
            null;
        }

        this.local = null;
        this.preparedMigration =
          null;

        reply({
          ok: false,
          error:
            error.message,
        });
      }

      return;
    }

    if (
      message.control
      === 'migration:abort'
    ) {
      this.migrationPreparation = null;
      await this
        .abortPreparedMigration();

      reply({
        ok: true,
      });

      return;
    }

    if (message.control === 'migration:arm') {
      const payload = message.payload || {};
      if (payload.roomId !== this.roomId || payload.successorId !== this.id
        || !INVITE_SECRET.test(payload.ticket || '')
        || !INVITE_SECRET.test(payload.inviteSecret || '')
        || !this.preparedMigration || !this.local?.connected || this.closed) {
        reply({ ok: false, error: '新协调器没有完成本机恢复。' });
        return;
      }
      this.pendingMigrationCommit = payload;
      reply({ ok: true, armed: true });
      return;
    }

    if (
      message.control
      === 'migration:commit'
    ) {
      const payload =
        message.payload || {};

      if (
        payload.roomId
        !== this.roomId
        || !INVITE_SECRET.test(
          payload.ticket || '',
        )
      ) {
        reply({
          ok: false,
          error:
            '迁移票据无效。',
        });

        return;
      }

      this.migrating = true;

      this.migrationCompletion =
        new Promise(
          resolve => {
            this.resolveMigration =
              resolve;
          },
        );

      this.failPending();

      reply({
        ok: true,
      });

      const timer =
        setTimeout(
          () => {
            this.delayedTimers
              .delete(timer);

            void this
              .finishMigration(
                payload,
              )
              .catch(
                error => (
                  this.disconnect(
                    `房间迁移失败：${error.message}`,
                  )
                ),
              );
          },
          this.id === payload.successorId ? 120
            : 400 + Math.min(8, Math.max(0, Number(payload.reconnectSlot) || 0)) * 180
              + Math.floor(Math.random() * 150),
        );

      this.delayedTimers
        .add(timer);
    }
  }

  async finishMigration({
    successorId,
    ticket,
    inviteSecret,
  }) {
    if (this.closed) return;

    if (
      !INVITE_SECRET.test(
        inviteSecret || '',
      )
    ) {
      throw new Error(
        '迁移邀请密钥无效。',
      );
    }

    this.inviteSecret =
      inviteSecret;

    this.remote?.close();

    if (
      this.id
      === successorId
    ) {
      if (
        !this.preparedMigration
        || !this.local?.connected
      ) {
        throw new Error(
          '新协调器没有完成本机恢复。',
        );
      }

      const committed =
        await ack(
          this.local,
          'room:migration-commit',
        );

      if (!committed?.ok) {
        throw new Error(
          committed?.error
          || '新协调器无法提交迁移。',
        );
      }

      this.peer?.destroy();

      let lastError;

      for (
        let attempt = 0;
        attempt < 8
        && !this.closed;
        attempt += 1
      ) {
        try {
          await this.openPeer(
            `roomcast-v1-${this.roomId}`,
            this.peerServer,
          );

          lastError = null;
          break;
        } catch (error) {
          lastError = error;

          this.peer?.destroy();

          await pause(
            250
            + attempt * 150,
          );
        }
      }

      if (lastError) {
        throw lastError;
      }

      this.peer.on(
        'connection',
        connection => (
          this.accept(connection)
        ),
      );

      this.isHost = true;
      this.connected = true;
      this.migrating = false;

      this.ownerToken =
        this.preparedMigration
          .ownerToken
        || '';

      this.resolveMigration?.();

      this.room =
        this.preparedMigration.room;

      this.dispatch(
        'room:resumed',
        this.preparedMigration,
      );

      this.preparedMigration =
        null;

      return;
    }

    let lastError;

    for (
      let attempt = 0;
      attempt < 12
      && !this.closed;
      attempt += 1
    ) {
      try {
        await this.connectRemote();

        this.connected = true;

        const result =
          await this.request(
            'room:join',
            {
              roomId:
                this.roomId,
              ticket,
            },
          );

        if (!result.ok) {
          throw new Error(
            result.error,
          );
        }

        this.id =
          result.selfId;

        this.room =
          result.room;

        this.migrating =
          false;

        this.resolveMigration?.();

        this.dispatch(
          'room:resumed',
          result,
        );

        return;
      } catch (error) {
        lastError = error;

        this.remote?.close();

        await pause(
          250
          + attempt * 150 + Math.floor(Math.random() * 250),
        );
      }
    }

    throw lastError
    || new Error(
      '无法连接新的房间协调器。',
    );
  }

  async leave() {
    // Room recovery is pre-copied to the remaining members. Local departure must
    // never depend on remote acknowledgements or coordinator reachability.
    this.disconnect();
    return { ok: true };
  }

  async accept(connection) {
    const metadata =
      connection.metadata
        && typeof connection.metadata
        === 'object'
        ? connection.metadata
        : {};

    const authMode =
      metadata.protocol
        === PEER_AUTH_PROTOCOL
        && metadata.authMode
        === 'invite'
        ? 'invite'
        : '';

    const authSecret =
      this.inviteSecret;

    if (
      this.closed
      || this.guests.size >= 9
      || this.unauthenticated.size
      >= MAX_UNAUTHENTICATED_PEERS
      || !authMode
      || !authSecret
      || (!metadata.campusRequest && [...this.unauthenticated].some(peer => peer.peer && peer.peer === connection.peer))
      || (this.authFailures.get(connection.peer) || 0) > Date.now()
    ) {
      connection.close();
      return;
    }

    this.unauthenticated
      .add(connection);

    const campus = !!metadata.campusRequest;
    if (campus) {
      const pc = connection.peerConnection;
      pc.roomcastCampus = true;
      pc.roomcastCampusPreparation = verifyCampusRequest(this, connection.peer, metadata.campusRequest).then(valid => {
        if (!valid || this.closed || pc.signalingState === 'closed') throw new Error('EasyTier 备用请求无效。');
        return prepareCampusConnection(this, pc);
      }).catch(error => { connection.close(); throw error; });
      pc.roomcastCampusPreparation.catch(() => {});
    }

    let socket;
    let closed = false;
    let authenticated = false;
    let authStarted = false;
    let memberId = '';

    let windowStarted =
      performance.now();

    let requests = 0;
    let imageWindowStarted = windowStarted;
    let imageRequests = 0;
    const blockedImages = new Set();
    let laserWindowStarted = windowStarted;
    let laserRequests = 0;

    let timeout;
    let authReceive;
    let rejectAuth;

    const cleanup = () => {
      if (closed) return;

      closed = true;
      this.failControlPending(connection);

      clearTimeout(timeout);
      if (authReceive) connection.off('data', authReceive);
      rejectAuth?.(new Error('P2P 连接已关闭。'));

      try { socket?.disconnect(); } catch { }

      this.unauthenticated
        .delete(connection);

      this.guests
        .delete(connection);

      if (
        memberId
        && this.guestMembers
          .get(memberId)
        === connection
      ) {
        this.guestMembers
          .delete(memberId);
      }
    };

    // A frozen/background web guest can keep its data channel alive without
    // answering JavaScript probes. Only transport close/error removes it.
    connection.on(
      'close',
      cleanup,
    );

    connection.on(
      'error',
      cleanup,
    );

    try {
      // ICE/data-channel setup has its own deadline. Authentication starts
      // only after a challenge can actually be delivered to the viewer.
      if (!connection.open) {
        await new Promise((resolve, reject) => {
          const finish = error => {
            clearTimeout(timeout);
            connection.off('open', opened);
            connection.off('close', ended);
            connection.off('error', ended);
            if (error) reject(error); else resolve();
          };
          const opened = () => finish();
          const ended = () => finish(new Error('P2P 连接已关闭。'));
          connection.once('open', opened);
          connection.once('close', ended);
          connection.once('error', ended);
          timeout = setTimeout(() => finish(new Error('P2P 连接建立超时。')), campus ? 115000 : PEER_AUTH_ICE_TIMEOUT_MS);
        });
      }
      if (closed || !connection.open) return;
      authStarted = true;
      timeout = setTimeout(() => {
        if (!authenticated) connection.close();
      }, PEER_AUTH_TIMEOUT_MS);

      const challenge = {
        protocol:
          PEER_AUTH_PROTOCOL,
        roomId:
          this.roomId,
        mode:
          authMode,
        nonce:
          randomPeerAuthNonce(),
      };

      let authMessages = 0;

      const proof =
        await withTimeout(
          new Promise(
            (resolve, reject) => {
              rejectAuth = reject;
              const receive =
                message => {
                  authMessages += 1;

                  let size = 0;

                  try {
                    size =
                      JSON.stringify(
                        message,
                      ).length;
                  } catch {
                    reject(
                      new Error(
                        'P2P 鉴权消息无效。',
                      ),
                    );

                    return;
                  }

                  if (
                    authMessages > 4
                    || size > 1024
                    || typeof message?.authProof
                    !== 'string'
                  ) {
                    reject(
                      new Error(
                        'P2P 鉴权消息无效。',
                      ),
                    );

                    return;
                  }

                  resolve(message);
                };

              authReceive = receive;
              connection.once(
                'data',
                receive,
              );

              const sendChallenge =
                () => {
                  if (
                    !closed
                    && connection.open
                  ) {
                    connection.send({
                      authChallenge:
                        challenge,
                    });
                  }
                };

              if (connection.open) {
                sendChallenge();
              } else {
                connection.once(
                  'open',
                  sendChallenge,
                );
              }
            },
          ),
          PEER_AUTH_TIMEOUT_MS,
          'P2P 鉴权超时。',
        );

      if (
        !await verifyPeerAuthProof(
          authSecret,
          challenge,
          proof.authProof,
        )
      ) {
        throw new Error(
          'P2P 鉴权失败。',
        );
      }

      if (this.inviteSecret !== authSecret) throw new Error('P2P 邀请已失效。');
      const hostProof = proof.authNonce
        ? await createPeerAuthProof(authSecret, { ...challenge, role: 'host', clientNonce: proof.authNonce })
        : undefined;
      if (closed || this.inviteSecret !== authSecret) throw new Error('P2P 邀请已失效。');

      if (
        this.guests.size >= 9
      ) {
        throw new Error(
          'P2P 房间已满。',
        );
      }

      if (closed || !connection.open) return;
      authenticated = true;

      clearTimeout(timeout);

      // Passing HMAC is not admission. Bound the gap until a successful join
      // so abandoned authenticated channels cannot reserve all nine slots.
      timeout = setTimeout(() => {
        cleanup();
        try { connection.close(); } catch { }
      }, 25_000);

      this.unauthenticated
        .delete(connection);

      this.guests
        .add(connection);

      socket =
        await this.localSocket();

      if (closed) {
        socket.disconnect();
        return;
      }

      socket.data = {
        admitted: false,
      };

      for (
        const event
        of forwarded
      ) {
        socket.on(
          event,
          data => {
            if (
              this.closed || !connection.open
            ) {
              return;
            }

            const messageId = data?.messageId;
            if (
              (event === 'image:chunk' || event === 'image:complete')
              && blockedImages.has(messageId)
            ) {
              if (event === 'image:complete') blockedImages.delete(messageId);
              return;
            }
            if (event === 'image:abort') blockedImages.delete(messageId);
            if (event === 'laser:stroke' && laserQueueBusy(connection)) return;

            if (
              event
              === 'image:chunk'
              && Number(
                connection
                  .dataChannel
                  ?.bufferedAmount
                || 0,
              ) > 1024 * 1024
            ) {
              blockedImages.add(messageId);
              connection.send({
                event: 'image:abort',
                data: { messageId },
              });
              return;
            }

            connection.send({
              event,
              data,
            });
          },
        );
      }

      connection.on(
        'data',
        async message => {
          if (socket.data.kicked || (!socket.data.admitted && this.inviteSecret !== authSecret)) { connection.close(); return; }
          if (message?.controlReply !== undefined) {
            this.finishControlReply(connection, message);
            return;
          }

          const imageChunk = message?.event === 'image:chunk';
          const binaryChunk = imageChunk && message.payload?.data;

          const binaryLength =
            binaryChunk instanceof ArrayBuffer
              ? binaryChunk.byteLength
              : ArrayBuffer.isView(
                binaryChunk,
              )
                ? binaryChunk.byteLength
                : 0;

          let serializedLength = 0;

          try {
            const serialized = JSON.stringify(
              binaryChunk
                ? { ...message, payload: { ...message.payload, data: undefined } }
                : message,
            );
            serializedLength = imageChunk
              ? new TextEncoder().encode(serialized).byteLength
              : serialized.length;
          } catch {
            connection.close();
            return;
          }

          const oversized =
            serializedLength > 65536
            || (
              binaryChunk && (
                binaryLength < 1
                || binaryLength
                > 48 * 1024
              )
            );

          const laser = message?.event === 'laser:stroke';
          if (laser) {
            // The existing room service remains authoritative for membership,
            // screen membership, permissions and coordinate validation. Laser
            // traffic has its own allowance and cannot consume control quota.
            if (!socket.data.admitted || closed || !socket.connected || oversized
                || serializedLength > LASER_MESSAGE_MAX_BYTES
                || (message.id !== undefined && (typeof message.id !== 'string' || message.id.length > 64))) return;
            const now = performance.now();
            if (now - laserWindowStarted >= 1_000) {
              laserWindowStarted = now;
              laserRequests = 0;
            }
            laserRequests += 1;
            if (laserRequests > LASER_PACKETS_PER_SECOND) return;
            if (message.id === undefined) {
              if (!laserQueueBusy(connection)) (socket.volatile || socket).emit('laser:stroke', message.payload);
              return;
            }
            // Old PR clients send ordinary RPC envelopes. Acknowledge these
            // without retaining pending requests in the host.
            try {
              const result = await ack(socket, 'laser:stroke', message.payload, 15_000);
              if (connection.open && !laserQueueBusy(connection)) connection.send({ reply: message.id, result });
            } catch { }
            return;
          }

          if (
            closed
            || !message
            || typeof message
            !== 'object'
            || oversized
            || typeof message.id
            !== 'string'
            || message.id.length
            > 64
          ) {
            connection.close();
            return;
          }

          const now =
            performance.now();

          if (message.event === 'image:chunk') {
            // A valid 10 MiB image needs 214 chunks. Keep its transport budget
            // separate from room control, matching the server's upload limit.
            if (now - imageWindowStarted > 60_000) {
              imageWindowStarted = now;
              imageRequests = 0;
            }
            imageRequests += 1;
            if (imageRequests > 1200) {
              connection.close();
              return;
            }
          } else {
            if (now - windowStarted > 10_000) {
              windowStarted = now;
              requests = 0;
            }
            requests += 1;
            if (requests > 160) {
              connection.close();
              return;
            }
          }

          let result;

          if (
            !allowed.has(
              message.event,
            )
            || (
              !socket.data.admitted
              && !beforeJoin.has(
                message.event,
              )
            )
          ) {
            result = {
              ok: false,
              error:
                '请先完成 room:join。',
            };
          } else if (
            message.event
            === 'room:join'
            && message.payload?.roomId
              !== this.roomId
          ) {
            result = {
              ok: false,
              error: '此邀请只能加入指定房间。',
            };
          } else {
            try {
              result = await ack(
                socket,
                message.event
                  === 'room:join'
                  && message.payload
                    ?.ticket
                  ? 'room:migration-join'
                  : message.event,
                imageChunk
                  ? {
                    uploadId: message.payload.uploadId,
                    index: message.payload.index,
                    data: binaryChunk,
                  }
                  : { ...(message.payload || {}) },
                15_000,
              );
            } catch (error) {
              result = {
                ok: false,
                error:
                  error.message,
              };
            }
          }

          if (
            beforeJoin.has(
              message.event,
            )
            && result.ok
          ) {
            if (closed || this.inviteSecret !== authSecret) { socket.disconnect(); connection.close(); return; }
            socket.data.admitted =
              true;

            clearTimeout(timeout);

            memberId =
              result.selfId;

            this.guestMembers
              .set(
                memberId,
                connection,
              );
            this.scheduleRecoveryBackup(true);
          }

          if (
            connection.open
          ) {
            connection.send({
              reply:
                message.id,
              result,
            });
          }
        },
      );

      if (
        connection.open
      ) {
        connection.send({
          authenticated: true,
          hostProof,
        });
      }
    } catch {
      if (authStarted && !authenticated && connection.peer) {
        this.authFailures.delete(connection.peer);
        this.authFailures.set(connection.peer, Date.now() + 3000);
        if (this.authFailures.size > 128) this.authFailures.delete(this.authFailures.keys().next().value);
      }
      cleanup();
      connection.close();
    }
  }

  async request(
    event,
    payload = {},
  ) {
    if (
      this.migrating
      && !(
        event === 'room:join'
        && payload.ticket
      )
    ) {
      await withTimeout(
        this.migrationCompletion,
        15000,
        '房间协调器尚未恢复',
      );
    }

    if (!this.connected) {
      throw new Error(
        '尚未连接 P2P 房间。',
      );
    }

    if (this.isHost) {
      try {
        return await ack(
          this.local,
          event,
          payload,
          15_000,
        );
      } catch (error) {
        return {
          ok: false,
          error:
            error.message,
        };
      }
    }

    const id =
      crypto.randomUUID();

    try {
      if (
        event
        === 'image:chunk'
      ) {
        await waitForDataQueue(
          this.remote,
        );
      }

      if (
        !this.remote?.open
      ) {
        throw new Error(
          this.migrating
            ? '房间协调器正在切换'
            : '房主连接已结束',
        );
      }

      return await withTimeout(
        new Promise(
          (resolve, reject) => {
            this.pending
              .set(
                id,
                resolve,
              );

            try {
              this.remote.send({
                id,
                event,
                payload,
              });
            } catch (error) {
              this.pending
                .delete(id);

              reject(error);
            }
          },
        ),
        15_000,
        '房主响应超时',
      );
    } finally {
      this.pending.delete(id);
    }
  }

  async screenSignal(message) {
    const {
      kind,
      requestId,
      from,
    } = message;

    if (
      kind === 'vdo-descriptor'
      || kind === 'vdo-error'
    ) {
      const pending =
        this.vdoPending
          .get(requestId);

      if (
        pending?.owner
        === from
      ) {
        pending.resolve(message);
      }

      return;
    }

    if (kind === 'candidate') {
      const entry =
        message.side
          === 'viewer'
          ? [
            ...this.screenSessions.values(),
          ].find(
            value => (
              value.requestId
              === requestId
              && value.owner
              === from
            ),
          )
          : this.screenViewers
            .get(requestId);

      if (
        !entry
        || (
          message.side
          === 'publisher'
          && entry.owner
          !== from
        )
      ) {
        return;
      }

      if (
        entry.pc
          .remoteDescription
      ) {
        await entry.pc
          .addIceCandidate(
            message.candidate
            ?? null,
          )
          .catch(() => { });
      } else {
        entry.candidates.push(
          message.candidate,
        );
      }

      return;
    }

    if (
      kind === 'answer'
      || kind === 'error'
    ) {
      if (
        this.screenViewers
          .get(requestId)
          ?.owner
        === from
      ) {
        if (
          kind === 'answer'
        ) {
          this.screenViewers
            .get(requestId)
            .session =
            message.session;
        }

        this.screenPending
          .get(requestId)
          ?.(message);
        if (kind === 'error' && message.error === 'NATIVE_MEDIA_FALLBACK' && !this.screenPending.has(requestId)) {
          const viewer = this.screenViewers.get(requestId);
          viewer?.pc.close();
          // close() itself does not fire this event; let the existing media
          // recovery state machine select its normal congestion-aware path.
          viewer?.pc.dispatchEvent(new Event('connectionstatechange'));
        }
      } else if (
        kind === 'answer'
        && message.session
      ) {
        void this.closeScreen(
          from,
          message.session,
        ).catch(() => { });
      }

      return;
    }

    // The local room server already validates that the sender is an
    // authenticated member and that this host currently has a live stream.
    // Do not gate screen signaling on the cached room state here: the first
    // offer can arrive before that cache updates, which silently drops the
    // request and makes the first viewer connection attempt time out.


    if (
      kind === 'vdo-request'
    ) {
      try {
        const descriptor =
          await this.getVdoDescriptor();

        await this.request(
          'screen:signal',
          {
            kind:
              'vdo-descriptor',
            requestId,
            to: from,
            vdo: descriptor,
          },
        );
      } catch (error) {
        await this.request(
          'screen:signal',
          {
            kind:
              'vdo-error',
            requestId,
            to: from,
            error:
              error?.message
              || 'VDO 备用连接暂不可用。',
          },
        ).catch(() => { });
      }

      return;
    }

    if (
      kind === 'close' || kind === 'cancel'
    ) {
      if (kind === 'cancel') {
        for (const [session, entry] of this.screenSessions) {
          if (entry.owner === from && entry.requestId === requestId) this.closeLocalScreen(from, session);
        }
        return;
      }
      this.closeLocalScreen(
        from,
        message.session,
      );

      return;
    }

    if (
      kind === 'offer'
    ) {
      try {
        const result =
          await this.answerScreen(
            from,
            message.sdp,
            requestId,
            message.route || 'p2p',
          );

        if (
          !this.connected
          || !this.screenStream?.active
        ) {
          this.closeLocalScreen(
            from,
            result.session,
          );

          return;
        }

        await this.request(
          'screen:signal',
          {
            kind: 'answer',
            requestId,
            to: from,
            ...result,
          },
        );
      } catch (error) {
        await this.request(
          'screen:signal',
          {
            kind: 'error',
            requestId,
            to: from,
            error:
              error.message,
          },
        ).catch(() => { });
      }
    }
  }

  setScreenStream(
    stream,
    settings = {},
  ) {
    this.stopScreenStream();

    this.screenStream =
      stream;

    this.screenSettings = {
      ...defaultScreenSettings,
      ...settings,
    };

    // Capture backends can return motion hints (OBS camera / canvas). Apply
    // the sharing preference before any sender or VDO clone is created.
    // Content type also selects Chromium's encoder/rate-control path. Treat
    // high-frame-rate sharing as interactive motion, while keeping the user's
    // resolution preference in RTP parameters. Forcing `detail` for 60 FPS
    // can accumulate a large motion burst in the pacer after an idle screen.
    const contentHint = this.screenSettings.sourceType === 'camera'
      || Number(this.screenSettings.fps) > 30
      || this.screenSettings.performanceMode === 'smooth' ? 'motion' : 'detail';
    for (const track of stream.getVideoTracks()) {
      if ('contentHint' in track) track.contentHint = contentHint;
    }

    this.nativeScreenPublisher = createNativeScreenPublisher(stream, this.screenSettings);
    this.nativeFallbackOwners = new Set();

    void this.startVdoPublisher(
      stream,
    ).catch(() => {
      // Native P2P sharing remains authoritative if VDO prewarm is unavailable.
    });
  }

  async startVdoPublisher(
    stream,
  ) {
    const generation =
      ++this.vdoPublisherGeneration;

    const task = (async () => {
      const {
        createVdoScreenPublisher,
      } = await import(
        './transports/vdo-screen-publisher.js'
      );

      if (
        generation
        !== this.vdoPublisherGeneration
        || this.screenStream
        !== stream
        || !stream?.active
      ) {
        throw new DOMException(
          '共享已变化。',
          'AbortError',
        );
      }

      const publisher =
        createVdoScreenPublisher(
          stream,
          {
            label:
              'Roomcast',
            quality: this.screenSettings,
          },
        );

      if (
        generation
        !== this.vdoPublisherGeneration
        || this.screenStream
        !== stream
      ) {
        await publisher
          .close()
          .catch(() => { });

        throw new DOMException(
          '共享已变化。',
          'AbortError',
        );
      }

      this.vdoPublisher =
        publisher;

      const descriptor =
        await publisher.ready;

      if (
        generation
        !== this.vdoPublisherGeneration
        || this.vdoPublisher
        !== publisher
        || this.screenStream
        !== stream
      ) {
        await publisher
          .close()
          .catch(() => { });

        throw new DOMException(
          '共享已变化。',
          'AbortError',
        );
      }

      return descriptor;
    })();

    this.vdoPublisherReady =
      task;

    try {
      await task;
    } catch (error) {
      if (
        generation
        === this.vdoPublisherGeneration
      ) {
        if (
          this.vdoPublisher
        ) {
          void this.vdoPublisher
            .close()
            .catch(() => { });
        }

        this.vdoPublisher =
          null;

        this.vdoPublisherReady =
          null;

        if (
          error?.name
          !== 'AbortError'
        ) {
          console.warn(
            '[Roomcast][VDO] Publisher unavailable; native P2P remains active:',
            error,
          );
        }
      }

      throw error;
    }
  }

  async getVdoDescriptor() {
    const pending =
      this.vdoPublisherReady;

    if (!pending) {
      throw new Error(
        'VDO Publisher 尚未就绪。',
      );
    }

    const descriptor =
      await withTimeout(
        pending,
        12_000,
        'VDO Publisher 响应超时。',
      );

    if (
      !descriptor
      || this.vdoPublisherReady
      !== pending
      || !this.screenStream?.active
    ) {
      throw new Error(
        'VDO Publisher 已失效。',
      );
    }

    return descriptor;
  }

  stopVdoPublisher() {
    this.vdoPublisherGeneration += 1;

    const publisher =
      this.vdoPublisher;

    this.vdoPublisher =
      null;

    this.vdoPublisherReady =
      null;

    if (publisher) {
      void publisher
        .close()
        .catch(error => {
          console.warn(
            '[Roomcast][VDO] Publisher cleanup failed:',
            error,
          );
        });
    }
  }

  stopScreenStream() {
    const release = callback => { try { callback(); } catch { } };
    release(() => { void this.nativeScreenPublisher?.close(); });
    this.nativeScreenPublisher = null;
    release(() => this.stopVdoPublisher());

    for (
      const entry
      of this.screenSessions.values()
    ) {
      release(() => entry.videoPolicy?.stop());
      clearTimeout(
        entry.calibrateTimer,
      );

      release(() => entry.pc?.close());
    }

    this.screenSessions.clear();

    for (
      const track
      of this.screenStream
        ?.getTracks()
      || []
    ) {
      release(() => track.stop());
    }

    release(() => this.screenStream?.roomcastCleanup?.());

    this.screenStream = null;
  }

  closeLocalScreen(
    owner,
    session,
  ) {
    const entry =
      this.screenSessions
        .get(session);

    if (
      !entry
      || entry.owner
      !== owner
    ) {
      return;
    }

    entry.videoPolicy?.stop();

    clearTimeout(
      entry.calibrateTimer,
    );

    entry.pc?.close();

    this.screenSessions
      .delete(session);
  }

  closeScreenOwner(owner) {
    for (
      const [
        session,
        entry,
      ]
      of this.screenSessions
    ) {
      if (
        entry.owner
        === owner
      ) {
        this.closeLocalScreen(
          owner,
          session,
        );
      }
    }

    for (
      const [
        requestId,
        pending,
      ]
      of this.vdoPending
    ) {
      if (
        pending.owner
        === owner
      ) {
        this.vdoPending
          .delete(requestId);

        pending.resolve({
          kind:
            'vdo-error',
          error:
            '共享者已离开房间。',
        });
      }
    }
  }

  async answerScreen(
    owner,
    sdp,
    requestId,
    route = 'p2p',
  ) {
    if (
      !this.screenStream
        ?.active
    ) {
      throw new Error(
        '共享画面已结束。',
      );
    }

    this.closeScreenOwner(owner);

    if (
      ![
        'p2p',
        'turn',
        'campus',
      ].includes(route)
    ) {
      throw new Error(
        '未知的屏幕媒体路线。',
      );
    }

    const relayOnly =
      route === 'turn' || route === 'campus';

    const routeIceServers =
      route === 'campus' ? [] : relayOnly
        ? turnIceServers(
          this.controlIceServers,
        )
        : this.mediaIceServers;

    if (
      route === 'turn'
      && !routeIceServers.length
    ) {
      throw new Error(
        'TURN 未启用或当前不可用。',
      );
    }

    if (route === 'p2p' && this.nativeScreenPublisher && !this.nativeFallbackOwners?.has(owner)) {
      const publisher = this.nativeScreenPublisher;
      const session = crypto.randomUUID();
      const entry = { owner, pc: { remoteDescription: null, close() {} }, requestId, route, candidates: [] };
      this.screenSessions.set(session, entry);
      try {
        const pc = await publisher.answer({
          id: session, offer: sdp, iceServers: routeIceServers,
          onPeer: value => {
            if (this.closed || this.nativeScreenPublisher !== publisher || this.screenSessions.get(session) !== entry) throw new Error('共享已取消。');
            entry.pc = value;
            for (const candidate of entry.candidates.splice(0)) void value.addIceCandidate(candidate);
          },
          onCandidate: ({ candidate }) => {
            if (this.connected && this.screenSessions.get(session) === entry) void this.request('screen:signal', {
              kind: 'candidate', side: 'publisher', requestId, to: owner, candidate: candidate?.toJSON() || null,
            }).catch(() => {});
          },
          onState: () => {
            if (entry.pc.connectionState === 'failed' && this.screenSessions.get(session) === entry) {
              this.nativeFallbackOwners?.add(owner);
              void this.request('screen:signal', { kind: 'error', requestId, to: owner, error: 'NATIVE_MEDIA_FALLBACK' }).catch(() => {});
              this.closeLocalScreen(owner, session);
            }
          },
        });
        if (this.screenSessions.get(session) !== entry) { pc.close(); throw new Error('共享已取消。'); }
        return { sdp: pc.localDescription.sdp, session };
      } catch (error) {
        this.closeLocalScreen(owner, session);
        if (this.closed || this.nativeScreenPublisher !== publisher || !this.screenStream?.active) throw error;
        this.nativeFallbackOwners?.add(owner);
        recordFailure('native-media', error);
        // Capability/negotiation failure uses the existing complete A/V path.
      }
    }

    const pc =
      createRoomcastPeerConnection({
        iceServers:
          routeIceServers,
        targetLatency:
          'lowest',
        ...(relayOnly
          ? {
            iceTransportPolicy:
              'relay',
          }
          : {}),
      });

    for (
      const track
      of this.screenStream
        .getTracks()
    ) {
      pc.addTrack(
        track,
        this.screenStream,
      );
    }

    const session =
      crypto.randomUUID();

    const entry = {
      owner,
      pc,
      requestId,
      route,
      candidates: [],
    };

    this.screenSessions
      .set(
        session,
        entry,
      );

    try {
      if (route === 'campus') await prepareCampusConnection(this, pc);
      if (this.closed || !this.screenStream?.active || this.screenSessions.get(session) !== entry) throw new Error('共享画面已结束。');
      await pc.setRemoteDescription({
        type: 'offer',
        sdp,
      });

      for (
        const candidate
        of entry.candidates
          .splice(0)
      ) {
        await pc
          .addIceCandidate(
            candidate ?? null,
          )
          .catch(() => { });
      }

      const answer =
        await pc.createAnswer();

      const targetBits =
        Math.max(
          0,
          Number(
            this.screenSettings
              .bitrate,
          ) || 0,
        ) * 1000;

      if (targetBits) {
        answer.sdp =
          lockVideoBitrate(
            answer.sdp,
            this.screenSettings
              .bitrate,
          );
      }

      pc.onicecandidate =
        ({ candidate }) => {
          if (
            this.connected
            && this.screenSessions
              .get(session)
            === entry
          ) {
            this.request(
              'screen:signal',
              {
                kind:
                  'candidate',
                side:
                  'publisher',
                requestId,
                to: owner,
                candidate:
                  candidate
                    ? candidate.toJSON()
                    : null,
              },
            ).catch(() => { });
          }
        };

      await pc.setLocalDescription(
        answer,
      );

      const quality =
        this.screenSettings;

      let videoSender;
      for (const sender of pc.getSenders()) {
        if (sender.track?.kind !== 'video') continue;
        videoSender = sender;
        await configureScreenVideoSender(sender, quality, route);
      }

      if (videoSender) {
        entry.videoPolicy = createP2pVideoPolicy({ pc, sender: videoSender, quality, route });
      }

      const calibrateResolution =
        async () => {
          if (
            !videoSender
            || pc.connectionState
            !== 'connected'
          ) {
            return;
          }

          const report =
            await videoSender
              .getStats();

          let outbound;

          report.forEach(
            item => {
              if (
                item.type
                === 'outbound-rtp'
                && item.kind
                === 'video'
                && item.frameWidth
              ) {
                outbound = item;
              }
            },
          );

          if (!outbound) {
            entry.calibrateTimer =
              setTimeout(
                calibrateResolution,
                350,
              );

            return;
          }

          const ratio =
            Math.max(
              outbound.frameWidth
              / quality.width,
              outbound.frameHeight
              / quality.height,
            );

          if (
            ratio <= 1.015
          ) {
            return;
          }

          const parameters =
            videoSender
              .getParameters();

          if (
            !parameters.encodings
              ?.length
          ) {
            return;
          }

          delete parameters
            .encodings[0]
            .scaleResolutionDownTo;

          parameters
            .encodings[0]
            .scaleResolutionDownBy =
            ratio;

          await videoSender
            .setParameters(
              parameters,
            )
            .catch(() => { });
        };

      pc.onconnectionstatechange =
        () => {
          if (
            pc.connectionState
            === 'connected'
          ) {
            entry.videoPolicy?.start();
            if (route === 'turn') entry.calibrateTimer =
              setTimeout(
                calibrateResolution,
                350,
              );
          }

          if (
            [
              'failed',
              'closed',
            ].includes(
              pc.connectionState,
            )
          ) {
            this.closeLocalScreen(
              owner,
              session,
            );
          }
        };

      if (pc.connectionState === 'connected') pc.onconnectionstatechange();

      return {
        sdp:
          pc.localDescription
            .sdp,
        session,
      };
    } catch (error) {
      this.closeLocalScreen(
        owner,
        session,
      );

      throw error;
    }
  }

  getTurnMediaIceServers() {
    return turnIceServers(
      this.controlIceServers,
    );
  }

  canUseCampus() {
    return !!this.campusSecret && !!window.roomcast?.startCampusNetwork && !this.closed;
  }

  async openScreen(
    owner,
    pc,
    {
      signal,
      route = 'p2p',
      onStage,
    } = {},
  ) {
    if (
      owner === this.id
    ) {
      throw new Error(
        '本机预览不得使用 P2P、ICE 或 TURN。',
      );
    }

    signal?.throwIfAborted();

    if (
      ![
        'p2p',
        'turn',
        'campus',
      ].includes(route)
    ) {
      throw new Error(
        '未知的屏幕媒体路线。',
      );
    }

    const requestId =
      crypto.randomUUID();

    const entry = {
      owner,
      pc,
      candidates: [],
      session: '',
    };

    this.screenViewers
      .set(
        requestId,
        entry,
      );

    let offerSent = false;
    let offerRequested = false;
    const outgoingCandidates = [];

    const sendCandidate =
      candidate => {
        if (
          this.connected
          && this.screenViewers
            .get(requestId)
          === entry
        ) {
          this.request(
            'screen:signal',
            {
              kind:
                'candidate',
              side:
                'viewer',
              requestId,
              to: owner,
              candidate,
            },
          ).catch(() => { });
        }
      };

    pc.onicecandidate =
      ({ candidate }) => {
        const value =
          candidate
            ? candidate.toJSON()
            : null;

        if (!offerSent) {
          outgoingCandidates
            .push(value);
        } else {
          sendCandidate(value);
        }
      };

    try {
      if (route === 'campus') {
        onStage?.('local');
        await withAbort(prepareCampusConnection(this, pc), signal);
      }
      onStage?.('answer');
      const offer =
        await withAbort(
          pc.createOffer(),
          signal,
        );

      await withAbort(
        pc.setLocalDescription(
          offer,
        ),
        signal,
      );

      const promise =
        new Promise(
          resolve => (
            this.screenPending
              .set(
                requestId,
                resolve,
              )
          ),
        );

      offerRequested = true;
      const offerRequest = this.request(
        'screen:signal',
        {
          kind: 'offer',
          requestId,
          to: owner,
          route,
          sdp: pc.localDescription.sdp,
        },
      );
      // The control channel is ordered. Dispatch the offer first, then trickle
      // candidates without waiting an extra control round trip for its ACK.
      offerSent = true;

      for (
        const candidate
        of outgoingCandidates
          .splice(0)
      ) {
        sendCandidate(
          candidate,
        );
      }

      const sent = await withAbort(offerRequest, signal);
      if (!sent.ok) throw new Error(sent.error);

      const result =
        await withTimeout(
          withAbort(
            promise,
            signal,
          ),
          route === 'campus' ? CAMPUS_ANSWER_TIMEOUT_MS : 12000,
          '共享者画面连接响应超时。',
        );

      if (
        result.kind
        === 'error'
      ) {
        throw new Error(
          result.error,
        );
      }

      entry.session =
        result.session;

      await withAbort(
        pc.setRemoteDescription({
          type: 'answer',
          sdp:
            result.sdp,
        }),
        signal,
      );

      for (
        const candidate
        of entry.candidates
          .splice(0)
      ) {
        await pc
          .addIceCandidate(
            candidate ?? null,
          )
          .catch(() => { });
      }

      signal?.throwIfAborted();

      onStage?.('ice');
      return result;
    } catch (error) {
      this.screenViewers
        .delete(requestId);

      if (offerRequested) void this.request('screen:signal', { kind: 'cancel', requestId, to: owner }).catch(() => {});

      pc.onicecandidate = null;

      if (entry.session) {
        void this.closeScreen(
          owner,
          entry.session,
        ).catch(() => { });
      }

      throw error;
    } finally {
      outgoingCandidates.length = 0;

      this.screenPending
        .delete(requestId);
    }
  }

  async requestVdoScreen(
    owner,
    { signal } = {},
  ) {
    if (
      owner === this.id
    ) {
      throw new Error(
        '本机预览不得使用 VDO。',
      );
    }

    signal?.throwIfAborted();

    const requestId =
      crypto.randomUUID();

    const promise =
      new Promise(resolve => {
        this.vdoPending.set(
          requestId,
          {
            owner,
            resolve,
          },
        );
      });

    try {
      const sent =
        await withAbort(
          this.request(
            'screen:signal',
            {
              kind:
                'vdo-request',
              requestId,
              to: owner,
            },
          ),
          signal,
        );

      if (!sent.ok) {
        throw new Error(
          sent.error,
        );
      }

      const result =
        await withTimeout(
          withAbort(
            promise,
            signal,
          ),
          12_000,
          'VDO 备用连接响应超时。',
        );

      if (
        result.kind
        === 'vdo-error'
      ) {
        throw new Error(
          result.error
          || 'VDO 备用连接不可用。',
        );
      }

      if (
        result.kind
        !== 'vdo-descriptor'
        || !result.vdo
      ) {
        throw new Error(
          'VDO 备用连接描述无效。',
        );
      }

      return result.vdo;
    } finally {
      this.vdoPending
        .delete(requestId);
    }
  }

  closeScreen(
    owner,
    session,
  ) {
    for (
      const [
        requestId,
        entry,
      ]
      of this.screenViewers
    ) {
      if (
        entry.owner === owner
        && entry.session
        === session
      ) {
        this.screenViewers
          .delete(requestId);
      }
    }

    if (
      owner === this.id
    ) {
      this.closeLocalScreen(
        owner,
        session,
      );

      return Promise.resolve({
        ok: true,
      });
    }

    return this.request(
      'screen:signal',
      {
        kind: 'close',
        requestId:
          crypto.randomUUID(),
        to: owner,
        session,
      },
    );
  }

  disconnect(
    reason = 'io client disconnect',
  ) {
    if (this.closed) return;

    this.closed = true;
    this.connected = false;
    this.pendingMigrationCommit = null;
    this.recoveryBackup = null;
    clearTimeout(this.backupTimer);
    this.backupTimer = null;
    try { this.recoveryCandidate?.destroy(); } catch {}
    this.recoveryCandidate = null;
    // Failure in one cleanup must not retain the other room connections.
    const release = callback => { try { callback(); } catch { } };
    release(() => stopCampusSession(this));

    this.resolveMigration?.();

    clearTimeout(
      this.peerReconnectTimer,
    );

    this.peerReconnectTimer =
      null;

    for (
      const timer
      of this.delayedTimers
    ) {
      clearTimeout(timer);
    }

    this.delayedTimers.clear();

    release(() => this.stopScreenStream());

    release(() => this.local?.removeAllListeners?.());
    release(() => this.local?.disconnect());
    release(() => { void Promise.resolve(this.browserService?.close()).catch(() => { }); });
    this.browserService = null;

    for (
      const guest
      of this.guests
    ) {
      release(() => guest.close());
    }

    for (
      const guest
      of this.unauthenticated
    ) {
      release(() => guest.close());
    }

    release(() => this.remote?.close());
    release(() => this.peer?.destroy());

    for (
      const resolve
      of this.pending.values()
    ) {
      resolve({
        ok: false,
        error:
          'P2P 连接已结束',
      });
    }

    for (
      const resolve
      of this.screenPending
        .values()
    ) {
      resolve({
        kind: 'error',
        error:
          'P2P 连接已结束',
      });
    }

    this.failControlPending();

    for (
      const pending
      of this.vdoPending
        .values()
    ) {
      pending.resolve({
        kind:
          'vdo-error',
        error:
          '房间连接已结束。',
      });
    }

    for (
      const entry
      of this.screenViewers
        .values()
    ) {
      release(() => entry.pc?.close());
    }

    this.pending.clear();
    this.controlPending.clear();
    this.screenPending.clear();
    this.vdoPending.clear();

    this.screenViewers.clear();
    this.guestMembers.clear();
    this.guests.clear();
    this.unauthenticated.clear();
    this.authFailures.clear();

    this.room = null;
    this.relayInvite = '';
    this.inviteSecret = '';

    this.controlIceServers = [];
    this.mediaIceServers = [];
    this.iceServers = [];

    this.dispatch(
      'disconnect',
      reason,
    );
  }
}
