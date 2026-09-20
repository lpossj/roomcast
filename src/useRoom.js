import { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { containsTurn, mediaIceServers } from './ice-policy.js';
import { ack, normalizeServer } from './lib.js';
import { P2PRoom } from './p2p.js';
import { imageDimensionsAllowed, imageMagicMatches, MAX_IMAGE_CACHE_BYTES, readImageDimensions } from './image-policy.js';
import { savePreference } from './preferences.js';
import { playSound } from './sounds.js';

// JPEG dimension markers can follow large metadata blocks. Keep parsing bounded
// by the existing maximum accepted image size instead of truncating valid headers.
const MAX_IMAGE_HEADER_BYTES = 10 * 1024 * 1024;

function imageHeaderBytes(chunks) {
  const total = Math.min(
    MAX_IMAGE_HEADER_BYTES,
    chunks.reduce((sum, chunk) => sum + (chunk?.byteLength || 0), 0),
  );
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    if (!chunk || offset >= total) continue;
    const bytes = new Uint8Array(chunk);
    const take = Math.min(bytes.byteLength, total - offset);
    result.set(bytes.subarray(0, take), offset);
    offset += take;
  }
  return result;
}

export default function useRoom(onError) {
  const [room, setRoom] = useState(null);
  const [selfId, setSelfId] = useState('');
  const [server, setServer] = useState(window.location.origin);
  const [readToken, setReadToken] = useState('');
  const [ownerToken, setOwnerToken] = useState('');
  const [config, setConfig] = useState(null);
  const [connection, setConnection] = useState('idle');
  const [messages, setMessages] = useState([]);
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const socketRef = useRef(null);
  const errorRef = useRef(onError);
  const membersRef = useRef(null);
  const messagesRef = useRef([]);
  const historyBusyRef = useRef(false);
  const incomingImagesRef = useRef(new Map());
  const imageUrlsRef = useRef(new Map());
  const imageUrlSizesRef = useRef(new Map());
  const imageCacheBytesRef = useRef(0);

  errorRef.current = onError;

  const revokeImageUrl = useCallback(messageId => {
    const url = imageUrlsRef.current.get(messageId);
    if (url) URL.revokeObjectURL(url);
    imageUrlsRef.current.delete(messageId);
    const size = imageUrlSizesRef.current.get(messageId) || 0;
    imageUrlSizesRef.current.delete(messageId);
    imageCacheBytesRef.current = Math.max(0, imageCacheBytesRef.current - size);
  }, []);

  const storeImageUrl = useCallback((messageId, url, size) => {
    const bytes = Math.max(0, Number(size) || 0);
    if (bytes > MAX_IMAGE_CACHE_BYTES) return false;
    revokeImageUrl(messageId);
    const evicted = new Set();
    while (imageCacheBytesRef.current + bytes > MAX_IMAGE_CACHE_BYTES && imageUrlsRef.current.size) {
      const oldest = imageUrlsRef.current.keys().next().value;
      revokeImageUrl(oldest);
      evicted.add(oldest);
    }
    if (evicted.size) {
      setMessages(current => {
        const next = current.map(item => ({
          ...item,
          ...(evicted.has(item.id) ? { objectUrl: undefined } : {}),
          ...(Array.isArray(item.images) ? {
            images: item.images.map(image => evicted.has(image?.id) ? { ...image, objectUrl: undefined } : image),
          } : {}),
        }));
        messagesRef.current = next;
        return next;
      });
    }
    imageUrlsRef.current.set(messageId, url);
    imageUrlSizesRef.current.set(messageId, bytes);
    imageCacheBytesRef.current += bytes;
    return true;
  }, [revokeImageUrl]);

  const mergeMessages = useCallback(items => {
    if (!Array.isArray(items) || !items.length) return;

    setMessages(current => {
      const unique = new Map(current.map(item => [item.seq, item]));

      for (const item of items) {
        if (!Number.isSafeInteger(item?.seq) || item.seq <= 0) continue;
        const legacyObjectUrl = imageUrlsRef.current.get(item.id);
        const images = Array.isArray(item.images)
          ? item.images.map(image => {
            const objectUrl = imageUrlsRef.current.get(image?.id);
            return objectUrl ? { ...image, objectUrl } : image;
          })
          : item.images;
        unique.set(item.seq, {
          ...unique.get(item.seq),
          ...item,
          ...(legacyObjectUrl ? { objectUrl: legacyObjectUrl } : {}),
          ...(Array.isArray(images) ? { images } : {}),
        });
      }

      const next = [...unique.values()]
        .sort((left, right) => left.seq - right.seq)
        .slice(-1000);

      const retainedMessageIds = new Set(next.map(item => item.id));
      for (const item of current) {
        if (retainedMessageIds.has(item.id)) continue;
        const imageIds = [
          item.id,
          ...(Array.isArray(item.images) ? item.images.map(image => image?.id).filter(Boolean) : []),
        ];
        for (const imageId of imageIds) revokeImageUrl(imageId);
      }

      messagesRef.current = next;
      return next;
    });
  }, [revokeImageUrl]);

  const clearMessages = useCallback(() => {
    for (const messageId of [...imageUrlsRef.current.keys()]) revokeImageUrl(messageId);
    imageUrlSizesRef.current.clear();
    imageCacheBytesRef.current = 0;
    incomingImagesRef.current.clear();
    messagesRef.current = [];
    historyBusyRef.current = false;

    setMessages([]);
    setHasOlderMessages(false);
    setHistoryLoading(false);
  }, [revokeImageUrl]);

  const syncMissingMessages = useCallback(async socket => {
    if (
      !socket?.connected
      || historyBusyRef.current
      || !messagesRef.current.length
    ) {
      return;
    }

    historyBusyRef.current = true;

    try {
      let afterSeq = messagesRef.current.at(-1)?.seq;

      for (
        let page = 0;
        page < 20 && socketRef.current === socket;
        page += 1
      ) {
        const result = await ack(socket, 'chat:history', {
          afterSeq,
          limit: 50,
        });

        mergeMessages(result.messages);

        if (
          !result.hasMore
          || !result.latestSeq
          || result.latestSeq <= afterSeq
        ) {
          break;
        }

        afterSeq = result.latestSeq;
      }
    } catch {
      // ignore
    } finally {
      historyBusyRef.current = false;
    }
  }, [mergeMessages]);

  const loadInitialMessages = useCallback(async socket => {
    setHistoryLoading(true);

    try {
      const result = await ack(socket, 'chat:history', {
        limit: 50,
      });

      if (socketRef.current !== socket) return;

      mergeMessages(result.messages);
      setHasOlderMessages(result.hasMore);
    } finally {
      if (socketRef.current === socket) {
        setHistoryLoading(false);
      }
    }
  }, [mergeMessages]);

  const loadOlderMessages = useCallback(async () => {
    const socket = socketRef.current;
    const beforeSeq = messagesRef.current[0]?.seq;

    if (
      !socket?.connected
      || !beforeSeq
      || !hasOlderMessages
      || historyBusyRef.current
    ) {
      return 0;
    }

    historyBusyRef.current = true;
    setHistoryLoading(true);

    try {
      const result = await ack(socket, 'chat:history', {
        beforeSeq,
        limit: 50,
      });

      if (socketRef.current !== socket) return 0;

      mergeMessages(result.messages);
      setHasOlderMessages(result.hasMore);

      return result.messages.length;
    } finally {
      historyBusyRef.current = false;

      if (socketRef.current === socket) {
        setHistoryLoading(false);
      }
    }
  }, [hasOlderMessages, mergeMessages]);

  const receiveChatMessage = useCallback((value, socket) => {
    const latestSeq = messagesRef.current.at(-1)?.seq;

    mergeMessages([value]);

    if (
      latestSeq
      && Number.isSafeInteger(value?.seq)
      && value.seq > latestSeq + 1
    ) {
      void syncMissingMessages(socket);
    }
  }, [mergeMessages, syncMissingMessages]);

  const receiveRecall = useCallback(value => {
    const current = messagesRef.current.find(item => item.id === value?.id);
    const imageIds = [
      value?.id,
      ...(Array.isArray(current?.images) ? current.images.map(image => image?.id).filter(Boolean) : []),
    ].filter(Boolean);

    for (const imageId of imageIds) revokeImageUrl(imageId);

    mergeMessages([
      {
        ...value,
        recalled: true,
        text: '',
        objectUrl: undefined,
        ...(Array.isArray(value?.images)
          ? { images: value.images.map(image => ({ ...image, objectUrl: undefined })) }
          : {}),
      },
    ]);
  }, [mergeMessages, revokeImageUrl]);

  const receiveImageStart = useCallback(value => {
    if (
      !value
      || typeof value.messageId !== 'string'
      || !['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(value.mime)
      || !Number.isSafeInteger(value.size)
      || value.size < 1
      || value.size > 10 * 1024 * 1024
      || incomingImagesRef.current.size >= 2
    ) {
      return;
    }

    incomingImagesRef.current.set(value.messageId, {
      ...value,
      chunks: [],
      received: 0,
      nextIndex: 0,
    });
  }, []);

  const receiveImageChunk = useCallback(value => {
    const entry = incomingImagesRef.current.get(value?.messageId);

    const data = value?.data instanceof ArrayBuffer
      ? value.data
      : ArrayBuffer.isView(value?.data)
        ? value.data.buffer.slice(
          value.data.byteOffset,
          value.data.byteOffset + value.data.byteLength,
        )
        : null;

    if (
      !entry
      || !data
      || data.byteLength < 1
      || data.byteLength > 48 * 1024
      || value.index !== entry.nextIndex
      || entry.received + data.byteLength > entry.size
    ) {
      if (entry) {
        incomingImagesRef.current.delete(value.messageId);
      }

      return;
    }

    if (value.index === 0 && !imageMagicMatches(entry.mime, data)) {
      incomingImagesRef.current.delete(value.messageId);
      return;
    }

    entry.chunks.push(data);
    entry.received += data.byteLength;
    entry.nextIndex += 1;
  }, []);

  const receiveImageComplete = useCallback(value => {
    const entry = incomingImagesRef.current.get(value?.messageId);

    incomingImagesRef.current.delete(value?.messageId);

    if (!entry || entry.received !== entry.size) return;

    const header = imageHeaderBytes(entry.chunks);
    const dimensions = readImageDimensions(entry.mime, header);
    if (!dimensions || !imageDimensionsAllowed(dimensions.width, dimensions.height)) {
      errorRef.current('收到的图片尺寸超限或无法识别，请对方缩小或重新导出后发送。');
      return;
    }

    const objectUrl = URL.createObjectURL(
      new Blob(entry.chunks, {
        type: entry.mime,
      }),
    );

    if (!storeImageUrl(value.messageId, objectUrl, entry.size)) {
      URL.revokeObjectURL(objectUrl);
      return;
    }

    setMessages(current => {
      const next = current.map(item => {
        if (item.id === value.messageId && !item.recalled) {
          return { ...item, objectUrl };
        }
        if (!item.recalled && Array.isArray(item.images) && item.images.some(image => image?.id === value.messageId)) {
          return {
            ...item,
            images: item.images.map(image => image?.id === value.messageId ? { ...image, objectUrl } : image),
          };
        }
        return item;
      });

      messagesRef.current = next;
      return next;
    });
  }, [storeImageUrl]);

  const receiveImageAbort = useCallback(value => {
    incomingImagesRef.current.delete(value?.messageId);
    if (typeof value?.messageId === 'string') revokeImageUrl(value.messageId);
  }, [revokeImageUrl]);

  const receiveRoom = useCallback(value => {
    const previous = membersRef.current;
    const next = new Set(
      value?.members?.map(member => member.id) || [],
    );

    if (previous) {
      if ([...next].some(id => !previous.has(id))) {
        playSound('join');
      } else if ([...previous].some(id => !next.has(id))) {
        playSound('leave');
      }
    }

    membersRef.current = next;
    setRoom(value);
  }, []);

  const memberLeft = useCallback(value => {
    if (!membersRef.current?.has(value.memberId)) return;

    membersRef.current.delete(value.memberId);

    playSound(
      value.reason === 'kick'
        ? 'kick'
        : 'leave',
    );
  }, []);

  const leave = useCallback(async (shutdown = false) => {
    const socket = socketRef.current;

    if (socket) {
      if (!shutdown && socket.connected) {
        playSound('leave');
      }

      if (
        !shutdown
        && socket.p2p
        && typeof socket.leave === 'function'
      ) {
        await socket.leave();
      } else if (!shutdown && socket.connected) {
        await ack(socket, 'room:leave').catch(() => { });
      }

      socketRef.current = null;
      socket.removeAllListeners();
      socket.disconnect();
    }

    membersRef.current = null;
    clearMessages();

    setRoom(null);
    setSelfId('');
    setReadToken('');
    setOwnerToken('');
    setConfig(null);
    setConnection('idle');
  }, [clearMessages]);

  const enter = useCallback(async (mode, details) => {
    await leave();

    const isP2P = details.networkMode === 'p2p';

    if (details.networkMode === 'public') {
      throw new Error(
        '公网邀请已停用，请使用普通 Roomcast 邀请链接加入房间。',
      );
    }

    const base = isP2P
      ? window.location.origin
      : normalizeServer(details.server);

    setConnection('connecting');

    let socket;

    try {
      setServer(base);

      const response = await fetch(
        `${base}/api/config`,
        {
          signal: AbortSignal.timeout(10000),
        },
      );

      if (!response.ok) {
        throw new Error(
          '无法读取服务配置，请检查服务器地址',
        );
      }

      const remoteConfig = await response.json();

      setConfig(remoteConfig);

      if (isP2P) {
        socket = new P2PRoom();
        socketRef.current = socket;

        socket.on('room:state', value => {
          receiveRoom(value);
          void syncMissingMessages(socket);
        });

        socket.on(
          'chat:message',
          value => receiveChatMessage(value, socket),
        );

        socket.on('chat:recalled', receiveRecall);
        socket.on('image:start', receiveImageStart);
        socket.on('image:chunk', receiveImageChunk);
        socket.on('image:complete', receiveImageComplete);
        socket.on('image:abort', receiveImageAbort);
        socket.on('member:left', memberLeft);

        socket.on('room:owner-token', value => {
          setOwnerToken(
            typeof value?.ownerToken === 'string'
              ? value.ownerToken
              : '',
          );
        });

        socket.on('room:resumed', value => {
          if (socketRef.current !== socket) return;

          receiveRoom(value.room);

          setReadToken(value.readToken || '');
          setOwnerToken(value.ownerToken || '');

          setConfig(current => {
            const controlIceServers = (
              value.controlIceServers
              || value.iceServers
              || current?.controlIceServers
              || []
            );

            return {
              ...current,
              iceServers: controlIceServers,
              controlIceServers,
              mediaIceServers:
                value.mediaIceServers
                || mediaIceServers(controlIceServers),
            };
          });
        });

        socket.on('room:kicked', value => {
          if (socketRef.current !== socket) return;

          playSound('kick');
          membersRef.current = null;

          clearMessages();

          socketRef.current = null;
          socket.removeAllListeners();
          socket.disconnect();

          setRoom(null);
          setSelfId('');
          setReadToken('');
          setOwnerToken('');
          setConnection('idle');

          errorRef.current(
            value?.error || '你已被移出房间。',
          );
        });

        socket.on(
          'p2p:notice',
          text => errorRef.current(text),
        );

        socket.on('disconnect', reason => {
          if (socketRef.current !== socket) return;

          playSound('leave');
          membersRef.current = null;

          clearMessages();

          socketRef.current = null;

          setRoom(null);
          setSelfId('');
          setReadToken('');
          setOwnerToken('');
          setConnection('idle');

          if (reason !== 'io client disconnect') {
            errorRef.current(
              `${reason}，请重新加入房间。`,
            );
          }
        });

        const result = await socket.enter(
          mode,
          details,
          remoteConfig,
        );

        receiveRoom(result.room);
        playSound('join');

        setSelfId(result.selfId);
        setReadToken(result.readToken);
        setOwnerToken(result.ownerToken || '');
        setConnection('connected');

        const controlIceServers = (
          result.controlIceServers
          || result.iceServers
          || []
        );

        setConfig({
          ...remoteConfig,
          iceServers: controlIceServers,
          controlIceServers,
          mediaIceServers:
            result.mediaIceServers
            || mediaIceServers(controlIceServers),
          relayInvite: result.relayInvite || '',
          inviteSecret: result.inviteSecret || '',
          relayEnabled: containsTurn(controlIceServers),
          p2p: true,
          mediaP2P: true,
          roomConnection: 'P2P',
        });

        await loadInitialMessages(socket);

        savePreference(
          'nickname',
          details.nickname.trim(),
        );

        return result;
      }

      socket = io(base, {
        autoConnect: false,
        reconnection: false,
        timeout: 10000,
      });

      socketRef.current = socket;

      socket.on('room:state', value => {
        receiveRoom(value);
        void syncMissingMessages(socket);
      });

      socket.on(
        'chat:message',
        value => receiveChatMessage(value, socket),
      );

      socket.on('chat:recalled', receiveRecall);
      socket.on('image:start', receiveImageStart);
      socket.on('image:chunk', receiveImageChunk);
      socket.on('image:complete', receiveImageComplete);
      socket.on('image:abort', receiveImageAbort);
      socket.on('member:left', memberLeft);

      socket.on('room:owner-token', value => {
        setOwnerToken(
          typeof value?.ownerToken === 'string'
            ? value.ownerToken
            : '',
        );
      });

      socket.on('room:kicked', value => {
        if (socketRef.current !== socket) return;

        playSound('kick');
        membersRef.current = null;

        clearMessages();

        socketRef.current = null;
        socket.removeAllListeners();
        socket.disconnect();

        setRoom(null);
        setSelfId('');
        setReadToken('');
        setOwnerToken('');
        setConnection('idle');

        errorRef.current(
          value?.error || '你已被移出房间。',
        );
      });

      socket.on('disconnect', reason => {
        if (socketRef.current !== socket) return;

        playSound('leave');
        membersRef.current = null;

        clearMessages();

        socketRef.current = null;
        socket.removeAllListeners();

        setRoom(null);
        setSelfId('');
        setReadToken('');
        setOwnerToken('');
        setConnection('idle');

        if (reason !== 'io client disconnect') {
          errorRef.current(
            '与房间的连接已断开，屏幕共享已结束。请重新加入。',
          );
        }
      });

      await new Promise((resolve, reject) => {
        socket.once('connect', resolve);

        socket.once(
          'connect_error',
          () => reject(
            new Error(
              '连接服务失败，请检查服务是否启动及网络地址',
            ),
          ),
        );

        socket.connect();
      });

      const result = await ack(
        socket,
        `room:${mode}`,
        {
          nickname: details.nickname.trim(),
          ...(mode === 'create'
            ? {
              name: details.name.trim(),
              createKey: details.createKey || '',
            }
            : {
              roomId: details.roomId.trim(),
            }),
        },
      );

      receiveRoom(result.room);
      playSound('join');

      setSelfId(result.selfId || socket.id);
      setReadToken(result.readToken);
      setOwnerToken(result.ownerToken || '');
      setConnection('connected');

      const controlIceServers = result.iceServers || [];

      setConfig({
        ...remoteConfig,
        iceServers: controlIceServers,
        controlIceServers,
        mediaIceServers: mediaIceServers(controlIceServers),
        roomConnection: 'Socket.IO',
      });

      await loadInitialMessages(socket);

      savePreference(
        'nickname',
        details.nickname.trim(),
      );

      savePreference(
        'server',
        base,
      );

      return result;
    } catch (error) {
      if (socketRef.current === socket) {
        await leave();
      } else {
        setConnection('idle');
      }

      throw error;
    }
  }, [
    clearMessages,
    leave,
    loadInitialMessages,
    memberLeft,
    receiveChatMessage,
    receiveImageAbort,
    receiveImageChunk,
    receiveImageComplete,
    receiveImageStart,
    receiveRecall,
    receiveRoom,
    syncMissingMessages,
  ]);

  const command = useCallback(
    (event, payload = {}) => (
      ack(socketRef.current, event, payload)
    ),
    [],
  );

  const sendMessage = useCallback(async text => {
    const result = await ack(
      socketRef.current,
      'chat:send',
      { text },
    );

    if (result.message) {
      mergeMessages([result.message]);
    }

    return result;
  }, [mergeMessages]);

  const recallMessage = useCallback(async messageId => {
    const result = await ack(
      socketRef.current,
      'chat:recall',
      { messageId },
    );

    if (result.message) {
      receiveRecall(result.message);
    }

    return result;
  }, [receiveRecall]);

  const sendImage = useCallback(async (file, text = '', batch = null) => {
    if (!(file instanceof Blob)) {
      throw new Error('请选择图片文件。');
    }

    const mime = String(file.type || '').toLowerCase();
    const fileName = String(file.name || '图片');
    const caption = typeof text === 'string' ? text.trim() : '';

    if (caption.length > 2000) {
      throw new Error('消息最多 2000 个字符。');
    }

    if (
      !/\.(?:jpe?g|png|webp|gif)$/i.test(fileName)
      || /\.(?:svg|html?|exe|dll|com|bat|cmd|msi)$/i.test(fileName)
    ) {
      throw new Error(
        '仅支持 JPG、PNG、WebP 和 GIF 图片文件。',
      );
    }

    if (
      ![
        'image/jpeg',
        'image/png',
        'image/webp',
        'image/gif',
      ].includes(mime)
    ) {
      throw new Error(
        '图片 MIME 类型不受支持。',
      );
    }

    if (
      !Number.isSafeInteger(file.size)
      || file.size < 1
      || file.size > 10 * 1024 * 1024
    ) {
      throw new Error(
        '图片大小不能超过 10MB。',
      );
    }

    const header = new Uint8Array(
      await file.slice(0, 16).arrayBuffer(),
    );

    const ascii = offset => (
      String.fromCharCode(
        ...header.slice(offset, offset + 4),
      )
    );

    const valid = mime === 'image/jpeg'
      ? (
        header[0] === 0xff
        && header[1] === 0xd8
        && header[2] === 0xff
      )
      : mime === 'image/png'
        ? [
          0x89,
          0x50,
          0x4e,
          0x47,
          0x0d,
          0x0a,
          0x1a,
          0x0a,
        ].every(
          (byte, index) => (
            header[index] === byte
          ),
        )
        : mime === 'image/gif'
          ? ['GIF87a', 'GIF89a'].includes(
            String.fromCharCode(
              ...header.slice(0, 6),
            ),
          )
          : (
            ascii(0) === 'RIFF'
            && ascii(8) === 'WEBP'
          );

    if (!valid) {
      throw new Error(
        '图片内容与文件类型不匹配。',
      );
    }

    const socket = socketRef.current;

    const init = await ack(
      socket,
      'image:init',
      {
        name: fileName,
        mime,
        size: file.size,
        text: caption,
        ...(batch ? {
          batchId: batch.id,
          batchIndex: batch.index,
          batchCount: batch.count,
        } : {}),
      },
    );

    const chunkSize = Math.min(
      48 * 1024,
      Number(init.chunkSize) || 48 * 1024,
    );

    for (
      let offset = 0, index = 0;
      offset < file.size;
      offset += chunkSize, index += 1
    ) {
      const data = await file
        .slice(
          offset,
          Math.min(
            file.size,
            offset + chunkSize,
          ),
        )
        .arrayBuffer();

      await ack(
        socket,
        'image:chunk',
        {
          uploadId: init.uploadId,
          index,
          data,
        },
        20_000,
      );

      await new Promise(
        resolve => setTimeout(resolve, 4),
      );
    }

    const result = await ack(
      socket,
      'image:complete',
      {
        uploadId: init.uploadId,
      },
      20_000,
    );

    const imageId = result.imageId || result.message?.id;
    if (imageId) {
      const objectUrl = URL.createObjectURL(file);
      if (!storeImageUrl(imageId, objectUrl, file.size)) URL.revokeObjectURL(objectUrl);
    }

    if (result.message) {
      mergeMessages([result.message]);
    }

    return result;
  }, [mergeMessages, storeImageUrl]);

  const sendImages = useCallback(async (files, text = '') => {
    const list = [...(files || [])].filter(Boolean);
    if (!list.length) throw new Error('请选择图片文件。');
    if (list.length > 4) throw new Error('一次最多发送 4 张图片。');
    if (list.length === 1) return sendImage(list[0], text);

    const id = typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `img-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let result = null;
    const completedIds = [];
    try {
      for (let index = 0; index < list.length; index += 1) {
        result = await sendImage(
          list[index],
          index === 0 ? text : '',
          { id, index, count: list.length },
        );
        if (result?.imageId) completedIds.push(result.imageId);
      }
      return result;
    } catch (error) {
      for (const imageId of completedIds) revokeImageUrl(imageId);
      throw error;
    }
  }, [revokeImageUrl, sendImage]);

  useEffect(() => {
    const unsubscribe = window.roomcast?.onBeforeClose?.(
      async () => {
        try {
          await leave();
          window.roomcast?.closeReady?.({ ok: true });
        } catch (error) {
          console.error(
            '关闭窗口前房间迁移失败：',
            error,
          );
          errorRef.current?.(error.message || '房间迁移失败，请重试退出。');
          window.roomcast?.closeReady?.({ ok: false });
        }
      },
    );

    return () => unsubscribe?.();
  }, [leave]);

  useEffect(
    () => () => {
      void leave(true);
    },
    [leave],
  );

  return {
    room,
    selfId,
    ownerToken,
    server,
    readToken,
    config,
    connection,
    socketRef,
    messages,
    hasOlderMessages,
    historyLoading,
    loadOlderMessages,
    sendMessage,
    sendImage,
    sendImages,
    recallMessage,
    enter,
    leave,
    command,
  };
}
