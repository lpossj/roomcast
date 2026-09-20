import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { Server } from 'socket.io';
import { io as clientIo } from 'socket.io-client';
import { attachRooms } from '../server/rooms.mjs';

function request(socket, event, payload = {}) {
  return new Promise((resolve, reject) => {
    socket.timeout(4000).emit(event, payload, (error, response) => error ? reject(error) : resolve(response));
  });
}

function nextEvent(socket, name, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(name, handler); reject(new Error(`Timed out waiting for ${name}`)); }, timeout);
    const handler = (value) => { clearTimeout(timer); resolve(value); };
    socket.once(name, handler);
  });
}

async function waitFor(predicate, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('Timed out waiting for condition');
}

async function harness(t, options = {}) {
  const http = createServer();
  const io = new Server(http, { transports: ['websocket'], maxHttpBufferSize: 128_000 });
  const service = attachRooms(io, options);
  const clients = [];
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${http.address().port}`;
  t.after(async () => {
    for (const socket of clients) socket.disconnect();
    await service.close();
    await new Promise((resolve) => io.close(resolve));
  });
  return {
    service,
    async connect(options = {}) {
      const socket = clientIo(url, { transports: ['websocket'], reconnection: false, forceNew: true, ...options });
      clients.push(socket);
      await nextEvent(socket, 'connect');
      return socket;
    },
  };
}

const create = (socket, overrides = {}) => request(socket, 'room:create', { name: '一起看屏幕', nickname: '房主', ...overrides });
const join = (socket, roomId, overrides = {}) => request(socket, 'room:join', { roomId, nickname: '朋友', ...overrides });

test('password-protected rooms expose only public state and keep member credentials private', async (t) => {
  const { connect } = await harness(t);
  const [owner, guest] = await Promise.all([connect(), connect()]);
  const created = await create(owner, { password: 'correct horse battery staple' });
  assert.equal(created.ok, true);
  assert.equal(created.selfId, owner.id);
  assert.match(created.room.id, /^[A-F0-9]{8}$/);
  assert.equal(created.room.maxMembers, 10);
  assert.equal(created.room.members[0].role, 'owner');
  assert.equal(created.room.members[0].canShare, true);
  assert.equal(JSON.stringify(created.room).includes(created.readToken), false);
  assert.equal(JSON.stringify(created.room).includes('correct horse battery staple'), false);
  assert.equal(JSON.stringify(created.room).includes('passwordHash'), false);
  assert.equal((await join(guest, created.room.id, { password: 'wrong' })).ok, false);
  assert.equal((await join(guest, `${created.room.id}x`, { password: 'correct horse battery staple' })).ok, false);
  const entered = await join(guest, created.room.id, { password: 'correct horse battery staple' });
  assert.equal(entered.ok, true);
  assert.notEqual(entered.readToken, created.readToken);
  assert.equal(JSON.stringify(entered.room).includes(entered.readToken), false);
});

test('the ten-person cap remains authoritative under concurrent password checks', async (t) => {
  const { connect, service } = await harness(t);
  const owner = await connect();
  const created = await create(owner, { password: 'room password' });
  const guests = await Promise.all(Array.from({ length: 12 }, () => connect()));
  const results = await Promise.all(guests.map((socket, index) => join(socket, created.room.id, { nickname: `朋友${index}`, password: 'room password' })));
  assert.equal(results.filter((result) => result.ok).length, 9);
  assert.equal(results.filter((result) => !result.ok).length, 3);
  assert.equal(service.rooms.get(created.room.id).members.size, 10);
  assert.equal(service.summary().members, 10);
  assert.equal(new Set([...service.rooms.get(created.room.id).members.values()].map(member => member.avatarColor)).size, 10);
  const accepted = guests[results.findIndex((result) => result.ok)];
  const rejected = guests[results.findIndex((result) => !result.ok)];
  assert.equal((await request(accepted, 'room:leave')).ok, true);
  assert.equal((await join(rejected, created.room.id, { password: 'room password' })).ok, true);
  assert.equal(service.summary().members, 10);
});

test('owner and administrator permissions are enforced by the room service', async (t) => {
  const { connect } = await harness(t);
  const [owner, admin, user] = await Promise.all([connect(), connect(), connect()]);
  const created = await create(owner);
  await join(admin, created.room.id, { nickname: '管理员' });
  await join(user, created.room.id, { nickname: '用户' });
  assert.equal((await request(user, 'member:role', { memberId: admin.id, role: 'admin' })).ok, false);
  assert.equal((await request(owner, 'member:role', { memberId: admin.id, role: 'admin' })).ok, true);
  assert.equal((await request(admin, 'member:share-permission', { memberId: user.id, canShare: false })).ok, true);
  assert.equal((await request(user, 'share:claim')).ok, false);
  assert.equal((await request(admin, 'member:share-permission', { memberId: user.id, canShare: true })).ok, true);
  assert.equal((await request(user, 'share:claim')).ok, true);
  assert.equal((await request(admin, 'member:share-permission', { memberId: owner.id, canShare: false })).ok, false);
  assert.equal((await request(admin, 'member:share-permission', { memberId: admin.id, canShare: false })).ok, false);
  assert.equal((await request(user, 'member:kick', { memberId: admin.id })).ok, false);
  assert.equal((await request(admin, 'member:kick', { memberId: owner.id })).ok, false);
  const kicked = nextEvent(user, 'room:kicked');
  assert.equal((await request(admin, 'member:kick', { memberId: user.id })).ok, true);
  assert.match((await kicked).error, /移出房间/);
});

test('ownership transfers to the oldest remaining member when the owner leaves', async (t) => {
  const { connect } = await harness(t);
  const [owner, first, second] = await Promise.all([connect(), connect(), connect()]);
  const created = await create(owner);
  await join(first, created.room.id, { nickname: '第一位' });
  await new Promise(resolve => setTimeout(resolve, 2));
  await join(second, created.room.id, { nickname: '第二位' });
  const state = nextEvent(first, 'room:state');
  await request(owner, 'room:leave');
  const inherited = await state;
  assert.equal(inherited.members.find(member => member.id === first.id).role, 'owner');
  assert.equal((await request(first, 'member:role', { memberId: second.id, role: 'admin' })).ok, true);
});

test('an unexpected owner disconnect closes the room instead of impersonating a committed migration', async (t) => {
  const { connect, service } = await harness(t);
  const [owner, guest] = await Promise.all([connect(), connect()]);
  const created = await create(owner);
  await join(guest, created.room.id);
  const kicked = nextEvent(guest, 'room:kicked');
  owner.disconnect();
  assert.match((await kicked).error, /异常中断.*未完成安全迁移/);
  assert.equal(service.rooms.has(created.room.id), false);
  assert.equal(guest.connected, false);
});

test('screen signaling trickles ICE candidates in both directions with authorization', async (t) => {
  const { connect } = await harness(t);
  const [owner, guest, outsider] = await Promise.all([connect(), connect(), connect()]);
  const created = await create(owner);
  await join(guest, created.room.id);
  await create(outsider, { name: '其他房间' });
  await request(guest, 'share:claim');
  await request(guest, 'share:started');
  assert.equal((await request(guest, 'screen:signal', { kind: 'offer', requestId: 'self-preview', to: guest.id, sdp: 'v=0\r\n' })).ok, false);
  let received = nextEvent(guest, 'screen:signal');
  assert.equal((await request(owner, 'screen:signal', { kind: 'offer', requestId: 'request-1', to: guest.id, sdp: 'v=0\r\n' })).ok, true);
  assert.equal((await received).from, owner.id);
  received = nextEvent(guest, 'screen:signal');
  assert.equal((await request(owner, 'screen:signal', { kind: 'candidate', side: 'viewer', requestId: 'request-1', to: guest.id, candidate: { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0, forged: true } })).ok, true);
  assert.deepEqual((await received).candidate, { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 });
  received = nextEvent(owner, 'screen:signal');
  assert.equal((await request(guest, 'screen:signal', { kind: 'candidate', side: 'publisher', requestId: 'request-1', to: owner.id, candidate: { candidate: 'candidate:2', sdpMid: '0', sdpMLineIndex: 0 } })).ok, true);
  assert.equal((await received).from, guest.id);
  received = nextEvent(guest, 'screen:signal');
  assert.equal((await request(owner, 'screen:signal', { kind: 'candidate', side: 'viewer', requestId: 'request-1', to: guest.id, candidate: null })).ok, true);
  assert.equal((await received).candidate, null);
  assert.equal((await request(owner, 'screen:signal', { kind: 'candidate', side: 'publisher', requestId: 'request-1', to: guest.id, candidate: { candidate: 'candidate:3' } })).ok, false);
  assert.equal((await request(outsider, 'screen:signal', { kind: 'offer', requestId: 'request-1', to: guest.id, sdp: 'v=0\r\n' })).ok, false);

  let turnOffer = nextEvent(guest, 'screen:signal');
  assert.equal((await request(owner, 'screen:signal', {
    kind: 'offer',
    route: 'turn',
    requestId: 'turn-request-1',
    to: guest.id,
    sdp: 'v=0\r\n',
  })).ok, true);
  assert.equal((await turnOffer).route, 'turn');

  assert.equal((await request(owner, 'screen:signal', {
    kind: 'offer',
    route: 'invalid',
    requestId: 'turn-request-bad',
    to: guest.id,
    sdp: 'v=0\r\n',
  })).ok, false);

  assert.equal((await request(owner, 'screen:signal', {
    kind: 'candidate',
    route: 'turn',
    side: 'viewer',
    requestId: 'turn-route-on-candidate',
    to: guest.id,
    candidate: null,
  })).ok, false);

  let vdoRequest = nextEvent(guest, 'screen:signal');
  assert.equal((await request(owner, 'screen:signal', {
    kind: 'vdo-request',
    requestId: 'vdo-request-1',
    to: guest.id,
  })).ok, true);
  assert.equal((await vdoRequest).from, owner.id);

  const descriptor = {
    version: 1,
    room: 'roomcast_12345678',
    streamId: 'screen_12345678',
    password: 'a'.repeat(64),
  };

  let vdoDescriptor = nextEvent(owner, 'screen:signal');
  assert.equal((await request(guest, 'screen:signal', {
    kind: 'vdo-descriptor',
    requestId: 'vdo-request-1',
    to: owner.id,
    vdo: descriptor,
  })).ok, true);
  assert.deepEqual((await vdoDescriptor).vdo, descriptor);

  assert.equal((await request(owner, 'screen:signal', {
    kind: 'vdo-descriptor',
    requestId: 'forged-vdo',
    to: guest.id,
    vdo: descriptor,
  })).ok, false);

  assert.equal((await request(guest, 'screen:signal', {
    kind: 'vdo-descriptor',
    requestId: 'bad-vdo',
    to: owner.id,
    vdo: { ...descriptor, password: 'bad' },
  })).ok, false);

  assert.equal((await request(outsider, 'screen:signal', {
    kind: 'vdo-request',
    requestId: 'outsider-vdo',
    to: guest.id,
  })).ok, false);
});

test('members can publish simultaneously and each stream releases independently', async (t) => {
  const { connect, service } = await harness(t);
  const [owner, guest] = await Promise.all([connect(), connect()]);
  const created = await create(owner);
  await join(guest, created.room.id);
  const claim = await request(owner, 'share:claim');
  assert.deepEqual(claim, { ok: true });
  assert.equal(service.rooms.get(created.room.id).streams.size, 0);
  const guestClaim = await request(guest, 'share:claim');
  assert.deepEqual(guestClaim, { ok: true });
  assert.deepEqual(await request(owner, 'share:claim'), { ok: true });
  assert.equal((await request(owner, 'share:started', { settings: { width: 100, height: 1080, fps: 30, bitrate: 4500 } })).ok, false);
  let started = nextEvent(guest, 'room:state');
  assert.equal((await request(owner, 'share:started', { settings: { width: 2560, height: 1440, fps: 75, bitrate: 0, performanceMode: 'smooth' } })).ok, true);
  let live = await started;
  const ownerStream = live.streams.find(stream => stream.memberId === owner.id);
  assert.deepEqual(ownerStream.settings, { width: 2560, height: 1440, fps: 75, bitrate: 0, performanceMode: 'smooth', protocol: 'WebRTC / DTLS-SRTP', codec: 'H.264 优先' });
  assert.equal(live.members.find((member) => member.id === owner.id).sharing, true);
  started = nextEvent(owner, 'room:state');
  assert.equal((await request(guest, 'share:started', { microphone: true })).ok, true);
  live = await started;
  assert.equal(live.streams.length, 2);
  assert.equal(live.streams.find(stream => stream.memberId === guest.id).microphone, true);
  started = nextEvent(guest, 'room:state');
  assert.equal((await request(owner, 'share:stop')).ok, true);
  live = await started;
  assert.deepEqual(live.streams.map(stream => stream.memberId), [guest.id]);
  const ownerId = owner.id;
  const left = nextEvent(guest, 'member:left');
  await request(owner, 'room:leave');
  assert.deepEqual(await left, { memberId: ownerId, reason: 'leave' });
  assert.equal(service.rooms.get(created.room.id).streams.size, 1);
  assert.equal((await request(guest, 'share:stop')).ok, true);
});

test('a new publisher can claim immediately after another publisher stops', async (t) => {
  const { connect } = await harness(t);
  const [owner, guest] = await Promise.all([connect(), connect()]);
  const created = await create(owner);
  await join(guest, created.room.id);
  assert.deepEqual(await request(owner, 'share:claim'), { ok: true });
  assert.equal((await request(owner, 'share:started')).ok, true);
  assert.equal((await request(owner, 'share:stop')).ok, true);
  assert.deepEqual(await request(guest, 'share:claim'), { ok: true });
});

test('disconnect removes empty rooms and stale room ids cannot be rejoined', async (t) => {
  const { connect, service } = await harness(t);
  const owner = await connect();
  const created = await create(owner);
  assert.deepEqual(await request(owner, 'share:claim'), { ok: true });
  owner.disconnect();
  await waitFor(() => service.rooms.size === 0);
  assert.equal(service.rooms.size, 0);
  assert.equal(service.summary().streams, 0);
  const guest = await connect();
  assert.equal((await join(guest, created.room.id)).ok, false);
});

test('room changes are explicit and leaving cancels a pending password check', async (t) => {
  const { connect, service } = await harness(t);
  const [owner, guest] = await Promise.all([connect(), connect()]);
  const first = await create(owner, { password: 'pw' });
  const other = await create(guest);
  assert.equal((await join(guest, first.room.id, { password: 'pw' })).ok, false);
  assert.equal((await create(guest)).ok, false);
  assert.equal(service.rooms.get(other.room.id).members.has(guest.id), true);
  await request(guest, 'room:leave');
  const joining = join(guest, first.room.id, { password: 'pw' });
  await request(guest, 'room:leave');
  assert.equal((await joining).ok, false);
  assert.equal(service.rooms.get(first.room.id).members.has(guest.id), false);
});

test('chat uses sequenced message events, paged history, and stays out of room state', async (t) => {
  const { connect, service } = await harness(t);
  const [owner, guest] = await Promise.all([connect(), connect()]);
  const created = await create(owner);
  const entered = await join(guest, created.room.id);
  assert.equal('messages' in created.room, false);
  assert.equal('messages' in entered.room, false);
  const received = nextEvent(guest, 'chat:message');
  const sent = await request(owner, 'chat:send', { text: '  hello\u0000\nworld  ' });
  assert.equal(sent.ok, true);
  const item = await received;
  assert.equal(item.text, 'hello\nworld');
  assert.equal(item.memberId, owner.id);
  assert.equal(item.seq, sent.message.seq);
  const initial = await request(guest, 'chat:history', { limit: 50 });
  assert.equal(initial.ok, true);
  assert.deepEqual(initial.messages.map(message => message.seq), [...initial.messages.map(message => message.seq)].sort((a, b) => a - b));
  assert.equal(initial.messages.at(-1).text, 'hello\nworld');
  assert.equal((await request(owner, 'chat:send', { text: 'x'.repeat(2001) })).ok, false);
  for (let index = 0; index < 6; index += 1) assert.equal((await request(owner, 'chat:send', { text: `message ${index}` })).ok, true);
  const limited = await request(owner, 'chat:send', { text: 'blocked' });
  assert.equal(limited.ok, false);
  assert.match(limited.error, /频繁/);
  assert.equal(service.rooms.get(created.room.id).messages.some((item) => item.text === 'blocked'), false);
});

test('owner migration restores stable member identities, chat, streams, and bidirectional signaling on a new coordinator', async (t) => {
  const first = await harness(t);
  const [owner, oldB, oldC] = await Promise.all([first.connect(), first.connect(), first.connect()]);
  const created = await create(owner, { password: 'migration-password' });
  const joinedB = await join(oldB, created.room.id, { nickname: 'B', password: 'migration-password' });
  const joinedC = await join(oldC, created.room.id, { nickname: 'C', password: 'migration-password' });
  await request(oldB, 'share:claim');
  await request(oldB, 'share:started', { settings: {} });
  await request(oldC, 'share:claim');
  await request(oldC, 'share:started', { settings: {} });
  await request(oldC, 'chat:send', { text: '迁移前消息' });
  const exported = await request(owner, 'room:migration-export', {
    candidateIds: [joinedB.selfId, joinedC.selfId]
  });
  assert.equal(exported.successorId, joinedB.selfId);
  assert.equal(exported.transfer.streams.length, 2);
  assert.equal(exported.transfer.version, 2);
  assert.equal(exported.transfer.ttlMs, 45_000);
  assert.equal('expiresAt' in exported.transfer, false);

  const second = await harness(t);
  const [newB, forgedC, newC] = await Promise.all([second.connect(), second.connect(), second.connect()]);
  // A legacy sender-wall-clock value must be ignored. Only bounded ttlMs starts
  // the receiver's local monotonic deadline.
  const restoredB = await request(newB, 'room:migration-create', { transfer: { ...exported.transfer, expiresAt: 0 }, ticket: exported.tickets[joinedB.selfId], memberId: joinedB.selfId });
  assert.equal(restoredB.selfId, joinedB.selfId);
  assert.equal(restoredB.room.members.find(member => member.id === joinedB.selfId).role, 'owner');
  assert.equal(restoredB.room.streams.length, 2);
  assert.match(restoredB.ownerToken, /^[a-f0-9]{64}$/);
  assert.equal((await request(newB, 'room:migration-commit')).ok, true);
  assert.equal((await request(forgedC, 'room:migration-join', { roomId: created.room.id, ticket: 'x'.repeat(43) })).ok, false);
  const restoredC = await request(newC, 'room:migration-join', { roomId: created.room.id, ticket: exported.tickets[joinedC.selfId] });
  assert.equal(restoredC.selfId, joinedC.selfId);
  assert.equal((await request(forgedC, 'room:migration-join', { roomId: created.room.id, ticket: exported.tickets[joinedC.selfId] })).ok, false);
  const history = await request(newB, 'chat:history', { limit: 50 });
  assert.equal(history.messages.some(message => message.text === '迁移前消息'), true);
  const chat = nextEvent(newC, 'chat:message');
  assert.equal((await request(newB, 'chat:send', { text: '迁移后消息' })).ok, true);
  assert.equal((await chat).text, '迁移后消息');

  const offerToC = nextEvent(newC, 'screen:signal');
  assert.equal((await request(newB, 'screen:signal', { kind: 'offer', requestId: 'b-to-c', to: joinedC.selfId, sdp: 'v=0\r\n' })).ok, true);
  assert.equal((await offerToC).from, joinedB.selfId);
  const offerToB = nextEvent(newB, 'screen:signal');
  assert.equal((await request(newC, 'screen:signal', { kind: 'offer', requestId: 'c-to-b', to: joinedB.selfId, sdp: 'v=0\r\n' })).ok, true);
  assert.equal((await offerToB).from, joinedC.selfId);
});

test('prepared migration can roll back and its one-time takeover ticket cannot be replayed', async (t) => {
  const first = await harness(t);
  const [owner, oldB] = await Promise.all([first.connect(), first.connect()]);
  const created = await create(owner);
  const joinedB = await join(oldB, created.room.id, { nickname: 'B' });
  const exported = await request(owner, 'room:migration-export', { candidateIds: [joinedB.selfId] });

  const second = await harness(t);
  const newB = await second.connect();
  const payload = { transfer: exported.transfer, ticket: exported.tickets[joinedB.selfId], memberId: joinedB.selfId };
  assert.equal((await request(newB, 'room:migration-create', payload)).ok, true);
  assert.equal((await request(newB, 'room:migration-abort')).ok, true);
  assert.equal(second.service.rooms.has(created.room.id), false);
  const replay = await request(newB, 'room:migration-create', payload);
  assert.equal(replay.ok, false);
  assert.match(replay.error, /无效或已使用/);
  assert.equal((await request(owner, 'chat:send', { text: '回滚后原房主仍可继续使用房间' })).ok, true);
});

test('only the current server identity can recall its own message and history keeps recalled state', async (t) => {
  const { connect } = await harness(t);
  const [owner, guest] = await Promise.all([connect(), connect()]);
  const created = await create(owner);
  await join(guest, created.room.id);
  const sent = await request(owner, 'chat:send', { text: '稍后撤回' });
  assert.match(sent.message.id, /^[0-9a-f-]{36}$/i);
  assert.equal((await request(guest, 'chat:recall', { messageId: sent.message.id, memberId: guest.id })).ok, false);
  const recalledEvent = nextEvent(guest, 'chat:recalled');
  assert.equal((await request(owner, 'chat:recall', { messageId: sent.message.id, memberId: guest.id })).ok, true);
  const recalled = await recalledEvent;
  assert.equal(recalled.recalled, true);
  assert.equal(recalled.text, '');
  const history = await request(guest, 'chat:history', { limit: 50 });
  assert.equal(history.messages.find(item => item.id === sent.message.id).recalled, true);
});

test('oversized, spoofed, and forged-length images are rejected before persistent buffering', async (t) => {
  const { connect } = await harness(t);
  const owner = await connect();
  await create(owner);
  assert.equal((await request(owner, 'image:init', { name: 'large.png', mime: 'image/png', size: 10 * 1024 * 1024 + 1 })).ok, false);
  assert.equal((await request(owner, 'image:init', { name: 'attack.svg', mime: 'image/png', size: 20 })).ok, false);
  const forged = await request(owner, 'image:init', { name: 'fake.png', mime: 'image/png', size: 16 });
  assert.equal(forged.ok, true);
  assert.equal((await request(owner, 'image:chunk', { uploadId: forged.uploadId, index: 0, data: Buffer.from('<html>not png') })).ok, false);
  const short = await request(owner, 'image:init', { name: 'short.png', mime: 'image/png', size: 12 });
  assert.equal(short.ok, true);
  assert.equal((await request(owner, 'image:chunk', { uploadId: short.uploadId, index: 0, data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) })).ok, true);
  assert.equal((await request(owner, 'image:complete', { uploadId: short.uploadId })).ok, false);
});

test('viewer state is deduplicated, removed on stop/disconnect, and isolated by room', async (t) => {
  const { connect } = await harness(t);
  const [owner, viewer, otherOwner, outsider] = await Promise.all([connect(), connect(), connect(), connect()]);
  const created = await create(owner);
  await join(viewer, created.room.id, { nickname: '张三' });
  const other = await create(otherOwner, { name: '另一个房间' });
  await join(outsider, other.room.id, { nickname: '李四' });
  await request(owner, 'share:claim');
  await request(owner, 'share:started');
  assert.equal((await request(owner, 'view:start', { ownerId: owner.id })).ok, false);
  let stateEvent = nextEvent(owner, 'room:state');
  assert.equal((await request(viewer, 'view:start', { ownerId: owner.id, memberId: outsider.id })).ok, true);
  let state = await stateEvent;
  assert.deepEqual(state.streams[0].viewers, [{ memberId: viewer.id, name: '张三', avatarColor: 1 }]);
  stateEvent = nextEvent(owner, 'room:state');
  assert.equal((await request(viewer, 'view:start', { ownerId: owner.id })).ok, true);
  state = await stateEvent;
  assert.equal(state.streams[0].viewers.length, 1);
  assert.equal((await request(outsider, 'view:start', { ownerId: owner.id })).ok, false);
  stateEvent = nextEvent(owner, 'room:state');
  assert.equal((await request(viewer, 'view:stop', { ownerId: owner.id })).ok, true);
  state = await stateEvent;
  assert.equal(state.streams[0].viewers.length, 0);
  stateEvent = nextEvent(owner, 'room:state');
  await request(viewer, 'view:start', { ownerId: owner.id });
  await stateEvent;
  stateEvent = nextEvent(owner, 'room:state');
  viewer.disconnect();
  state = await stateEvent;
  assert.equal(state.streams[0].viewers.length, 0);
  assert.equal(state.members.some(member => member.name === '李四'), false);
});

test('chat history loads newest 50, older pages, and sequence catch-up', async (t) => {
  const { connect, service } = await harness(t);
  const owner = await connect();
  const created = await create(owner);
  const room = service.rooms.get(created.room.id);
  room.messages = Array.from({ length: 120 }, (_, index) => ({ id: `m${index + 1}`, seq: index + 1, memberId: owner.id, name: '房主', text: `消息 ${index + 1}`, at: index + 1 }));
  room.nextMessageSeq = 121;
  const newest = await request(owner, 'chat:history', { limit: 50 });
  assert.deepEqual(newest.messages.map(item => item.seq), Array.from({ length: 50 }, (_, index) => index + 71));
  assert.equal(newest.hasMore, true);
  const older = await request(owner, 'chat:history', { beforeSeq: 71, limit: 50 });
  assert.deepEqual(older.messages.map(item => item.seq), Array.from({ length: 50 }, (_, index) => index + 21));
  assert.equal(older.hasMore, true);
  const catchup = await request(owner, 'chat:history', { afterSeq: 110, limit: 50 });
  assert.deepEqual(catchup.messages.map(item => item.seq), Array.from({ length: 10 }, (_, index) => index + 111));
  assert.equal(catchup.hasMore, false);
  assert.equal((await request(owner, 'chat:history', { beforeSeq: 50, afterSeq: 10 })).ok, false);
  room.messages = Array.from({ length: 1000 }, (_, index) => ({ id: `cap${index + 1}`, seq: index + 1, memberId: owner.id, name: '房主', text: `上限 ${index + 1}`, at: index + 1 }));
  room.nextMessageSeq = 1001;
  const live = nextEvent(owner, 'chat:message');
  assert.equal((await request(owner, 'chat:send', { text: '超过上限后的消息' })).ok, true);
  assert.equal((await live).seq, 1001);
  assert.equal(room.messages.length, 1000);
  assert.equal(room.messages[0].seq, 2);
  assert.equal(room.messages.at(-1).seq, 1001);
});

test('join attempts are rate limited before additional password checks', async (t) => {
  const { connect } = await harness(t);
  const guest = await connect();
  for (let index = 0; index < 12; index += 1) {
    const result = await join(guest, 'NOEXIST');
    assert.equal(result.ok, false);
    assert.doesNotMatch(result.error, /频繁/);
  }
  const limited = await join(guest, 'NOEXIST');
  assert.equal(limited.ok, false);
  assert.match(limited.error, /频繁/);
});
