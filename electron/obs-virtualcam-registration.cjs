const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const OBS_VIRTUAL_CAM_CLSID = '{A3FCE0F5-3493-419F-958A-ABA1250EC20B}';
const OBS_VIRTUAL_CAM_VERSION = '32.1.2';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function psSingleQuoted(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function encodePowerShell(command) {
  return Buffer.from(command, 'utf16le').toString('base64');
}

function cleanRegistryPath(value) {
  return String(value || '').trim().replace(/^"|"$/g, '');
}

function normalizeWindowsPath(value) {
  return cleanRegistryPath(value).replace(/\//g, '\\').replace(/\\+$/g, '').toLowerCase();
}

function pathInside(child, parent) {
  const a = normalizeWindowsPath(child);
  const b = normalizeWindowsPath(parent);
  return Boolean(a && b && (a === b || a.startsWith(`${b}\\`)));
}

function queryRegistrationView(view) {
  if (process.platform !== 'win32') {
    return { registered: false, path: '', pathExists: false, view: Number(view) };
  }
  const registryView = Number(view) === 32 ? 'Registry32' : 'Registry64';
  const subKey = `SOFTWARE\\Classes\\CLSID\\${OBS_VIRTUAL_CAM_CLSID}\\InprocServer32`;
  const command = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
    `$View = [Microsoft.Win32.RegistryView]::${registryView}`,
    '$Base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, $View)',
    `$Key = $Base.OpenSubKey(${psSingleQuoted(subKey)})`,
    'if ($null -eq $Key) {',
    `  [pscustomobject]@{ registered = $false; path = ''; view = ${Number(view)} } | ConvertTo-Json -Compress`,
    '} else {',
    "  $Value = [string]$Key.GetValue('')",
    '  $Key.Dispose()',
    `  [pscustomobject]@{ registered = $true; path = $Value; view = ${Number(view)} } | ConvertTo-Json -Compress`,
    '}',
    '$Base.Dispose()',
  ].join('; ');
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', encodePowerShell(command),
  ], {
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`无法读取 Windows ${view} 位 OBS Virtual Camera 注册状态：${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`读取 Windows ${view} 位 OBS Virtual Camera 注册状态失败（exit ${result.status ?? 'unknown'}）：${String(result.stderr || result.stdout || '').trim()}`);
  }
  try {
    const parsed = JSON.parse(String(result.stdout || '').replace(/^\uFEFF/, '').trim());
    const registered = parsed?.registered === true;
    const modulePath = cleanRegistryPath(parsed?.path || '');
    return {
      registered,
      path: modulePath,
      pathExists: registered && Boolean(modulePath) && fs.existsSync(modulePath),
      view: Number(view),
    };
  } catch (error) {
    throw new Error(`解析 Windows ${view} 位 OBS Virtual Camera 注册状态失败：${error.message}`);
  }
}

function classifyVirtualCameraRegistration({ reg32, reg64 }) {
  const has32 = typeof reg32 === 'object' ? reg32?.registered === true : reg32 === true;
  const has64 = typeof reg64 === 'object' ? reg64?.registered === true : reg64 === true;
  if (has32 && has64) return 'existing';
  if (!has32 && !has64) return 'absent';
  return 'partial';
}

function roomcastRegistrationDecision({ reg32, reg64 }) {
  const has32 = typeof reg32 === 'object' ? reg32?.registered === true : reg32 === true;
  const has64 = typeof reg64 === 'object' ? reg64?.registered === true : reg64 === true;
  // OBS 32.1.2's win-dshow plugin gates registration of the Virtual Camera
  // output on the 32-bit COM registry view even inside 64-bit OBS. Roomcast's
  // Chromium consumer is 64-bit, so both registry views are functional
  // requirements: x86 makes the OBS output exist; x64 makes the camera
  // consumable by Roomcast.
  return has32 && has64
    ? {
      ready: true,
      action: 'use-existing-dual',
      reason: 'x86-and-x64-present',
    }
    : {
      ready: false,
      action: 'register-missing-views',
      reason: !has32 && !has64 ? 'both-missing' : !has32 ? 'x86-missing' : 'x64-missing',
    };
}

function registrationStatus() {
  const view32 = queryRegistrationView(32);
  const view64 = queryRegistrationView(64);
  const reg32 = view32.registered;
  const reg64 = view64.registered;
  const decision = roomcastRegistrationDecision({ reg32, reg64 });
  const x86Ready = reg32 && view32.pathExists;
  const x64Ready = reg64 && view64.pathExists;
  const roomcastReady = x86Ready && x64Ready;
  return {
    reg32,
    reg64,
    reg32Path: view32.path,
    reg64Path: view64.path,
    reg32PathExists: view32.pathExists,
    reg64PathExists: view64.pathExists,
    state: classifyVirtualCameraRegistration({ reg32, reg64 }),
    roomcastReady,
    roomcastAction: roomcastReady ? 'use-existing-dual' : 'register-missing-views',
    roomcastReason: roomcastReady
      ? decision.reason
      : !x86Ready && !x64Ready
        ? 'x86-and-x64-missing-or-stale'
        : !x86Ready
          ? 'x86-missing-or-stale'
          : 'x64-missing-or-stale',
    x86RegistrationPresent: x86Ready,
    x64RegistrationPresent: x64Ready,
  };
}

function roomcastOwnedRegistration(modulePath, { dataRoot = '', module32 = '', module64 = '' } = {}) {
  const candidate = normalizeWindowsPath(modulePath);
  if (!candidate) return false;
  if (normalizeWindowsPath(module32) === candidate || normalizeWindowsPath(module64) === candidate) return true;
  if (dataRoot && pathInside(candidate, dataRoot)) return true;
  const programData = process.env.ProgramData || process.env.PROGRAMDATA || '';
  if (programData && pathInside(candidate, path.join(programData, 'Roomcast', 'obs-virtualcam'))) return true;
  return false;
}

function registrationAssessment(status, context = {}) {
  const views = [
    { bit: 32, registered: status.reg32, modulePath: status.reg32Path, pathExists: status.reg32PathExists },
    { bit: 64, registered: status.reg64, modulePath: status.reg64Path, pathExists: status.reg64PathExists },
  ];
  const validExternal = views.filter(item => item.registered && item.pathExists && !roomcastOwnedRegistration(item.modulePath, context));
  const validRoomcast = views.filter(item => item.registered && item.pathExists && roomcastOwnedRegistration(item.modulePath, context));
  const stale = views.filter(item => item.registered && !item.pathExists);

  const view32 = views[0];
  const view64 = views[1];
  const valid32 = view32.registered && view32.pathExists;
  const valid64 = view64.registered && view64.pathExists;

  if (valid32 && valid64) {
    return {
      action: validExternal.length ? 'use-existing-dual-preserve-external' : 'use-existing-roomcast-dual',
      ready: true,
      reason: validExternal.length ? 'valid-dual-with-external-registration' : 'valid-dual-roomcast-registration',
      validExternal,
      validRoomcast,
      stale,
      register32: false,
      register64: false,
    };
  }

  // Never overwrite a valid external registration. Repair only the missing or
  // stale registry view. This can intentionally leave one external view and one
  // Roomcast-owned view, which is safer than clobbering a system OBS install.
  return {
    action: 'install-missing-views',
    ready: false,
    reason: !valid32 && !valid64 ? 'both-views-missing-or-stale' : !valid32 ? 'x86-view-missing-or-stale' : 'x64-view-missing-or-stale',
    validExternal,
    validRoomcast,
    stale,
    register32: !valid32,
    register64: !valid64,
  };
}

function stableInstallPaths() {
  const programData = process.env.ProgramData || process.env.PROGRAMDATA || 'C:\\ProgramData';
  const installDir = path.join(programData, 'Roomcast', 'obs-virtualcam', OBS_VIRTUAL_CAM_VERSION);
  return {
    installDir,
    module32: path.join(installDir, 'obs-virtualcam-module32.dll'),
    module64: path.join(installDir, 'obs-virtualcam-module64.dll'),
  };
}

function buildElevatedRegistrationScript({
  module32,
  module64,
  target32,
  target64,
  resultPath,
  register32 = true,
  register64 = true,
}) {
  const subKey = `SOFTWARE\\Classes\\CLSID\\${OBS_VIRTUAL_CAM_CLSID}\\InprocServer32`;
  return [
    "$ErrorActionPreference = 'Stop'",
    `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)`,
    `$Source32 = ${psSingleQuoted(module32)}`,
    `$Source64 = ${psSingleQuoted(module64)}`,
    `$Target32 = ${psSingleQuoted(target32)}`,
    `$Target64 = ${psSingleQuoted(target64)}`,
    `$ResultPath = ${psSingleQuoted(resultPath)}`,
    `$Register32 = ${register32 ? '$true' : '$false'}`,
    `$Register64 = ${register64 ? '$true' : '$false'}`,
    "$Result = [ordered]@{ ok = $false; phase = 'init'; exit32 = $null; exit64 = $null; reg32Path = ''; reg64Path = ''; reg32Exe = ''; reg64Exe = ''; target32 = $Target32; target64 = $Target64; error32 = ''; error64 = ''; error = '' }",
    'function Save-Result {',
    '  $Parent = Split-Path -Parent $ResultPath',
    '  if ($Parent) { New-Item -ItemType Directory -Force -Path $Parent | Out-Null }',
    '  ($Result | ConvertTo-Json -Compress) | Set-Content -LiteralPath $ResultPath -Encoding UTF8',
    '}',
    'function Get-ComPath([Microsoft.Win32.RegistryView]$View) {',
    '  $Base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, $View)',
    `  $Key = $Base.OpenSubKey(${psSingleQuoted(subKey)})`,
    "  $Value = if ($null -eq $Key) { '' } else { [string]$Key.GetValue('') }",
    '  if ($null -ne $Key) { $Key.Dispose() }',
    '  $Base.Dispose()',
    '  return $Value',
    '}',
    'function Same-Path([string]$Expected, [string]$Actual) {',
    '  if ([string]::IsNullOrWhiteSpace($Expected) -or [string]::IsNullOrWhiteSpace($Actual)) { return $false }',
    '  try {',
    '    $A = [System.IO.Path]::GetFullPath($Expected).TrimEnd([char]92)',
    '    $B = [System.IO.Path]::GetFullPath($Actual).TrimEnd([char]92)',
    '    return [string]::Equals($A, $B, [System.StringComparison]::OrdinalIgnoreCase)',
    '  } catch { return $false }',
    '}',
    'function Invoke-Regsvr32([string]$Exe, [string]$Dll, [int]$TimeoutMs) {',
    '  $Psi = New-Object System.Diagnostics.ProcessStartInfo',
    '  $Psi.FileName = $Exe',
    '  $Psi.Arguments = \'/s /i "\' + $Dll + \'"\'',
    '  $Psi.UseShellExecute = $false',
    '  $Psi.CreateNoWindow = $true',
    '  $Process = New-Object System.Diagnostics.Process',
    '  $Process.StartInfo = $Psi',
    '  try {',
    "    if (-not $Process.Start()) { throw 'Process.Start returned false' }",
    '    if (-not $Process.WaitForExit($TimeoutMs)) {',
    '      try { $Process.Kill() } catch { }',
    "      throw ('regsvr32 timed out after ' + $TimeoutMs + ' ms')",
    '    }',
    '    return [int]$Process.ExitCode',
    '  } finally {',
    '    $Process.Dispose()',
    '  }',
    '}',
    'try {',
    "  $Result.phase = 'validate-source'",
    "  if ($Register32 -and -not (Test-Path -LiteralPath $Source32)) { throw 'bundled 32-bit Virtual Camera DLL is missing' }",
    "  if ($Register64 -and -not (Test-Path -LiteralPath $Source64)) { throw 'bundled 64-bit Virtual Camera DLL is missing' }",
    '  $InstallDir = Split-Path -Parent $Target64',
    '  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null',
    '  if ($Register32) { Copy-Item -LiteralPath $Source32 -Destination $Target32 -Force }',
    '  if ($Register64) { Copy-Item -LiteralPath $Source64 -Destination $Target64 -Force }',
    "  $WindowsRoot = if ($env:SystemRoot) { $env:SystemRoot } elseif ($env:WINDIR) { $env:WINDIR } else { throw 'Windows root environment variable is missing' }",
    "  $Reg32 = Join-Path $WindowsRoot 'SysWOW64\\regsvr32.exe'",
    "  $Reg64 = Join-Path $WindowsRoot 'System32\\regsvr32.exe'",
    '  $Result.reg32Exe = $Reg32',
    '  $Result.reg64Exe = $Reg64',
    '',
    '  # OBS 32.1.2 win-dshow checks the 32-bit COM view while loading the',
    '  # Virtual Camera output, so x86 registration must be complete before',
    '  # the bundled 64-bit OBS process is launched.',
    '  if ($Register32) {',
    "    $Result.phase = 'register32'",
    "    if (-not (Test-Path -LiteralPath $Reg32)) { throw ('32-bit regsvr32.exe is missing: ' + $Reg32) }",
    '    try {',
    '      $Result.exit32 = Invoke-Regsvr32 $Reg32 $Target32 30000',
    '    } catch {',
    '      $Result.error32 = $_.Exception.Message',
    "      throw ('32-bit regsvr32 could not complete: ' + $Result.error32)",
    '    }',
    '    $Result.reg32Path = Get-ComPath ([Microsoft.Win32.RegistryView]::Registry32)',
    "    if ($Result.exit32 -ne 0) { throw ('32-bit regsvr32 returned non-zero, exit=' + $Result.exit32 + '; registry=' + $Result.reg32Path) }",
    "    if (-not (Same-Path $Target32 $Result.reg32Path)) { throw ('32-bit registration verification failed; registry=' + $Result.reg32Path) }",
    '  } else {',
    '    $Result.reg32Path = Get-ComPath ([Microsoft.Win32.RegistryView]::Registry32)',
    '  }',
    '',
    '  if ($Register64) {',
    "    $Result.phase = 'register64'",
    "    if (-not (Test-Path -LiteralPath $Reg64)) { throw ('64-bit regsvr32.exe is missing: ' + $Reg64) }",
    '    try {',
    '      $Result.exit64 = Invoke-Regsvr32 $Reg64 $Target64 30000',
    '    } catch {',
    '      $Result.error64 = $_.Exception.Message',
    "      throw ('64-bit regsvr32 could not complete: ' + $Result.error64)",
    '    }',
    '    $Result.reg64Path = Get-ComPath ([Microsoft.Win32.RegistryView]::Registry64)',
    "    if ($Result.exit64 -ne 0) { throw ('64-bit regsvr32 returned non-zero, exit=' + $Result.exit64 + '; registry=' + $Result.reg64Path) }",
    "    if (-not (Same-Path $Target64 $Result.reg64Path)) { throw ('64-bit registration verification failed; registry=' + $Result.reg64Path) }",
    '  } else {',
    '    $Result.reg64Path = Get-ComPath ([Microsoft.Win32.RegistryView]::Registry64)',
    '  }',
    '',
    "  if ([string]::IsNullOrWhiteSpace($Result.reg32Path)) { throw '32-bit Virtual Camera registration is still missing after setup' }",
    "  if ([string]::IsNullOrWhiteSpace($Result.reg64Path)) { throw '64-bit Virtual Camera registration is still missing after setup' }",
    "  $Result.phase = 'complete'",
    '  $Result.ok = $true',
    '  Save-Result',
    '  exit 0',
    '} catch {',
    '  $Result.error = $_.Exception.Message',
    '  try {',
    '    if ([string]::IsNullOrWhiteSpace($Result.reg32Path)) { $Result.reg32Path = Get-ComPath ([Microsoft.Win32.RegistryView]::Registry32) }',
    '    if ([string]::IsNullOrWhiteSpace($Result.reg64Path)) { $Result.reg64Path = Get-ComPath ([Microsoft.Win32.RegistryView]::Registry64) }',
    '  } catch { }',
    '  try { Save-Result } catch { }',
    '  exit 1',
    '}',
    '',
  ].join('\r\n');
}

function elevatedLauncherCommand(scriptPath) {
  const script = psSingleQuoted(scriptPath);
  return [
    "$ErrorActionPreference = 'Stop'",
    `$ScriptPath = ${script}`,
    "$PowerShell = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'",
    "$Arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File \"' + $ScriptPath + '\"'",
    'try {',
    "  $Process = Start-Process -FilePath $PowerShell -Verb RunAs -ArgumentList $Arguments -Wait -PassThru -WindowStyle Hidden",
    '  exit $Process.ExitCode',
    '} catch {',
    '  if ($_.Exception.NativeErrorCode -eq 1223) { exit 1223 }',
    '  exit 1',
    '}',
  ].join('\r\n');
}

function sanitizeVirtualCameraInstaller(script) {
  return String(script || '')
    .split(/\r?\n/)
    .filter(line => !/^\s*pause\s*$/i.test(line))
    .join('\r\n');
}

function elevatedInstallerLauncherCommand(installerPath) {
  const installer = psSingleQuoted(installerPath);
  return [
    "$ErrorActionPreference = 'Stop'",
    `$InstallBat = ${installer}`,
    "if (-not (Test-Path -LiteralPath $InstallBat)) { exit 66 }",
    "$Cmd = Join-Path $env:SystemRoot 'System32\\cmd.exe'",
    'try {',
    "  $Process = Start-Process -FilePath $Cmd -ArgumentList '/d', '/c', ('\"' + $InstallBat + '\"') -WorkingDirectory (Split-Path -Parent $InstallBat) -Verb RunAs -Wait -PassThru",
    '  exit $Process.ExitCode',
    '} catch {',
    '  if ($_.Exception.NativeErrorCode -eq 1223) { exit 1223 }',
    '  exit 1',
    '}',
  ].join('\r\n');
}

function runProcess(file, args, { timeoutMs = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      windowsHide: true,
      stdio: 'ignore',
    });
    let settled = false;
    let timer = null;
    const finish = (error, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(code);
    };
    child.once('error', error => finish(error));
    child.once('exit', code => finish(null, Number.isInteger(code) ? code : 1));
    timer = setTimeout(() => {
      try { child.kill(); } catch { }
      finish(new Error('等待管理员权限操作超时。'));
    }, timeoutMs);
  });
}

async function readResultFile(resultPath) {
  try {
    const raw = await fsp.readFile(resultPath, 'utf8');
    return JSON.parse(raw.replace(/^\uFEFF/, '').trim());
  } catch {
    return null;
  }
}

function formatRegistrationFailure(result, launcherCode) {
  if (!result) {
    return `Virtual Camera 管理员注册进程失败（launcher=${launcherCode}），本次未生成诊断结果。`;
  }
  const details = [
    `phase=${result.phase || 'unknown'}`,
    `launcher=${launcherCode}`,
    `exit32=${result.exit32 == null ? 'n/a' : result.exit32}`,
    `exit64=${result.exit64 == null ? 'n/a' : result.exit64}`,
    result.reg32Exe ? `reg32Exe=${result.reg32Exe}` : '',
    result.reg64Exe ? `reg64Exe=${result.reg64Exe}` : '',
    result.target32 ? `target32=${result.target32}` : '',
    result.target64 ? `target64=${result.target64}` : '',
    result.reg32Path ? `reg32=${result.reg32Path}` : '',
    result.reg64Path ? `reg64=${result.reg64Path}` : '',
    result.error32 ? `error32=${result.error32}` : '',
    result.error64 ? `error64=${result.error64}` : '',
  ].filter(Boolean).join(', ');
  return `${result.error || 'Virtual Camera 双架构注册失败'}（${details}）`;
}

async function registerRoomcastVirtualCamera({
  module32,
  module64,
  dataRoot,
  register32 = true,
  register64 = true,
}) {
  if (process.platform !== 'win32') throw new Error('OBS Virtual Camera 注册只支持 Windows。');
  if (register32 && (!module32 || !fs.existsSync(module32))) {
    throw new Error('Roomcast 内置 OBS 32 位 Virtual Camera 组件不完整。');
  }
  if (register64 && (!module64 || !fs.existsSync(module64))) {
    throw new Error('Roomcast 内置 OBS 64 位 Virtual Camera 组件不完整。');
  }

  const tempDir = path.join(dataRoot, 'runtime', 'obs-virtualcam-setup');
  await fsp.mkdir(tempDir, { recursive: true });
  const stable = stableInstallPaths();
  const stamp = `${process.pid}-${Date.now()}`;
  const scriptPath = path.join(tempDir, `register-vcam-${stamp}.ps1`);
  const resultPath = path.join(tempDir, `registration-result-${stamp}.json`);
  const lastResultPath = path.join(tempDir, 'last-registration-result.json');

  await fsp.rm(resultPath, { force: true }).catch(() => {});
  await fsp.writeFile(scriptPath, `\uFEFF${buildElevatedRegistrationScript({
    module32,
    module64,
    target32: stable.module32,
    target64: stable.module64,
    resultPath,
    register32,
    register64,
  })}`, 'utf8');

  let launcherCode = 1;
  let result = null;
  try {
    const command = elevatedLauncherCommand(scriptPath);
    launcherCode = await runProcess('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', encodePowerShell(command),
    ]);

    if (launcherCode === 1223) {
      const error = new Error('你取消了管理员权限请求，OBS 采集无法启动。');
      error.code = 'UAC_CANCELLED';
      throw error;
    }

    result = await readResultFile(resultPath);
    if (result) await fsp.copyFile(resultPath, lastResultPath).catch(() => {});

    if (launcherCode !== 0 || result?.ok !== true) {
      const error = new Error(formatRegistrationFailure(result, launcherCode));
      error.code = result?.phase === 'register32'
        ? 'OBS_VIRTUALCAM_REGISTER_X86_FAILED'
        : result?.phase === 'register64'
          ? 'OBS_VIRTUALCAM_REGISTER_X64_FAILED'
          : 'OBS_VIRTUALCAM_REGISTER_FAILED';
      throw error;
    }
  } finally {
    await fsp.rm(scriptPath, { force: true }).catch(() => {});
    await fsp.rm(resultPath, { force: true }).catch(() => {});
  }

  await delay(800);
  const verified = registrationStatus();
  if (!verified.reg32 || !verified.reg32PathExists || !verified.reg64 || !verified.reg64PathExists) {
    const error = new Error(
      `OBS Virtual Camera 双架构注册完成后校验失败（reg32=${verified.reg32}, reg32Path=${verified.reg32Path || 'none'}, reg64=${verified.reg64}, reg64Path=${verified.reg64Path || 'none'}）。`
    );
    error.code = 'OBS_VIRTUALCAM_VERIFY_DUAL_FAILED';
    throw error;
  }

  return {
    ...verified,
    stableInstall: stable,
    registrationDiagnostics: result,
  };
}

async function prepareEngineForFreshVirtualCameraRegistration(engine) {
  await engine.prepare();
  const modules = engine.virtualCameraModules();
  const stoppedPreRegistrationObs = Boolean(engine.process || engine.client?.ready);
  if (stoppedPreRegistrationObs) await engine.close();
  return { modules, stoppedPreRegistrationObs };
}

async function ensureObsVirtualCameraRegistration({ engine, dataRoot }) {
  await engine.prepare();
  const modules = engine.virtualCameraModules();
  const before = registrationStatus();
  const assessment = registrationAssessment(before, { dataRoot, module32: modules.module32, module64: modules.module64 });

  if (assessment.ready) {
    return {
      ok: true,
      installedByRoomcast: false,
      stoppedPreRegistrationObs: false,
      registration: before,
      assessment,
    };
  }

  const { stoppedPreRegistrationObs } = await prepareEngineForFreshVirtualCameraRegistration(engine);
  const registration = await registerRoomcastVirtualCamera({
    module32: modules.module32,
    module64: modules.module64,
    dataRoot,
    register32: assessment.register32,
    register64: assessment.register64,
  });

  const markerPath = path.join(dataRoot, 'obs-virtualcam-registration.json');
  await fsp.writeFile(markerPath, JSON.stringify({
    schema: 6,
    architecture: 'dual-registry-required-by-obs-win-dshow',
    installedAt: new Date().toISOString(),
    sourceModule32: modules.module32,
    sourceModule64: modules.module64,
    registeredModule32: registration.reg32Path,
    registeredModule64: registration.reg64Path,
    repairedPreviousState: before.state,
    repaired32: assessment.register32,
    repaired64: assessment.register64,
    preservedExternalRegistrations: assessment.validExternal.map(item => ({ bit: item.bit, modulePath: item.modulePath })),
  }, null, 2), { mode: 0o600 }).catch(() => {});

  return {
    ok: true,
    installedByRoomcast: true,
    stoppedPreRegistrationObs,
    registration,
    assessment,
  };
}

module.exports = {
  OBS_VIRTUAL_CAM_CLSID,
  OBS_VIRTUAL_CAM_VERSION,
  classifyVirtualCameraRegistration,
  roomcastRegistrationDecision,
  registrationStatus,
  registrationAssessment,
  stableInstallPaths,
  buildElevatedRegistrationScript,
  elevatedLauncherCommand,
  sanitizeVirtualCameraInstaller,
  elevatedInstallerLauncherCommand,
  prepareEngineForFreshVirtualCameraRegistration,
  ensureObsVirtualCameraRegistration,
};
