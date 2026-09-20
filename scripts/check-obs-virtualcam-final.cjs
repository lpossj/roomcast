const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  classifyVirtualCameraRegistration,
  roomcastRegistrationDecision,
  registrationAssessment,
  stableInstallPaths,
  buildElevatedRegistrationScript,
  elevatedLauncherCommand,
  registrationStatus,
} = require('../electron/obs-virtualcam-registration.cjs');

assert.equal(classifyVirtualCameraRegistration({ reg32: false, reg64: false }), 'absent');
assert.equal(classifyVirtualCameraRegistration({ reg32: true, reg64: false }), 'partial');
assert.equal(classifyVirtualCameraRegistration({ reg32: false, reg64: true }), 'partial');
assert.equal(classifyVirtualCameraRegistration({ reg32: true, reg64: true }), 'existing');

// OBS 32.1.2 win-dshow checks Registry32 before it registers the Virtual
// Camera output, while Roomcast's Chromium consumer is x64. Both views are
// therefore functional requirements.
assert.equal(roomcastRegistrationDecision({ reg32: false, reg64: true }).ready, false, 'x64-only registration must not be Roomcast-ready');
assert.equal(roomcastRegistrationDecision({ reg32: true, reg64: false }).ready, false, 'x86-only registration must not be Roomcast-ready');
assert.equal(roomcastRegistrationDecision({ reg32: true, reg64: true }).ready, true);

const fakeDataRoot = 'C:\\Users\\Test\\AppData\\Roaming\\Roomcast';
const fake32 = `${fakeDataRoot}\\runtime\\obs-fixed-fps\\data\\obs-plugins\\win-dshow\\obs-virtualcam-module32.dll`;
const fake64 = `${fakeDataRoot}\\runtime\\obs-fixed-fps\\data\\obs-plugins\\win-dshow\\obs-virtualcam-module64.dll`;

let assessment = registrationAssessment({
  state: 'partial',
  reg32: true,
  reg64: false,
  reg32Path: 'C:\\Program Files\\obs-studio\\data\\obs-plugins\\win-dshow\\obs-virtualcam-module32.dll',
  reg64Path: '',
  reg32PathExists: true,
  reg64PathExists: false,
}, { dataRoot: fakeDataRoot, module32: fake32, module64: fake64 });
assert.equal(assessment.ready, false);
assert.equal(assessment.action, 'install-missing-views');
assert.equal(assessment.register32, false, 'valid external x86 registration must be preserved');
assert.equal(assessment.register64, true, 'missing x64 registration must be repaired');

assessment = registrationAssessment({
  state: 'partial',
  reg32: false,
  reg64: true,
  reg32Path: '',
  reg64Path: 'C:\\Program Files\\obs-studio\\data\\obs-plugins\\win-dshow\\obs-virtualcam-module64.dll',
  reg32PathExists: false,
  reg64PathExists: true,
}, { dataRoot: fakeDataRoot, module32: fake32, module64: fake64 });
assert.equal(assessment.ready, false);
assert.equal(assessment.register32, true, 'missing x86 registration must be repaired because OBS win-dshow requires it');
assert.equal(assessment.register64, false, 'valid external x64 registration must be preserved');

assessment = registrationAssessment({
  state: 'existing',
  reg32: true,
  reg64: true,
  reg32Path: fake32,
  reg64Path: fake64,
  reg32PathExists: true,
  reg64PathExists: true,
}, { dataRoot: fakeDataRoot, module32: fake32, module64: fake64 });
assert.equal(assessment.ready, true);
assert.equal(assessment.register32, false);
assert.equal(assessment.register64, false);

