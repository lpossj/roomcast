import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createPeerAuthProof, MAX_UNAUTHENTICATED_PEERS, PEER_AUTH_TIMEOUT_MS, randomPeerAuthNonce, verifyPeerAuthProof } from '../src/p2p-auth.js';

globalThis.btoa ||= value => Buffer.from(value, 'binary').toString('base64');
globalThis.atob ||= value => Buffer.from(value, 'base64').toString('binary');

const source = (await readFile(new URL('../src/p2p.js', import.meta.url), 'utf8'))
  .replace("import { Peer } from 'peerjs';", 'const Peer = null;')
  .replace("from 'socket.io-client'", `from '${import.meta.resolve('socket.io-client')}'`)
  .replace("from './lib.js'", `from '${new URL('../src/lib.js', import.meta.url).href}'`)
  .replace("from './relay.js'", `from '${new URL('../src/relay.js', import.meta.url).href}'`)
  .replace("from './p2p-video-policy.js'", `from '${new URL('../src/p2p-video-policy.js', import.meta.url).href}'`)
  .replace("from './ice-policy.js'", `from '${new URL('../src/ice-policy.js', import.meta.url).href}'`)
  .replace("from './p2p-auth.js'", `from '${new URL('../src/p2p-auth.js', import.meta.url).href}'`);
const { P2PRoom } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('control replies require the original connection and a bounded result; busy replies remain valid', async () => {
  const room = new P2PRoom();
  let request;
  const connection = { open: true, send: message => { request = message; } };
  const result = room.sendControl(connection, 'migration:probe', {}, 1000);
  const id = request.controlId;
  room.finishControlReply({}, { controlReply: id, result: { ok: true } });
  room.finishControlReply(connection, { controlReply: id, result: { ok: 'true' } });
  room.finishControlReply(connection, { controlReply: id, result: { ok: true, junk: 'x'.repeat(65536) } });
  assert.equal(room.controlPending.size, 1);
  room.finishControlReply(connection, { controlReply: id, result: { ok: false } });
  assert.deepEqual(await result, { ok: false });
  room.finishControlReply(connection, { controlReply: id, result: { ok: true } });
  assert.equal(room.controlPending.size, 0);
});

test('closed control connections settle promptly and congestion is bounded', async () => {
  const room = new P2PRoom();
  const a = { open: true, send() {} }, b = { open: true, send() {} };
  const pa = room.sendControl(a, 'migration:probe', {}, 1000);
  const pb = room.sendControl(b, 'migration:probe', {}, 1000);
  const rejectedA = assert.rejects(pa, /连接已结束/), rejectedB = assert.rejects(pb, /连接已结束/);
  room.failControlPending(a);
  assert.equal(room.controlPending.size, 1);
  await rejectedA;
  room.failControlPending();
  await rejectedB;
  a.dataChannel = { bufferedAmount: 2 * 1024 * 1024 };
  await assert.rejects(room.sendControl(a, 'migration:probe', {}), /积压/);
  a.dataChannel.bufferedAmount = 0;
  for (let i = 0; i < 64; i++) room.controlPending.set(String(i), {});
  await assert.rejects(room.sendControl(a, 'migration:probe', {}), /积压/);
  room.controlPending.clear();
});

test('challenge HMAC is room-bound and rejects the wrong invite secret', async () => {
  const challenge = { protocol: 2, roomId: 'ABCDEF12', mode: 'invite', nonce: randomPeerAuthNonce() };
  const proof = await createPeerAuthProof('s'.repeat(43), challenge);
  assert.equal(await verifyPeerAuthProof('s'.repeat(43), challenge, proof), true);
  assert.equal(await verifyPeerAuthProof('x'.repeat(43), challenge, proof), false);
  assert.equal(await verifyPeerAuthProof('s'.repeat(43), { ...challenge, roomId: 'DEADBEEF' }, proof), false);
  assert.equal(MAX_UNAUTHENTICATED_PEERS, 6);
});

