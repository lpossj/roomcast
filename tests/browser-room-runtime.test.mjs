import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash as nodeCreateHash, randomBytes as nodeRandomBytes, scrypt as nodeScrypt, timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import viteConfig from '../vite.config.js';
import { createBrowserRoomService } from '../src/browser-room-service.js';
import { Buffer as ShimBuffer, createHash, randomBytes, scrypt as shimScrypt, timingSafeEqual } from '../src/browser-node-crypto.js';

const roomsPath = fileURLToPath(new URL('../server/rooms.mjs', import.meta.url));

test('the vite browser-room-crypto transform rewrites every node: import in server/rooms.mjs', () => {
  const plugin = viteConfig.plugins.find(candidate => candidate.name === 'browser-room-crypto');
  assert.ok(plugin, 'vite 配置缺少 browser-room-crypto 插件');
  const source = readFileSync(roomsPath, 'utf8');
  const transformed = plugin.transform(source, roomsPath.replaceAll('\\', '/'));
  assert.ok(transformed, 'transform 未命中 server/rooms.mjs');
  assert.ok(!/['"]node:(?:crypto|util)['"]/.test(transformed), '浏览器包不得保留 node: 内置模块导入');
  assert.equal((transformed.match(/browser-node-crypto\.js/g) || []).length, 2);
  assert.equal(plugin.transform(source, '/project/src/other.js'), null);
  // If server/rooms.mjs is reformatted the rewrite must fail the build, not silently
  // ship node:crypto into the browser bundle and break the web host at runtime.
  assert.throws(
    () => plugin.transform(source.replace('randomUUID, ', ''), roomsPath.replaceAll('\\', '/')),
    /browser-room-crypto/,
  );
});

test('browser room service runs the shared room rules through the in-page socket shim', async t => {
  const service = createBrowserRoomService();
  t.after(() => service.close());

  const request = (socket, event, payload = {}) => new Promise((resolve, reject) => {
    socket.timeout(4000).emit(event, payload, (error, response) => error ? reject(error) : resolve(response));
  });

  const host = service.connect();
  const states = [];
  const left = [];
  host.on('room:state', value => states.push(value));
  host.on('member:left', value => left.push(value));

  const created = await request(host, 'room:create', { name: '浏览器房间', nickname: '房主' });
  assert.equal(created.ok, true);
  assert.equal(created.room.members.length, 1);

  const guest = service.connect();
  const joined = await request(guest, 'room:join', { roomId: created.room.id, nickname: '朋友' });
  assert.equal(joined.ok, true);
  assert.equal(joined.room.members.length, 2);
  assert.ok(states.length >= 1, '房主应收到 room:state 广播');

  const sent = await request(guest, 'chat:send', { text: '来自浏览器访客' });
  assert.equal(sent.ok, true);
  const history = await request(host, 'chat:history', {});
  assert.ok(history.messages.some(message => message.text === '来自浏览器访客'), '聊天历史应包含访客消息');

  guest.disconnect();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(left.length, 1, '访客断开应广播 member:left');
  const last = states.at(-1);
  assert.equal((last?.members ?? last?.room?.members)?.length, 1, '访客断开后房间应只剩房主');

  await assert.rejects(() => request(host, 'room:not-a-real-operation', {}), /Unknown room operation/);
});

test('browser crypto shim matches node:crypto for the paths server/rooms.mjs uses', async () => {
  assert.equal(createHash('sha256').update('roomcast').digest('hex'), nodeCreateHash('sha256').update('roomcast').digest('hex'));
  assert.match(randomBytes(32).toString('hex'), /^[0-9a-f]{64}$/);

  // rooms.mjs hashes room passwords with scrypt(password, salt, 32) and compares the
  // derived key, so the shim must be byte-identical to Node's implementation.
  const secret = 'correct horse battery staple';
  const salt = nodeRandomBytes(16);
  const shimKey = await promisify(shimScrypt)(secret, ShimBuffer.from(salt), 32);
  const nodeKey = await promisify(nodeScrypt)(secret, salt, 32, { N: 16384, r: 8, p: 1 });
  assert.deepEqual([...shimKey], [...nodeKey]);
  assert.equal(timingSafeEqual(shimKey, ShimBuffer.from(nodeKey)), true);
  assert.throws(() => timingSafeEqual(shimKey, ShimBuffer.from(nodeKey).subarray(0, 16)), /Byte lengths differ/);
  assert.equal(nodeTimingSafeEqual(Buffer.from(shimKey), nodeKey), true);

  const payload = JSON.stringify({ text: '中文字符' });
  assert.equal(ShimBuffer.byteLength(payload, 'utf8'), Buffer.byteLength(payload, 'utf8'));
  assert.equal(ShimBuffer.from('00ff10', 'hex').toString('hex'), '00ff10');
  assert.equal(ShimBuffer.from('aGk=', 'base64').toString('utf8'), 'hi');
  assert.equal(ShimBuffer.from(new Uint8Array([104, 105]).buffer, 0, 2).toString('utf8'), 'hi');
  assert.ok(ShimBuffer.isBuffer(ShimBuffer.from([1, 2, 3])));
  assert.equal(ShimBuffer.from('roomcast').subarray(0, 4).toString('utf8'), 'room');
});
