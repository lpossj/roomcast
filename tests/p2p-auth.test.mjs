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

test('a silent web guest is removed without a close event while responsive and busy guests stay', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const room = new P2PRoom();
  room.roomId = 'ABCDEF12'; room.inviteSecret = 's'.repeat(43);
  t.after(() => room.disconnect());
  const silent = await admittedGuest(room, 'silent', null);
  const healthy = await admittedGuest(room, 'healthy');
  const busy = await admittedGuest(room, 'busy', { ok: false });
  t.mock.timers.tick(10_000); await flush();
  assert.equal(silent.probes(), 1);
  assert.equal(silent.disconnected(), 0);
  t.mock.timers.tick(14_999); await flush();
  assert.equal(silent.disconnected(), 0, 'allow the full response budget');
  t.mock.timers.tick(1); await flush();
  assert.equal(silent.disconnected(), 1);
  assert.equal(silent.closed(), 1);
  assert.equal(room.guestMembers.has('silent'), false);
  assert.equal(room.guests.has(silent.connection), false);
  assert.equal(healthy.disconnected(), 0);
  assert.equal(busy.disconnected(), 0, 'busy replies still prove presence');
  assert.equal(room.guests.size, 2);
  room.disconnect();
  const probes = healthy.probes();
  t.mock.timers.tick(60_000); await flush();
  assert.equal(healthy.probes(), probes, 'no probes after closing the room');
  assert.equal(room.controlPending.size, 0);
});

test('host timer suspension resets presence instead of expiring its web guest', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let clock = 0;
  t.mock.method(performance, 'now', () => clock);
  const room = new P2PRoom();
  room.roomId = 'ABCDEF12'; room.inviteSecret = 's'.repeat(43);
  t.after(() => room.disconnect());
  const guest = await admittedGuest(room, 'paused', null);
  t.mock.timers.tick(10_000); await flush();
  clock = 60_000;
  t.mock.timers.tick(15_000); await flush();
  assert.equal(guest.disconnected(), 0);
  t.mock.timers.tick(10_000); await flush();
  assert.equal(guest.probes(), 2, 'resume with a fresh probe');
  clock += 15_000;
  t.mock.timers.tick(15_000); await flush();
  assert.equal(guest.disconnected(), 1, 'a new timely unanswered probe expires the guest');
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

