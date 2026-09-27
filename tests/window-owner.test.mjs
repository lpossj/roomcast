import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const { liveWebContents, ownsWindowEvent } = createRequire(import.meta.url)('../electron/window-owner.cjs');
const trusted = url => url === 'http://127.0.0.1:3210/';

test('late IPC never reads destroyed windows or accepts a destroyed frame', () => {
  let reads = 0;
  const destroyed = { isDestroyed: () => true, get webContents() { reads++; throw new Error('Object has been destroyed'); } };
  assert.equal(liveWebContents(destroyed), null);
  assert.equal(ownsWindowEvent({}, destroyed, trusted), false);
  assert.equal(reads, 0);
  const frame = { url: 'http://127.0.0.1:3210/' };
  const contents = { isDestroyed: () => false, mainFrame: frame };
  const candidate = { isDestroyed: () => false, webContents: contents };
  const event = { sender: contents, senderFrame: frame };
  assert.equal(ownsWindowEvent(event, candidate, trusted), true);
  assert.equal(ownsWindowEvent({ ...event, sender: {} }, candidate, trusted), false);
  assert.equal(ownsWindowEvent({ ...event, senderFrame: { ...frame } }, candidate, trusted), false);
  Object.defineProperty(frame, 'url', { get: () => { throw new Error('destroyed frame'); } });
  assert.equal(ownsWindowEvent(event, candidate, trusted), false);
});

test('actual preference IPC responds safely when the main window has been destroyed for update', async () => {
  const source = await readFile(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  const start = source.indexOf("      ipcMain.on('roomcast:preference-get',");
  const end = source.indexOf("      ipcMain.on('roomcast:preference-set',", start);
  let handler;
  vm.runInNewContext(source.slice(start, end), {
    ipcMain: { on: (name, callback) => { handler = callback; } },
    window: { isDestroyed: () => true, get webContents() { throw new Error('Object has been destroyed'); } },
    owns: (event, candidate) => ownsWindowEvent(event, candidate, trusted),
    preferenceKeys: new Set(['nickname']), preferences: { nickname: 'private' },
  });
  const event = { sender: {}, senderFrame: {} };
  assert.doesNotThrow(() => handler(event, 'nickname'));
  assert.equal(event.returnValue, undefined);
});

test('permission checks fail closed for null contents after window destruction', async () => {
  const source = await readFile(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  const start = source.indexOf('      privateSession.setPermissionCheckHandler(');
  const end = source.indexOf('      privateSession.setDisplayMediaRequestHandler(', start);
  let handler;
  vm.runInNewContext(source.slice(start, end), {
    privateSession: { setPermissionCheckHandler: callback => { handler = callback; } },
    window: { isDestroyed: () => true }, liveWebContents, trusted,
  });
  assert.equal(handler(null, 'media', 'http://127.0.0.1:3210/'), false);
});
