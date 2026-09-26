import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import test from 'node:test';
import { Server } from 'socket.io';
import { io } from 'socket.io-client';
// Replace only the browser PeerJS constructor; the production room state machine
// and real Socket.IO servers remain under test.
const source = (await readFile(new URL('../src/p2p.js', import.meta.url), 'utf8'))
  .replace("import { Peer } from 'peerjs';", 'const Peer = null;')
  .replace("from 'socket.io-client'", `from '${import.meta.resolve('socket.io-client')}'`)
  .replace("from './lib.js'", `from '${new URL('../src/lib.js', import.meta.url).href}'`)
  .replace("from './relay.js'", `from '${new URL('../src/relay.js', import.meta.url).href}'`)
  .replace("from './p2p-video-policy.js'", `from '${new URL('../src/p2p-video-policy.js', import.meta.url).href}'`)
  .replace("from './ice-policy.js'", `from '${new URL('../src/ice-policy.js', import.meta.url).href}'`)
  .replace("from './p2p-auth.js'", `from '${new URL('../src/p2p-auth.js', import.meta.url).href}'`);
const { P2PRoom } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

class Channel extends EventEmitter {
  open = false;
  static authDelay = 0;
  send(value) {
    if (!this.open) throw new Error('closed');
    const deliver = () => { if (this.other.open) this.other.emit('data', structuredClone(value)); };
    if (value.authProof && Channel.authDelay) setTimeout(deliver, Channel.authDelay);
    else queueMicrotask(deliver);
  }
  close() { if (!this.open) return; this.open = false; this.other.open = false; this.emit('close'); this.other.emit('close'); }
}

