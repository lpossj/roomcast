const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8');

const preferenceGate = "const preferredCaptureBackend = preferences?.shareSettings?.captureBackend === 'native' ? 'native' : 'obs';";
const prewindowRegister = 'const bootstrapRegistration = await ensureObsVirtualCameraRegistration({';
const browserWindow = 'window = new BrowserWindow({';
const regularRegister = 'const registration = await ensureObsVirtualCameraRegistration({ engine, dataRoot: app.getPath(\'userData\') });';

assert(main.includes(preferenceGate), 'startup bootstrap must respect the saved/default capture backend');
assert(main.includes(prewindowRegister), 'startup bootstrap registration is missing');
assert(main.indexOf(prewindowRegister) < main.indexOf(browserWindow), 'Virtual Camera registration must finish before BrowserWindow creation');
assert.match(main, /process\.platform === 'win32' && app\.isPackaged[^\n]+preferredCaptureBackend === 'obs'/, 'startup bootstrap must be packaged-Windows + OBS-only');
assert.match(main, /registrationStatus\(\)\.roomcastReady === true/, 'startup path must avoid UAC when V4 dual registration is already ready');
assert.match(main, /await bootstrapEngine\.close\(\)\.catch\(\(\) => \{\}\)/, 'bootstrap engine must always close');
assert(main.includes(regularRegister), 'normal V4 registration call must remain intact');
assert.match(main, /registration\?\.installedByRoomcast/, 'late registration fallback marker is missing');
assert.match(main, /OBS_RESTART_REQUIRED_AFTER_INSTALL/, 'late-registration fallback must return a stable error code');
assert.match(main, /请完全退出 Roomcast 后重新打开一次/, 'late-registration fallback must explain the one-time restart');

console.log('[OBS first-run Chromium bootstrap] pre-window ordering: PASS');
console.log('[OBS first-run Chromium bootstrap] saved-native UAC avoidance: PASS');
console.log('[OBS first-run Chromium bootstrap] late-registration restart fallback: PASS');
console.log('[OBS first-run Chromium bootstrap] PASS');
