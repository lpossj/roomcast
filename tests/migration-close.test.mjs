import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../electron/main.cjs', import.meta.url), 'utf8');
const start = source.indexOf("window.on('close',");
const end = source.indexOf("ipcMain.on('roomcast:system-accent-color-get'", start);
assert.ok(start >= 0 && end > start);

for (const testMode of [false, true]) {
  test(`first native close exits immediately, including unresponsive renderer and cleanup (test mode: ${testMode})`, () => {
    let close, exits = [];
    const context = vm.createContext({
      window: { on: (event, handler) => { assert.equal(event, 'close'); close = handler; },
        webContents: { send() { throw new Error('renderer is unresponsive'); } } },
      app: { exit: code => exits.push(code) },
      clearTimeout() {}, setTimeout() { throw new Error('exit must not schedule a wait'); },
      writeWindowState() { throw new Error('disk write is blocked'); },
      service: { close: () => new Promise(() => {}) },
      saveTimer: 1, quitting: false, process: { env: testMode ? { ROOMCAST_TEST_MODE: '1' } : {} },
    });
    vm.runInContext(source.slice(start, end), context);
    close({ preventDefault() { throw new Error('close must not be vetoed'); } });
    assert.deepEqual(exits, [0]);
    assert.equal(context.quitting, true);
  });
}

test('automatic update destroys only the main window and keeps its pipeline alive', () => {
  const start = source.indexOf('// Destroy only the main window:');
  const end = source.indexOf('return { ok: true, version:', start);
  assert.ok(start >= 0 && end > start);
  const calls = [];
  const context = vm.createContext({
    window: { isDestroyed: () => false, destroy: () => calls.push('destroy'),
      close() { throw new Error('normal close would exit the updater'); } },
    runUpdatePipeline: () => { calls.push('update'); return Promise.resolve(); },
    target: {}, asset: {}, lastUpdateCheck: { version: 'test' }, updatePipeline: null,
  });
  vm.runInContext(source.slice(start, end), context);
  assert.deepEqual(calls, ['destroy', 'update']);
});