test('an unauthenticated Peer never creates a privileged local Socket.IO connection', async () => {
  let localSockets = 0;
  class TestRoom extends P2PRoom {
    async localSocket() { localSockets += 1; throw new Error('must not be reached'); }
  }
  const room = new TestRoom();
  room.roomId = 'ABCDEF12';
  room.inviteSecret = 's'.repeat(43);
  room.joinDetails = { password: '' };
  const connection = new EventEmitter();
  connection.open = true;
  connection.metadata = { protocol: 2, authMode: 'invite' };
  connection.send = value => {
    if (value?.authChallenge) queueMicrotask(() => connection.emit('data', { authProof: 'x'.repeat(43) }));
  };
  connection.close = () => { connection.open = false; connection.emit('close'); };
  await room.accept(connection);
  assert.equal(localSockets, 0);
  assert.equal(room.guests.size, 0);
  assert.equal(room.unauthenticated.size, 0);
});

test('manual room-number password joins cannot replace the invite secret', async () => {
  const room = new P2PRoom();
  await assert.rejects(
    room.enter('join', {
      roomId: 'ABCDEF12',
      nickname: 'guest',
      password: 'weak',
    }, {}),
    /完整的 roomcast:\/\/ 安全邀请链接/,
  );
});

test('P2P accept rejects password auth mode even with a matching room password', async () => {
  let localSockets = 0;
  class TestRoom extends P2PRoom {
    async localSocket() {
      localSockets += 1;
      return null;
    }
  }
  const room = new TestRoom();
  room.roomId = 'ABCDEF12';
  room.inviteSecret = 's'.repeat(43);
  room.joinDetails = { password: 'weak' };
  const connection = new EventEmitter();
  connection.open = true;
  connection.metadata = { protocol: 2, authMode: 'password' };
  connection.send = () => {};
  connection.close = () => {
    connection.open = false;
    connection.emit('close');
  };
  await room.accept(connection);
  assert.equal(connection.open, false);
  assert.equal(localSockets, 0);
  assert.equal(room.guests.size, 0);
  assert.equal(room.unauthenticated.size, 0);
});

test('host answers a screen offer even when cached room state is stale', async () => {
  const room = new P2PRoom();
  room.id = 'owner';
  room.connected = true;
  room.room = { streams: [], members: [] };
  room.screenStream = { active: true };
  const requests = [];

  room.answerScreen = async (owner, sdp, requestId, route) => {
    assert.equal(owner, 'viewer');
    assert.equal(sdp, 'offer-sdp');
    assert.equal(requestId, 'req-1');
    assert.equal(route, 'p2p');
    return { session: 'session-1', sdp: 'answer-sdp' };
  };

  room.request = async (event, payload) => {
    requests.push({ event, payload });
    return { ok: true };
  };

  await room.screenSignal({
    kind: 'offer',
    requestId: 'req-1',
    from: 'viewer',
    sdp: 'offer-sdp',
    route: 'p2p',
  });

  assert.deepEqual(requests, [
    {
      event: 'screen:signal',
      payload: {
        kind: 'answer',
        requestId: 'req-1',
        to: 'viewer',
        session: 'session-1',
        sdp: 'answer-sdp',
      },
    },
  ]);
});


function pendingConnection(t, { respond = true } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const room = new P2PRoom();
  room.roomId = 'ABCDEF12';
  room.inviteSecret = 's'.repeat(43);
  const socket = new EventEmitter();
  socket.disconnect = () => {};
  let sockets = 0;
  room.localSocket = async () => { sockets++; return socket; };
  const connection = new EventEmitter();
  connection.open = false;
  connection.metadata = { protocol: 2, authMode: 'invite' };
  const messages = [];
  let closed = false;
  connection.send = message => {
    messages.push(message);
    if (respond && message.authChallenge) {
      void createPeerAuthProof(room.inviteSecret, message.authChallenge).then(authProof => {
        if (!closed) connection.emit('data', { authProof });
      });
    }
  };
  connection.close = () => { closed = true; connection.open = false; connection.emit('close'); };
  const accepted = room.accept(connection);
  t.after(async () => { connection.close(); t.mock.timers.tick(60000); await accepted; });
  return { room, connection, messages, accepted, sockets: () => sockets, closed: () => closed };
}

