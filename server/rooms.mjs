import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const MAX_MEMBERS = 10;
const MAX_ROOMS = 200;
const MAX_MESSAGES = 1000;
const CHAT_PAGE_SIZE = 50;
const CLAIM_TIMEOUT_MS = 45_000;
const VIEWER_TIMEOUT_MS = 25_000;
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_CHUNK_BYTES = 48 * 1024;
const IMAGE_UPLOAD_TIMEOUT_MS = 30_000;
const IMAGE_BATCH_TIMEOUT_MS = 90_000;
const IMAGE_BATCH_MAX = 4;
const MIGRATION_TIMEOUT_MS = 45_000;
const MIGRATION_TRANSFER_MAX_BYTES = 48 * 1024;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const token = () => randomBytes(32).toString('hex');
const tokenHash = value => createHash('sha256').update(String(value)).digest('hex');
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (error) => ({ ok: false, error });

function cleanText(value, max, label, { multiline = false, optional = false } = {}) {
  if (value === undefined && optional) return '';
  if (typeof value !== 'string' || value.length > max) throw new Error(`${label}长度须为 1–${max} 个字符。`);
  const text = value.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim();
  const result = multiline ? text : text.replace(/\s+/g, ' ');
  if (!result && !optional) throw new Error(`${label}不能为空。`);
  return result;
}

function passwordInput(value) {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string' || value.length > 128) throw new Error('房间密码最多 128 个字符。');
  return value;
}

function shareSettings(value) {
  const input = isRecord(value) ? value : {};

  const number = (field, fallback, min, max, allowZero = false) => {
    const result = input[field] === undefined ? fallback : Number(input[field]);

    if (
      !Number.isInteger(result)
      || (
        !(allowZero && result === 0)
        && (result < min || result > max)
      )
    ) {
      throw new Error(`共享参数 ${field} 超出范围。`);
    }

    return result;
  };

  const performanceMode =
    ['locked', 'balanced', 'quality', 'smooth'].includes(input.performanceMode)
      ? input.performanceMode
      : 'quality';

  return {
    width: number('width', 1920, 320, 7680),
    height: number('height', 1080, 240, 4320),
    fps: number('fps', 30, 1, 120),
    bitrate: number('bitrate', 4500, 200, 50000, true),
    performanceMode,
    protocol: 'WebRTC / DTLS-SRTP',
    codec: 'H.264 优先',
  };
}

function safeEqual(left, right) {
  return typeof left === 'string'
    && typeof right === 'string'
    && left.length === right.length
    && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function iceCandidate(value) {
  if (value === null) return null;

  if (
    !isRecord(value)
    || typeof value.candidate !== 'string'
    || value.candidate.length > 4096
  ) {
    throw new Error('ICE 候选格式错误。');
  }

  const result = {
    candidate: value.candidate,
  };

  for (const [field, max] of [['sdpMid', 128], ['usernameFragment', 256]]) {
    if (value[field] !== undefined) {
      if (
        value[field] !== null
        && (
          typeof value[field] !== 'string'
          || value[field].length > max
        )
      ) {
        throw new Error('ICE 候选格式错误。');
      }

      result[field] = value[field];
    }
  }

  if (value.sdpMLineIndex !== undefined) {
    if (
      value.sdpMLineIndex !== null
      && (
        !Number.isInteger(value.sdpMLineIndex)
        || value.sdpMLineIndex < 0
        || value.sdpMLineIndex > 255
      )
    ) {
      throw new Error('ICE 候选格式错误。');
    }

    result.sdpMLineIndex = value.sdpMLineIndex;
  }

  return result;
}

function binary(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);

  if (ArrayBuffer.isView(value)) {
    return Buffer.from(
      value.buffer,
      value.byteOffset,
      value.byteLength,
    );
  }

  throw new Error('图片分块格式错误。');
}

export function validImageMagic(type, value) {
  const bytes = binary(value);

  if (type === 'image/jpeg') {
    return bytes.length >= 3
      && bytes[0] === 0xff
      && bytes[1] === 0xd8
      && bytes[2] === 0xff;
  }

  if (type === 'image/png') {
    return bytes.length >= 8
      && bytes.subarray(0, 8).equals(
        Buffer.from([
          0x89,
          0x50,
          0x4e,
          0x47,
          0x0d,
          0x0a,
          0x1a,
          0x0a,
        ]),
      );
  }

  if (type === 'image/gif') {
    return bytes.length >= 6
      && ['GIF87a', 'GIF89a'].includes(
        bytes.subarray(0, 6).toString('ascii'),
      );
  }

  if (type === 'image/webp') {
    return bytes.length >= 12
      && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
      && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  }

  return false;
}

function cleanIceServers(value) {
  if (!Array.isArray(value)) return [];

  return value.slice(0, 8).flatMap(item => {
    const urls = (
      Array.isArray(item?.urls)
        ? item.urls
        : [item?.urls]
    ).filter(
      url =>
        typeof url === 'string'
        && /^(stun|turn|turns):/i.test(url)
        && url.length <= 512,
    );

    if (!urls.length) return [];

    const result = {
      urls: urls.length === 1
        ? urls[0]
        : urls,
    };

    if (
      urls.some(
        url => /^turns?:/i.test(url),
      )
    ) {
      if (
        typeof item?.username !== 'string'
        || typeof item?.credential !== 'string'
        || item.username.length > 512
        || item.credential.length > 512
      ) {
        return [];
      }

      result.username = item.username;
      result.credential = item.credential;
    }

    return [result];
  });
}

/**
 * In-memory rooms.
 */
