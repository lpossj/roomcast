import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import test from 'node:test';
import { Server } from 'socket.io';
import { io } from 'socket.io-client';
import { attachRooms } from '../server/rooms.mjs';
import { createPeerAuthProof } from '../src/p2p-auth.js';
import { ack } from '../src/lib.js';

// Accelerate only the two presence clocks; authentication, RPCs and the actual
// room server remain in use. The production 25-second budget has its own test.
const source = (await readFile(new URL('../src/p2p.js', import.meta.url), 'utf8'))
  .replace("import { Peer } from 'peerjs';", 'const Peer = null;')
  .replace("from 'socket.io-client'", `from '${import.meta.resolve('socket.io-client')}'`)
  .replace(/from '(\.\/[\w-]+\.js)'/g, (_, file) => `from '${new URL('../src/' + file.slice(2), import.meta.url).href}'`)
  .replace('GUEST_PROBE_INTERVAL_MS = 10_000', 'GUEST_PROBE_INTERVAL_MS = 100')
  .replace('GUEST_PROBE_TIMEOUT_MS = 15_000', 'GUEST_PROBE_TIMEOUT_MS = 100');
const { P2PRoom } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('silent page cleanup reaches the real room member list without affecting a responsive guest', async t => {
  const http = createServer();
  const server = new Server(http, { transports: ['websocket'] });
  const service = attachRooms(server);
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${http.address().port}`;
  const room = new P2PRoom();
  room.isHost = true; room.inviteSecret = 's'.repeat(43);
  const sockets = [];
  room.localSocket = async () => {
    const socket = io(url, { transports: ['websocket'], reconnection: false, forceNew: true });
    sockets.push(socket);
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    return socket;
  };
  t.after(async () => {
    room.disconnect();
    for (const socket of sockets) socket.disconnect();
    await service.close();
    await new Promise(resolve => server.close(resolve));
  });
  room.local = await room.localSocket();
  const created = await ack(room.local, 'room:create', { nickname: 'host', name: 'presence' });
  room.roomId = created.room.id;
  const stored = service.rooms.get(room.roomId);
  const guest = async responsive => {
    const connection = new EventEmitter();
    connection.open = true;
    connection.metadata = { protocol: 2, authMode: 'invite' };
    let joined;
    const admission = new Promise(resolve => { joined = resolve; });
    connection.send = message => {
      if (message.authChallenge) void createPeerAuthProof(room.inviteSecret, message.authChallenge)
        .then(authProof => connection.emit('data', { authProof }));
      if (message.reply === 'join') joined(message.result);
      if (responsive && message.control === 'migration:probe') queueMicrotask(() =>
        connection.emit('data', { controlReply: message.controlId, result: { ok: false } }));
    };
    connection.close = () => { connection.open = false; connection.emit('close'); };
    await room.accept(connection);
    connection.emit('data', { id: 'join', event: 'room:join', payload: { roomId: room.roomId, nickname: 'same nickname' } });
    const result = await admission;
    assert.equal(result.ok, true);
    return { connection, id: result.selfId };
  };
  const silent = await guest(false), healthy = await guest(true);
  assert.equal(stored.members.size, 3);
  let state;
  room.local.on('room:state', value => { state = value; });
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && (!state || stored.members.size !== 2)) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(stored.members.size, 2);
  assert.equal(stored.members.has(silent.id), false);
  assert.equal(stored.members.has(healthy.id), true);
  assert.equal(healthy.connection.open, true);
  assert.equal(state.members.some(member => member.id === silent.id), false);
  assert.equal(state.members.some(member => member.id === healthy.id), true);
});
