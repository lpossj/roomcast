import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { VIRTUALCAM_HASHES, virtualCameraTrustScript } = require('../electron/obs-virtualcam-trust.cjs');
const { buildElevatedRegistrationScript, elevatedRegistrationCommand } = require('../electron/obs-virtualcam-registration.cjs');
const { ObsFixedFpsEngine } = require('../electron/obs-fixed-fps.cjs');

test('packaged OBS ignores both environment overrides', () => {
  const previous = [process.env.ROOMCAST_OBS_RUNTIME, process.env.ROOMCAST_OBS_BUNDLE];
  try {
    process.env.ROOMCAST_OBS_RUNTIME = 'C:/untrusted/runtime';
    process.env.ROOMCAST_OBS_BUNDLE = 'C:/untrusted/bundle';
    const engine = new ObsFixedFpsEngine({ rootDir: process.cwd(), allowBundleOverride: false });
    assert.ok(!engine.obsDir.includes('untrusted'));
    assert.ok(engine.bundleCandidates.every(p => !p.includes('untrusted')));
  } finally {
    for (const [i, name] of ['ROOMCAST_OBS_RUNTIME', 'ROOMCAST_OBS_BUNDLE'].entries()) {
      if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i];
    }
  }
});

test('locally prepared official bundle matches pinned hashes', { skip: !existsSync('runtime/obs-bundle') }, () => {
  for (const bit of [32, 64]) {
    const dll = readFileSync(`runtime/obs-bundle/data/obs-plugins/win-dshow/obs-virtualcam-module${bit}.dll`);
    assert.equal(createHash('sha256').update(dll).digest('hex'), VIRTUALCAM_HASHES[bit]);
  }
});

test('Windows trust helpers reject tampering, reparse paths and lock verified targets before loading', { skip: process.platform !== 'win32' }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'roomcast-obs-trust-'));
  const source = path.join(dir, 'source.dll');
  writeFileSync(source, 'benign test fixture, never executed');
  writeFileSync(path.join(dir, '.roomcast-fixed-fps.json'), '{"embeddedVersion":"32.1.2"}');
  const expected = createHash('sha256').update(readFileSync(source)).digest('hex');
  const quote = s => `'${s.replace(/'/g, "''")}'`;
  const script = `$ErrorActionPreference = 'Stop'
${virtualCameraTrustScript()}
$Source = ${quote(source)}
$Target = ${quote(path.join(dir, 'target.dll'))}
$Expected = '${expected}'
$Locked = Copy-VerifiedDll $Source $Target $Expected
try {
  try { [IO.File]::WriteAllText($Target, 'replace'); throw 'write unexpectedly succeeded' } catch [IO.IOException] { }
  try { [IO.File]::Delete($Target); throw 'delete unexpectedly succeeded' } catch [IO.IOException] { }
} finally { $Locked.Dispose() }
[IO.File]::WriteAllText($Source, 'tampered with marker unchanged')
try { $X = Open-VerifiedDll $Source $Expected; $X.Dispose(); throw 'tamper unexpectedly accepted' } catch { if ($_.Exception.Message -notmatch 'SHA-256 mismatch') { throw } }
try { $X = Open-VerifiedDll $Target ('0' * 64); $X.Dispose(); throw 'wrong hash accepted' } catch { if ($_.Exception.Message -notmatch 'SHA-256 mismatch') { throw } }
[IO.File]::WriteAllText($Target, 'target substituted')
try { $X = Open-VerifiedDll $Target $Expected; $X.Dispose(); throw 'replaced target accepted' } catch { if ($_.Exception.Message -notmatch 'SHA-256 mismatch') { throw } }
New-Item -ItemType Junction -Path ${quote(path.join(dir, 'junction'))} -Target ${quote(dir)} | Out-Null
try { $X = Open-VerifiedDll ${quote(path.join(dir, 'junction/source.dll'))} $Expected; $X.Dispose(); throw 'junction accepted' } catch { if ($_.Exception.Message -notmatch 'Reparse point') { throw } }
Write-Output 'PASS'
`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /PASS/);
});

test('admin script embeds fixed hashes, protects target and fits Windows argument limit without mutable script', () => {
  const script = buildElevatedRegistrationScript({ module32: "C:/user/O'Brien/32.dll", module64: 'C:/user/64.dll', target32: 'C:/Program Files/Roomcast/obs-virtualcam/32.1.2/obs-virtualcam-module32.dll', target64: 'C:/Program Files/Roomcast/obs-virtualcam/32.1.2/obs-virtualcam-module64.dll', resultPath: 'C:/Program Files/Roomcast/obs-virtualcam/32.1.2/result.json' });
  const command = elevatedRegistrationCommand(script);
  assert.ok(command.length < 30000);
  assert.doesNotMatch(command, /-File /);
  assert.ok(script.indexOf('$Locked64 = Copy-VerifiedDll') < script.indexOf('$Result.exit64 = Invoke-Regsvr32'));
  for (const hash of Object.values(VIRTUALCAM_HASHES)) assert.ok(script.includes(hash));
  assert.match(script, /GetFolderPath\('ProgramFiles'\)/);
  if (process.platform === 'win32') {
    const parse = `$Tokens=$null; $Errors=$null; [System.Management.Automation.Language.Parser]::ParseInput([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${Buffer.from(script, 'utf16le').toString('base64')}')), [ref]$Tokens, [ref]$Errors) | Out-Null; if ($Errors.Count) { $Errors | % { Write-Error $_.Message }; exit 1 }`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', parse], { windowsHide: true, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
});
