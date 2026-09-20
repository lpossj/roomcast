import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const outDir = path.join(root, 'release', 'Roomcast-OBS-Portability-Test');
const zipPath = path.join(root, 'release', 'Roomcast-OBS-Portability-Test.zip');
const obsBundle = path.join(root, 'runtime', 'obs-bundle');
const electronDist = path.join(root, 'node_modules', 'electron', 'dist');
const markerPath = path.join(obsBundle, '.roomcast-embedded-obs.json');

const requiredProjectFiles = [
  'electron/obs-fixed-fps.cjs',
  'scripts/check-obs-static-motion.cjs',
  'scripts/obs-static-motion-renderer.js',
  'scripts/obs-transition-metrics.cjs',
];

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

async function copyRequired(rel) {
  const src = path.join(root, rel);
  const dst = path.join(outDir, rel);
  if (!(await exists(src))) throw new Error(`缺少文件：${rel}`);
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  await fsp.copyFile(src, dst);
}

async function sha256(file) {
  return await new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('error', reject);
    s.on('data', chunk => h.update(chunk));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

function utf8Bom(text) {
  return Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(text, 'utf8')]);
}

function assertAsciiExecutable(name, text) {
  if (/[^\x00-\x7F]/.test(text)) {
    throw new Error(`${name} contains non-ASCII executable text; this is unsafe for Windows PowerShell 5.1.`);
  }
}

function psSingleQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function parseGeneratedPowerShell(files) {
  const checks = files.map(file => {
    const q = psSingleQuote(file);
    return [
      '$tokens=$null',
      '$errors=$null',
      `[System.Management.Automation.Language.Parser]::ParseFile(${q}, [ref]$tokens, [ref]$errors) | Out-Null`,
      `if ($errors.Count -gt 0) { Write-Host ('PowerShell parse failed: ' + ${q}) -ForegroundColor Red; $errors | ForEach-Object { Write-Host $_.Message -ForegroundColor Red }; exit 91 }`,
    ].join('; ');
  }).join('; ');

  const ps = spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-Command', checks,
  ], { encoding: 'utf8' });

  if (ps.error) throw new Error(`无法调用 Windows PowerShell 语法检查：${ps.error.message}`);
  if (ps.status !== 0) {
    throw new Error(`Windows PowerShell 语法检查失败 (exit=${ps.status})\n${ps.stdout || ''}\n${ps.stderr || ''}`);
  }
}

function runRegistryMissingKeySelfTest(runnerPath) {
  const ps = spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', runnerPath,
    '-SelfTestRegistryProbe',
  ], { encoding: 'utf8' });

  if (ps.error) throw new Error(`Registry missing-key self-test could not start Windows PowerShell: ${ps.error.message}`);
  if (ps.status !== 0) {
    throw new Error(`Registry missing-key self-test failed (exit=${ps.status})\n${ps.stdout || ''}\n${ps.stderr || ''}`);
  }
  if (!String(ps.stdout || '').includes('Registry missing-key self-test: PASS')) {
    throw new Error(`Registry missing-key self-test did not report PASS.\n${ps.stdout || ''}\n${ps.stderr || ''}`);
  }
}

function runWaitSemanticsSelfTest(runnerPath) {
  const ps = spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', runnerPath,
    '-SelfTestWaitProbe',
  ], { encoding: 'utf8' });

  if (ps.error) throw new Error(`Wait-semantics self-test could not start Windows PowerShell: ${ps.error.message}`);
  if (ps.status !== 0) {
    throw new Error(`Wait-semantics self-test failed (exit=${ps.status})\n${ps.stdout || ''}\n${ps.stderr || ''}`);
  }
  if (!String(ps.stdout || '').includes('GUI-process wait self-test: PASS')) {
    throw new Error(`Wait-semantics self-test did not report PASS.\n${ps.stdout || ''}\n${ps.stderr || ''}`);
  }
}

