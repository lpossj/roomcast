const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

const { ObsFixedFpsEngine, EMBEDDED_OBS_VERSION } = require('../electron/obs-fixed-fps.cjs');
const pkg = require('../package.json');

const EXPECTED_OBS_VERSION = '32.1.2';
const EXPECTED_BINARY_ARCHIVE_SHA256 = '8d97e4563bd8d22d03e63042aa7dccede1d555c9bd35ce8a9e5019b0d0201bf6';
const EXPECTED_SOURCE_SHA256 = 'c6532380c68a75327fe8b551461adeca8f184dcbe4015096251a6de76362a554';
const SOURCE_NAME = `OBS-Studio-${EXPECTED_OBS_VERSION}-Sources.tar.gz`;

const REQUIRED_PACKAGED_RESOURCES = Object.freeze([
  ['runtime/obs-bundle/bin/64bit/obs64.exe', 1_000_000],
  ['runtime/obs-bundle/roomcast-embedded-obs.json', 20],
  ['runtime/obs-bundle/.roomcast-embedded-obs.json', 20],
  ['runtime/obs-bundle/obs-plugins/64bit/obs-websocket.dll', 10_000],
  ['runtime/obs-bundle/obs-plugins/64bit/win-dshow.dll', 10_000],
  ['runtime/obs-bundle/data/obs-plugins/obs-websocket/locale/en-US.ini', 10],
  ['runtime/obs-bundle/data/obs-plugins/win-capture', 1],
  ['runtime/obs-bundle/data/obs-plugins/win-dshow/obs-virtualcam-module32.dll', 10_000],
  ['runtime/obs-bundle/data/obs-plugins/win-dshow/obs-virtualcam-module64.dll', 10_000],
  ['runtime/obs-bundle/data/obs-studio/license/gplv2.txt', 100],
  [`runtime/obs-source/${SOURCE_NAME}`, 1_000_000],
  ['runtime/obs-source/OBS-SOURCE-NOTICE.txt', 100],
  ['runtime/loopback-capture/loopback_capture_addon.node', 10_000],
  ['runtime/loopback-capture/LICENSE', 10],
]);

function normalizeVersion(value) {
  const match = String(value || '').match(/\b(\d+\.\d+\.\d+)\b/);
  return match?.[1] || '';
}

function argument(name, fallback = '') {
  const prefix = `--${name}=`;
  const value = process.argv.find(item => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

async function sha256(file) {
  const hash = createHash('sha256');
  const stream = fs.createReadStream(file);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

async function assertFile(file, minimumBytes = 1) {
  const stat = await fsp.stat(file).catch(() => null);
  assert.ok(stat?.isFile(), `缺少文件：${file}`);
  assert.ok(stat.size >= minimumBytes, `文件异常或过小：${file} (${stat.size} bytes)`);
  return stat.size;
}

async function assertDirectory(dir) {
  const stat = await fsp.stat(dir).catch(() => null);
  assert.ok(stat?.isDirectory(), `缺少目录：${dir}`);
}

async function collectFilesByExtension(root, extension) {
  const matches = [];
  const pending = [root];
  const wanted = String(extension || '').toLowerCase();

  while (pending.length) {
    const current = pending.pop();
    const entries = await fsp.readdir(current, { withFileTypes: true });

    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile() && path.extname(entry.name).toLowerCase() === wanted) matches.push(absolute);
    }
  }

  return matches;
}

async function freeTcpPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function powershellProductVersion(file) {
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$v = (Get-Item -LiteralPath $env:ROOMCAST_STEP5D_FILE).VersionInfo",
    "[Console]::Out.Write(($v.ProductVersion + '|' + $v.FileVersion))",
  ].join('; ');
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command,
    ], {
      windowsHide: true,
      env: { ...process.env, ROOMCAST_STEP5D_FILE: file },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('exit', code => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`读取 OBS 文件版本失败：${stderr.trim() || `exit ${code}`}`));
    });
  });
}

function inside(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function waitForExit(child, timeoutMs = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    delay(timeoutMs),
  ]);
}

