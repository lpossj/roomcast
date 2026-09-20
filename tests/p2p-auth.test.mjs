import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createPeerAuthProof, MAX_UNAUTHENTICATED_PEERS, randomPeerAuthNonce, verifyPeerAuthProof } from '../src/p2p-auth.js';

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
