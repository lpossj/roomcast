const assert = require('node:assert/strict');
const { waitForObsVirtualCameraState } = require('../electron/obs-fixed-fps.cjs');

async function main() {
  let calls = 0;
  const fakeClient = {
    async request(type) {
      assert.equal(type, 'GetVirtualCamStatus');
      calls += 1;
      return { outputActive: calls >= 4 };
    },
  };
  const noDelay = async () => {};
  const started = await waitForObsVirtualCameraState(fakeClient, true, {
    timeoutMs: 1000,
    pollMs: 0,
    delayFn: noDelay,
  });
  assert.equal(started.outputActive, true);
  assert.equal(calls, 4);

  let stopCalls = 0;
  const fakeStopClient = {
    async request(type) {
      assert.equal(type, 'GetVirtualCamStatus');
      stopCalls += 1;
      return { outputActive: stopCalls < 3 };
    },
  };
  const stopped = await waitForObsVirtualCameraState(fakeStopClient, false, {
    timeoutMs: 1000,
    pollMs: 0,
    delayFn: noDelay,
  });
  assert.equal(stopped.outputActive, false);
  assert.equal(stopCalls, 3);

  let transientCalls = 0;
  const transientClient = {
    async request(type) {
      assert.equal(type, 'GetVirtualCamStatus');
      transientCalls += 1;
      if (transientCalls === 1) throw new Error('transient');
      return { outputActive: transientCalls >= 3 };
    },
  };
  const recovered = await waitForObsVirtualCameraState(transientClient, true, {
    timeoutMs: 1000,
    pollMs: 0,
    delayFn: noDelay,
  });
  assert.equal(recovered.outputActive, true);
  assert.equal(transientCalls, 3);
  console.log('[OBS virtualcam wait self-test] PASS');
}

main().catch(error => {
  console.error('[OBS virtualcam wait self-test] FAIL:', error);
  process.exitCode = 1;
});
