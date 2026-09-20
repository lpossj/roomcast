const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const mainPath = path.join(root, 'electron', 'main.cjs');
const preloadPath = path.join(root, 'electron', 'preload.cjs');
const libPath = path.join(root, 'src', 'lib.js');

function mustContain(text, needle, label) {
  assert.ok(text.includes(needle), `${label}: missing ${needle}`);
}

async function main() {
  const mainText = fs.readFileSync(mainPath, 'utf8');
  const preloadText = fs.readFileSync(preloadPath, 'utf8');
  const libText = fs.readFileSync(libPath, 'utf8');

  // Integration guards: these checks make sure the tested helper block is actually
  // wired into the Electron IPC and renderer capture lifecycle.
  mustContain(mainText, "return runObsCaptureOperation(async () => {", 'OBS IPC serialization');
  mustContain(mainText, "const requestedCaptureId = normalizeObsCaptureId(payload?.captureId) || randomUUID();", 'start capture id');
  mustContain(mainText, "return { ok: true, captureId: requestedCaptureId, status };", 'start response capture id');
  mustContain(mainText, "closeObsCaptureEngine({ captureId: requestedCaptureId })", 'capture-scoped stop');
  mustContain(mainText, "window.webContents.on('did-start-navigation'", 'renderer reload cleanup');
  mustContain(preloadText, "stopObsCapture: captureId =>", 'preload capture-scoped stop');
  mustContain(libText, "captureId: requestedCaptureId", 'renderer start id');
  mustContain(libText, "stopObsCapture(backendCaptureId)", 'renderer stop id');
  mustContain(libText, "endedCaptureId !== backendCaptureId", 'stale crash event filter');
  mustContain(libText, "stream.roomcastCaptureId = backendCaptureId", 'stream diagnostics id');

  // Evaluate the exact helper block from main.cjs, then drive it with fake engines.
  const start = mainText.indexOf('let obsCaptureEngine = null;');
  const end = mainText.indexOf('const TITLEBAR_HEIGHT', start);
  assert.ok(start >= 0 && end > start, 'unable to locate OBS state helper block');
  const helper = mainText.slice(start, end) + `\n` + `
    globalThis.__step5c = {
      runObsCaptureOperation,
      normalizeObsCaptureId,
      closeObsCaptureEngine,
      handleObsCaptureUnexpectedExit,
      setState(value = {}) {
        if ('engine' in value) obsCaptureEngine = value.engine;
        if ('timer' in value) obsCaptureIdleTimer = value.timer;
        if ('active' in value) obsCaptureActive = value.active;
        if ('permissionUntil' in value) obsVideoPermissionUntil = value.permissionUntil;
        if ('sessionId' in value) obsCaptureSessionId = value.sessionId;
        if ('phase' in value) obsCapturePhase = value.phase;
      },
      state() {
        return {
          engine: obsCaptureEngine,
          active: obsCaptureActive,
          permissionUntil: obsVideoPermissionUntil,
          sessionId: obsCaptureSessionId,
          phase: obsCapturePhase,
        };
      },
    };
  `;

  const sent = [];
  const context = {
    console,
    setTimeout,
    clearTimeout,
    Promise,
    window: {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send: (channel, payload) => sent.push({ channel, payload }),
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(helper, context, { filename: 'main-obs-step5c-extract.cjs' });
  const api = context.__step5c;

  assert.equal(api.normalizeObsCaptureId('abc_DEF-123'), 'abc_DEF-123');
  assert.equal(api.normalizeObsCaptureId('bad id'), '');

  let closeCount = 0;
  const currentEngine = { close: async () => { closeCount += 1; } };
  api.setState({ engine: currentEngine, active: true, sessionId: 'new_session_123', phase: 'active', permissionUntil: Date.now() + 10000 });

  const stale = await api.closeObsCaptureEngine({ captureId: 'old_session_456' });
  assert.equal(stale.stale, true, 'old cleanup must be marked stale');
  assert.equal(closeCount, 0, 'old cleanup must not close the current engine');
  assert.equal(api.state().sessionId, 'new_session_123', 'old cleanup must not clear the current session');
  assert.equal(api.state().active, true, 'old cleanup must not deactivate current capture');

  const stopped = await api.closeObsCaptureEngine({ captureId: 'new_session_123' });
  assert.equal(stopped.stale, false);
  assert.equal(closeCount, 1, 'matching cleanup should close exactly once');
  assert.equal(api.state().engine, null);
  assert.equal(api.state().active, false);
  assert.equal(api.state().sessionId, '');
  assert.equal(api.state().phase, 'idle');

  // A late cleanup from an older stream must not even close a newly prewarmed
  // OBS engine when no active capture session exists yet.
  let prewarmCloseCount = 0;
  const prewarmEngine = { close: async () => { prewarmCloseCount += 1; } };
  api.setState({ engine: prewarmEngine, active: false, sessionId: '', phase: 'idle' });
  const staleAgainstPrewarm = await api.closeObsCaptureEngine({ captureId: 'old_session_789' });
  assert.equal(staleAgainstPrewarm.stale, true);
  assert.equal(prewarmCloseCount, 0, 'stale stream cleanup must not kill a prewarmed next engine');
  assert.equal(api.state().engine, prewarmEngine);

  // Verify the exact queue helper serializes overlapping async operations.
  const order = [];
  const first = api.runObsCaptureOperation(async () => {
    order.push('first:start');
    await new Promise(resolve => setTimeout(resolve, 25));
    order.push('first:end');
  });
  const second = api.runObsCaptureOperation(async () => {
    order.push('second:start');
    order.push('second:end');
  });
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first:start', 'first:end', 'second:start', 'second:end']);

  // Unexpected exit must be tagged with the active capture id, while an exit
  // from an obsolete engine must not touch a newer session.
  sent.length = 0;
  const crashEngine = { close: async () => {} };
  api.setState({ engine: crashEngine, active: true, sessionId: 'crash_session_1', phase: 'active' });
  api.handleObsCaptureUnexpectedExit(crashEngine, { code: 23, signal: 'SIGTERM' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channel, 'roomcast:obs-capture-ended');
  assert.equal(sent[0].payload.captureId, 'crash_session_1');
  assert.equal(api.state().active, false);
  assert.equal(api.state().phase, 'idle');

  const newerEngine = { close: async () => {} };
  api.setState({ engine: newerEngine, active: true, sessionId: 'newer_session_2', phase: 'active' });
  api.handleObsCaptureUnexpectedExit(crashEngine, { code: 99 });
  assert.equal(api.state().engine, newerEngine, 'obsolete engine exit must not clear newer engine');
  assert.equal(api.state().sessionId, 'newer_session_2');
  assert.equal(api.state().active, true);

  console.log('[Step5C OBS concurrency self-test] PASS');
}

main().catch(error => {
  console.error('[Step5C OBS concurrency self-test] FAIL');
  console.error(error?.stack || error);
  process.exitCode = 1;
});