export function attachRooms(io, {
  createKey = '',
  getIceServers = () => [],
  isTrustedLocalSocket = socket => true,
  onRoomClosed = () => { },
} = {}) {
  const rooms = new Map();
  const readers = new Map();
  const ipLimits = new Map();
  const sockets = new Set();
  const consumedMigrationTickets = new Map();

  let closed = false;

  function consume(limits, key, max, windowMs) {
    const now = Date.now();

    let bucket = limits.get(key);

    if (
      !bucket
      || bucket.until <= now
    ) {
      bucket = {
        count: 0,
        until: now + windowMs,
      };

      limits.set(key, bucket);
    }

    if (bucket.count >= max) {
      return false;
    }

    bucket.count += 1;

    return true;
  }

  const prune = setInterval(
    () => {
      const now = Date.now();
      const monotonicNow = performance.now();

      for (
        const [key, bucket]
        of ipLimits
      ) {
        if (bucket.until <= now) {
          ipLimits.delete(key);
        }
      }

      for (
        const [key, deadline]
        of consumedMigrationTickets
      ) {
        if (deadline <= monotonicNow) {
          consumedMigrationTickets.delete(key);
        }
      }

      for (
        const room
        of rooms.values()
      ) {
        if (
          room.migrationPrepared
          && room.migrationDeadline
          && room.migrationDeadline
          <= monotonicNow
        ) {
          for (
            const candidate
            of room.members.values()
          ) {
            if (candidate.readToken) {
              readers.delete(
                candidate.readToken,
              );
            }

            if (candidate.socket) {
              delete candidate.socket
                .data.shareRoomId;

              delete candidate.socket
                .data.memberId;

              candidate.socket
                .disconnect(true);
            }
          }

          room.migrationTickets
            ?.clear();

          rooms.delete(room.id);

          try {
            onRoomClosed(room.id);
          } catch { }

          continue;
        }

        if (
          room.migrationDeadline
          && room.migrationDeadline
          <= monotonicNow
        ) {
          for (
            const member
            of [...room.members.values()]
          ) {
            if (member.socket) {
              continue;
            }

            releaseStream(
              room,
              member.id,
            );

            for (
              const viewers
              of room.viewers.values()
            ) {
              viewers.delete(
                member.id,
              );
            }

            room.members.delete(
              member.id,
            );
          }

          room.migrationTickets
            ?.clear();

          room.migrationDeadline = 0;

          if (
            room.members.size
          ) {
            broadcast(room);
          }
        }

        let changed = false;

        for (
          const viewers
          of room.viewers.values()
        ) {
          for (
            const [
              memberId,
              viewer,
            ]
            of viewers
          ) {
            if (
              viewer.lastSeen
              + VIEWER_TIMEOUT_MS
              <= now
              || !room.members
                .has(memberId)
            ) {
              viewers.delete(
                memberId,
              );

              changed = true;
            }
          }
        }

        if (changed) {
          broadcast(room);
        }
      }
    },
    10_000,
  );

  prune.unref?.();

  function snapshot(room) {
    return {
      id: room.id,
      name: room.name,
      maxMembers: MAX_MEMBERS,

      members: [
        ...room.members.values(),
      ].map(
        ({
          id,
          name,
          sharing,
          joinedAt,
          role,
          canShare,
          avatarColor,
        }) => ({
          id,
          name,
          sharing,
          joinedAt,
          role,
          canShare,
          avatarColor,
        }),
      ),

      streams: [
        ...room.streams.values(),
      ].map(
        stream => ({
          ...stream,

          viewers: [
            ...(
              room.viewers
                .get(stream.memberId)
                ?.values()
              || []
            ),
          ]
            .filter(
              viewer =>
                viewer.memberId
                !== stream.memberId
                && room.members
                  .has(
                    viewer.memberId,
                  ),
            )
            .map(
              ({
                memberId,
                name,
                avatarColor,
              }) => ({
                memberId,
                name,
                avatarColor,
              }),
            ),
        }),
      ),
    };
  }

  function broadcast(room) {
    // Direct socket delivery avoids waiting
    // for an asynchronous adapter join.
    const state = snapshot(room);

    for (
      const member
      of room.members.values()
    ) {
      member.socket?.emit(
        'room:state',
        state,
      );
    }
  }

  function message(
    room,
    member,
    text,
    system = false,
    extra = {},
  ) {
    const item = {
      id: randomUUID(),

      memberId:
        member?.id ?? null,

      seq:
        room.nextMessageSeq++,

      name:
        system
          ? '系统'
          : member.name,

      text,

      at:
        Date.now(),

      ...(
        system
          ? {
            system: true,
          }
          : {
            avatarColor:
              member.avatarColor,
          }
      ),

      recalled:
        false,

      ...extra,
    };

    room.messages.push(item);

    if (
      room.messages.length
      > MAX_MESSAGES
    ) {
      room.messages.splice(
        0,
        room.messages.length
        - MAX_MESSAGES,
      );
    }

    for (
      const recipient
      of room.members.values()
    ) {
      recipient.socket?.emit(
        'chat:message',
        item,
      );
    }

    return item;
  }

  function releaseStream(
    room,
    memberId,
  ) {
    const claim =
      room.claims.get(memberId);

    const stream =
      room.streams.get(memberId);

    if (
      !claim
      && !stream
    ) {
      return;
    }

    if (claim?.timer) {
      clearTimeout(
        claim.timer,
      );
    }

    const owner =
      room.members.get(memberId);

    if (owner) {
      owner.sharing = false;
    }

    room.claims.delete(
      memberId,
    );

    room.streams.delete(
      memberId,
    );

    room.viewers.delete(
      memberId,
    );

  }

  function removeMember(
    socket,
    departure =
      socket.data.kicked
        ? 'kick'
        : 'disconnect',
  ) {
    const room =
      rooms.get(
        socket.data.shareRoomId,
      );

    delete socket.data
      .shareRoomId;

    if (!room) {
      return;
    }

    const memberId =
      socket.data.memberId
      || socket.id;

    const member =
      room.members.get(
        memberId,
      );

    if (!member) {
      return;
    }

    if (
      room.migrationPrepared
    ) {
      for (
        const candidate
        of room.members.values()
      ) {
        if (
          candidate.readToken
        ) {
          readers.delete(
            candidate.readToken,
          );
        }
      }

      room.migrationTickets
        ?.clear();

      rooms.delete(room.id);

      try {
        onRoomClosed(room.id);
      } catch { }

      return;
    }

    readers.delete(
      member.readToken,
    );

    releaseStream(
      room,
      member.id,
    );

    for (
      const viewers
      of room.viewers.values()
    ) {
      viewers.delete(
        member.id,
      );
    }

    room.members.delete(
      member.id,
    );


    // Explicit departures need immediate notification
    // for audio peer teardown.
    for (
      const remaining
      of room.members.values()
    ) {
      remaining.socket?.emit(
        'member:left',
        {
          memberId:
            member.id,

          reason:
            departure,
        },
      );
    }

    if (
      !room.members.size
    ) {
      rooms.delete(
        room.id,
      );

      try {
        onRoomClosed(
          room.id,
        );
      } catch { }
    } else {
      if (
        member.role === 'owner'
        && departure
        === 'disconnect'
      ) {
        // A socket disappearing is not a completed
        // two-phase migration. Close the coordinator
        // state instead of advertising an
        // unacknowledged HA takeover.
        rooms.delete(room.id);

        for (
          const remaining
          of room.members.values()
        ) {
          readers.delete(
            remaining.readToken,
          );

          releaseStream(
            room,
            remaining.id,
          );


          remaining.socket?.emit(
            'room:kicked',
            {
              error:
                '房主连接异常中断；未完成安全迁移，房间已关闭。',
            },
          );

          if (
            remaining.socket
          ) {
            delete remaining.socket
              .data.shareRoomId;

            delete remaining.socket
              .data.memberId;

            remaining.socket
              .disconnect(true);
          }
        }

        try {
          onRoomClosed(
            room.id,
          );
        } catch { }

        return;
      }

      if (
        member.role
        === 'owner'
      ) {
        try {
          onRoomClosed(
            room.id,
          );
        } catch { }

        const successor =
          [
            ...room.members.values(),
          ].sort(
            (
              left,
              right,
            ) =>
              left.joinedAt
              - right.joinedAt,
          )[0];

        successor.role =
          'owner';

        successor.canShare =
          true;

        successor.ownerToken =
          token();

        successor.socket?.emit(
          'room:owner-token',
          {
            ownerToken:
              successor.ownerToken,
          },
        );

        message(
          room,
          null,
          `${successor.name} 已继承房主权限`,
          true,
        );
      }

      message(
        room,
        null,
        `${member.name} 离开了房间`,
        true,
      );

      broadcast(room);
    }
  }

  function current(socket) {
    const room =
      rooms.get(
        socket.data.shareRoomId,
      );

    const member =
      room?.members.get(
        socket.data.memberId
        || socket.id,
      );

    if (
      !room
      || !member
    ) {
      throw new Error(
        '请先加入房间。',
      );
    }

    return {
      room,
      member,
    };
  }

  function addMember(
    socket,
    room,
    name,
    role = 'user',
    memberId = socket.id,
  ) {
    if (
      !socket.connected
      || closed
    ) {
      throw new Error(
        '连接已断开。',
      );
    }

    if (
      room.members.size
      >= MAX_MEMBERS
    ) {
      throw new Error(
        '房间已满，最多 10 人。',
      );
    }

    const usedColors =
      new Set(
        [
          ...room.members.values(),
        ].map(
          candidate =>
            candidate.avatarColor,
        ),
      );

    const avatarColor =
      Array.from(
        {
          length:
            MAX_MEMBERS,
        },
        (
          _,
          index,
        ) => index,
      ).find(
        index =>
          !usedColors.has(index),
      )
      ?? 0;

    const member = {
      id: memberId,
      name,
      avatarColor,
      sharing: false,
      joinedAt: Date.now(),
      role,
      canShare: true,
      readToken: token(),

      ownerToken:
        role === 'owner'
          ? token()
          : '',

      socket,
    };

    room.members.set(
      member.id,
      member,
    );

    readers.set(
      member.readToken,
      {
        roomId:
          room.id,

        memberId:
          member.id,
      },
    );

    socket.data.shareRoomId =
      room.id;

    socket.data.memberId =
      member.id;

    message(
      room,
      null,
      `${name} 加入了房间`,
      true,
    );

    broadcast(room);

    return {
      ok: true,
      selfId: member.id,
      room: snapshot(room),
      readToken:
        member.readToken,

      ...(
        member.ownerToken
          ? {
            ownerToken:
              member.ownerToken,
          }
          : {}
      ),

      iceServers:
        room.iceServers?.length
          ? room.iceServers
          : getIceServers(
            member.id,
          ),
    };
  }

  function connect(socket) {
    if (closed) {
      return socket.disconnect(
        true,
      );
    }

    sockets.add(socket);

    const limits =
      new Map();

    const ip =
      socket.handshake.address
      || 'unknown';

    const uploads =
      new Map();

    const imageBatches =
      new Map();

    const emitImageAbort = (room, memberId, messageId) => {
      for (const recipient of room.members.values()) {
        if (recipient.id !== memberId) {
          recipient.socket?.emit('image:abort', { messageId });
        }
      }
    };

    const abortImageBatch = batch => {
      if (!batch || imageBatches.get(batch.id) !== batch) return;
      imageBatches.delete(batch.id);
      clearTimeout(batch.timer);
      for (const [uploadId, upload] of [...uploads.entries()]) {
        if (upload.batchId === batch.id) {
          clearTimeout(upload.timer);
          uploads.delete(uploadId);
        }
      }
      for (const messageId of batch.imageIds) {
        emitImageAbort(batch.room, batch.member.id, messageId);
      }
    };

    const armImageBatch = batch => {
      clearTimeout(batch.timer);
      batch.timer = setTimeout(() => abortImageBatch(batch), IMAGE_BATCH_TIMEOUT_MS);
      batch.timer.unref?.();
    };

    let membershipBusy =
      false;

    let membershipGeneration =
      0;

    function event(
      name,
      handler,
      {
        max = 30,
        windowMs = 10_000,
        membership = false,
        ipMax,
      } = {},
    ) {
      socket.on(
        name,
        async (
          payload,
          ack,
        ) => {
          // Socket.IO emits no payload
          // for some controls.
          if (
            typeof payload
            === 'function'
          ) {
            ack = payload;
            payload = {};
          }

          const reply =
            value => {
              if (
                typeof ack
                === 'function'
              ) {
                ack(value);
              }
            };

          if (
            closed
            || !socket.connected
          ) {
            return reply(
              fail(
                '连接已断开。',
              ),
            );
          }

          if (
            !consume(
              limits,
              name,
              max,
              windowMs,
            )
            || (
              ipMax
              && !consume(
                ipLimits,
                `${ip}:${name}`,
                ipMax,
                windowMs,
              )
            )
          ) {
            return reply(
              fail(
                '操作过于频繁，请稍后重试。',
              ),
            );
          }

          if (
            membership
            && membershipBusy
          ) {
            return reply(
              fail(
                '正在处理入房请求，请稍后重试。',
              ),
            );
          }

          if (membership) {
            membershipBusy =
              true;
          }

          try {
            if (
              !isRecord(
                payload ?? {},
              )
            ) {
              throw new Error(
                '请求格式错误。',
              );
            }

            reply(
              await handler(
                payload ?? {},
              ),
            );
          } catch (error) {
            reply(
              fail(
                error
                  instanceof Error
                  ? error.message
                  : '请求失败，请稍后重试。',
              ),
            );
          } finally {
            if (membership) {
              membershipBusy =
                false;
            }
          }
        },
      );
    }

    event(
      'room:create',
      async payload => {
        if (
          createKey
          && !safeEqual(
            createKey,
            payload.createKey,
          )
        ) {
          throw new Error(
            '节点管理密码不正确；请填写部署时设置的 SERVER_CREATE_KEY。',
          );
        }

        if (
          socket.data
            .shareRoomId
        ) {
          throw new Error(
            '请先离开当前房间。',
          );
        }

        if (
          rooms.size
          >= MAX_ROOMS
        ) {
          throw new Error(
            '当前房间过多，请稍后重试。',
          );
        }

        const name =
          cleanText(
            payload.name,
            64,
            '房间名称',
          );

        const nickname =
          cleanText(
            payload.nickname,
            32,
            '昵称',
          );

        const password =
          passwordInput(
            payload.password,
          );

        const generation =
          membershipGeneration;

        const salt =
          randomBytes(16);

        const passwordHash =
          password
            ? await scrypt(
              password,
              salt,
              32,
            )
            : null;

        if (
          generation
          !== membershipGeneration
          || !socket.connected
          || closed
        ) {
          throw new Error(
            '入房请求已取消。',
          );
        }

        if (
          rooms.size
          >= MAX_ROOMS
        ) {
          throw new Error(
            '当前房间过多，请稍后重试。',
          );
        }

        let id;

        do {
          id = randomBytes(4)
            .toString('hex')
            .toUpperCase();
        } while (
          rooms.has(id)
        );

        const room = {
          id,

          path:
            `room-${id}`,

          name,
          salt,
          passwordHash,

          members:
            new Map(),

          messages: [],

          nextMessageSeq:
            1,

          streams:
            new Map(),

          claims:
            new Map(),

          viewers:
            new Map(),

          iceServers:
            cleanIceServers(
              payload.iceServers,
            ),
        };

        rooms.set(
          id,
          room,
        );

        return addMember(
          socket,
          room,
          nickname,
          'owner',
        );
      },
      {
        max: 3,
        windowMs: 60_000,
        membership: true,
        ipMax: 12,
      },
    );

    event(
      'room:ping',
      () => {
        current(socket);
        return { ok: true };
      },
      {
        max: 30,
        windowMs: 60_000,
      },
    );

    event(
      'room:join',
      async payload => {
        if (
          socket.data
            .shareRoomId
        ) {
          throw new Error(
            '请先离开当前房间。',
          );
        }

        const roomId =
          cleanText(
            payload.roomId,
            32,
            '房间号',
          );

        const nickname =
          cleanText(
            payload.nickname,
            32,
            '昵称',
          );

        const password =
          passwordInput(
            payload.password,
          );

        const room =
          rooms.get(roomId);

        if (!room) {
          throw new Error(
            '房间不存在或已关闭。',
          );
        }

        if (
          payload.requirePassword
          === true
          && !room.passwordHash
        ) {
          throw new Error(
            '此房间只能通过完整安全邀请链接加入。',
          );
        }

        if (
          room.members.size
          >= MAX_MEMBERS
        ) {
          throw new Error(
            '房间已满，最多 10 人。',
          );
        }

        const generation =
          membershipGeneration;

        if (
          room.passwordHash
        ) {
          const candidate =
            await scrypt(
              password,
              room.salt,
              32,
            );

          if (
            !timingSafeEqual(
              candidate,
              room.passwordHash,
            )
          ) {
            throw new Error(
              '房间密码错误。',
            );
          }
        }

        if (
          generation
          !== membershipGeneration
          || !socket.connected
          || closed
        ) {
          throw new Error(
            '入房请求已取消。',
          );
        }

        if (
          rooms.get(roomId)
          !== room
        ) {
          throw new Error(
            '房间已关闭。',
          );
        }

        return addMember(
          socket,
          room,
          nickname,
          'user',
          socket.id,
        );
      },
      {
        max: 12,
        windowMs: 60_000,
        membership: true,
        ipMax: 60,
      },
    );

    event(
      'room:migration-export',
      payload => {
        const {
          room,
          member,
        } = current(socket);

        if (
          member.role
          !== 'owner'
        ) {
          throw new Error(
            '只有当前房主可以迁移房间。',
          );
        }

        const remaining =
          [
            ...room.members.values(),
          ]
            .filter(
              candidate =>
                candidate.id
                !== member.id,
            )
            .sort(
              (
                left,
                right,
              ) =>
                left.joinedAt
                - right.joinedAt,
            );

        if (
          !remaining.length
        ) {
          throw new Error(
            '没有可接管房间的成员。',
          );
        }

        const candidateIds =
          new Set(
            Array.isArray(
              payload?.candidateIds,
            )
              ? payload
                .candidateIds
                .filter(
                  id =>
                    typeof id
                    === 'string',
                )
              : [],
          );

        const successor =
          remaining.find(
            candidate =>
              candidateIds
                .has(
                  candidate.id,
                ),
          );

        if (!successor) {
          throw new Error(
            '当前没有可接管房间的P2P成员。',
          );
        }

        const successorId =
          successor.id;

        const tickets = {};

        const members =
          remaining.map(
            candidate => {
              const resumeToken =
                randomBytes(32)
                  .toString(
                    'base64url',
                  );

              tickets[
                candidate.id
              ] = resumeToken;

              return {
                id:
                  candidate.id,

                name:
                  candidate.name,

                avatarColor:
                  candidate.avatarColor,

                sharing:
                  candidate.sharing,

                joinedAt:
                  candidate.joinedAt,

                role:
                  candidate.id
                    === successorId
                    ? 'owner'
                    : candidate.role
                      === 'owner'
                      ? 'user'
                      : candidate.role,

                canShare:
                  candidate.id
                    === successorId
                    ? true
                    : candidate.canShare,

                ticketHash:
                  tokenHash(
                    resumeToken,
                  ),
              };
            },
          );

        const memberIds =
          new Set(
            members.map(
              candidate =>
                candidate.id,
            ),
          );

        const streams =
          [
            ...room.streams.values(),
          ]
            .filter(
              stream =>
                memberIds.has(
                  stream.memberId,
                ),
            )
            .map(
              stream => ({
                ...stream,

                settings:
                  shareSettings(
                    stream.settings,
                  ),
              }),
            );

        const viewers =
          [
            ...room.viewers,
          ].flatMap(
            ([
              ownerId,
              entries,
            ]) =>
              memberIds.has(
                ownerId,
              )
                ? [
                  ...entries.values(),
                ]
                  .filter(
                    viewer =>
                      memberIds.has(
                        viewer.memberId,
                      ),
                  )
                  .map(
                    viewer => ({
                      ownerId,

                      memberId:
                        viewer.memberId,

                      name:
                        viewer.name,

                      lastSeen:
                        viewer.lastSeen,
                    }),
                  )
                : [],
          );

        const transfer = {
            version: 2,

            roomId:
              room.id,

            name:
              room.name,

            salt:
              room.salt
                .toString(
                  'base64',
                ),

            passwordHash:
              room.passwordHash
                ?.toString(
                  'base64',
                )
              || '',

            members,
            streams,
            viewers,

            messages:
              room.messages
                .slice(
                  -MAX_MESSAGES,
                )
                .map(
                  item => ({
                    ...item,
                  }),
                ),

            nextMessageSeq:
              room.nextMessageSeq,

            iceServers:
              room.iceServers,

            ttlMs:
              MIGRATION_TIMEOUT_MS,
        };

        // Leave room for the migration-create envelope below Socket.IO's 64 KiB limit.
        let transferBytes = Buffer.byteLength(JSON.stringify(transfer), 'utf8');
        while (transferBytes > MIGRATION_TRANSFER_MAX_BYTES) {
          if (!transfer.messages.length) throw new Error('房间迁移状态超过大小限制。');
          const removed = transfer.messages.shift();
          transferBytes -= Buffer.byteLength(JSON.stringify(removed), 'utf8') + (transfer.messages.length ? 1 : 0);
        }

        return { ok: true, successorId, tickets, transfer };
      },
      {
        max: 2,
        windowMs: 60_000,
      },
    );

    event(
      'room:migration-create',
      payload => {
        if (
          !isTrustedLocalSocket(
            socket,
          )
        ) {
          throw new Error(
            '房间迁移只能由本机协调器完成。',
          );
        }

        if (
          socket.data
            .shareRoomId
        ) {
          throw new Error(
            '请先离开当前房间。',
          );
        }

        const transfer =
          payload.transfer;

        if (
          !isRecord(transfer)
          || transfer.version !== 2
          || !Number.isSafeInteger(
            transfer.ttlMs,
          )
          || transfer.ttlMs < 1000
          || transfer.ttlMs
          > MIGRATION_TIMEOUT_MS
        ) {
          throw new Error(
            '房间迁移数据无效或已过期。',
          );
        }

        const roomId =
          typeof transfer.roomId
            === 'string'
            ? transfer.roomId
            : '';

        if (
          !/^[A-F0-9]{8}$/.test(
            roomId,
          )
          || rooms.has(roomId)
          || rooms.size
          >= MAX_ROOMS
        ) {
          throw new Error(
            '迁移房间号不可用。',
          );
        }

        const members =
          Array.isArray(
            transfer.members,
          )
            ? transfer.members
            : [];

        if (
          members.length < 1
          || members.length
          > MAX_MEMBERS
        ) {
          throw new Error(
            '迁移成员列表无效。',
          );
        }

        const successorId =
          typeof payload.memberId
            === 'string'
            ? payload.memberId
            : '';

        const own =
          members.find(
            candidate =>
              candidate?.id
              === successorId,
          );

        const takeoverHash =
          typeof payload.ticket
            === 'string'
            ? tokenHash(
              payload.ticket,
            )
            : '';

        if (
          !own
          || own.role !== 'owner'
          || !takeoverHash
          || consumedMigrationTickets
            .has(takeoverHash)
          || !safeEqual(
            takeoverHash,
            own.ticketHash,
          )
        ) {
          throw new Error(
            '迁移接管凭据无效或已使用。',
          );
        }

        const seen =
          new Set();

        const restored =
          members.map(
            candidate => {
              if (
                !isRecord(
                  candidate,
                )
                || typeof candidate.id
                !== 'string'
                || candidate.id.length < 1
                || candidate.id.length > 128
                || seen.has(
                  candidate.id,
                )
              ) {
                throw new Error(
                  '迁移成员标识无效。',
                );
              }

              seen.add(
                candidate.id,
              );

              const name =
                cleanText(
                  candidate.name,
                  32,
                  '昵称',
                );

              const role =
                [
                  'owner',
                  'admin',
                  'user',
                ].includes(
                  candidate.role,
                )
                  ? candidate.role
                  : 'user';

              if (
                !/^[a-f0-9]{64}$/
                  .test(
                    candidate.ticketHash
                    || '',
                  )
              ) {
                throw new Error(
                  '迁移恢复票据无效。',
                );
              }

              const avatarColor =
                Number.isInteger(
                  candidate.avatarColor,
                )
                  && candidate.avatarColor
                  >= 0
                  && candidate.avatarColor
                  < MAX_MEMBERS
                  ? candidate.avatarColor
                  : -1;

              return {
                id:
                  candidate.id,

                name,
                avatarColor,

                sharing:
                  candidate.sharing
                  === true,

                joinedAt:
                  Number.isSafeInteger(
                    candidate.joinedAt,
                  )
                    ? candidate.joinedAt
                    : Date.now(),

                role,

                canShare:
                  candidate.canShare
                  !== false,

                ticketHash:
                  candidate.ticketHash,
              };
            },
          );

        const usedAvatarColors =
          new Set();

        for (
          const candidate
          of restored
        ) {
          if (
            candidate.avatarColor
            < 0
            || usedAvatarColors
              .has(
                candidate.avatarColor,
              )
          ) {
            candidate.avatarColor =
              Array.from(
                {
                  length:
                    MAX_MEMBERS,
                },
                (
                  _,
                  index,
                ) => index,
              ).find(
                index =>
                  !usedAvatarColors
                    .has(index),
              )
              ?? 0;
          }

          usedAvatarColors.add(
            candidate.avatarColor,
          );
        }

        if (
          restored.filter(
            candidate =>
              candidate.role
              === 'owner',
          ).length !== 1
          || restored.find(
            candidate =>
              candidate.role
              === 'owner',
          )?.id !== successorId
        ) {
          throw new Error(
            '迁移房主状态无效。',
          );
        }

        const salt =
          Buffer.from(
            String(
              transfer.salt
              || '',
            ),
            'base64',
          );

        const passwordHash =
          transfer.passwordHash
            ? Buffer.from(
              String(
                transfer.passwordHash,
              ),
              'base64',
            )
            : null;

        if (
          salt.length !== 16
          || (
            passwordHash
            && passwordHash.length
            !== 32
          )
        ) {
          throw new Error(
            '迁移密码状态无效。',
          );
        }

        const room = {
          id:
            roomId,

          path:
            `room-${roomId}`,

          name:
            cleanText(
              transfer.name,
              64,
              '房间名称',
            ),

          salt,
          passwordHash,

          members:
            new Map(),

          messages: [],

          nextMessageSeq:
            1,

          streams:
            new Map(),

          claims:
            new Map(),

          viewers:
            new Map(),

          iceServers:
            cleanIceServers(
              transfer.iceServers,
            ),

          migrationTickets:
            new Map(),

          migrationDeadline:
            performance.now()
            + transfer.ttlMs,

          migrationPrepared:
            true,
        };

        for (
          const candidate
          of restored
        ) {
          const bound =
            candidate.id
            === successorId;

          const restoredMember = {
            ...candidate,

            readToken:
              bound
                ? token()
                : '',

            ownerToken:
              bound
                ? token()
                : '',

            socket:
              bound
                ? socket
                : null,
          };

          delete restoredMember
            .ticketHash;

          room.members.set(
            candidate.id,
            restoredMember,
          );

          room.migrationTickets
            .set(
              candidate.ticketHash,
              candidate.id,
            );

          if (bound) {
            readers.set(
              restoredMember
                .readToken,
              {
                roomId,

                memberId:
                  candidate.id,
              },
            );
          }
        }

        const messages =
          Array.isArray(
            transfer.messages,
          )
            ? transfer.messages
              .slice(
                -MAX_MESSAGES,
              )
            : [];

        room.messages =
          messages
            .filter(
              item =>
                isRecord(item)
                && typeof item.id
                === 'string'
                && item.id.length
                <= 64
                && Number.isSafeInteger(
                  item.seq,
                )
                && item.seq > 0
                && typeof item.name
                === 'string'
                && item.name.length
                <= 32
                && typeof item.text
                === 'string'
                && item.text.length
                <= 2000
                && Number.isFinite(
                  item.at,
                ),
            )
            .map(
              item => ({
                ...item,

                text:
                  item.text
                    .slice(
                      0,
                      2000,
                    ),
              }),
            );

        room.nextMessageSeq =
          Math.max(
            Number.isSafeInteger(
              transfer.nextMessageSeq,
            )
              ? transfer.nextMessageSeq
              : 1,

            (
              room.messages.at(-1)
                ?.seq
              || 0
            ) + 1,
          );

        for (
          const raw
          of Array.isArray(
            transfer.streams,
          )
            ? transfer.streams
            : []
        ) {
          if (
            !isRecord(raw)
            || !room.members
              .has(
                raw.memberId,
              )
          ) {
            continue;
          }

          room.streams.set(
            raw.memberId,
            {
              memberId:
                raw.memberId,

              name:
                room.members
                  .get(
                    raw.memberId,
                  )
                  .name,

              avatarColor:
                room.members
                  .get(
                    raw.memberId,
                  )
                  .avatarColor,

              path:
                room.path,

              startedAt:
                Number.isSafeInteger(
                  raw.startedAt,
                )
                  ? raw.startedAt
                  : Date.now(),

              microphone:
                raw.microphone
                === true,

              settings:
                shareSettings(
                  raw.settings,
                ),
            },
          );

          room.claims.set(
            raw.memberId,
            {
              memberId:
                raw.memberId,

              timer:
                null,
            },
          );

          room.viewers.set(
            raw.memberId,
            new Map(),
          );
        }

        for (
          const raw
          of Array.isArray(
            transfer.viewers,
          )
            ? transfer.viewers
            : []
        ) {
          if (
            !isRecord(raw)
            || !room.streams
              .has(
                raw.ownerId,
              )
            || !room.members
              .has(
                raw.memberId,
              )
            || raw.ownerId
            === raw.memberId
          ) {
            continue;
          }

          room.viewers
            .get(
              raw.ownerId,
            )
            .set(
              raw.memberId,
              {
                memberId:
                  raw.memberId,

                name:
                  room.members
                    .get(
                      raw.memberId,
                    )
                    .name,

                avatarColor:
                  room.members
                    .get(
                      raw.memberId,
                    )
                    .avatarColor,

                lastSeen:
                  Date.now(),
              },
            );
        }

        rooms.set(
          roomId,
          room,
        );

        consumedMigrationTickets
          .set(
            takeoverHash,
            room.migrationDeadline,
          );

        socket.data.shareRoomId =
          roomId;

        socket.data.memberId =
          successorId;

        room.migrationTickets
          .delete(
            own.ticketHash,
          );

        const owner =
          room.members.get(
            successorId,
          );

        message(
          room,
          null,
          `${owner.name} 已接管房间连接`,
          true,
        );

        broadcast(room);

        return {
          ok: true,

          selfId:
            successorId,

          room:
            snapshot(room),

          readToken:
            owner.readToken,

          ownerToken:
            owner.ownerToken,

          iceServers:
            room.iceServers?.length
              ? room.iceServers
              : getIceServers(
                successorId,
              ),
        };
      },
      {
        max: 2,
        windowMs: 60_000,
        membership: true,
      },
    );

    event(
      'room:migration-commit',
      () => {
        const {
          room,
          member,
        } = current(socket);

        if (
          !isTrustedLocalSocket(
            socket,
          )
          || member.role
          !== 'owner'
          || !room.migrationPrepared
        ) {
          throw new Error(
            '迁移提交状态无效。',
          );
        }

        room.migrationPrepared =
          false;

        return {
          ok: true,
        };
      },
      {
        max: 2,
        windowMs: 60_000,
      },
    );

    event(
      'room:migration-abort',
      () => {
        const {
          room,
          member,
        } = current(socket);

        if (
          !isTrustedLocalSocket(
            socket,
          )
          || member.role
          !== 'owner'
          || !room.migrationPrepared
        ) {
          throw new Error(
            '迁移回滚状态无效。',
          );
        }

        for (
          const claim
          of room.claims.values()
        ) {
          if (claim.timer) {
            clearTimeout(
              claim.timer,
            );
          }
        }

        for (
          const candidate
          of room.members.values()
        ) {
          if (
            candidate.readToken
          ) {
            readers.delete(
              candidate.readToken,
            );
          }
        }

        room.migrationTickets
          .clear();

        rooms.delete(
          room.id,
        );

        delete socket.data
          .shareRoomId;

        delete socket.data
          .memberId;

        try {
          onRoomClosed(
            room.id,
          );
        } catch { }

        return {
          ok: true,
        };
      },
      {
        max: 2,
        windowMs: 60_000,
      },
    );

    event(
      'room:migration-join',
      payload => {
        if (
          socket.data
            .shareRoomId
        ) {
          throw new Error(
            '迁移恢复请求无效。',
          );
        }

        const roomId =
          typeof payload.roomId
            === 'string'
            ? payload.roomId
            : '';

        const resumeToken =
          typeof payload.ticket
            === 'string'
            ? payload.ticket
            : '';

        if (
          !/^[A-F0-9]{8}$/
            .test(roomId)
          || !/^[A-Za-z0-9_-]{43}$/
            .test(
              resumeToken,
            )
        ) {
          throw new Error(
            '迁移恢复票据无效。',
          );
        }

        const room =
          rooms.get(roomId);

        const ticketHash =
          tokenHash(
            resumeToken,
          );

        const memberId =
          room?.migrationDeadline
            > performance.now()
            ? room
              .migrationTickets
              ?.get(
                ticketHash,
              )
            : '';

        const member =
          memberId
            ? room.members
              .get(memberId)
            : null;

        if (
          !room
          || !member
          || member.socket
        ) {
          throw new Error(
            '迁移恢复票据无效或已使用。',
          );
        }

        member.socket =
          socket;

        member.readToken =
          token();

        readers.set(
          member.readToken,
          {
            roomId,
            memberId,
          },
        );

        room.migrationTickets
          .delete(
            ticketHash,
          );

        socket.data.shareRoomId =
          roomId;

        socket.data.memberId =
          memberId;

        broadcast(room);

        return {
          ok: true,

          selfId:
            memberId,

          room:
            snapshot(room),

          readToken:
            member.readToken,

          iceServers:
            room.iceServers?.length
              ? room.iceServers
              : getIceServers(
                memberId,
              ),
        };
      },
      {
        max: 4,
        windowMs: 60_000,
        membership: true,
      },
    );

    event(
      'room:leave',
      () => {
        membershipGeneration += 1;

        for (
          const upload
          of uploads.values()
        ) {
          clearTimeout(
            upload.timer,
          );

          if (
            upload.started
          ) {
            for (
              const recipient
              of upload.room
                .members
                .values()
            ) {
              if (
                recipient.id
                !== (
                  socket.data.memberId
                  || socket.id
                )
              ) {
                recipient.socket?.emit(
                  'image:abort',
                  {
                    messageId:
                      upload.messageId,
                  },
                );
              }
            }
          }
        }

        uploads.clear();
        for (const batch of [...imageBatches.values()]) abortImageBatch(batch);

        removeMember(
          socket,
          'leave',
        );

        return {
          ok: true,
        };
      },
    );

    event(
      'member:role',
      payload => {
        const {
          room,
          member,
        } = current(socket);

        if (
          member.role
          !== 'owner'
        ) {
          throw new Error(
            '只有房主可以设置管理员。',
          );
        }

        const target =
          room.members.get(
            payload.memberId,
          );

        if (
          !target
          || target.id
          === member.id
          || target.role
          === 'owner'
        ) {
          throw new Error(
            '无法修改该成员角色。',
          );
        }

        if (
          ![
            'admin',
            'user',
          ].includes(
            payload.role,
          )
        ) {
          throw new Error(
            '成员角色无效。',
          );
        }

        target.role =
          payload.role;

        message(
          room,
          null,
          `${target.name} 已被设为${target.role === 'admin' ? '管理员' : '用户'}`,
          true,
        );

        broadcast(room);

        return {
          ok: true,
        };
      },
    );

    event(
      'member:share-permission',
      payload => {
        const {
          room,
          member,
        } = current(socket);

        if (
          ![
            'owner',
            'admin',
          ].includes(
            member.role,
          )
        ) {
          throw new Error(
            '只有房主或管理员可以管理共享权限。',
          );
        }

        const target =
          room.members.get(
            payload.memberId,
          );

        if (
          !target
          || target.role
          === 'owner'
          || target.id
          === member.id
        ) {
          throw new Error(
            '无法修改该成员的共享权限。',
          );
        }

        if (
          typeof payload.canShare
          !== 'boolean'
        ) {
          throw new Error(
            '共享权限格式错误。',
          );
        }

        target.canShare =
          payload.canShare;

        if (
          !target.canShare
        ) {
          releaseStream(
            room,
            target.id,
          );
        }

        message(
          room,
          null,
          `${member.name} 已${target.canShare ? '允许' : '禁止'} ${target.name} 共享屏幕`,
          true,
        );

        broadcast(room);

        return {
          ok: true,
        };
      },
    );

    event(
      'member:kick',
      payload => {
        const {
          room,
          member,
        } = current(socket);

        if (
          ![
            'owner',
            'admin',
          ].includes(
            member.role,
          )
        ) {
          throw new Error(
            '只有房主或管理员可以踢出成员。',
          );
        }

        const target =
          room.members.get(
            payload.memberId,
          );

        if (
          !target
          || target.id
          === member.id
          || target.role
          === 'owner'
        ) {
          throw new Error(
            '无法踢出该成员。',
          );
        }

        if (
          !target.socket
        ) {
          throw new Error(
            '该成员正在恢复连接，请稍后重试。',
          );
        }

        target.socket
          .data.kicked =
          true;

        target.socket.emit(
          'room:kicked',
          {
            error:
              `你已被 ${member.name} 移出房间。`,
          },
        );

        message(
          room,
          null,
          `${target.name} 已被 ${member.name} 移出房间`,
          true,
        );

        setTimeout(
          () =>
            target.socket
              .disconnect(true),
          120,
        ).unref?.();

        return {
          ok: true,
        };
      },
      {
        max: 10,
        windowMs: 60_000,
      },
    );

    event(
      'chat:send',
      payload => {
        const {
          room,
          member,
        } = current(socket);

        const text =
          cleanText(
            payload.text,
            2000,
            '消息',
            {
              multiline: true,
            },
          );

        return {
          ok: true,

          message:
            message(
              room,
              member,
              text,
            ),
        };
      },
      {
        max: 8,
      },
    );

    event(
      'chat:recall',
      payload => {
        const {
          room,
          member,
        } = current(socket);

        if (
          typeof payload.messageId
          !== 'string'
          || payload.messageId.length
          > 64
        ) {
          throw new Error(
            '消息标识无效。',
          );
        }

        const item =
          room.messages.find(
            candidate =>
              candidate.id
              === payload.messageId,
          );

        if (
          !item
          || item.system
        ) {
          throw new Error(
            '消息不存在。',
          );
        }

        if (
          item.memberId
          !== member.id
        ) {
          throw new Error(
            '只能撤回自己的消息。',
          );
        }

        if (!item.recalled) {
          item.recalled =
            true;

          item.text = '';

          for (
            const recipient
            of room.members.values()
          ) {
            recipient.socket?.emit(
              'chat:recalled',
              {
                ...item,
              },
            );
          }
        }

        return {
          ok: true,

          message: {
            ...item,
          },
        };
      },
      {
        max: 10,
        windowMs: 60_000,
      },
    );

    event(
      'image:init',
      payload => {
        const {
          room,
          member,
        } = current(socket);

        if (
          uploads.size >= 2
        ) {
          throw new Error(
            '同时最多发送 2 张图片。',
          );
        }

        const mime =
          typeof payload.mime
            === 'string'
            ? payload.mime
              .toLowerCase()
            : '';

        const size =
          Number(
            payload.size,
          );

        if (
          !IMAGE_TYPES.has(
            mime,
          )
        ) {
          throw new Error(
            '仅支持 JPG、PNG、WebP 和 GIF 图片。',
          );
        }

        if (
          !Number.isSafeInteger(
            size,
          )
          || size < 1
          || size
          > IMAGE_MAX_BYTES
        ) {
          throw new Error(
            '图片大小不能超过 10MB。',
          );
        }

        const name =
          cleanText(
            payload.name
            || '图片',
            120,
            '文件名',
          );

        const text =
          cleanText(
            payload.text,
            2000,
            '消息',
            {
              multiline: true,
              optional: true,
            },
          );

        if (
          !/\.(?:jpe?g|png|webp|gif)$/i
            .test(name)
          || /\.(?:svg|html?|exe|dll|com|bat|cmd|msi)$/i
            .test(name)
        ) {
          throw new Error(
            '图片文件扩展名不受支持。',
          );
        }

        const batchId =
          typeof payload.batchId === 'string'
            ? payload.batchId.trim()
            : '';
        const batchMode = batchId.length > 0;
        const batchCount = Number(payload.batchCount);
        const batchIndex = Number(payload.batchIndex);
        let batch = null;

        if (batchMode) {
          if (
            !/^[A-Za-z0-9_-]{8,64}$/.test(batchId)
            || !Number.isSafeInteger(batchCount)
            || batchCount < 2
            || batchCount > IMAGE_BATCH_MAX
            || !Number.isSafeInteger(batchIndex)
            || batchIndex < 0
            || batchIndex >= batchCount
          ) {
            throw new Error('多图发送参数无效。');
          }

          batch = imageBatches.get(batchId);
          if (!batch) {
            if (batchIndex !== 0) throw new Error('多图发送顺序无效。');
            batch = {
              id: batchId,
              room,
              member,
              count: batchCount,
              text,
              items: Array(batchCount).fill(null),
              slots: new Set(),
              imageIds: new Set(),
              messageId: null,
              timer: null,
            };
            imageBatches.set(batchId, batch);
          } else if (
            batch.room !== room
            || batch.member !== member
            || batch.count !== batchCount
          ) {
            throw new Error('多图发送批次已失效。');
          }

          if (batch.slots.has(batchIndex)) {
            throw new Error('多图发送索引重复。');
          }
          batch.slots.add(batchIndex);
          armImageBatch(batch);
        }

        const uploadId =
          randomUUID();

        const messageId =
          randomUUID();

        if (batch) {
          batch.imageIds.add(messageId);
          if (batchIndex === 0) batch.messageId = messageId;
        }

        const upload = {
          uploadId,
          messageId,
          room,
          member,
          mime,
          size,
          name,
          text,
          batchId: batch?.id || '',
          batchIndex: batch ? batchIndex : -1,
          received: 0,
          nextIndex: 0,
          started: false,
          timer: null,
        };

        upload.timer =
          setTimeout(
            () => {
              uploads.delete(
                uploadId,
              );

              if (upload.batchId) {
                const activeBatch = imageBatches.get(upload.batchId);
                if (activeBatch) abortImageBatch(activeBatch);
                return;
              }

              if (
                upload.started
              ) {
                emitImageAbort(
                  room,
                  socket.data.memberId || socket.id,
                  messageId,
                );
              }
            },
            IMAGE_UPLOAD_TIMEOUT_MS,
          );

        upload.timer.unref?.();

        uploads.set(
          uploadId,
          upload,
        );

        return {
          ok: true,
          uploadId,
          messageId,
          chunkSize:
            IMAGE_CHUNK_BYTES,
        };
      },
      {
        max: 8,
        windowMs: 60_000,
        ipMax: 40,
      },
    );

    event(
      'image:chunk',
      payload => {
        const {
          room,
          member,
        } = current(socket);

        const upload =
          uploads.get(
            payload.uploadId,
          );

        if (
          !upload
          || upload.room
          !== room
          || upload.member
          !== member
        ) {
          throw new Error(
            '图片上传不存在或已过期。',
          );
        }

        if (
          !Number.isSafeInteger(
            payload.index,
          )
          || payload.index
          !== upload.nextIndex
        ) {
          throw new Error(
            '图片分块顺序错误。',
          );
        }

        const data =
          binary(
            payload.data,
          );

        if (
          !data.length
          || data.length
          > IMAGE_CHUNK_BYTES
          || upload.received
          + data.length
          > upload.size
        ) {
          uploads.delete(
            upload.uploadId,
          );

          clearTimeout(
            upload.timer,
          );

          throw new Error(
            '图片分块大小或声明长度无效。',
          );
        }

        if (
          payload.index === 0
          && !validImageMagic(
            upload.mime,
            data,
          )
        ) {
          uploads.delete(
            upload.uploadId,
          );

          clearTimeout(
            upload.timer,
          );

          throw new Error(
            '图片内容与 MIME 类型不匹配。',
          );
        }

        if (
          !upload.started
        ) {
          upload.started =
            true;

          for (
            const recipient
            of room.members.values()
          ) {
            if (
              recipient.id
              !== member.id
            ) {
              recipient.socket?.emit(
                'image:start',
                {
                  messageId:
                    upload.messageId,

                  memberId:
                    member.id,

                  name:
                    member.name,

                  fileName:
                    upload.name,

                  mime:
                    upload.mime,

                  size:
                    upload.size,
                },
              );
            }
          }
        }

        upload.received +=
          data.length;

        upload.nextIndex += 1;

        for (
          const recipient
          of room.members.values()
        ) {
          if (
            recipient.id
            !== member.id
          ) {
            recipient.socket?.emit(
              'image:chunk',
              {
                messageId:
                  upload.messageId,

                index:
                  payload.index,

                data,
              },
            );
          }
        }

        return {
          ok: true,

          received:
            upload.received,
        };
      },
      {
        max: 1200,
        windowMs: 60_000,
        ipMax: 4800,
      },
    );

    event(
      'image:complete',
      payload => {
        const {
          room,
          member,
        } = current(socket);

        const upload =
          uploads.get(
            payload.uploadId,
          );

        if (
          !upload
          || upload.room
          !== room
          || upload.member
          !== member
        ) {
          throw new Error(
            '图片上传不存在或已过期。',
          );
        }

        uploads.delete(
          upload.uploadId,
        );

        clearTimeout(
          upload.timer,
        );

        if (
          !upload.started
          || upload.received
          !== upload.size
        ) {
          if (upload.batchId) {
            const batch = imageBatches.get(upload.batchId);
            if (batch) abortImageBatch(batch);
          } else if (
            upload.started
          ) {
            emitImageAbort(room, member.id, upload.messageId);
          }

          throw new Error(
            '图片长度与声明不一致。',
          );
        }

        for (
          const recipient
          of room.members.values()
        ) {
          if (
            recipient.id
            !== member.id
          ) {
            recipient.socket?.emit(
              'image:complete',
              {
                messageId:
                  upload.messageId,
              },
            );
          }
        }

        if (upload.batchId) {
          const batch = imageBatches.get(upload.batchId);
          if (!batch) throw new Error('多图发送批次已失效。');

          batch.items[upload.batchIndex] = {
            id: upload.messageId,
            mime: upload.mime,
            size: upload.size,
            fileName: upload.name,
          };
          armImageBatch(batch);

          if (!batch.items.every(Boolean)) {
            return {
              ok: true,
              imageId: upload.messageId,
            };
          }

          clearTimeout(batch.timer);
          imageBatches.delete(batch.id);
          const first = batch.items[0];
          const item = message(
            room,
            member,
            batch.text,
            false,
            {
              id: batch.messageId,
              kind: 'image',
              mime: first.mime,
              size: first.size,
              fileName: first.fileName,
              images: batch.items,
            },
          );

          return {
            ok: true,
            imageId: upload.messageId,
            message: item,
          };
        }

        const item =
          message(
            room,
            member,
            upload.text,
            false,
            {
              id:
                upload.messageId,

              kind:
                'image',

              mime:
                upload.mime,

              size:
                upload.size,

              fileName:
                upload.name,
            },
          );

        return {
          ok: true,
          imageId: upload.messageId,
          message: item,
        };
      },
      {
        max: 8,
        windowMs: 60_000,
      },
    );

    event(
      'chat:history',
      payload => {
        const {
          room,
        } = current(socket);

        const limit =
          payload.limit
            === undefined
            ? CHAT_PAGE_SIZE
            : Number(
              payload.limit,
            );

        if (
          !Number.isInteger(
            limit,
          )
          || limit < 1
          || limit
          > CHAT_PAGE_SIZE
        ) {
          throw new Error(
            `每页消息数量须为 1–${CHAT_PAGE_SIZE}。`,
          );
        }

        const hasBefore =
          payload.beforeSeq
          !== undefined;

        const hasAfter =
          payload.afterSeq
          !== undefined;

        if (
          hasBefore
          && hasAfter
        ) {
          throw new Error(
            '历史消息游标无效。',
          );
        }

        const cursor =
          Number(
            hasBefore
              ? payload.beforeSeq
              : hasAfter
                ? payload.afterSeq
                : 0,
          );

        if (
          (
            hasBefore
            || hasAfter
          )
          && (
            !Number.isSafeInteger(
              cursor,
            )
            || cursor < 1
          )
        ) {
          throw new Error(
            '历史消息游标无效。',
          );
        }

        const candidates =
          hasAfter
            ? room.messages.filter(
              item =>
                item.seq
                > cursor,
            )
            : room.messages.filter(
              item =>
                !hasBefore
                || item.seq
                < cursor,
            );

        const page =
          hasAfter
            ? candidates.slice(
              0,
              limit,
            )
            : candidates.slice(
              -limit,
            );

        return {
          ok: true,
          messages: page,

          direction:
            hasAfter
              ? 'after'
              : 'before',

          hasMore:
            candidates.length
            > page.length,

          oldestSeq:
            page[0]?.seq
            ?? null,

          latestSeq:
            page.at(-1)
              ?.seq
            ?? null,
        };
      },
      {
        max: 20,
        windowMs: 10_000,
      },
    );

    event(
      'screen:signal',
      payload => {
        const {
          room,
        } = current(socket);

        if (
          !room.streams.size
          || typeof payload.to
          !== 'string'
          || !room.members
            .has(
              payload.to,
            )
        ) {
          throw new Error(
            '共享目标不在房间中。',
          );
        }

        if (
          payload.to
          === (
            socket.data.memberId
            || socket.id
          )
        ) {
          throw new Error(
            '本机预览不得使用房间屏幕信令。',
          );
        }

        if (
          ![
            'offer',
            'answer',
            'candidate',
            'close',
            'error',
            'vdo-request',
            'vdo-descriptor',
            'vdo-error',
          ].includes(
            payload.kind,
          )
          || typeof payload.requestId
          !== 'string'
          || !/^[a-zA-Z0-9_-]{1,64}$/
            .test(
              payload.requestId,
            )
        ) {
          throw new Error(
            '画面信令格式错误。',
          );
        }

        const viewerSide =
          [
            'offer',
            'close',
            'vdo-request',
          ].includes(
            payload.kind,
          )
          || (
            payload.kind
            === 'candidate'
            && payload.side
            === 'viewer'
          );

        if (
          viewerSide
            ? !room.streams
              .has(
                payload.to,
              )
            : !room.streams
              .has(
                socket.data.memberId
                || socket.id,
              )
        ) {
          throw new Error(
            '无权发送此画面信令。',
          );
        }

        if (
          payload.sdp
          !== undefined
          && (
            typeof payload.sdp
            !== 'string'
            || payload.sdp.length
            > 60000
          )
        ) {
          throw new Error(
            'SDP 过大。',
          );
        }

        if (
          payload.session
          !== undefined
          && (
            typeof payload.session
            !== 'string'
            || payload.session.length
            > 128
          )
        ) {
          throw new Error(
            '会话标识错误。',
          );
        }

        let route;

        if (
          payload.kind === 'offer'
        ) {
          route =
            payload.route
            || 'p2p';

          if (
            ![
              'p2p',
              'turn',
            ].includes(route)
          ) {
            throw new Error(
              '屏幕媒体路线无效。',
            );
          }
        } else if (
          payload.route
          !== undefined
        ) {
          throw new Error(
            '屏幕媒体路线位置错误。',
          );
        }

        let vdo;

        if (
          payload.kind
          === 'vdo-descriptor'
        ) {
          const value =
            payload.vdo;

          if (
            !isRecord(value)
            || value.version !== 1
            || typeof value.room !== 'string'
            || !/^[A-Za-z0-9_]{8,128}$/
              .test(value.room)
            || typeof value.streamId !== 'string'
            || !/^[A-Za-z0-9_]{8,128}$/
              .test(value.streamId)
            || typeof value.password !== 'string'
            || !/^[a-f0-9]{64}$/
              .test(value.password)
          ) {
            throw new Error(
              'VDO 连接描述格式错误。',
            );
          }

          vdo = {
            version: 1,
            room:
              value.room,
            streamId:
              value.streamId,
            password:
              value.password,
          };
        } else if (
          payload.vdo
          !== undefined
        ) {
          throw new Error(
            'VDO 连接描述位置错误。',
          );
        }

        const candidate =
          payload.kind
            === 'candidate'
            ? iceCandidate(
              payload.candidate,
            )
            : undefined;

        if (
          payload.kind
          === 'candidate'
          && ![
            'viewer',
            'publisher',
          ].includes(
            payload.side,
          )
        ) {
          throw new Error(
            'ICE 候选方向错误。',
          );
        }

        room.members
          .get(
            payload.to,
          )
          .socket
          ?.emit(
            'screen:signal',
            {
              from:
                socket.data.memberId
                || socket.id,

              kind:
                payload.kind,

              requestId:
                payload.requestId,

              sdp:
                payload.sdp,

              session:
                payload.session,

              candidate,

              side:
                payload.side,

              route,

              vdo,

              error:
                typeof payload.error
                  === 'string'
                  ? payload.error
                    .slice(
                      0,
                      300,
                    )
                  : undefined,
            },
          );

        return {
          ok: true,
        };
      },
      {
        max: 160,
      },
    );

    event(
      'view:start',
      payload => {
        const {
          room,
          member,
        } = current(socket);

        const ownerId =
          typeof payload.ownerId
            === 'string'
            ? payload.ownerId
            : '';

        if (
          ownerId === member.id
          || !room.streams
            .has(ownerId)
        ) {
          throw new Error(
            '观看目标无效。',
          );
        }

        if (
          !room.viewers
            .has(ownerId)
        ) {
          room.viewers.set(
            ownerId,
            new Map(),
          );
        }

        room.viewers
          .get(ownerId)
          .set(
            member.id,
            {
              memberId:
                member.id,

              name:
                member.name,

              avatarColor:
                member.avatarColor,

              lastSeen:
                Date.now(),
            },
          );

        broadcast(room);

        return {
          ok: true,
        };
      },
      {
        max: 12,
        windowMs: 10_000,
      },
    );

    event(
      'view:heartbeat',
      payload => {
        const {
          room,
          member,
        } = current(socket);

        const viewer =
          room.viewers
            .get(
              payload.ownerId,
            )
            ?.get(
              member.id,
            );

        if (
          !viewer
          || !room.streams
            .has(
              payload.ownerId,
            )
        ) {
          throw new Error(
            '观看状态不存在。',
          );
        }

        viewer.lastSeen =
          Date.now();

        return {
          ok: true,
        };
      },
      {
        max: 12,
        windowMs: 60_000,
      },
    );

    event(
      'view:stop',
      payload => {
        const {
          room,
          member,
        } = current(socket);

        const removed =
          room.viewers
            .get(
              payload.ownerId,
            )
            ?.delete(
              member.id,
            )
          || false;

        if (removed) {
          broadcast(room);
        }

        return {
          ok: true,
        };
      },
      {
        max: 20,
        windowMs: 10_000,
      },
    );

    event(
      'share:claim',
      () => {
        const {
          room,
          member,
        } = current(socket);

        if (
          !socket.connected
          || closed
        ) {
          throw new Error(
            '共享请求已取消。',
          );
        }

        if (
          !member.canShare
        ) {
          throw new Error(
            '你的屏幕共享权限已被管理员关闭。',
          );
        }

        if (
          room.claims
            .has(member.id)
        ) {
          return {
            ok: true,
          };
        }

        const claim = {
          memberId:
            member.id,

          timer:
            null,
        };

        claim.timer =
          setTimeout(
            () => {
              if (
                room.claims
                  .get(
                    member.id,
                  )
                !== claim
                || room.streams
                  .has(
                    member.id,
                  )
              ) {
                return;
              }

              releaseStream(
                room,
                member.id,
              );

              member.socket.emit(
                'share:expired',
                {
                  error:
                    '屏幕共享启动超时，请重新开始。',
                },
              );

              broadcast(room);
            },
            CLAIM_TIMEOUT_MS,
          );

        claim.timer.unref?.();

        room.claims.set(
          member.id,
          claim,
        );

        return {
          ok: true,
        };
      },
      {
        max: 15,
      },
    );

    event(
      'share:started',
      payload => {
        const {
          room,
          member,
        } = current(socket);

        const claim =
          room.claims.get(
            member.id,
          );

        if (!claim) {
          throw new Error(
            '请先申请屏幕共享。',
          );
        }

        if (
          !member.canShare
        ) {
          throw new Error(
            '你的屏幕共享权限已被管理员关闭。',
          );
        }

        if (claim.timer) {
          clearTimeout(
            claim.timer,
          );
        }

        claim.timer = null;

        if (
          !room.streams
            .has(member.id)
        ) {
          room.streams.set(
            member.id,
            {
              memberId:
                member.id,

              name:
                member.name,

              avatarColor:
                member.avatarColor,

              path:
                room.path,

              startedAt:
                Date.now(),

              microphone:
                payload.microphone
                === true,

              settings:
                shareSettings(
                  payload.settings,
                ),
            },
          );
        }

        member.sharing =
          true;

        broadcast(room);

        return {
          ok: true,
        };
      },
      {
        max: 15,
      },
    );

    event(
      'share:stop',
      () => {
        const {
          room,
          member,
        } = current(socket);

        if (
          !room.claims
            .has(member.id)
          && !room.streams
            .has(member.id)
        ) {
          throw new Error(
            '没有正在进行的共享。',
          );
        }

        releaseStream(
          room,
          member.id,
        );

        broadcast(room);

        return {
          ok: true,
        };
      },
      {
        max: 15,
      },
    );

    socket.on(
      'disconnect',
      () => {
        membershipGeneration += 1;

        for (
          const upload
          of uploads.values()
        ) {
          clearTimeout(
            upload.timer,
          );

          if (
            upload.started
          ) {
            for (
              const recipient
              of upload.room
                .members
                .values()
            ) {
              if (
                recipient.id
                !== (
                  socket.data.memberId
                  || socket.id
                )
              ) {
                recipient.socket?.emit(
                  'image:abort',
                  {
                    messageId:
                      upload.messageId,
                  },
                );
              }
            }
          }
        }

        uploads.clear();
        for (const batch of [...imageBatches.values()]) abortImageBatch(batch);

        removeMember(
          socket,
        );

        sockets.delete(
          socket,
        );
      },
    );
  }

  io.on(
    'connection',
    connect,
  );


  return {
    rooms,

    isOwner(
      roomId,
      ownerToken,
    ) {
      const room =
        rooms.get(roomId);

      const owner =
        room
        && [
          ...room.members.values(),
        ].find(
          member =>
            member.role
            === 'owner',
        );

      return Boolean(
        owner
        && typeof ownerToken
        === 'string'
        && safeEqual(
          owner.ownerToken,
          ownerToken,
        ),
      );
    },

    summary: () => ({
      rooms:
        rooms.size,

      members:
        [
          ...rooms.values(),
        ].reduce(
          (
            sum,
            room,
          ) =>
            sum
            + room.members.size,
          0,
        ),

      streams:
        [
          ...rooms.values(),
        ].reduce(
          (
            sum,
            room,
          ) =>
            sum
            + room.streams.size,
          0,
        ),

      maxMembers:
        MAX_MEMBERS,
    }),

    async close() {
      if (closed) {
        return;
      }

      closed = true;

      clearInterval(
        prune,
      );

      io.off(
        'connection',
        connect,
      );

      for (
        const socket
        of sockets
      ) {
        removeMember(
          socket,
        );
      }

      sockets.clear();
      readers.clear();
      consumedMigrationTickets.clear();
      rooms.clear();
      ipLimits.clear();

    },
  };
}