const stable = stableInstallPaths();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'roomcast-vcam-final-'));
try {
  const regScript = path.join(temp, 'register.ps1');
  const resultPath = path.join(temp, 'result.json');
  const launcherScript = path.join(temp, 'launcher.ps1');
  const script = buildElevatedRegistrationScript({
    module32: path.join(temp, "O'Brien 32.dll"),
    module64: path.join(temp, 'Module 64.dll'),
    target32: stable.module32,
    target64: stable.module64,
    resultPath,
    register32: true,
    register64: true,
  });
  fs.writeFileSync(regScript, `\uFEFF${script}`, 'utf8');
  fs.writeFileSync(launcherScript, `\uFEFF${elevatedLauncherCommand(regScript)}`, 'utf8');

  assert.match(script, /SysWOW64\\regsvr32\.exe/i, 'x86 DLL must use SysWOW64 regsvr32');
  assert.match(script, /System32\\regsvr32\.exe/i, 'x64 DLL must use System32 regsvr32');
  assert.match(script, /System\.Diagnostics\.ProcessStartInfo/i, 'regsvr32 must use an explicit Process object');
  assert.match(script, /WaitForExit\(\$TimeoutMs\)/i, 'regsvr32 must use a bounded wait');
  assert.match(script, /Process\.ExitCode/i, 'real regsvr32 exit code must be recorded');
  assert.match(script, /Registry32/i, 'x86 registry verification missing');
  assert.match(script, /Registry64/i, 'x64 registry verification missing');
  assert.match(script, /30000/i, 'regsvr32 must have a bounded 30-second timeout');
  assert(
    script.indexOf("$Result.phase = 'register32'") < script.indexOf("$Result.phase = 'register64'"),
    'x86 registration must complete before x64 registration / OBS relaunch',
  );

  if (process.platform === 'win32') {
    const psQuote = value => `'${String(value).replace(/'/g, "''")}'`;
    const parseCommand = [
      "$ErrorActionPreference = 'Stop'",
      `$Files = @(${psQuote(regScript)}, ${psQuote(launcherScript)})`,
      'foreach ($File in $Files) {',
      '  $Tokens = $null; $Errors = $null',
      '  [System.Management.Automation.Language.Parser]::ParseFile($File, [ref]$Tokens, [ref]$Errors) | Out-Null',
      '  if ($Errors.Count -gt 0) { $Errors | ForEach-Object { Write-Error $_.Message }; exit 2 }',
      '}',
      'exit 0',
    ].join('; ');
    const parsed = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', parseCommand], {
      windowsHide: true,
      encoding: 'utf8',
    });
    assert.equal(parsed.status, 0, `Windows PowerShell parser failed: ${parsed.stderr || parsed.stdout || parsed.status}`);
  }
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

const source = fs.readFileSync(require.resolve('../electron/obs-virtualcam-registration.cjs'), 'utf8');
assert.match(source, /registration-result-\$\{stamp\}\.json/, 'each elevated registration attempt must use a unique result file');
assert.doesNotMatch(source, /const resultPath = path\.join\(tempDir, 'last-registration-result\.json'\)/, 'stale fixed result path must not be used as the live result');
assert.match(source, /architecture: 'dual-registry-required-by-obs-win-dshow'/, 'registration marker must document the dual-view requirement');
assert.match(source, /OBS 32\.1\.2's win-dshow plugin gates registration/, 'source must preserve the reason x86 is functional, not optional');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8');
const registrationCatch = mainSource.slice(
  mainSource.indexOf("ipcMain.handle('roomcast:obs-capture-start'"),
  mainSource.indexOf("ipcMain.handle('roomcast:obs-capture-stop'"),
);
assert.match(registrationCatch, /startPhase !== 'registration'/, 'registration errors must suppress unrelated OBS runtime diagnostics');
assert.match(registrationCatch, /startPhase === 'virtual-camera-ready'/, 'virtual-camera-ready failures need dedicated diagnostics');
assert.match(registrationCatch, /x86=.*missing\/stale/, 'virtual-camera-ready diagnostics must expose x86 registration state');
assert.match(registrationCatch, /x64=.*missing\/stale/, 'virtual-camera-ready diagnostics must expose x64 registration state');

const engineSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'obs-fixed-fps.cjs'), 'utf8');
assert.match(engineSource, /OBS_VIRTUALCAM_OUTPUT_UNAVAILABLE/, '604 readiness failures must have a dedicated error code');
assert.doesNotMatch(
  engineSource.slice(engineSource.indexOf('async virtualCameraDiagnostics()'), engineSource.indexOf('async stopVirtualCamera()')),
  /\|failed\|error/i,
  'Virtual Camera diagnostics must not append every unrelated OBS failure/warning',
);

if (process.platform === 'win32') {
  const current = registrationStatus();
  console.log(`[OBS VirtualCam final] current=${current.state} reg32=${current.reg32} reg64=${current.reg64} ready=${current.roomcastReady}`);
  if (current.reg32Path) console.log(`[OBS VirtualCam final] reg32Path=${current.reg32Path}`);
  if (current.reg64Path) console.log(`[OBS VirtualCam final] reg64Path=${current.reg64Path}`);
}

console.log('[OBS VirtualCam final] OBS 32.1.2 dual-registry functional gate: PASS');
console.log('[OBS VirtualCam final] valid external registration preservation: PASS');
console.log('[OBS VirtualCam final] bounded Process.WaitForExit + real ExitCode diagnostics: PASS');
console.log('[OBS VirtualCam final] unique per-attempt elevated result file: PASS');
console.log('[OBS VirtualCam final] readiness diagnostic de-noising: PASS');
console.log('[OBS VirtualCam final] PASS');