test('the viewer waits for the host ICE window plus the authentication window', async () => {
  // accept() only starts its PEER_AUTH_TIMEOUT_MS clock after the data channel
  // opens, so a slow-but-successful ICE setup needs the host's full ICE window
  // plus the authentication window. A viewer deadline that only matches the ICE
  // window makes the first join fail on the viewer side while the host is still
  // waiting. Source-level assertion because connectRemote() needs a live
  // PeerJS/socket.io runtime that this file deliberately stubs out.
  const declared = name => {
    if (name === 'PEER_AUTH_TIMEOUT_MS') return PEER_AUTH_TIMEOUT_MS;
    const declaration = new RegExp(`const\\s+${name}\\s*=\\s*([^;]+);`).exec(source);
    assert.ok(declaration, `${name} must stay declared in src/p2p.js`);
    const value = expression => expression.trim().split('+').reduce((sum, part) => {
      const term = part.trim();
      const numeric = /^[0-9_]+$/.test(term);
      const resolved = numeric ? Number(term.replace(/_/g, '')) : declared(term);
      return sum + resolved;
    }, 0);
    return value(declaration[1]);
  };

  const ice = declared('PEER_AUTH_ICE_TIMEOUT_MS');
  const total = declared('PEER_AUTH_TOTAL_TIMEOUT_MS');
  assert.equal(ice, 25_000);
  assert.equal(total, ice + PEER_AUTH_TIMEOUT_MS, 'viewer deadline must cover the host ICE window plus authentication');
  assert.ok(total > ice, 'viewer deadline must exceed the ICE window alone');
});

test('first join survives a data channel taking nine seconds to open', async t => {
  const f = pendingConnection(t);
  t.mock.timers.tick(9000);
  await Promise.resolve();
  assert.equal(f.closed(), false, 'ICE setup must not consume the authentication deadline');
  assert.equal(f.messages.length, 0);
  f.connection.open = true;
  f.connection.emit('open');
  await f.accepted;
  assert.equal(f.sockets(), 1);
  assert.ok(f.messages.some(message => message.authenticated === true));
  assert.equal(f.connection.listenerCount('open'), 0);
});

test('an unopened peer still times out and releases the unauthenticated slot', async t => {
  const f = pendingConnection(t);
  t.mock.timers.tick(25001);
  await f.accepted;
  assert.equal(f.closed(), true);
  assert.equal(f.sockets(), 0);
  assert.equal(f.room.unauthenticated.size, 0);
  assert.equal(f.connection.listenerCount('open'), 0);
});

test('an opened peer still has only eight seconds to authenticate', async t => {
  const f = pendingConnection(t, { respond: false });
  t.mock.timers.tick(9000);
  f.connection.open = true;
  f.connection.emit('open');
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(f.messages.some(message => message.authChallenge));
  t.mock.timers.tick(8001);
  await f.accepted;
  assert.equal(f.closed(), true);
  assert.equal(f.sockets(), 0);
  assert.equal(f.room.unauthenticated.size, 0);
});

test('closing before open promptly cleans the pending handshake', async t => {
  const f = pendingConnection(t);
  f.connection.close();
  await f.accepted;
  assert.equal(f.sockets(), 0);
  assert.equal(f.connection.listenerCount('open'), 0);
  assert.equal(f.room.unauthenticated.size, 0);
});

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test('host proof is role/client-nonce bound and rejects replay or protocol changes', async () => {
  const secret = 's'.repeat(43);
  const challenge = { protocol: 2, roomId: 'ABCDEF12', mode: 'invite', nonce: randomPeerAuthNonce() };
  const host = { ...challenge, role: 'host', clientNonce: randomPeerAuthNonce() };
  const proof = await createPeerAuthProof(secret, host);
  assert.equal(await verifyPeerAuthProof(secret, host, proof), true);
  assert.equal(await verifyPeerAuthProof(secret, challenge, proof), false);
  assert.equal(await verifyPeerAuthProof(secret, { ...host, clientNonce: randomPeerAuthNonce() }, proof), false);
  assert.equal(await verifyPeerAuthProof(secret, { ...host, nonce: randomPeerAuthNonce() }, proof), false);
  assert.equal(await verifyPeerAuthProof(secret, { ...host, protocol: 3 }, proof), false);
});