// Keep executable PowerShell strictly ASCII. Windows PowerShell 5.1 otherwise
// interprets UTF-8-without-BOM scripts using the active ANSI code page.
const runnerPs1 = String.raw`param([switch]$SelfTestRegistryProbe, [switch]$SelfTestWaitProbe)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Clsid = '{A3FCE0F5-3493-419F-958A-ABA1250EC20B}'

function Get-ComPath([string]$View, [string]$TargetClsid = $Clsid) {
  if ($View -eq '64') {
    $registryView = [Microsoft.Win32.RegistryView]::Registry64
  } elseif ($View -eq '32') {
    $registryView = [Microsoft.Win32.RegistryView]::Registry32
  } else {
    throw "Unsupported registry view: $View"
  }

  $baseKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
    [Microsoft.Win32.RegistryHive]::LocalMachine,
    $registryView
  )
  try {
    $subPath = "SOFTWARE\Classes\CLSID\$TargetClsid\InprocServer32"
    $key = $baseKey.OpenSubKey($subPath, $false)
    if ($null -eq $key) { return $null }
    try {
      $value = $key.GetValue($null, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      if ($null -eq $value) { return $null }
      $text = [string]$value
      if ([string]::IsNullOrWhiteSpace($text)) { return $null }
      return $text.Trim()
    } finally {
      $key.Dispose()
    }
  } finally {
    $baseKey.Dispose()
  }
}


function Invoke-WaitedProcess(
  [string]$FilePath,
  [string[]]$ArgumentList,
  [string]$WorkingDirectory
) {
  $params = @{
    FilePath = $FilePath
    ArgumentList = $ArgumentList
    Wait = $true
    PassThru = $true
    NoNewWindow = $true
  }
  if (-not [string]::IsNullOrWhiteSpace($WorkingDirectory)) {
    $params.WorkingDirectory = $WorkingDirectory
  }
  $proc = Start-Process @params
  if ($null -eq $proc) { throw "Start-Process returned no process object: $FilePath" }
  return [int]$proc.ExitCode
}

if ($SelfTestWaitProbe) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $waitArgs = @(
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    'Start-Sleep -Milliseconds 800; exit 37'
  )
  $code = Invoke-WaitedProcess -FilePath 'powershell.exe' -ArgumentList $waitArgs -WorkingDirectory $Root
  $sw.Stop()
  if ($code -ne 37) {
    throw "GUI-process wait self-test failed: expected exit 37, got $code"
  }
  if ($sw.ElapsedMilliseconds -lt 600) {
    throw "GUI-process wait self-test failed: process returned too early ($($sw.ElapsedMilliseconds) ms)"
  }
  Write-Host '[OBS portability] GUI-process wait self-test: PASS'
  exit 0
}

if ($SelfTestRegistryProbe) {
  $missing = '{00000000-0000-0000-0000-000000000000}'
  $test64 = Get-ComPath '64' $missing
  $test32 = Get-ComPath '32' $missing
  if ($null -ne $test64 -or $null -ne $test32) {
    throw 'Registry probe self-test failed: a deliberately missing CLSID returned a value.'
  }
  Write-Host '[OBS portability] Registry missing-key self-test: PASS'
  exit 0
}

$ReportDir = Join-Path $Root 'portability-results'
New-Item -ItemType Directory -Force -Path $ReportDir | Out-Null
$Preflight = Join-Path $ReportDir 'preflight.txt'

$Reg64 = Get-ComPath '64'
$Reg32 = Get-ComPath '32'
$InstalledByTest = $false

@(
  "timestamp=$([DateTime]::Now.ToString('o'))",
  "os=$([Environment]::OSVersion.VersionString)",
  "machine=$env:COMPUTERNAME",
  "reg64=$Reg64",
  "reg32=$Reg32"
) | Set-Content -Encoding UTF8 $Preflight

if (($Reg64 -and -not $Reg32) -or ($Reg32 -and -not $Reg64)) {
  throw 'OBS Virtual Camera is registered in only one registry view. This test will not overwrite the existing state. Send portability-results\preflight.txt back to the developer.'
}

if ($Reg64 -and $Reg32) {
  if (-not (Test-Path -LiteralPath $Reg64) -or -not (Test-Path -LiteralPath $Reg32)) {
    throw 'OBS Virtual Camera is registered, but one or both DLL paths are invalid. This test will not overwrite the existing state. Send portability-results\preflight.txt back to the developer.'
  }
  Write-Host '[Portability] Existing OBS Virtual Camera registration found. It will not be overwritten.'
} else {
  $InstallBat = Join-Path $Root 'runtime\obs-bundle\data\obs-plugins\win-dshow\virtualcam-install.bat'
  if (-not (Test-Path -LiteralPath $InstallBat)) { throw "Bundled Virtual Camera installer is missing: $InstallBat" }
  Write-Host '[Portability] OBS Virtual Camera is not registered. A UAC prompt will appear for temporary registration.'
  $p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', ('"' + $InstallBat + '"') -WorkingDirectory (Split-Path $InstallBat) -Verb RunAs -Wait -PassThru
  if ($p.ExitCode -ne 0) { throw "Virtual Camera registration failed, exit=$($p.ExitCode)" }
  Start-Sleep -Milliseconds 800
  $Reg64 = Get-ComPath '64'; $Reg32 = Get-ComPath '32'
  if (-not $Reg64 -or -not $Reg32) { throw 'UAC returned success, but Virtual Camera registration is still incomplete.' }
  $InstalledByTest = $true
  Write-Host '[Portability] Temporary Virtual Camera registration completed.'
}

$Electron = Join-Path $Root 'electron-runtime\electron.exe'
if (-not (Test-Path -LiteralPath $Electron)) { throw "Electron Runtime is missing: $Electron" }

$ExitCode = 1
try {
  Write-Host '[Portability] Starting static-to-motion 60 FPS validation. This takes about 35 seconds.'
  $RootArg = '"' + $Root + '"'
  $electronArgs = @(
    $RootArg,
    '--monitor=0',
    '--width=1920',
    '--height=1080',
    '--fps=60',
    '--static-seconds=20',
    '--motion-seconds=8'
  )
  $ExitCode = Invoke-WaitedProcess -FilePath $Electron -ArgumentList $electronArgs -WorkingDirectory $Root
  Write-Host "[Portability] Test process exit=$ExitCode"
} finally {
  if ($InstalledByTest) {
    $UninstallBat = Join-Path $Root 'runtime\obs-bundle\data\obs-plugins\win-dshow\virtualcam-uninstall.bat'
    Write-Host '[Portability] The test registered Virtual Camera temporarily. A second UAC prompt will remove it now.'
    try {
      $u = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', ('"' + $UninstallBat + '"') -WorkingDirectory (Split-Path $UninstallBat) -Verb RunAs -Wait -PassThru
      if ($u.ExitCode -ne 0) { Write-Warning "Virtual Camera cleanup returned exit=$($u.ExitCode). Run CLEANUP-VIRTUALCAM.cmd manually." }
      else { Write-Host '[Portability] Temporary Virtual Camera registration removed.' }
    } catch {
      Write-Warning "Automatic Virtual Camera cleanup failed: $($_.Exception.Message). Run CLEANUP-VIRTUALCAM.cmd manually."
    }
  }
}

Write-Host ''
if ($ExitCode -eq 0) { Write-Host '[Portability] PASS' -ForegroundColor Green }
else { Write-Host '[Portability] FAIL' -ForegroundColor Red }
Write-Host 'Result directory:' (Join-Path $Root 'runtime\obs-test-data-static-motion')
exit $ExitCode
`;

