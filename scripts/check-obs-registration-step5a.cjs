const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  classifyVirtualCameraRegistration,
  roomcastRegistrationDecision,
  registrationStatus,
  buildElevatedRegistrationScript,
  elevatedLauncherCommand,
} = require('../electron/obs-virtualcam-registration.cjs');

function assert(value, message) {
  if (!value) throw new Error(message);
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

const cases = [
  [{ reg32: false, reg64: false }, 'absent'],
  [{ reg32: true, reg64: true }, 'existing'],
  [{ reg32: true, reg64: false }, 'partial'],
  [{ reg32: false, reg64: true }, 'partial'],
];
for (const [input, expected] of cases) {
  assert(classifyVirtualCameraRegistration(input) === expected, `registration classifier failed: ${JSON.stringify(input)}`);
}

assert(roomcastRegistrationDecision({ reg32: true, reg64: true }).ready === true, 'dual registration must be Roomcast-ready');
assert(roomcastRegistrationDecision({ reg32: true, reg64: false }).ready === false, 'x86-only registration must not be Roomcast-ready');
assert(roomcastRegistrationDecision({ reg32: false, reg64: true }).ready === false, 'x64-only registration must not be Roomcast-ready because OBS win-dshow gates Virtual Camera output on Registry32');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'roomcast-obs-reg-'));
try {
  const regScript = path.join(temp, 'register.ps1');
  const launcherScript = path.join(temp, 'launcher.ps1');
  fs.writeFileSync(regScript, `\uFEFF${buildElevatedRegistrationScript({
    module32: path.join(temp, "O'Brien 32.dll"),
    module64: path.join(temp, 'Module 64.dll'),
    target32: path.join(temp, 'Target 32.dll'),
    target64: path.join(temp, 'Target 64.dll'),
    resultPath: path.join(temp, 'result.json'),
    register32: true,
    register64: true,
  })}`, 'utf8');
  fs.writeFileSync(launcherScript, `\uFEFF${elevatedLauncherCommand(regScript)}`, 'utf8');

  if (process.platform === 'win32') {
    const command = [
      '$ErrorActionPreference = \'Stop\'',
      `$files = @(${psQuote(regScript)}, ${psQuote(launcherScript)})`,
      'foreach ($file in $files) {',
      '  $tokens = $null; $errors = $null',
      '  [System.Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors) | Out-Null',
      '  if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_.Message }; exit 2 }',
      '}',
      'exit 0',
    ].join('; ');
    const parsed = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
      windowsHide: true,
      encoding: 'utf8',
    });
    if (parsed.status !== 0) throw new Error(`Windows PowerShell parser failed: ${parsed.stderr || parsed.stdout || parsed.status}`);
  }
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

const current = registrationStatus();
console.log(`[Step5A registration self-test] current=${current.state} reg32=${current.reg32} reg64=${current.reg64}`);
console.log('[Step5A registration self-test] PASS');