test('viewer requires valid host proof before accepting room messages', async () => {
  for (const valid of [true, false]) {
    const room = new P2PRoom();
    room.roomId = 'ABCDEF12'; room.inviteSecret = 's'.repeat(43);
    const peer = new EventEmitter(), remote = new EventEmitter();
    remote.open = true;
    remote.close = () => { remote.open = false; remote.emit('close'); };
    const challenge = { protocol: 2, roomId: room.roomId, mode: 'invite', nonce: randomPeerAuthNonce() };
    remote.send = message => { void (async () => {
      const hostProof = valid ? await createPeerAuthProof(room.inviteSecret, { ...challenge, role: 'host', clientNonce: message.authNonce }) : 'x'.repeat(43);
      remote.emit('data', { authenticated: true, hostProof });
    })(); };
    peer.connect = () => remote; peer.destroy = () => {};
    room.peer = peer;
    const pending = room.connectRemote();
    remote.emit('data', { event: 'room:state', data: { id: 'untrusted' } });
    assert.notEqual(room.room?.id, 'untrusted');
    remote.emit('data', { authChallenge: challenge });
    if (valid) assert.equal(await pending, remote);
    else await assert.rejects(pending);
    room.disconnect();
  }
});

test('duplicate pre-auth peers are rejected and a closed handshake releases its listener', async t => {
  const f = pendingConnection(t, { respond: false });
  f.connection.peer = 'repeated';
  const duplicate = new EventEmitter();
  duplicate.open = true; duplicate.peer = 'repeated'; duplicate.metadata = { protocol: 2, authMode: 'invite' };
  duplicate.close = () => { duplicate.open = false; };
  await f.room.accept(duplicate);
  assert.equal(duplicate.open, false);
  f.connection.open = true; f.connection.emit('open'); await flush();
  f.connection.close(); await f.accepted;
  assert.equal(f.connection.listenerCount('data'), 0);
  assert.equal(f.room.unauthenticated.size, 0);
  assert.ok(f.room.authFailures.get('repeated') > Date.now());
});

test('kick rotates the room credential, preserves admitted viewers and rejects the old invite', async t => {
  const room = new P2PRoom();
  room.isHost = true; room.roomId = 'ABCDEF12'; room.inviteSecret = 's'.repeat(43);
  t.after(() => room.disconnect());
  const kicked = await admittedGuest(room, 'kicked');
  const healthy = await admittedGuest(room, 'healthy');
  const messages = [];
  const send = healthy.connection.send;
  healthy.connection.send = message => { messages.push(message); send(message); };
  const oldSecret = room.inviteSecret;
  room.dispatch('room:credential-revoke', { memberId: 'kicked' });
  assert.notEqual(room.inviteSecret, oldSecret);
  assert.equal(kicked.connection.open, false);
  assert.equal(healthy.connection.open, true);
  assert.equal(healthy.disconnected(), 0);
  assert.equal(messages.find(m => m.event === 'room:credential').data.inviteSecret, room.inviteSecret);
  let sockets = 0;
  room.localSocket = async () => { sockets++; throw Error('must not admit'); };
  const rejoin = new EventEmitter(); rejoin.open = true; rejoin.metadata = { protocol: 2, authMode: 'invite' };
  rejoin.close = () => { rejoin.open = false; rejoin.emit('close'); };
  rejoin.send = message => { if (message.authChallenge) void createPeerAuthProof(oldSecret, message.authChallenge).then(authProof => rejoin.emit('data', { authProof })); };
  await room.accept(rejoin);
  assert.equal(rejoin.open, false); assert.equal(sockets, 0);
  // A remaining viewer receives the new secret before migration/reconnect.
  const viewer = new P2PRoom(); viewer.dispatch('room:credential', messages.find(m => m.event === 'room:credential').data);
  assert.equal(viewer.inviteSecret, room.inviteSecret);
});