const cleanupPs1 = String.raw`$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Bat = Join-Path $Root 'runtime\obs-bundle\data\obs-plugins\win-dshow\virtualcam-uninstall.bat'
if (-not (Test-Path -LiteralPath $Bat)) { throw "Virtual Camera uninstaller not found: $Bat" }
$p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', ('"' + $Bat + '"') -WorkingDirectory (Split-Path $Bat) -Verb RunAs -Wait -PassThru
exit $p.ExitCode
`;

const runCmd = `@echo off\r\ncd /d "%~dp0"\r\npowershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0RUN-PORTABILITY-CHECK.ps1"\r\nset EC=%ERRORLEVEL%\r\necho.\r\necho Exit code: %EC%\r\npause\r\nexit /b %EC%\r\n`;
const cleanupCmd = `@echo off\r\ncd /d "%~dp0"\r\npowershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0CLEANUP-VIRTUALCAM.ps1"\r\npause\r\n`;

async function main() {
  if (process.platform !== 'win32') throw new Error('此构建脚本只支持 Windows。');
  if (process.arch !== 'x64') throw new Error(`只支持 x64，当前 ${process.arch}。`);
  if (!(await exists(markerPath))) throw new Error('runtime\\obs-bundle 未准备。请先运行 npm run prepare:obs。');
  const marker = JSON.parse(await fsp.readFile(markerPath, 'utf8'));
  if (marker.version !== '32.1.2') throw new Error(`内置 OBS 版本必须是 32.1.2，实际 ${marker.version || 'unknown'}。`);
  for (const rel of requiredProjectFiles) if (!(await exists(path.join(root, rel)))) throw new Error(`缺少当前 Probe 文件：${rel}`);
  if (!(await exists(path.join(electronDist, 'electron.exe')))) throw new Error('node_modules\\electron\\dist 不完整。请先 npm install/npm ci。');

  assertAsciiExecutable('RUN-PORTABILITY-CHECK.ps1', runnerPs1);
  assertAsciiExecutable('CLEANUP-VIRTUALCAM.ps1', cleanupPs1);
  assertAsciiExecutable('RUN-PORTABILITY-CHECK.cmd', runCmd);
  assertAsciiExecutable('CLEANUP-VIRTUALCAM.cmd', cleanupCmd);

  await fsp.rm(outDir, { recursive: true, force: true });
  await fsp.mkdir(outDir, { recursive: true });

  await fsp.cp(obsBundle, path.join(outDir, 'runtime', 'obs-bundle'), { recursive: true, force: true });
  await fsp.cp(electronDist, path.join(outDir, 'electron-runtime'), { recursive: true, force: true });
  for (const rel of requiredProjectFiles) await copyRequired(rel);

  await fsp.writeFile(path.join(outDir, 'package.json'), JSON.stringify({
    name: 'roomcast-obs-portability-test',
    private: true,
    version: '0.12.0-test',
    main: 'scripts/check-obs-static-motion.cjs',
  }, null, 2));

  const runnerPath = path.join(outDir, 'RUN-PORTABILITY-CHECK.ps1');
  const cleanupPath = path.join(outDir, 'CLEANUP-VIRTUALCAM.ps1');
  await fsp.writeFile(runnerPath, utf8Bom(runnerPs1));
  await fsp.writeFile(path.join(outDir, 'RUN-PORTABILITY-CHECK.cmd'), runCmd, 'ascii');
  await fsp.writeFile(cleanupPath, utf8Bom(cleanupPs1));
  await fsp.writeFile(path.join(outDir, 'CLEANUP-VIRTUALCAM.cmd'), cleanupCmd, 'ascii');

  // Parse with Windows PowerShell itself before the ZIP is produced. This would
  // catch encoding/quoting/parser failures on the developer machine.
  parseGeneratedPowerShell([runnerPath, cleanupPath]);
  console.log('[OBS portability] Windows PowerShell parser: PASS');
  runRegistryMissingKeySelfTest(runnerPath);
  console.log('[OBS portability] Registry missing-key runtime self-test: PASS');
  runWaitSemanticsSelfTest(runnerPath);
  console.log('[OBS portability] GUI-process wait runtime self-test: PASS');

  const readme = [
    'Roomcast OBS Portability Test',
    '',
    'Target: validate the bundled OBS 32.1.2 fixed-60-FPS path on Windows 10/11.',
    '',
    'Run: double-click RUN-PORTABILITY-CHECK.cmd.',
    'If OBS Virtual Camera is not registered, the test will request UAC for temporary registration and cleanup.',
    'If an existing Virtual Camera registration is found, the test will not overwrite it.',
    'The runner waits for Electron to fully exit before any temporary Virtual Camera cleanup is attempted.',
    '',
    'Keep runtime\\obs-test-data-static-motion\\static-motion-report.json and portability-results\\preflight.txt after the test.',
  ].join('\r\n');
  await fsp.writeFile(path.join(outDir, 'README-TEST.txt'), utf8Bom(readme));

  const manifest = {
    builtAt: new Date().toISOString(),
    obsVersion: marker.version,
    electronExeSha256: await sha256(path.join(outDir, 'electron-runtime', 'electron.exe')),
    obsExeSha256: await sha256(path.join(outDir, 'runtime', 'obs-bundle', 'bin', '64bit', 'obs64.exe')),
    powershellScriptsAscii: true,
    powershellUtf8Bom: true,
    powershellParserChecked: true,
    registryMissingKeySelfTestChecked: true,
    files: {},
  };
  for (const rel of requiredProjectFiles) manifest.files[rel] = await sha256(path.join(outDir, rel));
  await fsp.writeFile(path.join(outDir, 'PORTABILITY-MANIFEST.json'), JSON.stringify(manifest, null, 2));

  await fsp.rm(zipPath, { force: true });
  const ps = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    `Compress-Archive -Path '${outDir.replaceAll("'", "''")}\\*' -DestinationPath '${zipPath.replaceAll("'", "''")}' -CompressionLevel Optimal -Force`],
    { stdio: 'inherit' });
  if (ps.status !== 0 || !(await exists(zipPath))) throw new Error('生成 portability ZIP 失败。');
  const zipHash = await sha256(zipPath);
  console.log('[OBS portability] PASS');
  console.log(`[OBS portability] 目录：${outDir}`);
  console.log(`[OBS portability] ZIP：${zipPath}`);
  console.log(`[OBS portability] SHA256：${zipHash}`);
  console.log('[OBS portability] 把整个 ZIP 拷到其他 Win10/Win11 电脑，解压后双击 RUN-PORTABILITY-CHECK.cmd。');
}

main().catch(error => {
  console.error(`[OBS portability] FAIL: ${error.stack || error.message}`);
  process.exitCode = 1;
});
