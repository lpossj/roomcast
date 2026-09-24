import { Peer } from 'peerjs';
import { io } from 'socket.io-client';
import { createRoomcastPeerConnection, DEFAULT_STUN_ICE, mediaIceServers, turnIceServers } from './ice-policy.js';
import { ack } from './lib.js';
import { createPeerAuthProof, MAX_UNAUTHENTICATED_PEERS, PEER_AUTH_PROTOCOL, PEER_AUTH_TIMEOUT_MS, randomPeerAuthNonce, verifyPeerAuthProof } from './p2p-auth.js';
import { encodeRelayInvite, optionalRelayIce } from './relay.js';
import { createP2pVideoPolicy, p2pResolutionScale } from './p2p-video-policy.js';

export const P2P_ICE = DEFAULT_STUN_ICE;

const forwarded = [
  'room:state',
  'room:kicked',
  'room:owner-token',
  'chat:message',
  'chat:recalled',
  'image:start',
  'image:chunk',
  'image:complete',
  'image:abort',
  'screen:signal',
  'member:left',
  'share:expired',
];

const allowed = new Set([
  'room:join',
  'room:leave',
  'room:ping',
  'member:role',
  'member:share-permission',
  'member:kick',
  'chat:send',
  'chat:recall',
  'chat:history',
  'image:init',
  'image:chunk',
  'image:complete',
  'screen:signal',
  'view:start',
  'view:heartbeat',
  'view:stop',
  'share:claim',
  'share:started',
  'share:stop',
]);

