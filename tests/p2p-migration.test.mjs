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
