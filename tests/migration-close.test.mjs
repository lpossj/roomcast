import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../electron/main.cjs', import.meta.url), 'utf8');
const start = source.indexOf("const exitImmediately =");
const end = source.indexOf("ipcMain.on('roomcast:system-accent-color-get'", start);
assert.ok(start >= 0 && end > start);

for (const testMode of [false, true]) {
  test(`first native close exits immediately, including unresponsive renderer and cleanup (test mode: ${testMode})`, () => {
    let close, exits = [];
    const context = vm.createContext({
      window: { on: (event, handler) => { assert.equal(event, 'close'); close = handler; },
        hookWindowMessage() {},
        webContents: { send() { throw new Error('renderer is unresponsive'); } } },
      app: { exit() { throw new Error('Electron window destruction must be bypassed'); } },
      setImmediate: callback => callback(), clearTimeout() {}, setTimeout() { throw new Error('exit must not schedule a wait'); },
      writeWindowState() { throw new Error('disk write is blocked'); },
      service: { close: () => new Promise(() => {}) },
      saveTimer: 1, quitting: false, process: { reallyExit: code => exits.push(code), platform: 'win32', env: testMode ? { ROOMCAST_TEST_MODE: '1' } : {} },
    });
    vm.runInContext(source.slice(start, end), context);
    close({ preventDefault() { throw new Error('close must not be vetoed'); } });
    assert.deepEqual(exits, [0]);
    assert.equal(context.quitting, true);
  });
}


test('Windows native X and Alt+F4 bypass the delayed Electron close event', () => {
  const hooks = new Map(), exits = [];
  const context = vm.createContext({
    window: { on() {}, hookWindowMessage: (message, handler) => hooks.set(message, handler) },
    app: { exit: code => exits.push(code) }, clearTimeout() {}, saveTimer: 1,
    quitting: false, process: { platform: 'win32', reallyExit: code => exits.push(code) },
  });
  vm.runInContext(source.slice(start, end), context);
  const param = Buffer.alloc(8);
  param.writeUInt32LE(0xf020); // minimize does not exit
  hooks.get(0x0112)(param);
  assert.deepEqual(exits, []);
  param.writeUInt32LE(0xf063); // SC_CLOSE low bits vary
  hooks.get(0x0112)(param);
  hooks.get(0x0010)();
  assert.deepEqual(exits, [0, 0]);
});

test('automatic update destroys only the main window and keeps its pipeline alive', () => {
  const start = source.indexOf('// Destroy only the main window:');
  const end = source.indexOf('return { ok: true, version:', start);
  assert.ok(start >= 0 && end > start);
  const calls = [];
  const context = vm.createContext({
    window: { isDestroyed: () => false, destroy: () => calls.push('destroy'),
      close() { throw new Error('normal close would exit the updater'); } },
    runUpdatePipeline: () => { calls.push('update'); return Promise.resolve(); },
    stopAllAudioCaptures() {}, runObsCaptureOperation: async callback => callback(), closeObsCaptureEngine() {},
    target: {}, asset: {}, lastUpdateCheck: { version: 'test' }, updatePipeline: null,
  });
  vm.runInContext(source.slice(start, end), context);
  assert.deepEqual(calls, ['destroy', 'update']);
});
