import { configureScreenVideoSender, withScreenStartBitrate } from './video-sender-settings.js';
import { createBrowserRoomService } from './browser-room-service.js';
import { prepareNativeReceiveOffer } from './video-codec-policy.js';
import { createNativeScreenPublisher } from './transports/native-screen-publisher.js';
import { configureCampusSession, prepareCampusConnection, stopCampusSession, verifyCampusRequest, campusStatsRoute } from './campus-session.js';
import { installNativeControl } from './transports/native-room-control.js';
import { NativeScreenConnection } from './transports/native-screen-connection.js';
import { nativeAvailable } from './transports/native-endpoint.js';
import { Peer } from 'peerjs';
import { io } from 'socket.io-client';
import { createRoomcastPeerConnection, DEFAULT_STUN_ICE, mediaIceServers, turnIceServers } from './ice-policy.js';
import { ack, recordLifecycle } from './lib.js';
import { createPeerAuthProof, MAX_UNAUTHENTICATED_PEERS, PEER_AUTH_PROTOCOL, PEER_AUTH_TIMEOUT_MS, PEER_AUTH_ICE_TIMEOUT_MS, randomPeerAuthNonce, verifyPeerAuthProof } from './p2p-auth.js';
import { encodeRelayInvite, optionalRelayIce } from './relay.js';
import { createP2pVideoPolicy, p2pResolutionScale } from './p2p-video-policy.js';
import { CAMPUS_ANSWER_TIMEOUT_MS } from './fallback-policy.js';
import { createJoinTrace, recordFailure } from './lifecycle-diagnostics.js';
import { connectGuestControl, CONTROL_DISCONNECT_GRACE_MS, joinGuestRoom } from './guest-room-join.js';
import { withTimeout } from './room-operation.js';
import { enableControlNatPrediction, markControlAuthenticated, markControlFailure } from './control-nat-prediction.js';
import { enableEnhancedIce, setEnhancedIceRemote } from './enhanced-ice.js';
import { localNetworkCapabilities, negotiateNetwork } from './network-capabilities.js';

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
const lastBackupByConnection = new WeakMap();
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

const defaultScreenSettings = {
  width: 1920,
  height: 1080,
  fps: 30,
  bitrate: 4500,
  performanceMode: 'smooth',
};