async function portableRuntimePreflight(portableExe, projectRoot) {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'Roomcast Portable OBS Preflight-'));
  const profileDir = path.join(tempRoot, 'profile');
  const resultPath = path.join(tempRoot, 'result.json');
  const env = {
    ...process.env,
    ROOMCAST_ALLOW_PARALLEL_INSTANCE: '1',
    ROOMCAST_PROFILE_DIR: profileDir,
    ROOMCAST_OBS_PREFLIGHT_RESULT: resultPath,
  };
  delete env.ROOMCAST_OBS_BUNDLE;
  delete env.ROOMCAST_OBS_RUNTIME;

  const child = spawn(portableExe, [], {
    cwd: path.dirname(portableExe),
    windowsHide: true,
    stdio: 'ignore',
    env,
  });

  let spawnError = null;
  child.once('error', error => { spawnError = error; });
  const deadline = Date.now() + 45_000;
  let report = null;

  try {
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      try {
        report = JSON.parse(await fsp.readFile(resultPath, 'utf8'));
        break;
      } catch {}
      if (child.exitCode !== null && !(await fsp.stat(resultPath).catch(() => null))) {
        throw new Error(`portable EXE exited before writing OBS preflight result (exit=${child.exitCode})`);
      }
      await delay(250);
    }

    if (!report) throw new Error('portable EXE OBS runtime preflight timed out after 45 seconds');
    assert.equal(report.ok, true, `portable EXE could not resolve bundled OBS: ${report.error || 'unknown error'}`);
    assert.equal(report.appIsPackaged, true, 'portable preflight did not run as a packaged Electron app');
    assert.ok(report.resourcesPath, 'portable preflight did not report process.resourcesPath');
    assert.ok(report.prepared?.bundleDir, 'portable preflight did not report the selected OBS bundle');
    assert.ok(
      inside(report.prepared.bundleDir, report.resourcesPath),
      `portable OBS bundle is not under process.resourcesPath: ${report.prepared.bundleDir}`,
    );
    assert.ok(!inside(report.prepared.bundleDir, projectRoot), 'portable OBS bundle incorrectly came from the project tree');
    return {
      resourcesPath: report.resourcesPath,
      bundleDir: report.prepared.bundleDir,
      obsDir: report.prepared.obsDir,
      copied: report.prepared.copied,
      version: report.prepared.version,
    };
  } finally {
    await waitForExit(child, 5000);
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill(); } catch {}
    }
    await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('Step5D 打包验收必须在 Windows x64 上运行。');
  }
  assert.equal(EMBEDDED_OBS_VERSION, EXPECTED_OBS_VERSION, '运行时代码中的 OBS 版本常量不一致');

  const projectRoot = path.resolve(__dirname, '..');
  const releaseDir = path.resolve(argument('release-dir', path.join(projectRoot, 'release')));
  const unpackedDir = path.join(releaseDir, 'win-unpacked');
  const resourcesDir = path.join(unpackedDir, 'resources');
  const portableExe = path.join(releaseDir, `Roomcast-${pkg.version}-Windows.exe`);
  const appAsar = path.join(resourcesDir, 'app.asar');

  const report = {
    step: '5D',
    version: pkg.version,
    releaseDir,
    resourcesDir,
    checks: {},
  };

  await assertDirectory(unpackedDir);
  report.checks.portableExeBytes = await assertFile(portableExe, 10_000_000);
  report.checks.appAsarBytes = await assertFile(appAsar, 100_000);

  const resourceSizes = {};
  for (const [relative, minimumBytes] of REQUIRED_PACKAGED_RESOURCES) {
    const absolute = path.join(resourcesDir, ...relative.split('/'));
    if (relative.endsWith('win-capture')) {
      await assertDirectory(absolute);
      resourceSizes[relative] = 'directory';
    } else {
      resourceSizes[relative] = await assertFile(absolute, minimumBytes);
    }
  }
  report.checks.resources = resourceSizes;

  const packagedObsBundle = path.join(resourcesDir, 'runtime', 'obs-bundle');
  const packagedObsConfig = path.join(packagedObsBundle, 'config');
  const packagedObsConfigStat = await fsp.stat(packagedObsConfig).catch(() => null);
  assert.equal(packagedObsConfigStat, null, `正式发布包不应包含 OBS 用户配置目录：${packagedObsConfig}`);
  report.checks.packagedObsConfigPresent = false;

  const packagedPdbFiles = await collectFilesByExtension(packagedObsBundle, '.pdb');
  assert.deepEqual(
    packagedPdbFiles,
    [],
    `正式发布包不应包含 OBS PDB 调试符号：${packagedPdbFiles.join(', ')}`,
  );
  report.checks.packagedObsPdbFiles = 0;

  const plainMarkerPath = path.join(resourcesDir, 'runtime', 'obs-bundle', 'roomcast-embedded-obs.json');
  const dotMarkerPath = path.join(resourcesDir, 'runtime', 'obs-bundle', '.roomcast-embedded-obs.json');
  const marker = JSON.parse(await fsp.readFile(plainMarkerPath, 'utf8'));
  const dotMarker = JSON.parse(await fsp.readFile(dotMarkerPath, 'utf8'));
  assert.deepEqual(dotMarker, marker, '打包内 OBS 双 marker 内容不一致');
  assert.equal(marker.version, EXPECTED_OBS_VERSION, '打包内 OBS marker 版本错误');
  assert.equal(marker.platform, 'windows-x64', '打包内 OBS marker 平台错误');
  assert.equal(marker.binarySha256, EXPECTED_BINARY_ARCHIVE_SHA256, '打包内 OBS marker 官方二进制哈希错误');
  report.checks.marker = {
    version: marker.version,
    platform: marker.platform,
    source: marker.source || null,
    binarySha256: marker.binarySha256,
    plainAndDotMarkersMatch: true,
  };

  const sourceArchive = path.join(resourcesDir, 'runtime', 'obs-source', SOURCE_NAME);
  const sourceHash = await sha256(sourceArchive);
  assert.equal(sourceHash, EXPECTED_SOURCE_SHA256, '随包 OBS 对应源码归档 SHA256 不匹配');
  const notice = await fsp.readFile(path.join(resourcesDir, 'runtime', 'obs-source', 'OBS-SOURCE-NOTICE.txt'), 'utf8');
  assert.ok(notice.includes(EXPECTED_SOURCE_SHA256), 'OBS SOURCE NOTICE 缺少源码 SHA256');
  assert.ok(notice.includes(EXPECTED_OBS_VERSION), 'OBS SOURCE NOTICE 缺少 OBS 版本');
  report.checks.sourceSha256 = sourceHash;

  const packagedObsExe = path.join(resourcesDir, 'runtime', 'obs-bundle', 'bin', '64bit', 'obs64.exe');
  const fileVersionRaw = await powershellProductVersion(packagedObsExe);
  const fileVersion = normalizeVersion(fileVersionRaw);
  assert.equal(fileVersion, EXPECTED_OBS_VERSION, `打包内 obs64.exe 版本错误：${fileVersionRaw}`);
  report.checks.obsFileVersion = fileVersionRaw;

  // Deliberately use spaces + Chinese characters and an isolated data root. This
  // exercises the packaged copy-and-launch path without Program Files/project OBS.
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'Roomcast Step5D 中文 路径-'));
  const savedBundle = process.env.ROOMCAST_OBS_BUNDLE;
  const savedRuntime = process.env.ROOMCAST_OBS_RUNTIME;
  delete process.env.ROOMCAST_OBS_BUNDLE;
  delete process.env.ROOMCAST_OBS_RUNTIME;

  let engine = null;
  try {
    const port = await freeTcpPort();
    engine = new ObsFixedFpsEngine({
      runtimeRoot: resourcesDir,
      dataRoot: tempRoot,
      port,
    });

    const prepared = await engine.prepare();
    assert.equal(prepared.source, 'embedded');
    assert.equal(prepared.version, EXPECTED_OBS_VERSION);
    assert.ok(inside(prepared.bundleDir, resourcesDir), `OBS bundle 没有来自打包 resources：${prepared.bundleDir}`);
    assert.ok(inside(prepared.obsDir, tempRoot), `OBS 工作目录没有隔离到临时 dataRoot：${prepared.obsDir}`);
    assert.ok(!inside(prepared.obsDir, projectRoot), 'OBS 工作目录错误地落在项目目录内');

    const modules = engine.virtualCameraModules();
    await assertFile(modules.module32, 10_000);
    await assertFile(modules.module64, 10_000);

    const launched = await engine.launch({ width: 1280, height: 720, fps: 60 });
    assert.equal(normalizeVersion(launched.version), EXPECTED_OBS_VERSION);
    const status = await engine.status();
    assert.equal(status.video.width, 1280);
    assert.equal(status.video.height, 720);
    assert.equal(status.video.fpsNumerator, 60);
    assert.equal(status.video.fpsDenominator, 1);

    const sources = await engine.sources();
    assert.ok(Array.isArray(sources.monitors) && sources.monitors.length > 0, '打包内 OBS 没有枚举到显示器');

    report.checks.packagedRuntime = {
      bundleDir: prepared.bundleDir,
      isolatedObsDir: prepared.obsDir,
      obsVersion: launched.version,
      video: status.video,
      monitorCount: sources.monitors.length,
      windowCount: sources.windows.length,
      virtualCameraModulesPresent: true,
    };
  } finally {
    if (engine) await engine.close().catch(() => {});
    if (savedBundle === undefined) delete process.env.ROOMCAST_OBS_BUNDLE;
    else process.env.ROOMCAST_OBS_BUNDLE = savedBundle;
    if (savedRuntime === undefined) delete process.env.ROOMCAST_OBS_RUNTIME;
    else process.env.ROOMCAST_OBS_RUNTIME = savedRuntime;
    await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }

  report.checks.portableRuntimePreflight = await portableRuntimePreflight(portableExe, projectRoot);

  report.ok = true;
  console.log('[Step5D packaged OBS] PASS');
  console.log(JSON.stringify(report, null, 2));
}

main().catch(error => {
  console.error(`[Step5D packaged OBS] FAIL: ${error?.stack || error}`);
  process.exitCode = 1;
});
