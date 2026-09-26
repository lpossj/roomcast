import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { waitForRoomOperation } from '../src/room-operation.js';

const source = await readFile(new URL('../src/useRoom.js', import.meta.url), 'utf8');
const callbacks = source.slice(source.indexOf('  const leave ='), source.indexOf('  const command ='));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));
const details = { networkMode: 'p2p', nickname: 'test', roomId: 'invite' };
const result = id => ({ room: { id }, selfId: id, readToken: id });

function harness({ desktop = false, fetch = async () => ({ ok: true, json: async () => ({}) }) } = {}) {
  const state = {}, sockets = [];
  const socketRef = { current: null }, operationRef = { current: null };
  class Socket {
    constructor() { this.p2p = true; this.listeners = new Map(); this.entry = deferred(); sockets.push(this); }
    on(name, callback) { this.listeners.set(name, callback); }
    removeAllListeners() { this.listeners.clear(); }
    disconnect() { this.disconnected = true; }
    enter() { return this.entry.promise; }
    leave() { return this.leaving?.promise || Promise.resolve({ ok: true }); }
  }
  const context = {
    useCallback: callback => callback, AbortController, AbortSignal, waitForRoomOperation,
    socketRef, operationRef, membersRef: { current: null }, errorRef: { current() {} },
    P2PRoom: Socket, fetch, window: { location: { origin: 'http://local' }, roomcast: { desktop } },
    console: { error() {} }, clearMessages() {}, playSound() {}, savePreference() {},
    normalizeServer: value => value, containsTurn: () => false, mediaIceServers: () => [],
    receiveRoom: room => { state.room = room; }, loadInitialMessages: async () => {}, syncMissingMessages: async () => {},
  };
  for (const name of ['Room', 'SelfId', 'ReadToken', 'OwnerToken', 'Config', 'Connection', 'Server']) {
    context[`set${name}`] = value => { state[name[0].toLowerCase() + name.slice(1)] = value; };
  }
  for (const name of ['memberLeft', 'receiveChatMessage', 'receiveImageAbort', 'receiveImageChunk',
    'receiveImageComplete', 'receiveImageStart', 'receiveRecall']) context[name] = () => {};
  const api = vm.runInNewContext(callbacks + ';({leave,enter});', context);
  return { ...api, state, sockets, socketRef, operationRef };
}

test('cancel a configuration request before any socket exists, then reuse the app', async () => {
  let signal;
  const h = harness({ desktop: true, fetch: (_url, options) => { signal = options.signal; return new Promise(() => {}); } });
  const entry = h.enter('create', details);
  await tick();
  assert.equal(h.state.connection, 'connecting');
  await h.leave(true);
  assert.equal(signal.aborted, true);
  assert.equal((await entry).cancelled, true);
  assert.equal(h.state.connection, 'idle');
  assert.equal(h.state.room, null);
  assert.equal(h.sockets.length, 0);
});

for (const lateResult of ['resolve', 'reject']) {
  test(`cancel an unresponsive entry; late ${lateResult} cannot overwrite the next room`, async () => {
    const h = harness();
    const first = h.enter('join', details);
    await tick();
    const old = h.sockets[0], oldState = old.listeners.get('room:state');
    await h.leave(true);
    assert.equal((await first).cancelled, true);
    assert.equal(old.disconnected, true);
    const second = h.enter('join', details);
    await tick();
    h.sockets[1].entry.resolve(result('new'));
    await second;
    if (lateResult === 'resolve') old.entry.resolve(result('old'));
    else old.entry.reject(new Error('late failure'));
    oldState({ id: 'old-event' });
    await tick();
    assert.equal(h.state.room.id, 'new');
    assert.equal(h.state.connection, 'connected');
    assert.equal(h.socketRef.current, h.sockets[1]);
  });
}

test('force leave interrupts hung host transfer; its late completion cannot clear a new room', async () => {
  const h = harness();
  const joined = h.enter('join', details);
  await tick();
  const old = h.sockets[0];
  old.entry.resolve(result('old')); await joined;
  old.leaving = deferred();
  const leaving = h.leave();
  assert.equal(h.state.connection, 'leaving');
  await h.leave(true);
  assert.equal(h.state.room, null);
  assert.equal(h.state.connection, 'idle');
  assert.equal((await leaving).cancelled, true);
  const next = h.enter('join', details); await tick();
  h.sockets[1].entry.resolve(result('new')); await next;
  old.leaving.resolve({ closed: true }); await tick();
  assert.equal(h.state.room.id, 'new');
});

test('transfer and disconnect exceptions still reset local state and permit another entry', async () => {
  const h = harness();
  const joined = h.enter('join', details); await tick();
  const socket = h.sockets[0]; socket.entry.resolve(result('old')); await joined;
  socket.leave = async () => { throw new Error('transfer failure'); };
  socket.removeAllListeners = () => { throw new Error('listener cleanup failure'); };
  socket.disconnect = () => { throw new Error('disconnect failure'); };
  await assert.rejects(h.leave(), /transfer failure/);
  assert.equal(h.socketRef.current, null);
  assert.equal(h.state.connection, 'idle');
  assert.equal(h.state.room, null);
  const next = h.enter('join', details); await tick();
  h.sockets[1].entry.resolve(result('new')); await next;
  assert.equal(h.state.room.id, 'new');
});

test('closed P2P creation cannot resume after a delayed TURN response', async () => {
  const p2p = await readFile(new URL('../src/p2p.js', import.meta.url), 'utf8');
  const methods = p2p.slice(p2p.indexOf('  assertOpen()'), p2p.indexOf('  async connectRemote()'));
  const relay = deferred();
  const Room = vm.runInNewContext(`(class { ${methods} })`, {
    DOMException, randomSecret: () => 'test', optionalRelayIce: () => relay.promise,
  });
  const room = new Room();
  let localCreated = false;
  room.localSocket = async () => { localCreated = true; };
  const entry = room.enter('create', { nickname: 'test' }, {});
  room.closed = true;
  relay.resolve({ iceServers: [] });
  await assert.rejects(entry, error => error.name === 'AbortError');
  assert.equal(localCreated, false);
});

test('closed P2P local socket disconnects when its delayed connection finally opens', async () => {
  const p2p = await readFile(new URL('../src/p2p.js', import.meta.url), 'utf8');
  const methods = p2p.slice(p2p.indexOf('  assertOpen()'), p2p.indexOf('  async openPeer('));
  let open, disconnected = false;
  const Room = vm.runInNewContext(`(class { ${methods} })`, {
    DOMException, window: { location: { origin: 'local' } },
    io: () => ({ once: (event, callback) => { if (event === 'connect') open = callback; },
      connect() {}, disconnect() { disconnected = true; } }),
    withTimeout: promise => promise,
  });
  const room = new Room(), connecting = room.localSocket();
  room.closed = true; open();
  await assert.rejects(connecting, error => error.name === 'AbortError');
  assert.equal(disconnected, true);
});