function lockVideoBitrate(sdp, kbps, startAtTarget) {
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

        const limit = Math.round(bits / 1000);
        const controls = startAtTarget
          ? `x-google-start-bitrate=${limit};x-google-max-bitrate=${limit}`
          : `x-google-max-bitrate=${limit}`;

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
    this.idleScreenTracks = new Map();
    this.vdoPending = new Map();

    this.vdoPublisher = null;
    this.vdoPublisherReady = null;
    this.vdoPublisherGeneration = 0;

    this.screenStream = null;
    this.screenSettings = defaultScreenSettings;

    this.closed = false;
    this.guestJoinController = new AbortController();

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
      if (changed && this.screenStream?.active && (this.vdoPublisher || this.vdoPublisherReady)) {
        this.stopVdoPublisher();
        void this.startVdoPublisher(this.screenStream).catch(() => { });
      }
    }
    if (event === 'room:state') {
      this.refreshCachedRecovery(value);
      this.room = value;
      if (this.idleScreenTracks.size) {
        const viewers = value?.streams?.find(stream => stream.memberId === this.id)?.viewers;
        for (const owner of this.idleScreenTracks.keys()) {
          if (!viewers?.some(viewer => viewer.memberId === owner)) this.releaseIdleScreenTrack(owner);
        }
      }
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
      this.releaseIdleScreenTrack(value.memberId);
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
      // A joined page must be able to take over even if the static site goes offline.
      this.browserService ??= createBrowserRoomService();
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

  async openPeer(id, override, { adopt = true, timeout = 20000, signal } = {}) {
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
    installNativeControl(peer, this);

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
      signal,
    ); } catch (error) { peer.destroy(); throw error; }

    if (this.closed || signal?.aborted) { peer.destroy(); signal?.throwIfAborted(); this.assertOpen(); }
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

      await configureCampusSession(this, !window.roomcast?.physicalDirect && window.roomcast?.startCampusNetwork ? randomSecret() : '');
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
      this.nativeHost = parsed.searchParams.get('native') === '1';
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
      (!window.roomcast?.physicalDirect && relayValue)
      || (
        relay.length
          ? encodeRelayInvite(relay)
          : ''
      );

    await configureCampusSession(this, window.roomcast?.physicalDirect ? '' : campusSecret);
    this.assertOpen();
    const result = await joinGuestRoom(this, 'initial', { nickname: details.nickname });
    this.assertOpen();

    const connectionStats = await this.remote?.peerConnection?.getStats().catch(() => null);
    this.assertOpen();
    return {
      ...result,
      roomConnection: this.remote?.roomcastNative ? '原生直连' : connectionStats ? campusStatsRoute(connectionStats) : '路线检测中',
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

  connectRemote(timeout, trace, signal) {
    return connectGuestControl(this, timeout, trace, signal);
  }

  handleGuestData(remote, data) {
    if (this.closed || this.remote !== remote) return;
    if (data.event === 'room:credential') { this.dispatch(data.event, data.data); return; }
    if (data.control) void this.handleControl(data, remote);
    if (forwarded.includes(data.event) && !this.migrating) this.dispatch(data.event, data.data);

    const pending = this.pending.get(data.reply);
    if (pending) {
      this.pending.delete(data.reply);
      pending.reply?.(data.result);
      pending.resolve(data.result);
    }
  }

  handleGuestClose(remote, { transportLoss = false } = {}) {
    if (this.closed || this.departure || this.isHost || this.remote !== remote) return;
    // Only the old host closing its own connection commits an armed handover.
    if (this.pendingMigrationCommit) {
      if (transportLoss) return;
      const payload = this.pendingMigrationCommit;
      this.pendingMigrationCommit = null;
      this.migrating = true;
      this.migrationCompletion = new Promise(resolve => { this.resolveMigration = resolve; });
      this.failPending();
      void this.finishMigration(payload).catch(error => this.disconnect('房间迁移失败：' + error.message));
    } else if (this.connected && !this.migrating) {
      this.remote = null;
      if (transportLoss) {
        try { remote.close(); } catch { /* The old transport is already gone. */ }
      }
      if (this.recoveryBackup) this.beginRecovery(transportLoss);
      else this.disconnect('房主连接已结束，尚未收到可恢复的房间状态。');
    }
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

  async sendRecoveryBackup(departing = false) {
    if (this.closed || !this.isHost || !this.local?.connected || !this.guestMembers.size) return;
    this.backupBusy = true;
    this.backupDirty = false;
    this.backupUrgent = false;
    this.lastBackupAt = performance.now();
    const exportSecret = this.inviteSecret;
    const exportMembers = recoveryMemberKey(this.room);
    const recipients = new Map(this.guestMembers);
    try {
      const result = await ack(this.local, 'room:recovery-export', {}, 3000);
      if (!result.ok || this.closed || !this.isHost) return;
      if (exportSecret !== this.inviteSecret || exportMembers !== recoveryMemberKey(this.room)) {
        this.backupDirty = true;
        this.backupUrgent = true;
        return;
      }
      const notices = [];
      for (const [memberId, connection] of recipients) {
        if (this.guestMembers.get(memberId) !== connection) continue;
        if (!connection.open || !result.tickets[memberId]) continue;
        if (Number(connection.dataChannel?.bufferedAmount || 0) > 64 * 1024 || (!departing && connection.bufferSize > 0)) {
          this.backupDirty = true;
          continue;
        }
        const payload = { transfer: result.transfer, ticket: result.tickets[memberId], inviteSecret: exportSecret };
        if (departing) {
          notices.push(this.sendControl(connection, 'recovery:backup', { ...payload, departing: true }, 700));
        } else {
          connection.send({ control: 'recovery:backup', payload });
        }
      }
      await Promise.allSettled(notices);
    } catch {
      // Backup failure never freezes the live room or delays local exit.
    } finally {
      this.backupBusy = false;
      if (this.backupDirty) this.scheduleRecoveryBackup();
    }
  }

  beginRecovery(transportLoss = false) {
    if (this.closed || this.recoveryPromise || !this.recoveryBackup) return;
    recordLifecycle('room-recovery', 'started');
    this.confirmResumeOn = null;
    const backup = this.recoveryBackup;
    this.migrating = true;
    this.migrationCompletion = new Promise(resolve => { this.resolveMigration = resolve; });
    this.failPending();
    const pending = this.recoverRoom(backup, transportLoss);
    this.recoveryPromise = pending;
    void pending.catch(error => {
      if (!this.closed) this.disconnect(`房间接任失败：${error.message}`);
    }).finally(() => {
      if (this.recoveryPromise === pending) this.recoveryPromise = null;
    });
  }

  async recoverRoom(backup, transportLoss) {
    const rank = backup.transfer.successorIds.indexOf(this.id);
    const deadline = performance.now() + 45_000;
    await pause(250 + Math.max(0, rank) * 900);
    // Survivors can observe the same ICE loss seconds apart. Give the preferred
    // successor one grace period, then let the remaining candidates claim the ID.
    const preferredUntil = transportLoss && rank > 0 ? performance.now() + CONTROL_DISCONNECT_GRACE_MS : 0;
    let lastError;
    let mayClaim = rank >= 0;
    let following = null;
    while (!this.closed && performance.now() < deadline) {
      let candidate = null;
      let local = null;
      const arrivals = new Set();
      const deferClaim = mayClaim && performance.now() < preferredUntil;
      const queueArrival = connection => {
        if (this.closed || arrivals.size >= MAX_UNAUTHENTICATED_PEERS) connection.close();
        else arrivals.add(connection);
      };
      try {
        if (mayClaim && !deferClaim) {
          candidate = await this.openPeer(`roomcast-v1-${this.roomId}`, this.peerServer, { adopt: false, timeout: 5000 });
          this.recoveryCandidate = candidate;
          candidate.on('connection', queueArrival);
          this.assertOpen();
          if (following) {
            this.guestJoinController.abort();
            await following;
            following = null;
            this.remote?.close();
            this.remote = null;
            this.assertOpen();
          }
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
        // Rejoining the live host can proceed even while a higher-ranked member has first claim.
        following ??= joinGuestRoom(this, 'recovery', { ticket: backup.ticket }, deadline)
          .then(result => ({ result }), error => ({ error }));
        // A stale broker registration can outlast the old host's data channel.
        // Preserve one ongoing join while periodically checking if the room ID is free.
        const nextClaim = deferClaim ? preferredUntil - performance.now() : 1500;
        const outcome = mayClaim ? await Promise.race([following, pause(Math.max(0, nextClaim)).then(() => null)]) : await following;
        if (!outcome) continue;
        following = null;
        if (outcome.error) throw outcome.error;
        const { result } = outcome;
        this.assertOpen();
        this.connected = true;
        this.migrating = false;
        this.resolveMigration?.();
        this.dispatch('room:resumed', result);
        const fresh = this.recoveryBackup;
        const replacementReady = fresh && fresh.ticket !== backup.ticket && lastBackupByConnection.get(this.remote) === fresh;
        if (result.resumedHere && !replacementReady) {
          // Keep the presented ticket usable until the replacement snapshot reaches this channel.
          if (backup.inviteSecret === this.inviteSecret) this.recoveryBackup = backup;
          this.confirmResumeOn = { connection: this.remote, ticket: backup.ticket };
        } else {
          if (this.recoveryBackup === backup) this.recoveryBackup = null;
          void this.request('room:migration-confirm').catch(() => {});
        }
        return;
      } catch (error) {
        if (this.closed) return;
        lastError = error;
      }
      const retryDelay = deferClaim
        ? Math.max(0, preferredUntil - performance.now())
        : 500 + Math.floor(Math.random() * 200);
      await pause(retryDelay);
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
      const { resolve }
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
    const reply = result => {
      if (connection.open && message.controlId) connection.send({ controlReply: message.controlId, result });
    };
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
      lastBackupByConnection.set(connection, payload);
      if (!payload.departing) this.refreshCachedRecovery(this.room);
      if (payload.departing === true) {
        reply({ ok: true });
        this.beginRecovery();
        return;
      }
      if (this.confirmResumeOn?.connection === connection && this.confirmResumeOn.ticket !== payload.ticket) {
        this.confirmResumeOn = null;
        void this.request('room:migration-confirm').catch(() => {});
      }
      return;
    }
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
        const result = await joinGuestRoom(this, 'migration', { ticket });
        this.assertOpen();

        this.migrating =
          false;

        this.resolveMigration?.();

        this.dispatch(
          'room:resumed',
          result,
        );

        return;
      } catch (error) {
        if (this.closed || error.name === 'AbortError') return;
        lastError = error;

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
    if (!this.departure && this.connected) {
      // Give up the public ID while the authenticated data channels are still
      // open. An older/offline member must never hold the local exit open.
      let notice;
      if (this.isHost && this.guestMembers.size) {
        this.peer?.disconnect();
        notice = this.sendRecoveryBackup(true);
      } else if (!this.isHost && !this.migrating && this.remote?.open) {
        notice = this.request('room:leave');
      }
      this.departure = withTimeout(Promise.resolve(notice), 750, '退出通知超时').catch(() => {});
    }
    await this.departure;
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

    const campus = !!metadata.campusRequest;
    const route = connection.roomcastNative ? 'native' : campus ? 'campus' : 'ordinary';
    const trace = createJoinTrace('host', 'incoming', metadata.joinAttemptId);
    trace.mark('control', 'offer-received', route);

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
      || (!connection.roomcastNative && !metadata.campusRequest && [...this.unauthenticated].some(peer => peer.peer && peer.peer === connection.peer))
      || (this.authFailures.get(connection.peer) || 0) > Date.now()
    ) {
      trace.mark('control', this.closed ? 'cancelled' : 'rejected', route);
      connection.close();
      return;
    }

    this.unauthenticated
      .add(connection);

    if (route === 'ordinary') enableControlNatPrediction(connection.peerConnection, {
      role: 'host', channel: connection.dataChannel, joinAttemptId: trace.id,
    });
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
    let repliedToJoin = false;
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
    let repeatChallengeTimer;

    const cleanup = () => {
      if (closed) return;

      closed = true;
      if (!memberId && !repliedToJoin) {
        const stage = authenticated ? 'admission' : authStarted ? 'authentication' : 'control';
        trace.mark(stage, this.closed ? 'cancelled' : 'failed', route, 'closed');
      }
      this.failControlPending(connection);

      clearTimeout(timeout);
      clearTimeout(repeatChallengeTimer);
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
      trace.mark('control', 'channel-open', route);
      authStarted = true;
      timeout = setTimeout(() => {
        if (!authenticated) {
          trace.mark('authentication', 'failed', route, 'deadline');
          markControlFailure(connection.peerConnection);
          connection.close();
        }
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
                  clearTimeout(repeatChallengeTimer);
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
                    trace.mark('authentication', 'challenge', route);
                  }
                };

              sendChallenge();
              if (metadata.repeatChallenge === true) {
                repeatChallengeTimer = setTimeout(() => {
                  if (closed || !connection.open || authMessages) return;
                  try {
                    connection.send({ authChallenge: challenge });
                    trace.mark('authentication', 'challenge-repeated', route);
                  } catch (error) { reject(error); }
                }, PEER_AUTH_TIMEOUT_MS / 2);
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
      trace.mark('authentication', 'verified', route);
      setEnhancedIceRemote(connection.peerConnection, metadata.networkCapabilities);
      markControlAuthenticated(connection.peerConnection);

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
            serializedLength > (message?.event === 'member:profile' ? 220 * 1024 : 65536)
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

          const joining = message.event === 'room:join' && !socket.data.admitted;
          if (joining) trace.mark('admission', 'request-received', route);
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
            if (joining) {
              repliedToJoin = true;
              trace.mark('admission', 'reply-sent', route, result.ok ? 'accepted' : 'rejected');
            }
          }
        },
      );

      if (
        connection.open
      ) {
        connection.send({
          authenticated: true,
          networkCapabilities: localNetworkCapabilities(),
          hostProof,
        });
      }
    } catch {
      markControlFailure(connection.peerConnection, this.closed ? 'cancelled' : 'failed');
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
    delivery,
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
            this.pending.set(id, { resolve, reply: delivery?.reply });

            try {
              this.remote.send({
                id,
                event,
                payload,
              });
              delivery?.sent?.();
            } catch (error) {
              this.pending
                .delete(id);

              reject(error);
            }
          },
        ),
        15_000,
        '房主响应超时',
        delivery?.signal,
      );
    } finally {
      this.pending.delete(id);
    }
  }

  async checkScreenFrames(owner, session, signal, requestKeyFrame = false) {
    const requestId = crypto.randomUUID();
    let listener;
    const reply = new Promise(resolve => {
      listener = message => {
        if (message.kind === 'frame-status' && message.from === owner
          && message.session === session && message.requestId === requestId) resolve(message.expectsVideo === true);
      };
    });
    this.on('screen:signal', listener);
    try {
      const sent = this.request('screen:signal', { kind: 'frame-check', to: owner, session, requestId, requestKeyFrame }, { signal });
      return await withTimeout(sent.then(result => result.ok ? reply : null), 4000, '观看状态查询超时。', signal);
    } catch { return null; }
    finally { this.off('screen:signal', listener); }
  }

  async screenSignal(message) {
    const {
      kind,
      requestId,
      from,
    } = message;

    if (kind === 'frame-status') return; // Delivered to the scoped request listener by dispatch().
    if (kind === 'frame-check') {
      const entry = this.screenSessions.get(message.session);
      if (entry?.owner === from) {
        if (message.requestKeyFrame === true) entry.videoPolicy?.requestKeyFrame();
        void this.request('screen:signal', { kind: 'frame-status', to: from, requestId,
          session: message.session, expectsVideo: entry.videoPolicy?.expectsVideo() === true }).catch(() => {});
      }
      return;
    }

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
        && !entry.restarting
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
      const viewer = this.screenViewers.get(requestId);
      if (viewer?.owner === from) {
        if (kind === 'answer') {
          if (viewer.session && viewer.session !== message.session) return;
          if (!viewer.session) {
            viewer.session = message.session;
            viewer.onSession?.(message.session, message.publisherRelayed === true);
          }
        }

        this.screenPending
          .get(requestId)
          ?.(message);
        if (kind === 'error' && message.error === 'NATIVE_MEDIA_FALLBACK' && !this.screenPending.has(requestId)) {
          viewer.pc.close();
          // close() itself does not fire this event; let the existing media
          // recovery state machine select its normal congestion-aware path.
          viewer.pc.dispatchEvent(new Event('connectionstatechange'));
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
        // This describes the publisher's route to the coordinator only. Read
        // it alongside the direct negotiation without holding up its answer.
        let publisherRelayed = false;
        const coordinator = this.guestCoordinator(from);
        if (coordinator && !message.restart && message.route === 'p2p' && this.getTurnMediaIceServers().length) {
          void this.controlUsesTurnRelay(coordinator.id).then(relayed => { publisherRelayed = relayed; }).catch(() => {});
        }
        const result =
          message.restart === true
          ? await this.answerScreenRestart(from, message.sdp, requestId, message.session)
          : await this.answerScreen(
            from,
            message.sdp,
            requestId,
            message.route || 'p2p',
            message.networkCapabilities,
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

        const sent = await this.request(
          'screen:signal',
          {
            kind: 'answer',
            requestId,
            to: from,
            ...result,
            ...(publisherRelayed ? { publisherRelayed: true } : {}),
            networkCapabilities: result.networkCapabilities || localNetworkCapabilities(),
          },
        );
        if (sent.ok) this.screenSessions.get(result.session)?.onAnswerSent?.();
        else this.closeLocalScreen(from, result.session);
      } catch (error) {
        if (error?.name === 'AbortError') return;
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

    // VDO publisher is started lazily in getVdoDescriptor() only after a viewer enters the preview.
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
    if (window.roomcast?.physicalDirect) throw new Error('房主使用物理网卡直连。');
    if (!this.vdoPublisherReady && this.screenStream?.active) {
      void this.startVdoPublisher(this.screenStream).catch(() => { });
    }
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

    for (const [session, entry] of this.screenSessions) {
      this.closeLocalScreen(entry.owner, session);
    }
    for (const owner of this.idleScreenTracks.keys()) this.releaseIdleScreenTrack(owner);

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

    this.screenSessions.delete(session);
    clearTimeout(entry.calibrateTimer);
    clearTimeout(entry.restartWaitTimer);
    try { entry.videoPolicy?.stop(); } catch {}
    try { entry.pc?.close(); } catch {}
    if (entry.videoTrack) {
      const watching = this.room?.streams?.find(stream => stream.memberId === this.id)?.viewers
        ?.some(viewer => viewer.memberId === owner);
      if (watching && entry.videoTrack.readyState === 'live' && entry.videoTrack.enabled && this.screenStream?.active) {
        // A new PC for the same watch can reuse its capture track. The closed
        // PC owns the old encoder. Every other viewer keeps a separate track.
        this.releaseIdleScreenTrack(owner);
        const timer = setTimeout(() => this.releaseIdleScreenTrack(owner), 15000);
        this.idleScreenTracks.set(owner, { source: entry.videoSource, track: entry.videoTrack, timer });
      } else entry.videoTrack.stop();
    }
  }

  releaseIdleScreenTrack(owner) {
    const idle = this.idleScreenTracks.get(owner);
    if (!idle) return;
    this.idleScreenTracks.delete(owner);
    clearTimeout(idle.timer);
    idle.track.stop();
  }

  videoTrackForViewer(owner, source) {
    const idle = this.idleScreenTracks.get(owner);
    if (idle?.source === source && idle.track.readyState === 'live' && idle.track.enabled) {
      clearTimeout(idle.timer);
      this.idleScreenTracks.delete(owner);
      return idle.track;
    }
    this.releaseIdleScreenTrack(owner);
    return source.clone();
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

  waitForScreenReconnect(session, entry) {
    clearTimeout(entry.restartWaitTimer);
    entry.restartWaitTimer = setTimeout(() => {
      entry.restartWaitTimer = null;
      if (this.screenSessions.get(session) === entry && entry.pc.connectionState !== 'connected') {
        this.closeLocalScreen(entry.owner, session);
      }
    }, 15000);
  }

  async answerScreen(
    owner,
    sdp,
    requestId,
    route = 'p2p',
    remoteCapabilities = null,
  ) {
    if (
      !this.screenStream
        ?.active
    ) {
      throw new Error(
        '共享画面已结束。',
      );
    }

    if (
      ![
        'p2p',
        'turn',
        'campus',
        'native',
      ].includes(route)
    ) {
      throw new Error(
        '未知的屏幕媒体路线。',
      );
    }

    if (route === 'native' && (!nativeAvailable() || !negotiateNetwork(remoteCapabilities).features.nativeUdpMux)) {
      throw new Error('当前共享不支持原生媒体连接。');
    }
    this.closeScreenOwner(owner);
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

    const physicalMedia = route === 'p2p' && window.roomcast?.physicalDirect === true;
    if (route === 'p2p' && !physicalMedia && this.nativeScreenPublisher && !this.nativeFallbackOwners?.has(owner)) {
      const publisher = this.nativeScreenPublisher;
      const session = crypto.randomUUID();
      const entry = { owner, pc: { remoteDescription: null, close() {} }, requestId, route, candidates: [] };
      this.screenSessions.set(session, entry);
      let answerSent = false;
      const notifyFailure = () => {
        // Before the answer is delivered, negotiation owns fallback; an error
        // signal here would finish the viewer's still-pending request first.
        if (answerSent && entry.pc.connectionState === 'failed' && this.screenSessions.get(session) === entry) {
          this.nativeFallbackOwners?.add(owner);
          void this.request('screen:signal', { kind: 'error', requestId, to: owner, error: 'NATIVE_MEDIA_FALLBACK' }).catch(() => {});
          this.closeLocalScreen(owner, session);
        }
      };
      entry.onAnswerSent = () => { answerSent = true; notifyFailure(); };
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
          onState: notifyFailure,
        });
        if (this.screenSessions.get(session) !== entry) { pc.close(); throw new Error('共享已取消。'); }
        if (['failed', 'closed'].includes(pc.connectionState)) throw new Error('原生媒体协商失败。');
        return { sdp: pc.localDescription.sdp, session,
          networkCapabilities: localNetworkCapabilities({ mediaIceRestart: false }) };
      } catch (error) {
        const cancelled = this.screenSessions.get(session) !== entry;
        this.closeLocalScreen(owner, session);
        // A cancelled/superseded request must not create another connection.
        if (cancelled) throw new DOMException('共享已取消。', 'AbortError');
        if (this.closed || this.nativeScreenPublisher !== publisher || !this.screenStream?.active) throw error;
        this.nativeFallbackOwners?.add(owner);
        recordFailure('native-media', error);
        // Capability/negotiation failure uses the existing complete A/V path.
      }
    }

    const pc = route === 'native' || physicalMedia ? new NativeScreenConnection(false, this.screenSettings.bitrate) :
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

    const session =
      crypto.randomUUID();

    const entry = {
      owner,
      pc,
      requestId,
      route,
      candidates: [],
      network: negotiateNetwork(remoteCapabilities),
    };

    this.screenSessions
      .set(
        session,
        entry,
      );

    try {
      for (const track of this.screenStream.getTracks()) {
        if (track.kind === 'video') {
          // Each viewer owns its outgoing video track and encoder lifetime.
          // Keep the source running when this session is cancelled or replaced.
          entry.videoSource = track;
          entry.videoTrack = this.videoTrackForViewer(owner, track);
          if ('contentHint' in entry.videoTrack) entry.videoTrack.contentHint = track.contentHint;
          pc.addTrack(entry.videoTrack, this.screenStream);
        } else pc.addTrack(track, this.screenStream);
      }
      if (route === 'p2p' && !physicalMedia) {
        enableEnhancedIce(pc, { scope: 'screen-media', role: 'publisher' });
        setEnhancedIceRemote(pc, remoteCapabilities);
      }
      if (route === 'campus') await prepareCampusConnection(this, pc);
      if (this.closed || !this.screenStream?.active || this.screenSessions.get(session) !== entry) throw new Error('共享画面已结束。');
      await pc.setRemoteDescription({
        type: 'offer',
        sdp: pc instanceof NativeScreenConnection ? sdp : withScreenStartBitrate(sdp, this.screenSettings.bitrate),
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
        const hasOtherViewer = [...this.screenSessions.values()].some(
          other => other.owner !== owner && !['closed', 'failed'].includes(other.pc.connectionState),
        );
        answer.sdp = lockVideoBitrate(answer.sdp, this.screenSettings.bitrate, !hasOtherViewer);
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

      const quality = this.screenSettings;
      const videoSender = pc.getSenders().find(sender => sender.track?.kind === 'video');
      // Apply the viewer's caps before the answer starts its encoder on a
      // shared capture source. Some engines only expose encodings afterwards.
      const configured = videoSender && await configureScreenVideoSender(videoSender, quality, route);
      await pc.setLocalDescription(answer);
      if (videoSender) {
        if (!configured) await configureScreenVideoSender(videoSender, quality, route);
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
            entry.established = true;
            clearTimeout(entry.restartWaitTimer);
            entry.restartWaitTimer = null;
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
            // Give the authenticated viewer its one restart opportunity before
            // disposing the sender. This timer never initiates another attempt.
            if (pc.connectionState === 'failed' && route === 'p2p' && entry.established && entry.network?.features.mediaIceRestart) {
              if (entry.restartWaitTimer) return;
              if (!entry.restartUsed || entry.restarting) {
                this.waitForScreenReconnect(session, entry);
                return;
              }
            }
            this.closeLocalScreen(
              owner,
              session,
            );
          }
        };

      if (['connected', 'failed', 'closed'].includes(pc.connectionState)) pc.onconnectionstatechange();

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

  memberControl(memberId) {
    if (this.isHost) return this.guestMembers.get(memberId);
    const owner = this.room?.members?.find(member => member.role === 'owner');
    return memberId === owner?.id ? this.remote : null;
  }

  guestCoordinator(otherId) {
    if (this.isHost || !this.remote?.open || this.id === otherId) return null;
    const members = this.room?.members || [];
    const owner = members.find(member => member.role === 'owner');
    return owner && owner.id !== otherId && members.some(member => member.id === otherId) ? owner : null;
  }

  async controlUsesTurnRelay(memberId) {
    const connection = this.memberControl(memberId);
    const pc = connection?.peerConnection;
    if (!connection?.open || connection.roomcastNative || !pc || pc.roomcastCampus) return false;
    // relayProtocol describes only the local allocation. The selected pair
    // still identifies TURN when it is the publisher that needs the relay.
    const route = campusStatsRoute(await pc.getStats());
    return connection.open && this.memberControl(memberId) === connection && route === 'TURN中继';
  }

  canUseCampus() {
    return !window.roomcast?.physicalDirect && !!this.campusSecret && !!window.roomcast?.startCampusNetwork && !this.closed;
  }

  async openScreen(
    owner,
    pc,
    {
      signal,
      route = 'p2p',
      onStage,
      onSession,
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
        'native',
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
      onSession,
    };

    this.screenViewers
      .set(
        requestId,
        entry,
      );

    let resolveInitialAnswer;
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

    if (route === 'p2p' && !(pc instanceof NativeScreenConnection)) enableEnhancedIce(pc, { scope: 'screen-media', role: 'viewer' });
    try {
      if (route === 'campus') {
        onStage?.('local');
        await withAbort(prepareCampusConnection(this, pc), signal);
      }
      onStage?.('answer');
      let offer =
        await withAbort(
          pc.createOffer(),
          signal,
        );

      const publication = this.room?.streams?.find(stream => stream.memberId === owner);
      if (route === 'p2p' && publication?.nativeCapable !== false) {
        offer = await withAbort(prepareNativeReceiveOffer(offer), signal);
      }

      await withAbort(
        pc.setLocalDescription(
          offer,
        ),
        signal,
      );

      const promise = new Promise(resolve => { resolveInitialAnswer = resolve; });
      this.screenPending.set(requestId, resolveInitialAnswer);

      offerRequested = true;
      const offerRequest = this.request(
        'screen:signal',
        {
          kind: 'offer',
          requestId,
          to: owner,
          route,
          sdp: pc.localDescription.sdp,
          networkCapabilities: localNetworkCapabilities(),
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

      setEnhancedIceRemote(pc, result.networkCapabilities);
      entry.network = negotiateNetwork(result.networkCapabilities);

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

      if (this.screenPending.get(requestId) === resolveInitialAnswer) this.screenPending.delete(requestId);
    }
  }

  canRestartScreen(owner, pc) {
    return [...this.screenViewers.values()].some(entry => entry.owner === owner && entry.pc === pc
      && entry.session && entry.network?.features.mediaIceRestart && !entry.restartUsed
      && pc.signalingState === 'stable' && !this.closed && this.connected);
  }

  async restartScreen(owner, pc, { signal } = {}) {
    const found = [...this.screenViewers].find(([, entry]) => entry.owner === owner && entry.pc === pc);
    if (!found || !this.canRestartScreen(owner, pc)) throw new Error('当前画面不支持原连接恢复。');
    const [requestId, entry] = found;
    const expectedSession = entry.session;
    entry.restartUsed = true;
    entry.restarting = true;
    let resolveAnswer;
    const answer = new Promise(resolve => { resolveAnswer = resolve; });
    this.screenPending.set(requestId, resolveAnswer);
    const forward = pc.onicecandidate;
    const outgoing = [];
    const collect = event => outgoing.push(event);
    pc.onicecandidate = collect;
    try {
      signal?.throwIfAborted();
      pc.restartIce();
      const offer = await withAbort(pc.createOffer(), signal);
      await withAbort(pc.setLocalDescription(offer), signal);
      const sent = this.request('screen:signal', {
        kind: 'offer', requestId, to: owner, route: 'p2p', session: expectedSession,
        restart: true, sdp: pc.localDescription.sdp, networkCapabilities: localNetworkCapabilities(),
      }, { signal }).then(ack => {
        if (!ack.ok) throw new Error(ack.error || '原连接恢复请求未送达。');
      });
      pc.onicecandidate = forward;
      for (const event of outgoing.splice(0)) forward?.call(pc, event);
      const [, result] = await withTimeout(Promise.all([sent, answer]), 8000, '原连接恢复响应超时。', signal);
      if (result.kind !== 'answer' || result.session !== expectedSession) throw new Error(result.error || '原连接恢复未完成。');
      await withAbort(pc.setRemoteDescription({ type: 'answer', sdp: result.sdp }), signal);
      entry.restarting = false;
      for (const candidate of entry.candidates.splice(0)) await pc.addIceCandidate(candidate ?? null).catch(() => {});
    } finally {
      entry.restarting = false;
      outgoing.length = 0;
      if (pc.onicecandidate === collect) pc.onicecandidate = forward;
      if (this.screenPending.get(requestId) === resolveAnswer) this.screenPending.delete(requestId);
    }
  }

  async answerScreenRestart(owner, sdp, requestId, session) {
    const entry = this.screenSessions.get(session);
    if (!entry || entry.owner !== owner || entry.requestId !== requestId || entry.route !== 'p2p'
      || !entry.network?.features.mediaIceRestart || entry.restartUsed || !this.screenStream?.active
      || entry.pc.signalingState !== 'stable') throw new Error('原共享连接已不可恢复。');
    entry.restartUsed = true;
    entry.restarting = true;
    // The wait for an offer ends here. Give this accepted exchange its full
    // window, even if most of the first timer elapsed before the offer arrived.
    this.waitForScreenReconnect(session, entry);
    try {
      await withTimeout((async () => {
        await entry.pc.setRemoteDescription({ type: 'offer', sdp });
        const answer = await entry.pc.createAnswer();
        if (Number(this.screenSettings.bitrate) > 0) {
          answer.sdp = lockVideoBitrate(answer.sdp, this.screenSettings.bitrate, false);
        }
        await entry.pc.setLocalDescription(answer);
      })(), 8000, '原共享连接恢复协商超时。');
      if (this.screenSessions.get(session) !== entry || !this.screenStream?.active) throw new Error('共享已结束。');
      entry.restarting = false;
      for (const candidate of entry.candidates.splice(0)) await entry.pc.addIceCandidate(candidate ?? null).catch(() => {});
      return { sdp: entry.pc.localDescription.sdp, session };
    } catch (error) {
      this.closeLocalScreen(owner, session);
      throw error;
    } finally { entry.restarting = false; }
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
    this.guestJoinController.abort(new DOMException('操作已取消', 'AbortError'));
    this.connected = false;
    this.pendingMigrationCommit = null;
    this.confirmResumeOn = null;
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
      const { resolve }
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