async function admittedGuest(room, id, reply = { ok: true }) {
  const socket = new EventEmitter();
  socket.data = {};
  socket.connected = true;
  let disconnected = 0, closed = 0, probes = 0;
  socket.disconnect = () => { disconnected++; };
  socket.timeout = () => ({ emit: (_event, _payload, callback) => callback(null, { ok: true, selfId: id }) });
  room.localSocket = async () => socket;
  const connection = new EventEmitter();
  connection.open = true;
  connection.metadata = { protocol: 2, authMode: 'invite' };
  connection.send = message => {
    if (message.authChallenge) void createPeerAuthProof(room.inviteSecret, message.authChallenge)
      .then(authProof => connection.emit('data', { authProof }));
    if (message.control === 'migration:probe') {
      probes++;
      if (reply) queueMicrotask(() => connection.emit('data', { controlReply: message.controlId, result: reply }));
    }
  };
  connection.close = () => { closed++; connection.open = false; connection.emit('close'); };
  await room.accept(connection);
  connection.emit('data', { id: 'join', event: 'room:join', payload: { roomId: room.roomId } });
  await flush();
  assert.equal(room.guestMembers.get(id), connection);
  return { connection, disconnected: () => disconnected, closed: () => closed, probes: () => probes };
}

test('authenticated channels expire if they never join and release their reserved slot', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const room = new P2PRoom(); room.roomId = 'ABCDEF12'; room.inviteSecret = 's'.repeat(43);
  t.after(() => room.disconnect());
  const socket = new EventEmitter(); let disconnects = 0;
  socket.disconnect = () => { disconnects++; };
  room.localSocket = async () => socket;
  const connection = new EventEmitter(); connection.open = true;
  connection.metadata = { protocol: 2, authMode: 'invite' };
  connection.close = () => { connection.open = false; connection.emit('close'); };
  connection.send = value => {
    if (value.authChallenge) void createPeerAuthProof(room.inviteSecret, value.authChallenge)
      .then(authProof => connection.emit('data', { authProof }));
  };
  await room.accept(connection);
  assert.equal(room.guests.size, 1); assert.equal(socket.data.admitted, false);
  t.mock.timers.tick(24_999); assert.equal(connection.open, true);
  t.mock.timers.tick(1); assert.equal(connection.open, false);
  assert.equal(room.guests.size, 0); assert.equal(disconnects, 1);
});

test('credential rotation closes the old VDO publisher and preserves native capture and sessions', async () => {
  const room = new P2PRoom(); room.isHost = true; room.inviteSecret = 's'.repeat(43);
  let vdoClosed = 0, starts = 0, tracksStopped = 0, pcClosed = 0;
  const capture = { active: true, getTracks: () => [{ stop: () => tracksStopped++ }] };
  room.screenStream = capture;
  room.vdoPublisher = { close: async () => { vdoClosed++; } };
  room.screenSessions.set('native', { owner: 'healthy', pc: { close: () => pcClosed++ } });
  room.startVdoPublisher = async stream => { assert.equal(stream, capture); starts++; };
  room.rotateInviteCredential('kicked');
  await flush();
  assert.equal(vdoClosed, 1); assert.equal(starts, 1);
  assert.equal(tracksStopped, 0); assert.equal(pcClosed, 0); assert.equal(room.screenSessions.size, 1);
  room.dispatch('room:credential', { inviteSecret: room.inviteSecret });
  assert.equal(starts, 1, 'a repeated credential does not rotate media again');
  room.disconnect();
});

test('revoked share permission stops capture and VDO even if the room remains open', () => {
  const room = new P2PRoom(); room.id = 'me';
  let stopped = 0, cleaned = 0, closed = 0;
  room.screenStream = { getTracks: () => [{ stop: () => stopped++ }], roomcastCleanup: () => cleaned++ };
  room.vdoPublisher = { close: async () => closed++ };
  room.dispatch('room:state', { id: 'room', members: [{ id: 'me', canShare: false }], streams: [] });
  assert.equal(stopped, 1); assert.equal(cleaned, 1); assert.equal(closed, 1);
  assert.equal(room.screenStream, null); assert.equal(room.room.id, 'room');
});

