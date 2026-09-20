const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const { bindObsProcessLifecycle } = require(path.join(root, 'electron', 'obs-fixed-fps.cjs'));

function fakeEngine({ closing = false } = {}) {
  const child = new EventEmitter();
  let closed = 0;
  const exits = [];
  const engine = {
    process: child,
    capture: { type: 'monitor', id: 'display-1' },
    closing,
    client: { close: async () => { closed += 1; } },
    onUnexpectedExit: details => exits.push(details),
  };
  bindObsProcessLifecycle(engine, child);
  return { child, engine, exits, closed: () => closed };
}

{
  const value = fakeEngine();
  value.child.emit('exit', 17, 'SIGTERM');
  assert.equal(value.engine.process, null);
  assert.equal(value.engine.capture, null);
  assert.equal(value.closed(), 1);
  assert.deepEqual(value.exits, [{ code: 17, signal: 'SIGTERM' }]);
}

{
  const value = fakeEngine({ closing: true });
  value.child.emit('exit', 0, null);
  assert.equal(value.closed(), 1);
  assert.deepEqual(value.exits, []);
}

const main = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'electron', 'preload.cjs'), 'utf8');
const lib = fs.readFileSync(path.join(root, 'src', 'lib.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src', 'App.jsx'), 'utf8');

assert.match(main, /roomcast:obs-capture-ended/);
assert.match(main, /fallbackNative:\s*false/);
assert.match(preload, /onObsCaptureEnded/);
assert.match(lib, /fallbackBackend\s*=\s*'native'/);
assert.match(lib, /roomcastBackendEndedReason/);
assert.doesNotMatch(app, /OBS 启动失败，已切换到原生采集/);
assert.match(app, /roomcastBackendEndedReason/);

console.log('[Step5B OBS lifecycle self-test] PASS');
