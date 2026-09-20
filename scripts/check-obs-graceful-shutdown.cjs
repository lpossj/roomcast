const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const {
  ObsFixedFpsEngine,
  gracefulTerminateObsProcess,
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
  exit(code = 0, signal = null) {
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
    const child = new FakeChild(1001);
    let gracefulRequests = 0;
    const result = await gracefulTerminateObsProcess(child, {
      gracefulTimeoutMs: 50,
      forceTimeoutMs: 50,
      requestClose: async pid => {
        assert.equal(pid, 1001);
        gracefulRequests += 1;
        child.exit(0, null);
        return { requested: true, code: 0 };
      },
    });
    assert.equal(gracefulRequests, 1);
    assert.equal(result.exited, true);
    assert.equal(result.forced, false);
    assert.equal(child.forceKills, 0);
    console.log('[OBS graceful shutdown] graceful process close before force: PASS');
  }

  {
    const child = new FakeChild(1002);
    const result = await gracefulTerminateObsProcess(child, {
      gracefulTimeoutMs: 15,
      forceTimeoutMs: 50,
      requestClose: async () => ({ requested: true, code: 0 }),
    });
    assert.equal(result.exited, true);
    assert.equal(result.forced, true);
    assert.equal(child.forceKills, 1);
    console.log('[OBS graceful shutdown] force is last-resort fallback: PASS');
  }

  {
    const engine = new ObsFixedFpsEngine({ rootDir: path.resolve(__dirname, '..', '.obs-graceful-selftest') });
    const liveInputs = new Set([
      'Roomcast Probe monitors stale-a',
      'Roomcast Probe windows stale-b',
      'Unrelated Input',
    ]);
    const attempts = new Map();
    engine.probes.add('Roomcast Probe monitors stale-a');
    engine.client = {
      ready: true,
      async request(type, data = {}) {
        if (type === 'GetInputList') {
          return { inputs: [...liveInputs].map(inputName => ({ inputName })) };
        }
        if (type === 'RemoveInput') {
          const name = String(data.inputName || '');
          attempts.set(name, (attempts.get(name) || 0) + 1);
          if (name === 'Roomcast Probe monitors stale-a' && attempts.get(name) === 1) {
            throw new Error('simulated transient remove failure');
          }
          liveInputs.delete(name);
          return {};
        }
        throw new Error(`unexpected request ${type}`);
      },
    };
    const cleanup = await engine.cleanupProbeInputs({ timeoutMs: 100, pollMs: 0, settleMs: 0, delayFn: async () => {} });
    assert.deepEqual(cleanup.remaining, []);
    assert.equal(liveInputs.has('Roomcast Probe monitors stale-a'), false);
    assert.equal(liveInputs.has('Roomcast Probe windows stale-b'), false);
    assert.equal(liveInputs.has('Unrelated Input'), true);
    assert.equal(attempts.get('Roomcast Probe monitors stale-a'), 2);
    console.log('[OBS graceful shutdown] probe cleanup retries and preserves unrelated inputs: PASS');
  }

  {
    const engine = new ObsFixedFpsEngine({ rootDir: path.resolve(__dirname, '..', '.obs-probe-enumeration-selftest') });
    let cleanupCalls = 0;
    engine.client = {
      ready: true,
      async request(type, data = {}) {
        if (type === 'CreateInput') return {};
        if (type === 'GetInputPropertiesListPropertyItems') {
          const isMonitor = String(data.propertyName || '') === 'monitor_id';
          return {
            propertyItems: [{
              itemEnabled: true,
              itemName: isMonitor ? 'Display 1' : 'Window 1',
              itemValue: isMonitor ? 'display-1' : 'window-1',
            }],
          };
        }
        if (type === 'RemoveInput') {
          // Simulate the OBS/WGC first-enumeration race: RemoveInput is not
          // acknowledged promptly, so the probe remains tracked for retry.
          throw new Error('simulated delayed WGC teardown');
        }
        throw new Error(`unexpected request ${type}`);
      },
    };
    engine.cleanupProbeInputs = async () => {
      cleanupCalls += 1;
      if (cleanupCalls === 1) return { removed: [], remaining: [] };
      return { removed: [], remaining: [...engine.probes] };
    };

    const sources = await engine.sources();
    assert.deepEqual(sources.monitors, [{ id: 'display-1', name: 'Display 1' }]);
    assert.deepEqual(sources.windows, [{ id: 'window-1', name: 'Window 1' }]);
    assert.equal(cleanupCalls, 2);
    assert.equal(engine.probes.size, 2);
    console.log('[OBS graceful shutdown] delayed final probe cleanup does not discard valid source enumeration: PASS');
  }

  {
    const engine = new ObsFixedFpsEngine({ rootDir: path.resolve(__dirname, '..', '.obs-probe-preclean-selftest') });
    engine.client = { ready: true };
    engine.cleanupProbeInputs = async () => ({
      removed: [],
      remaining: ['Roomcast Probe windows stuck-before-enumeration'],
    });
    await assert.rejects(
      () => engine.sources(),
      /OBS 临时枚举源无法清理/,
    );
    console.log('[OBS graceful shutdown] stale probe still blocks the next enumeration until safely cleaned: PASS');
  }

  {
    const engine = new ObsFixedFpsEngine({ rootDir: path.resolve(__dirname, '..', '.obs-graceful-close-selftest') });
    const child = new FakeChild(1003);
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
      delayFn: async () => {},
      terminateProcess: async managedChild => {
        order.push(`ManagedTerminate:${managedChild.pid}`);
        managedChild.exit(1, null);
        return { exited: true, forced: true, managed: true, processTreeRequested: true };
      },
    });
    const probeRemovalIndex = order.indexOf('RemoveInput:Roomcast Probe monitors close-a');
    const wsCloseIndex = order.indexOf('WebSocketClose');
    const processCloseIndex = order.indexOf('ManagedTerminate:1003');
    assert.ok(probeRemovalIndex >= 0, order.join(' -> '));
    assert.ok(wsCloseIndex > probeRemovalIndex, order.join(' -> '));
    assert.ok(processCloseIndex > wsCloseIndex, order.join(' -> '));
    assert.equal(result.process.managed, true);
    assert.equal(result.process.forced, true);
    assert.equal(engine.process, null);
    console.log('[OBS graceful shutdown] cleanup order preserved before managed termination: PASS');
  }

  console.log('[OBS graceful shutdown] PASS');
})().catch(error => {
  console.error('[OBS graceful shutdown] FAIL');
  console.error(error?.stack || error);
  process.exitCode = 1;
});