test('background silence and host timer stalls preserve members until transport closes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const room = new P2PRoom();
  room.roomId = 'ABCDEF12'; room.inviteSecret = 's'.repeat(43);
  t.after(() => room.disconnect());
  const silent = await admittedGuest(room, 'silent', null);
  const healthy = await admittedGuest(room, 'healthy');
  const busy = await admittedGuest(room, 'busy', { ok: false });
  t.mock.timers.tick(300_000); await flush();
  assert.equal(silent.disconnected(), 0);
  assert.equal(silent.connection.open, true);
  assert.equal(room.guestMembers.has('silent'), true);
  assert.equal(room.guests.size, 3);
  assert.equal(room.controlPending.size, 0, 'no presence requests queue up while a guest is frozen');
  silent.connection.close();
  assert.equal(silent.disconnected(), 1);
  assert.equal(room.guestMembers.has('silent'), false);
  assert.equal(room.guests.size, 2);
  assert.equal(healthy.disconnected(), 0); assert.equal(busy.disconnected(), 0);
  busy.connection.emit('error', new Error('transport ended'));
  assert.equal(busy.disconnected(), 1);
  assert.equal(room.guestMembers.has('busy'), false);
  room.disconnect();
  t.mock.timers.tick(60_000); await flush();
  assert.equal(room.controlPending.size, 0);
});

test('closing an older guest session cannot delete its replacement mapping', async t => {
  const room = new P2PRoom();
  room.roomId = 'ABCDEF12'; room.inviteSecret = 's'.repeat(43);
  t.after(() => room.disconnect());
  const guest = await admittedGuest(room, 'same-id');
  const replacement = { close() {} };
  room.guestMembers.set('same-id', replacement);
  guest.connection.close();
  assert.equal(room.guestMembers.get('same-id'), replacement);
  assert.equal(guest.disconnected(), 1);
});

test('disconnect still releases remaining connections when one cleanup throws', async () => {
  const room = new P2PRoom();
  const released = [];
  room.stopScreenStream = () => { throw Error('capture failed'); };
  room.local = { removeAllListeners() { throw Error('listener failed'); }, disconnect() { released.push('local'); } };
  room.browserService = { close: async () => { throw Error('service failed'); } };
  room.guests.add({ close() { throw Error('guest failed'); } });
  room.guests.add({ close() { released.push('guest'); } });
  room.remote = { close() { released.push('remote'); } };
  room.peer = { destroy() { released.push('peer'); } };
  room.screenViewers.set('bad', { pc: { close() { throw Error('viewer failed'); } } });
  room.screenViewers.set('good', { pc: { close() { released.push('viewer'); } } });
  room.disconnect();
  await flush();
  assert.deepEqual(released, ['local', 'guest', 'remote', 'peer', 'viewer']);
  assert.equal(room.closed, true);
  assert.equal(room.guests.size, 0);
  assert.equal(room.screenViewers.size, 0);
  assert.equal(room.browserService, null);
});

test('one failed track or screen session does not retain the rest of the capture', () => {
  const room = new P2PRoom();
  const released = [];
  room.stopVdoPublisher = () => { throw Error('publisher failed'); };
  room.screenSessions.set('bad', { videoPolicy: { stop() { throw Error('policy failed'); } }, pc: { close() { released.push('first-pc'); } } });
  room.screenSessions.set('good', { pc: { close() { released.push('second-pc'); } } });
  room.screenStream = {
    getTracks: () => [{ stop() { throw Error('track failed'); } }, { stop() { released.push('track'); } }],
    roomcastCleanup() { released.push('capture'); },
  };
  room.stopScreenStream();
  assert.deepEqual(released, ['first-pc', 'second-pc', 'track', 'capture']);
  assert.equal(room.screenStream, null);
  assert.equal(room.screenSessions.size, 0);
});
