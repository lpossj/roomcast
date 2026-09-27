import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
const { ObsFixedFpsEngine } = createRequire(import.meta.url)('../electron/obs-fixed-fps.cjs');

test('stop cancels a hung queue, skips queued starts and cannot affect a new session', async () => {
  const source = await readFile(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  const helper = source.slice(source.indexOf('let obsCaptureEngine = null;'), source.indexOf('const TITLEBAR_HEIGHT'));
  const context = vm.createContext({ setTimeout, clearTimeout, window: null });
  vm.runInContext(helper + `
    globalThis.api = { runObsCaptureOperation, closeObsCaptureEngine,
      set: engine => { obsCaptureEngine = engine; obsCaptureSessionId = 'current_123'; },
      current: () => obsCaptureEngine };
  `, context);
  const api = context.api;
  let finishOld, lateResult = false, queuedStart = false;
  const engine = { retire() {}, close: async () => ({ ok: true }) };
  api.set(engine);
  const old = api.runObsCaptureOperation(async check => {
    await new Promise(resolve => { finishOld = resolve; });
    check(); lateResult = true;
  });
  const queued = api.runObsCaptureOperation(() => { queuedStart = true; });
  const rejectedOld = assert.rejects(old, /已取消/), rejectedQueued = assert.rejects(queued, /已取消/);
  await Promise.resolve();
  await api.closeObsCaptureEngine({ captureId: 'current_123', cancelPending: true });
  await Promise.all([rejectedOld, rejectedQueued]);
  const newEngine = { close: async () => { throw new Error('must preserve new capture'); } };
  await api.runObsCaptureOperation(() => api.set(newEngine));
  finishOld();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(lateResult, false);
  assert.equal(queuedStart, false);
  assert.equal(api.current(), newEngine);
  const stale = await api.closeObsCaptureEngine({ expectedEngine: engine });
  assert.equal(stale.stale, true);
});

test('retired engine never launches after slow preparation completes', async () => {
  const engine = new ObsFixedFpsEngine({ rootDir: process.cwd() });
  let finish;
  engine.prepare = () => new Promise(resolve => { finish = resolve; });
  const launched = engine.launch();
  const rejected = assert.rejects(launched, error => error.code === 'OBS_CAPTURE_CANCELLED');
  engine.retire(); finish();
  await rejected;
  assert.equal(engine.process, null);
});

test('cleanup deadline covers a hung first request and termination helper, closes only owned child once', async () => {
  const engine = new ObsFixedFpsEngine({ rootDir: process.cwd() });
  const child = new EventEmitter();
  child.pid = 12345; child.exitCode = null; child.signalCode = null;
  let kills = 0;
  child.kill = () => { kills++; child.exitCode = 1; child.emit('exit', 1); };
  engine.process = child;
  engine.client = { ready: true, close: async () => {} };
  engine.stopVirtualCamera = () => new Promise(() => {});
  const started = performance.now();
  const options = { cleanupTimeoutMs: 20, forceTimeoutMs: 20, fallbackTimeoutMs: 10,
    terminateProcess: managed => { assert.equal(managed, child); return new Promise(() => {}); } };
  const first = engine.close(options), second = engine.close(options);
  assert.equal(first, second);
  const result = await first;
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'cleanup-timeout');
  assert.equal(kills, 1);
  assert.equal(engine.process, null);
  assert.ok(performance.now() - started < 1000);
});
