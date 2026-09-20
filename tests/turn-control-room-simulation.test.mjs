import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { io as clientIo } from 'socket.io-client';
import { attachRooms } from '../server/rooms.mjs';

function request(socket, event, payload = {}) {
  return new Promise((resolve, reject) => {
    socket.timeout(4000).emit(
      event,
      payload,
      (error, response) => error ? reject(error) : resolve(response),
    );
  });
}

function nextEvent(socket, name, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(name, handler);
      reject(new Error(`Timed out waiting for ${name}`));
    }, timeout);

    const handler = value => {
      clearTimeout(timer);
      resolve(value);
    };

    socket.once(name, handler);
  });
}

async function harness(t) {
  const http = createServer();
  const io = new Server(http, {
    transports: ['websocket'],
    maxHttpBufferSize: 128_000,
  });
  const service = attachRooms(io);
  const clients = [];

  await new Promise(resolve =>
    http.listen(0, '127.0.0.1', resolve),
  );

  const url = `http://127.0.0.1:${http.address().port}`;

  t.after(async () => {
    for (const socket of clients) socket.disconnect();
    await service.close();
    await new Promise(resolve => io.close(resolve));
  });

  return {
    service,
    async connect() {
      const socket = clientIo(url, {
        transports: ['websocket'],
        reconnection: false,
        forceNew: true,
      });

      clients.push(socket);
      await nextEvent(socket, 'connect');
      return socket;
    },
  };
}

const createRoom = socket =>
  request(socket, 'room:create', {
    name: 'TURN 加房模拟',
    nickname: '房主',
  });

const joinRoom = (socket, roomId, nickname) =>
  request(socket, 'room:join', {
    roomId,
    nickname,
  });

test('CONTROL simulation: joining is independent from 0 / 1 / 2 active screen shares', async t => {
  const { connect, service } = await harness(t);

  const owner = await connect();
  const first = await connect();
  const second = await connect();
  const third = await connect();

  const created = await createRoom(owner);
  assert.equal(created.ok, true);

  // 0 active shares: first guest must still join.
  const joined0 = await joinRoom(
    first,
    created.room.id,
    '0 路共享加入者',
  );
  assert.equal(joined0.ok, true);
  assert.equal(service.rooms.get(created.room.id).streams.size, 0);

  // 1 active share: owner starts sharing, second guest must still join.
  assert.equal((await request(owner, 'share:claim')).ok, true);
  assert.equal((await request(owner, 'share:started', {
    settings: {
      width: 1920,
      height: 1080,
      fps: 30,
      bitrate: 4500,
      performanceMode: 'quality',
    },
  })).ok, true);

  assert.equal(service.rooms.get(created.room.id).streams.size, 1);

  const joined1 = await joinRoom(
    second,
    created.room.id,
    '1 路共享加入者',
  );
  assert.equal(joined1.ok, true);

  // 2 active shares: first guest also shares, third guest must still join.
  assert.equal((await request(first, 'share:claim')).ok, true);
  assert.equal((await request(first, 'share:started', {
    settings: {
      width: 1280,
      height: 720,
      fps: 30,
      bitrate: 3000,
      performanceMode: 'quality',
    },
  })).ok, true);

  assert.equal(service.rooms.get(created.room.id).streams.size, 2);

  const joined2 = await joinRoom(
    third,
    created.room.id,
    '2 路共享加入者',
  );
  assert.equal(joined2.ok, true);

  assert.equal(service.rooms.get(created.room.id).members.size, 4);
});
