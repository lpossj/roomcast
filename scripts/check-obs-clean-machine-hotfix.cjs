const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  sanitizeVirtualCameraInstaller,
  elevatedInstallerLauncherCommand,
  registrationStatus,
} = require('../electron/obs-virtualcam-registration.cjs');

function assert(value, message) {
  if (!value) throw new Error(message);
}

const sampleInstaller = [
  '@echo off',
  'echo Installing 32-bit Virtual Cam...',
  'regsvr32.exe /i /s obs-virtualcam-module32.dll',
  'echo Installing 64-bit Virtual Cam...',
  'regsvr32.exe /i /s obs-virtualcam-module64.dll',
  'pause',
  'exit',
  '',
].join('\r\n');

const sanitized = sanitizeVirtualCameraInstaller(sampleInstaller);
assert(!/^\s*pause\s*$/im.test(sanitized), 'sanitizer must remove pause');
assert(/obs-virtualcam-module32\.dll/i.test(sanitized), 'sanitizer removed 32-bit module registration');
assert(/obs-virtualcam-module64\.dll/i.test(sanitized), 'sanitizer removed 64-bit module registration');
assert(/regsvr32/i.test(sanitized), 'sanitizer removed regsvr32 commands');

const launcher = elevatedInstallerLauncherCommand(`C:\\Roomcast Test 中文\\O'Brien\\virtualcam-install.cmd`);
assert(/Start-Process/i.test(launcher), 'installer launcher must use Start-Process');
assert(/-Verb RunAs/i.test(launcher), 'installer launcher must request UAC');
assert(/cmd\.exe/i.test(launcher), 'installer launcher must run OBS installer via cmd.exe');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8');
const sourcesStart = mainSource.indexOf("ipcMain.handle('roomcast:obs-capture-sources'");
const captureStart = mainSource.indexOf("ipcMain.handle('roomcast:obs-capture-start'", sourcesStart);
const captureStop = mainSource.indexOf("ipcMain.handle('roomcast:obs-capture-stop'", captureStart);
assert(sourcesStart >= 0 && captureStart > sourcesStart && captureStop > captureStart, 'OBS IPC handler layout not found');
const sourceHandler = mainSource.slice(sourcesStart, captureStart);
const startHandler = mainSource.slice(captureStart, captureStop);
assert(!/ensureObsVirtualCameraRegistration/.test(sourceHandler), 'OBS source enumeration must not install/register Virtual Camera');
assert(!/virtualCameraCapability/.test(sourceHandler), 'OBS source enumeration must not require Virtual Camera capability');
assert(/await engine\.prepare\(\)/.test(sourceHandler), 'OBS source enumeration must prepare bundled OBS');
assert(/await engine\.launch\(settings\)/.test(sourceHandler), 'OBS source enumeration must launch bundled OBS');
assert(/ensureObsVirtualCameraRegistration/.test(startHandler), 'OBS share start must ensure Virtual Camera registration');
assert(/waitForObsVirtualCameraAvailable/.test(startHandler), 'OBS share start must wait for Virtual Camera capability');

const bundledInstaller = path.join(__dirname, '..', 'runtime', 'obs-bundle', 'data', 'obs-plugins', 'win-dshow', 'virtualcam-install.bat');
if (fs.existsSync(bundledInstaller)) {
  const actual = sanitizeVirtualCameraInstaller(fs.readFileSync(bundledInstaller, 'utf8'));
  assert(/obs-virtualcam-module32\.dll/i.test(actual), 'bundled installer missing 32-bit module');
  assert(/obs-virtualcam-module64\.dll/i.test(actual), 'bundled installer missing 64-bit module');
}

if (process.platform === 'win32') {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roomcast-clean-obs-hotfix-'));
  try {
    const ps1 = path.join(tempDir, 'launcher.ps1');
    fs.writeFileSync(ps1, `\uFEFF${launcher}`, 'utf8');
    const parseCommand = [
      '$tokens = $null; $errors = $null',
      `[System.Management.Automation.Language.Parser]::ParseFile('${ps1.replace(/'/g, "''")}', [ref]$tokens, [ref]$errors) | Out-Null`,
      'if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_.Message }; exit 2 }',
      'exit 0',
    ].join('; ');
    const parsed = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', parseCommand], {
      windowsHide: true,
      encoding: 'utf8',
    });
    assert(parsed.status === 0, `PowerShell launcher parser failed: ${parsed.stderr || parsed.stdout || parsed.status}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

const status = registrationStatus();
console.log(`[Clean OBS hotfix] current=${status.state} reg32=${status.reg32} reg64=${status.reg64}`);
console.log('[Clean OBS hotfix] PASS');
