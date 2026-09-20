import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

test('Electron keeps the coordinator alive on migration failure or handshake timeout', async () => {
  const source = await readFile(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  const start = source.indexOf("window.on('close', event => {");
  const end = source.indexOf("ipcMain.on('roomcast:system-accent-color-get'", start);
  assert.ok(start >= 0 && end > start);
  const handlers = new Map();
  let timeout, closes = 0, cancelled = 0;
  const webContents = { send() {}, mainFrame: { url: 'app' } };
  const context = vm.createContext({
    window: { on: (event, handler) => handlers.set(event, handler), webContents, isDestroyed: () => false, close: () => closes++ },
    ipcMain: { on: (event, handler) => handlers.set(event, handler) },
    clearTimeout() {}, setTimeout: callback => { timeout = callback; return 1; },
    saveTimer: null, closeHandshakeTimer: null, forceWindowClose: false, quitting: false,
    process: { env: {} }, writeWindowState() {}, trusted: () => true,
  });
  vm.runInContext(source.slice(start, end), context);
  const request = () => handlers.get('close')({ preventDefault: () => cancelled++ });
  const reply = result => handlers.get('roomcast:close-ready')({ sender: webContents, senderFrame: webContents.mainFrame }, result);
  request(); reply({ ok: false });
  assert.equal(closes, 0); assert.equal(context.closeHandshakeTimer, null);
  request(); timeout();
  assert.equal(closes, 0); assert.equal(context.forceWindowClose, false);
  request(); reply({ ok: true });
  assert.equal(closes, 1); assert.equal(cancelled, 3);
});
