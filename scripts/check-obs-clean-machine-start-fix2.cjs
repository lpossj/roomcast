const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const registrationPath = path.join(root, 'electron', 'obs-virtualcam-registration.cjs');
const mainPath = path.join(root, 'electron', 'main.cjs');
const {
  prepareEngineForFreshVirtualCameraRegistration,
  sanitizeVirtualCameraInstaller,
} = require(registrationPath);

(async () => {
  // Reproduce the clean-PC state that caused the bug: OBS is already running
  // because the user selected the OBS backend and enumerated sources before
  // Virtual Camera registration exists.
  const calls = [];
  const fakeEngine = {
    process: { pid: 1234 },
    client: { ready: true },
    async prepare() { calls.push('prepare'); },
    virtualCameraModules() {
      calls.push('modules');
      return { module32: 'module32.dll', module64: 'module64.dll' };
    },
    async close() {
      calls.push('close');
      this.process = null;
      this.client.ready = false;
    },
  };

  const prepared = await prepareEngineForFreshVirtualCameraRegistration(fakeEngine);
  assert.deepEqual(calls, ['prepare', 'modules', 'close'], 'pre-registration OBS must be closed after resolving bundled modules');
  assert.equal(prepared.stoppedPreRegistrationObs, true);
  assert.equal(fakeEngine.process, null);
  assert.equal(fakeEngine.client.ready, false);

  // If OBS was not running, the helper must not invent an unnecessary close.
  const idleCalls = [];
  const idleEngine = {
    process: null,
    client: { ready: false },
    async prepare() { idleCalls.push('prepare'); },
    virtualCameraModules() { idleCalls.push('modules'); return { module32: '32', module64: '64' }; },
    async close() { idleCalls.push('close'); },
  };
  const idlePrepared = await prepareEngineForFreshVirtualCameraRegistration(idleEngine);
  assert.deepEqual(idleCalls, ['prepare', 'modules']);
  assert.equal(idlePrepared.stoppedPreRegistrationObs, false);

  const sanitized = sanitizeVirtualCameraInstaller('echo before\r\npause\r\nregsvr32.exe /s a.dll\r\nPAUSE\r\necho after\r\n');
  assert(!/^\s*pause\s*$/im.test(sanitized), 'sanitized installer must not block on pause');
  assert(/regsvr32/i.test(sanitized));

  const regSource = fs.readFileSync(registrationPath, 'utf8');
  const ensureStart = regSource.indexOf('async function ensureObsVirtualCameraRegistration');
  const ensureEnd = regSource.indexOf('\nmodule.exports', ensureStart);
  const ensureBlock = regSource.slice(ensureStart, ensureEnd);
  assert(ensureBlock.indexOf('prepareEngineForFreshVirtualCameraRegistration') < ensureBlock.indexOf('registerRoomcastVirtualCamera'), 'OBS must be stopped before first registration');
  assert(/await delay\(800\)/.test(regSource), 'clean-machine registration must keep the Step3C 800ms settle window');

  const mainSource = fs.readFileSync(mainPath, 'utf8');
  const startMark = "ipcMain.handle('roomcast:obs-capture-start'";
  const statusMark = "ipcMain.handle('roomcast:obs-capture-stop'";
  const start = mainSource.indexOf(startMark);
  const end = mainSource.indexOf(statusMark, start);
  assert(start >= 0 && end > start, 'OBS start handler not found');
  const startBlock = mainSource.slice(start, end);
  const ensureIndex = startBlock.indexOf('ensureObsVirtualCameraRegistration');
  const launchIndex = startBlock.indexOf('await engine.launch(settings)');
  const capabilityIndex = startBlock.indexOf('await waitForObsVirtualCameraAvailable(engine');
  assert(ensureIndex >= 0 && launchIndex > ensureIndex && capabilityIndex > launchIndex, 'share start must execute register -> launch/relaunch -> capability wait');

  // Source enumeration must remain registration-free.
  const sourcesStart = mainSource.indexOf("ipcMain.handle('roomcast:obs-capture-sources'");
  const sourcesEnd = mainSource.indexOf(startMark, sourcesStart);
  const sourcesBlock = mainSource.slice(sourcesStart, sourcesEnd);
  assert(!/ensureObsVirtualCameraRegistration/.test(sourcesBlock), 'selecting OBS must not trigger UAC/registration');

  console.log('[Clean-PC OBS start fix2] PASS');
})().catch(error => {
  console.error('[Clean-PC OBS start fix2] FAIL');
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