const beforeJoin = new Set(['room:join']);
const INVITE_SECRET = /^[A-Za-z0-9_-]{43}$/;

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

    this.migrating = false;
    this.peerReconnectTimer = null;
    this.delayedTimers = new Set();
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
    if (event === 'room:state') {
      this.room = value;
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

  async localSocket() {
    if (typeof document !== 'undefined' && !window.roomcast?.desktop) {
      if (!this.browserService) {
        const { createBrowserRoomService } = await import('./browser-room-service.js');
        this.browserService = createBrowserRoomService();
      }
      return this.browserService.connect();
    }
    const socket = io(
      window.location.origin,
      {
        reconnection: false,
        autoConnect: false,
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

    return socket;
  }

  async openPeer(id, override) {
    const options = {
      config: {
        iceServers:
          this.controlIceServers,
        iceTransportPolicy: 'all',
        roomcastIcePolicy: false,
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

    this.peer = id
      ? new Peer(id, options)
      : new Peer(options);

    await withTimeout(
      new Promise(
        (resolve, reject) => {
          this.peer.once(
            'open',
            resolve,
          );

          this.peer.on(
            'error',
            error => reject(
              new Error(
                `公共信令连接失败：${error.type || 'unknown'}。检查网络或稍后重试。`,
              ),
            ),
          );
        },
      ),
      20000,
      '公共信令服务连接超时；当前网络可能无法访问该服务。',
    );

    this.peer.on(
      'disconnected',
      () => {
        if (!this.closed) {
          clearTimeout(
            this.peerReconnectTimer,
          );

          this.peerReconnectTimer =
            setTimeout(
              () => {
                if (
                  !this.closed
                  && this.peer?.disconnected
                  && !this.peer.destroyed
                ) {
                  this.peer.reconnect();
                }
              },
              2500,
            );
        }
      },
    );
  }

  async enter(
    mode,
    details,
    config,
  ) {
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

      const relayResult =
        await optionalRelayIce({
          settings:
            details.relaySettings
            || { enabled: false },
        });

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

      this.local =
        await this.localSocket();

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

      this.id =
        result.selfId;

      this.roomId =
        result.room.id;

      this.room =
        result.room;

      this.ownerToken =
        result.ownerToken || '';

      await this.openPeer(
        `roomcast-v1-${this.roomId}`,
        config.peerServer,
      );

      this.peer.on(
        'connection',
        connection => (
          this.accept(connection)
        ),
      );

      this.connected = true;

      return {
        ...result,
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

    await this.openPeer(
      undefined,
      this.peerServer,
    );

    this.peer.on(
      'connection',
      connection => (
        connection.close()
      ),
    );

    await this.connectRemote();

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

    if (!result.ok) {
      throw new Error(
        result.error,
      );
    }

    this.id =
      result.selfId;

    this.room =
      result.room;

    return {
      ...result,
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

  async connectRemote() {
    const authMode = 'invite';

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
          },
        },
      );

    this.remote = remote;

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

    const failed =
      error => rejectReady(
        new Error(
          error?.type
          || error?.message
          || '房间连接已关闭',
        ),
      );

    peer.on(
      'error',
      failed,
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
          const secret =
            this.inviteSecret;

          void createPeerAuthProof(
            secret,
            data.authChallenge,
          )
            .then(
              proof => {
                if (remote.open) {
                  remote.send({
                    authProof:
                      proof,
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
          ready();
        }

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
          && !this.migrating
          && this.remote
          === remote
        ) {
          this.disconnect(
            '房主连接已结束',
          );
        }
      },
    );

    try {
      await withTimeout(
        hostReady,
        PEER_AUTH_TOTAL_TIMEOUT_MS,
        '无法与房主建立 P2P 连接。',
      );
    } catch (error) {
      remote.close();
      throw error;
    } finally {
      peer.off(
        'error',
        failed,
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

  async sendControl(
    connection,
    control,
    payload,
    timeout = 8000,
  ) {
    const id =
      crypto.randomUUID();

    return withTimeout(
      new Promise(
        resolve => {
          this.controlPending
            .set(id, resolve);

          connection.send({
            control,
            controlId: id,
            payload,
          });
        },
      ),
      timeout,
      '房间协调器迁移响应超时',
    ).finally(
      () => (
        this.controlPending
          .delete(id)
      ),
    );
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
                !this.migrating
                || event
                !== 'room:state'
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
    if (this.closed) {
      return {
        ok: true,
      };
    }

    if (
      !this.isHost
      || !this.room?.members
        ?.some(
          member => (
            member.id
            !== this.id
          ),
        )
    ) {
      if (this.connected) {
        await this.request(
          'room:leave',
        ).catch(() => { });
      }

      this.disconnect();

      return {
        ok: true,
      };
    }

    const candidateIds = [
      ...this.guestMembers,
    ]
      .filter(
        ([, connection]) => (
          connection?.open
        ),
      )
      .map(
        ([memberId]) => (
          memberId
        ),
      );

    const healthy = [];
    await Promise.all(candidateIds.map(async memberId => {
      const started = performance.now();
      try {
        const result = await this.sendControl(this.guestMembers.get(memberId), 'migration:probe', {}, 1000);
        if (result?.ok) healthy.push({ memberId, elapsed: performance.now() - started });
      } catch { /* A non-responsive member must not block a healthy successor. */ }
    }));
    healthy.sort((a, b) => a.elapsed - b.elapsed);

    let exported, successor;
    let prepareError = new Error('当前没有响应正常的接管成员，请稍后重试。');
    // At most two exports, matching the server's existing rate limit.
    for (const { memberId } of healthy.slice(0, 2)) {
      const candidate = this.guestMembers.get(memberId);
      if (!candidate?.open) continue;
      const result = await ack(this.local, 'room:migration-export', { candidateIds: [memberId] });
      if (!result.ok) throw new Error(result.error || '无法准备房间迁移。');
      try {
        const prepared = await this.sendControl(candidate, 'migration:prepare', {
          transfer: result.transfer,
          ticket: result.tickets[result.successorId],
          inviteSecret: this.inviteSecret,
        }, 8000);
        if (!prepared?.ok) throw new Error(prepared?.error || '新房主未能恢复房间。');
        exported = result;
        successor = candidate;
        break;
      } catch (error) {
        prepareError = error;
        await this.sendControl(candidate, 'migration:abort', {}, 500).catch(() => { });
      }
    }
    if (!exported) throw prepareError;

    try {
      const armed = await this.sendControl(successor, 'migration:arm', {
        roomId: this.roomId,
        successorId: exported.successorId,
        ticket: exported.tickets[exported.successorId],
        inviteSecret: this.inviteSecret,
      }, 3000);
      if (!armed?.ok || armed.armed !== true || !successor.open) {
        throw new Error(armed?.error || '新房主未确认接管。');
      }
    } catch (error) {
      await this.sendControl(successor, 'migration:abort', {}, 2500).catch(() => { });
      throw new Error('新房主未确认房间迁移，其他成员未切换，可重试退出：' + error.message);
    }

    const commits = [];

    for (
      const [
        memberId,
        connection,
      ]
      of this.guestMembers
    ) {
      const ticket =
        exported.tickets[
        memberId
        ];

      if (
        connection.open
        && ticket
        && memberId !== exported.successorId
      ) {
        commits.push({
          memberId,
          promise:
            this.sendControl(
              connection,
              'migration:commit',
              {
                roomId:
                  this.roomId,
                successorId:
                  exported.successorId,
                ticket,
                reconnectSlot: commits.filter(entry => entry.memberId !== exported.successorId).length,
                inviteSecret:
                  this.inviteSecret,
              },
              3000,
            ),
        });
      }
    }

    await Promise.allSettled(commits.map(entry => entry.promise));

    await ack(
      this.local,
      'room:leave',
    ).catch(() => { });

    await pause(80);

    this.disconnect();

    return {
      ok: true,
      migratedTo:
        exported.successorId,
    };
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
    ) {
      connection.close();
      return;
    }

    this.unauthenticated
      .add(connection);

    let socket;
    let closed = false;
    let authenticated = false;
    let memberId = '';

    let windowStarted =
      performance.now();

    let requests = 0;

    let timeout;

    const cleanup = () => {
      if (closed) return;

      closed = true;

      clearTimeout(timeout);

      socket?.disconnect();

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
          timeout = setTimeout(() => finish(new Error('P2P 连接建立超时。')), PEER_AUTH_ICE_TIMEOUT_MS);
        });
      }
      if (closed || !connection.open) return;
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

                  resolve(
                    message.authProof,
                  );
                };

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
          proof,
        )
      ) {
        throw new Error(
          'P2P 鉴权失败。',
        );
      }

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
              !connection.open
            ) {
              return;
            }

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
              connection.close();
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
          if (
            message?.controlReply
            && this.controlPending
              .has(
                message.controlReply,
              )
          ) {
            this.controlPending
              .get(
                message.controlReply,
              )(
                message.result,
              );

            this.controlPending
              .delete(
                message.controlReply,
              );

            return;
          }

          const binaryChunk =
            message?.event
            === 'image:chunk'
            && message.payload?.data;

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
            serializedLength =
              binaryChunk
                ? 0
                : JSON.stringify(
                  message,
                ).length;
          } catch {
            connection.close();
            return;
          }

          const oversized =
            binaryChunk
              ? (
                binaryLength < 1
                || binaryLength
                > 48 * 1024
              )
              : serializedLength
              > 65536;

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

          if (
            now - windowStarted
            > 10_000
          ) {
            windowStarted = now;
            requests = 0;
          }

          requests += 1;

          if (
            requests > 160
          ) {
            connection.close();
            return;
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
                {
                  ...(
                    message.payload
                    || {}
                  ),
                },
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
        });
      }
    } catch {
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
      kind === 'close'
    ) {
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
    this.stopVdoPublisher();

    for (
      const entry
      of this.screenSessions.values()
    ) {
      entry.videoPolicy?.stop();
      clearTimeout(
        entry.calibrateTimer,
      );

      entry.pc?.close();
    }

    this.screenSessions.clear();

    for (
      const track
      of this.screenStream
        ?.getTracks()
      || []
    ) {
      track.stop();
    }

    this.screenStream
      ?.roomcastCleanup?.();

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
      ].includes(route)
    ) {
      throw new Error(
        '未知的屏幕媒体路线。',
      );
    }

    const relayOnly =
      route === 'turn';

    const routeIceServers =
      relayOnly
        ? turnIceServers(
          this.controlIceServers,
        )
        : this.mediaIceServers;

    if (
      relayOnly
      && !routeIceServers.length
    ) {
      throw new Error(
        'TURN 未启用或当前不可用。',
      );
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

      for (
        const sender
        of pc.getSenders()
      ) {
        if (
          sender.track?.kind
          !== 'video'
        ) {
          continue;
        }

        videoSender =
          sender;

        const parameters =
          sender.getParameters();

        if (
          !parameters.encodings
            ?.length
        ) {
          parameters.encodings =
            [{}];
        }

        delete parameters
          .encodings[0]
          .scaleResolutionDownTo;

        parameters
          .encodings[0]
          .scaleResolutionDownBy =
          route === 'p2p' ? p2pResolutionScale(sender.track, quality) : 1;

        if (
          quality.bitrate > 0
        ) {
          parameters
            .encodings[0]
            .maxBitrate =
            quality.bitrate
            * 1000;
        } else {
          delete parameters
            .encodings[0]
            .maxBitrate;
        }

        parameters
          .encodings[0]
          .maxFramerate =
          quality.fps;

        parameters
          .encodings[0]
          .priority =
          'high';

        parameters
          .encodings[0]
          .networkPriority =
          'high';

        parameters
          .encodings[0]
          .bitratePriority =
          2;

        parameters
          .degradationPreference =
          route === 'p2p' ? 'maintain-resolution' : quality.performanceMode
            === 'smooth'
            ? 'maintain-framerate'
            : 'maintain-resolution';

        await sender
          .setParameters(
            parameters,
          )
          .catch(() => { });
      }

      if (route === 'p2p' && videoSender) {
        entry.videoPolicy = createP2pVideoPolicy({ pc, sender: videoSender, quality });
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
            if (entry.videoPolicy) entry.videoPolicy.start();
            else entry.calibrateTimer =
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

  async openScreen(
    owner,
    pc,
    {
      signal,
      route = 'p2p',
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

      const sent =
        await withAbort(
          this.request(
            'screen:signal',
            {
              kind: 'offer',
              requestId,
              to: owner,
              route,
              sdp:
                pc.localDescription
                  .sdp,
            },
          ),
          signal,
        );

      if (!sent.ok) {
        throw new Error(
          sent.error,
        );
      }

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

      const result =
        await withTimeout(
          withAbort(
            promise,
            signal,
          ),
          12000,
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

      return result;
    } catch (error) {
      this.screenViewers
        .delete(requestId);

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

    this.stopScreenStream();

    this.local
      ?.removeAllListeners?.();

    this.local
      ?.disconnect();
    void this.browserService?.close();
    this.browserService = null;

    for (
      const guest
      of this.guests
    ) {
      guest.close();
    }

    for (
      const guest
      of this.unauthenticated
    ) {
      guest.close();
    }

    this.remote?.close();
    this.peer?.destroy();

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

    for (
      const resolve
      of this.controlPending
        .values()
    ) {
      resolve({
        ok: false,
        error:
          'P2P 连接已结束',
      });
    }

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
      entry.pc?.close();
    }

    this.pending.clear();
    this.controlPending.clear();
    this.screenPending.clear();
    this.vdoPending.clear();

    this.screenViewers.clear();
    this.guestMembers.clear();
    this.guests.clear();
    this.unauthenticated.clear();

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