for (const scenario of [
  { name: 'browser successor', count: 3, browserSuccessor: true },
  { name: 'browser successor with delayed probe', count: 3, browserSuccessor: true, browserProbeDelay: 1500 },
  { name: 'three members', count: 3 },
  { name: 'successor rejects arm without moving other members', count: 3, commitFailure: 'reject' },
  { name: 'lost arm acknowledgement can be aborted without moving members', count: 3, commitFailure: 'timeout' },
  { name: 'successor local service fails before arm', count: 3, commitFailure: 'local-disconnect' },
  { name: 'ten members, large history, slow authentication and repeated migration', count: 10, repeat: true },
  { name: 'ten members with failed first successor and disconnected member', count: 10, failed: true },
  { name: 'ten members with unresponsive oldest successor', count: 10, slow: true },
]) test(`P2PRoom migration: ${scenario.name}`, async t => {
  const registry = new Map(), peers = [], services = [];
  class TestRoom extends P2PRoom {
    async handleControl(message, connection) {
      if (message.control === 'migration:probe') {
        if (scenario.browserSuccessor && this.index !== 1) {
          connection.send({ controlReply: message.controlId, result: { ok: false } });
          return;
        }
        if (scenario.browserProbeDelay && this.index === 1) {
          await new Promise(resolve => setTimeout(resolve, scenario.browserProbeDelay));
        }
        if (scenario.commitFailure && this.index !== 1) {
          connection.send({ controlReply: message.controlId, result: { ok: false } });
          return;
        }
        if (scenario.slow && this.index === 1) return;
        await new Promise(resolve => setTimeout(resolve, this.index * 12));
      }
      if (scenario.failed && this.index === 1 && message.control === 'migration:prepare') {
        connection.send({ controlReply: message.controlId, result: { ok: false, error: 'forced successor failure' } });
        return;
      }
      if (scenario.commitFailure && this.index === 1 && message.control === 'migration:arm') {
        if (scenario.commitFailure === 'reject') {
          connection.send({ controlReply: message.controlId, result: { ok: false, error: 'forced rejection' } });
          return;
        }
        if (scenario.commitFailure === 'timeout') {
          return super.handleControl(message, { open: true, send() {} });
        }
        this.local.disconnect();
      }
      return super.handleControl(message, connection);
    }
    async localSocket() {
      if (scenario.browserSuccessor && this.index === 1) {
        const { createBrowserRoomService } = await import('../src/browser-room-service.js');
        this.browserService ||= createBrowserRoomService();
        return this.browserService.connect();
      }
      const socket = io(this.url, { transports: ['websocket'], reconnection: false });
      await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
      return socket;
    }
    async openPeer(id = crypto.randomUUID()) {
      if (registry.has(id)) throw new Error('occupied');
      const peer = new EventEmitter();
      peer.connections = new Set();
      peer.connect = (target, options) => {
        const channel = new Channel(), other = new Channel();
        channel.other = other; other.other = channel; other.metadata = options.metadata;
        const remote = registry.get(target);
        setTimeout(() => {
          if (!remote) return channel.emit('error', new Error('missing peer'));
          channel.open = other.open = true;
          peer.connections.add(channel); remote.connections.add(other);
          remote.emit('connection', other); channel.emit('open'); other.emit('open');
        }, 1);
        return channel;
      };
      peer.destroy = () => { registry.delete(id); for (const channel of peer.connections) channel.close(); peer.destroyed = true; };
      registry.set(id, peer); this.peer = peer;
    }
  }
  const { attachRooms } = await import('../server/rooms.mjs');
  for (let i = 0; i < scenario.count; i++) {
    const http = createServer(), server = new Server(http, { maxHttpBufferSize: 64 * 1024 });
    const rooms = attachRooms(server);
    await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
    const room = new TestRoom(); room.index = i; room.url = `http://127.0.0.1:${http.address().port}`;
    peers.push(room); services.push({ rooms, server });
  }
  t.after(async () => { Channel.authDelay = 0; for (const peer of peers) peer.disconnect(); for (const { rooms, server } of services) { await rooms.close(); await new Promise(resolve => server.close(resolve)); } });
  const a = peers[0];
  let b = peers[scenario.failed || scenario.slow ? 2 : 1], c = peers[scenario.failed || scenario.slow ? 3 : 2];
  const originalWindow = globalThis.window;
  globalThis.window = { roomcast: { fetchRelayIce: async () => { throw new Error('Worker 500'); } } };
  t.after(() => { globalThis.window = originalWindow; });
  const created = await a.enter('create', { name: 'test', nickname: 'A', relaySettings: { enabled: true, endpoint: 'https://roomcast.example.com' } }, {});
  assert.equal(created.turnUnavailable, true);
  assert.deepEqual(created.controlIceServers, [{ urls: 'stun:stun.cloudflare.com:3478' }]);
  const invite = `roomcast://join/${created.room.id}?secret=${a.inviteSecret}`;
  for (const peer of peers.slice(1)) await peer.enter('join', { roomId: invite, nickname: `guest ${peer.index}` }, {});
  assert.equal(a.guests.size, scenario.count - 1);
  if (scenario.count === 10) {
    const stored = services[0].rooms.rooms.get(created.room.id);
    stored.messages = Array.from({ length: 1000 }, (_, i) => ({ id: `long-${i}`, seq: i + 1, memberId: a.id, name: 'A', text: '测'.repeat(2000), at: Date.now() }));
    stored.nextMessageSeq = 1001;
    Channel.authDelay = 700;
  }
  if (scenario.failed) peers.at(-1).disconnect();
  for (const connection of a.guests) {
    assert.deepEqual(connection.metadata, { protocol: 2, authMode: 'invite' });
    assert.equal('inviteSecret' in connection.metadata, false);
  }
  const sharingPeers = [b, c];
  for (const peer of sharingPeers) {
    assert.equal((await peer.request('share:claim')).ok, true);
    assert.equal((await peer.request('share:started', { settings: {} })).ok, true);
  }
  const resumed = peer => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('migration did not finish')), 10000);
    peer.once('room:resumed', value => { clearTimeout(timer); resolve(value); });
  });
  const active = peers.slice(1).filter(peer => !peer.closed);
  if (scenario.commitFailure) {
    // A handover that never gets acknowledged must not trap the owner in the room any
    // more: leave() reports that the room was closed instead of rejecting, and no
    // member is moved onto an unacknowledged takeover.
    const outcome = await a.leave();
    assert.equal(outcome.ok, true);
    assert.equal(outcome.closed, true);
    assert.match(outcome.reason, /未确认接管|移交未能完成/);
    assert.equal(a.closed, true);
    assert.equal(a.guests.size, 0);
    for (const guest of active) {
      assert.equal(guest.migrating, false);
    }
    assert.equal(peers[1].pendingMigrationCommit, null);
    assert.equal(peers[1].preparedMigration, null);
    assert.equal(peers[1].local, null);
    return;
  }
  const waiting = Promise.all(active.map(resumed));
  void waiting.catch(() => {});
  const left = await a.leave();
  if (scenario.browserSuccessor) assert.equal(left.closed, undefined, 'responsive browser successor must keep the room alive');
  await waiting;
  b = active.find(peer => peer.id === left.migratedTo);
  c = active.find(peer => peer !== b);
  if (scenario.failed || scenario.slow) assert.notEqual(b, peers[1]);
  assert.equal(a.closed, true); assert.equal(a.guests.size, 0); assert.equal(a.pending.size, 0);
  assert.equal(b.isHost, true); assert.equal(c.isHost, false); assert.equal(c.remote.open, true);
  assert.equal(b.guests.size, active.length - 1);
  assert.equal(b.unauthenticated.size, 0);
  if (scenario.count === 10) {
    const history = await c.request('chat:history', { limit: 50 });
    assert.equal(history.messages.find(message => message.id === 'long-999')?.seq, 1000);
    assert.ok(history.messages.length > 0 && history.messages.length < 1000);
  }
  assert.equal(b.room.streams.length, 2); assert.equal(c.room.streams.length, 2);
  assert.equal((await c.request('chat:send', { text: 'after migration' })).ok, true);
  assert.equal((await b.request('chat:history', { limit: 50 })).messages.at(-1).text, 'after migration');
  for (const [viewer, owner] of [sharingPeers, [...sharingPeers].reverse()]) {
    assert.equal((await viewer.request('view:start', { ownerId: owner.id })).ok, true);
    assert.equal((await viewer.request('screen:signal', { kind: 'candidate', side: 'viewer', requestId: 'test', to: owner.id, candidate: null })).ok, true);
    assert.equal((await viewer.request('view:stop', { ownerId: owner.id })).ok, true);
  }
  if (scenario.repeat) {
    const remaining = active.filter(peer => peer !== b);
    const again = Promise.all(remaining.map(resumed));
    const leftAgain = await b.leave();
    await again;
    const nextHost = remaining.find(peer => peer.id === leftAgain.migratedTo);
    assert.equal(nextHost.isHost, true);
    assert.equal(nextHost.guests.size, remaining.length - 1);
    assert.equal((await remaining.at(-1).request('chat:send', { text: 'second migration' })).ok, true);
  }
});

