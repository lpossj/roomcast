import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

// Closing Roomcast used to be gated on the room handover: a failed migration replied
// `ok: false` and the window stayed open forever. Exit is now unconditional - the
// handover gets a short budget and the window closes regardless.
test('Electron closes the window even when the handover fails, is unanswered or is asked twice', async () => {
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
    console: { warn() {} },
    Date, CLOSE_GRACE_MS: 2500,
    saveTimer: null, closeHandshakeTimer: null, closeRequestedAt: 0, forceWindowClose: false, quitting: false,
    process: { env: {} }, writeWindowState() {}, trusted: () => true,
  });
  vm.runInContext(source.slice(start, end), context);
  const request = () => handlers.get('close')({ preventDefault: () => cancelled++ });
  const reply = result => handlers.get('roomcast:close-ready')({ sender: webContents, senderFrame: webContents.mainFrame }, result);

  // A reported migration failure is information, not a veto.
  request();
  assert.equal(closes, 0, 'the first close request must still give the handover its budget');
  reply({ ok: false, reason: '新房主未确认接管' });
  assert.equal(closes, 1, 'a failed handover must not keep the window open');
  assert.equal(cancelled, 1);

  // Asking twice quits immediately, even if the renderer never answers. The second
  // request is still prevented before the forced close is issued, so it counts as a
  // cancelled attempt plus the close that follows.
  closes = 0; cancelled = 0; context.forceWindowClose = false; context.closeRequestedAt = 0;
  request(); request();
  assert.equal(closes, 1, 'a second close request must close the window at once');
  assert.equal(cancelled, 2);

  // And the deadline closes it when nothing answers at all.
  closes = 0; cancelled = 0; context.forceWindowClose = false; context.closeRequestedAt = 0;
  request();
  assert.equal(typeof timeout, 'function');
  timeout();
  assert.equal(closes, 1, 'the grace deadline must close the window on its own');
});
