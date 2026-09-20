const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const {
  ObsFixedFpsEngine,
  terminateManagedObsProcess,
} = require('../electron/obs-fixed-fps.cjs');

class FakeChild extends EventEmitter {
  constructor(pid = 4242) {
    super();
    this.pid = pid;
    this.exitCode = null;
    this.signalCode = null;
    this.forceKills = 0;
  }
  exit(code = 1, signal = null) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
  kill() {
    this.forceKills += 1;
    this.exit(1, 'SIGTERM');
    return true;
  }
}

(async () => {
  {
    const child = new FakeChild(2001);
    let treeRequests = 0;
    const result = await terminateManagedObsProcess(child, {
      timeoutMs: 50,
      fallbackTimeoutMs: 50,
      requestKill: async pid => {
        assert.equal(pid, 2001);
        treeRequests += 1;
        child.exit(1, null);
        return { requested: true, code: 0 };
      },
    });
    assert.equal(treeRequests, 1);
    assert.equal(result.exited, true);
    assert.equal(result.forced, true);
    assert.equal(result.processTreeRequested, true);
    assert.equal(child.forceKills, 0);
    console.log('[OBS managed termination] process-tree termination: PASS');
  }

  {
    const child = new FakeChild(2002);
    const result = await terminateManagedObsProcess(child, {
      timeoutMs: 10,
      fallbackTimeoutMs: 50,
      requestKill: async () => ({ requested: false, code: 5, reason: 'simulated failure' }),
    });
    assert.equal(result.exited, true);
    assert.equal(result.forced, true);
    assert.equal(child.forceKills, 1);
    console.log('[OBS managed termination] Node force fallback: PASS');
  }

  {
    const engine = new ObsFixedFpsEngine({ rootDir: path.resolve(__dirname, '..', '.obs-managed-close-selftest') });
    const child = new FakeChild(2003);
    engine.process = child;
    engine.capture = { type: 'monitor', id: 'x' };
    engine.probes.add('Roomcast Probe monitors close-a');
    const liveInputs = new Set(['Roomcast Probe monitors close-a', 'Roomcast Capture']);
    const order = [];
    engine.client = {
      ready: true,
      async request(type, data = {}) {
        order.push(type === 'RemoveInput' ? `RemoveInput:${data.inputName}` : type);
        if (type === 'GetVirtualCamStatus') return { outputActive: false };
        if (type === 'GetInputList') return { inputs: [...liveInputs].map(inputName => ({ inputName })) };
        if (type === 'RemoveInput') { liveInputs.delete(String(data.inputName || '')); return {}; }
        if (type === 'GetStats') return {};
        throw new Error(`unexpected request ${type}`);
      },
      async close() {
        order.push('WebSocketClose');
        this.ready = false;
      },
    };
    const result = await engine.close({
      terminateTimeoutMs: 50,
      fallbackTimeoutMs: 50,
      delayFn: async () => {},
      terminateProcess: async managedChild => {
        order.push(`ManagedTerminate:${managedChild.pid}`);
        managedChild.exit(1, null);
        return { exited: true, forced: true, managed: true, processTreeRequested: true, code: 1, signal: null };
      },
    });
    const captureRemovalIndex = order.indexOf('RemoveInput:Roomcast Capture');
    const probeRemovalIndex = order.indexOf('RemoveInput:Roomcast Probe monitors close-a');
    const statsIndex = order.lastIndexOf('GetStats');
    const wsCloseIndex = order.indexOf('WebSocketClose');
    const terminateIndex = order.indexOf('ManagedTerminate:2003');
    assert.ok(captureRemovalIndex >= 0, order.join(' -> '));
    assert.ok(probeRemovalIndex > captureRemovalIndex, order.join(' -> '));
    assert.ok(statsIndex > probeRemovalIndex, order.join(' -> '));
    assert.ok(wsCloseIndex > statsIndex, order.join(' -> '));
    assert.ok(terminateIndex > wsCloseIndex, order.join(' -> '));
    assert.equal(result.process.managed, true);
    assert.equal(result.process.forced, true);
    assert.equal(engine.process, null);
    console.log('[OBS managed termination] close order = outputs/sources -> settle -> websocket -> terminate: PASS');
  }

  const source = require('node:fs').readFileSync(path.join(__dirname, '..', 'electron', 'obs-fixed-fps.cjs'), 'utf8');
  assert.match(source, /taskkill\.exe[^\n]*\['\/PID', String\(pid\), '\/T', '\/F'\]/);
  assert.match(source, /Freeing OBS context data/);
  console.log('[OBS managed termination] Windows /T /F path + crash rationale present: PASS');

  console.log('[OBS managed termination] PASS');
})().catch(error => {
  console.error('[OBS managed termination] FAIL');
  console.error(error?.stack || error);
  process.exitCode = 1;
});