test('migration prepare closes temporary local socket when migration-create fails', async () => {
  let disconnected = false;

  class FailingRoom extends P2PRoom {
    async localSocket() {
      const socket = new EventEmitter();

      socket.connected = true;
      socket.timeout = () => socket;

      socket.emit = (event, payload, callback) => {
        if (event === 'room:migration-create') {
          queueMicrotask(() => {
            callback(null, {
              ok: false,
              error: 'forced migration-create failure'
            });
          });
          return true;
        }

        return EventEmitter.prototype.emit.call(
          socket,
          event,
          payload,
          callback
        );
      };

      socket.disconnect = () => {
        disconnected = true;
        socket.connected = false;
      };

      return socket;
    }
  }

  const room = new FailingRoom();

  room.id = 'B';
  room.roomId = 'ABCDEF12';

  const replies = [];

  const connection = {
    open: true,
    send(value) {
      replies.push(value);
    }
  };

  await room.handleControl({
    control: 'migration:prepare',
    controlId: 'prepare-test',
    payload: {
      transfer: {
        roomId: 'ABCDEF12',
        members: [
          {
            id: 'B',
            role: 'owner'
          }
        ]
      },
      ticket: 't'.repeat(43),
      inviteSecret: 'i'.repeat(43)
    }
  }, connection);

  assert.equal(disconnected, true);
  assert.equal(room.local, null);
  assert.equal(room.preparedMigration, null);

  assert.equal(
    replies.at(-1)?.controlReply,
    'prepare-test'
  );

  assert.equal(
    replies.at(-1)?.result?.ok,
    false
  );
});

test('abort during migration-create cleans a late prepared coordinator', async () => {
  let finishCreate, disconnected = false, aborted = false;
  const local = new EventEmitter();
  local.connected = true;
  local.timeout = () => local;
  local.disconnect = () => { disconnected = true; };
  local.emit = (event, payload, callback) => {
    if (event === 'room:migration-create') finishCreate = () => callback(null, { ok: true });
    if (event === 'room:migration-abort') { aborted = true; callback(null, { ok: true }); }
  };
  const room = new P2PRoom();
  room.id = 'B'; room.roomId = 'ABCDEF12'; room.localSocket = async () => local;
  const replies = [];
  const connection = { open: true, send: value => replies.push(value) };
  const preparing = room.handleControl({ control: 'migration:prepare', controlId: 'prepare', payload: {
    transfer: { roomId: room.roomId, members: [{ id: room.id, role: 'owner' }] },
    ticket: 't'.repeat(43), inviteSecret: 'i'.repeat(43),
  } }, connection);
  await new Promise(resolve => setImmediate(resolve));
  await room.handleControl({ control: 'migration:abort', controlId: 'abort' }, connection);
  finishCreate();
  await preparing;
  assert.equal(aborted, true);
  assert.equal(disconnected, true);
  assert.equal(room.local, null);
  assert.equal(room.preparedMigration, null);
  assert.equal(replies.find(reply => reply.controlReply === 'prepare').result.ok, false);
});
