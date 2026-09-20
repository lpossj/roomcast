import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, copyFile, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = '32.1.2';
const BINARY_NAME = `OBS-Studio-${VERSION}-Windows-x64.zip`;
const BINARY_URL = `https://github.com/obsproject/obs-studio/releases/download/${VERSION}/${BINARY_NAME}`;
const BINARY_SHA256 = '8d97e4563bd8d22d03e63042aa7dccede1d555c9bd35ce8a9e5019b0d0201bf6';
const SOURCE_NAME = `OBS-Studio-${VERSION}-Sources.tar.gz`;
const SOURCE_URL = `https://github.com/obsproject/obs-studio/releases/download/${VERSION}/${SOURCE_NAME}`;
const SOURCE_SHA256 = 'c6532380c68a75327fe8b551461adeca8f184dcbe4015096251a6de76362a554';

const downloadsDir = path.join(rootDir, 'runtime', 'downloads', 'obs');
const bundleDir = path.join(rootDir, 'runtime', 'obs-bundle');
const sourceDir = path.join(rootDir, 'runtime', 'obs-source');
const binaryZip = path.join(downloadsDir, BINARY_NAME);
const sourceArchive = path.join(sourceDir, SOURCE_NAME);
const MARKER_NAMES = Object.freeze(['roomcast-embedded-obs.json', '.roomcast-embedded-obs.json']);
const BUNDLE_ROOT_ALLOWLIST = new Set(['bin', 'data', 'obs-plugins', 'portable_mode.txt', ...MARKER_NAMES]);
const legacyRuntimeDir = path.join(rootDir, 'runtime', 'obs');
const releaseMode = process.argv.includes('--release');

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}


async function readBundleMarker(dir) {
  for (const name of MARKER_NAMES) {
    const file = path.join(dir, name);
    if (!(await exists(file))) continue;
    try {
      return { marker: JSON.parse(await readFile(file, 'utf8')), file };
    } catch {}
  }
  return { marker: null, file: '' };
}

async function writeBundleMarkers(dir, marker) {
  const encoded = JSON.stringify(marker, null, 2);
  for (const name of MARKER_NAMES) {
    await writeFile(path.join(dir, name), encoded);
  }
}

async function sanitizeBundleRoot(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (BUNDLE_ROOT_ALLOWLIST.has(entry.name)) continue;
    await rm(path.join(dir, entry.name), { recursive: true, force: true });
  }
}


async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function describeError(error) {
  if (!error) return 'unknown error';
  const parts = [];
  if (error.code) parts.push(String(error.code));
  if (error.message) parts.push(String(error.message));
  if (error.cause?.code) parts.push(String(error.cause.code));
  if (error.cause?.message) parts.push(String(error.cause.message));
  return [...new Set(parts)].join(': ') || String(error);
}

async function run(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: options.stdio ?? 'inherit',
      windowsHide: true,
      env: options.env ?? process.env,
    });
    child.once('error', reject);
    child.once('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`${command} 退出码 ${code}`));
    });
  });
}

async function downloadWithNodeFetch(url, temporary) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'Roomcast OBS Runtime Builder' },
  });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
  await pipeline(response.body, createWriteStream(temporary));
}

async function downloadWithNodeSystemCA(url, temporary) {
  const helper = String.raw`
const fs = require('node:fs');
const { pipeline } = require('node:stream/promises');
(async () => {
  const response = await fetch(process.env.ROOMCAST_DOWNLOAD_URL, {
    redirect: 'follow',
    headers: { 'user-agent': 'Roomcast OBS Runtime Builder' },
  });
  if (!response.ok || !response.body) throw new Error('HTTP ' + response.status);
  await pipeline(response.body, fs.createWriteStream(process.env.ROOMCAST_DOWNLOAD_DEST));
})().catch(error => { console.error(error); process.exit(1); });`;

  const major = Number.parseInt(process.versions.node.split('.')[0], 10);
  const args = [];
  // Node 24+ can also consume HTTP(S)_PROXY/NO_PROXY via --use-env-proxy.
  if (major >= 24) args.push('--use-env-proxy');
  args.push('-e', helper);

  await run(process.execPath, args, {
    env: {
      ...process.env,
      NODE_USE_SYSTEM_CA: '1',
      ROOMCAST_DOWNLOAD_URL: url,
      ROOMCAST_DOWNLOAD_DEST: temporary,
    },
  });
}

async function downloadWithPowerShell(url, temporary) {
  const command = [
    "$ErrorActionPreference = 'Stop'",
    '[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12',
    "$params = @{ Uri = $env:ROOMCAST_DOWNLOAD_URL; OutFile = $env:ROOMCAST_DOWNLOAD_DEST; MaximumRedirection = 10; UseBasicParsing = $true; Headers = @{ 'User-Agent' = 'Roomcast OBS Runtime Builder' } }",
    'Invoke-WebRequest @params',
  ].join('; ');

  await run('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-Command', command,
  ], {
    env: {
      ...process.env,
      ROOMCAST_DOWNLOAD_URL: url,
      ROOMCAST_DOWNLOAD_DEST: temporary,
    },
  });
}

async function downloadWithCurl(url, temporary) {
  await run('curl.exe', [
    '--fail',
    '--location',
    '--retry', '3',
    '--retry-delay', '2',
    '--connect-timeout', '30',
    '--output', temporary,
    url,
  ]);
}

async function copyLocalArchive(source, temporary) {
  const resolved = path.resolve(source);
  if (!(await exists(resolved))) throw new Error(`本地归档不存在：${resolved}`);
  await copyFile(resolved, temporary);
}

async function tryDownloadStrategies(url, temporary, localOverride = '') {
  const failures = [];
  const strategies = [];

  if (localOverride) {
    strategies.push(['本地归档', () => copyLocalArchive(localOverride, temporary)]);
  } else if (process.platform === 'win32') {
    // Prefer Windows-native networking first. It uses the Windows trust store and
    // is the most compatible option for machines behind enterprise/campus proxies.
    strategies.push(
      ['PowerShell/Windows 证书库', () => downloadWithPowerShell(url, temporary)],
      ['Node + 系统 CA', () => downloadWithNodeSystemCA(url, temporary)],
      ['curl.exe/Schannel', () => downloadWithCurl(url, temporary)],
      ['Node fetch', () => downloadWithNodeFetch(url, temporary)],
    );
  } else {
    // Self-test/non-Windows development path only; production preparation is Windows x64.
    strategies.push(['Node fetch', () => downloadWithNodeFetch(url, temporary)]);
  }

  for (const [name, fn] of strategies) {
    await rm(temporary, { force: true });
    try {
      console.log(`[OBS bundle] 下载方式：${name}`);
      await fn();
      return name;
    } catch (error) {
      failures.push(`${name}: ${describeError(error)}`);
      console.warn(`[OBS bundle] ${name} 失败，尝试下一种方式：${describeError(error)}`);
    }
  }

  throw new Error([
    `无法下载：${url}`,
    ...failures.map(line => `  - ${line}`),
    '',
    '没有关闭 TLS 校验，也不会使用 NODE_TLS_REJECT_UNAUTHORIZED=0。',
    '如果网络策略阻止自动下载，可手动从 OBS 官方 Release 下载后设置：',
    '  ROOMCAST_OBS_BINARY_ARCHIVE=<Windows x64 zip 路径>',
    '  ROOMCAST_OBS_SOURCE_ARCHIVE=<Sources.tar.gz 路径>',
  ].join('\n'));
}

async function ensureDownloaded(url, file, expectedHash, localOverride = '') {
  await mkdir(path.dirname(file), { recursive: true });

  if (await exists(file)) {
    const current = await sha256(file);
    if (current === expectedHash) return { downloaded: false, sha256: current, method: 'cache' };
    console.warn(`[OBS bundle] 已缓存文件 SHA256 不匹配，删除后重新获取：${path.basename(file)}`);
    await rm(file, { force: true });
  }

  const temporary = `${file}.part`;
  console.log(`[OBS bundle] 获取：${url}`);
  const method = await tryDownloadStrategies(url, temporary, localOverride);

  const actual = await sha256(temporary);
  if (actual !== expectedHash) {
    await rm(temporary, { force: true });
    throw new Error([
      `OBS 文件 SHA256 不匹配：${path.basename(file)}`,
      `期望：${expectedHash}`,
      `实际：${actual}`,
      `下载方式：${method}`,
      '文件已删除；不会继续解压或打包。',
    ].join('\n'));
  }

  await rm(file, { force: true });
  await rename(temporary, file);
  return { downloaded: true, sha256: actual, method };
}

async function expandZip(zipFile, destination) {
  const command = 'Expand-Archive -LiteralPath $env:ROOMCAST_OBS_ZIP -DestinationPath $env:ROOMCAST_OBS_DEST -Force';
  await run('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-Command', command,
  ], {
    env: {
      ...process.env,
      ROOMCAST_OBS_ZIP: zipFile,
      ROOMCAST_OBS_DEST: destination,
    },
  });
}

async function verifyBundle(dir) {
  const required = [
    'bin/64bit/obs64.exe',
    'data/obs-plugins/obs-websocket/locale/en-US.ini',
    'obs-plugins/64bit/obs-websocket.dll',
    'data/obs-plugins/win-capture',
    'data/obs-plugins/win-dshow/virtualcam-install.bat',
    'data/obs-plugins/win-dshow/obs-virtualcam-module32.dll',
    'data/obs-plugins/win-dshow/obs-virtualcam-module64.dll',
    'obs-plugins/64bit/win-dshow.dll',
    'data/obs-studio/license/gplv2.txt',
  ];
  for (const relative of required) {
    if (!(await exists(path.join(dir, relative)))) throw new Error(`官方 OBS Runtime 不完整：缺少 ${relative}`);
  }
}


function normalizeVersion(value) {
  const match = String(value || '').match(/\b(\d+\.\d+\.\d+)\b/);
  return match?.[1] || '';
}

async function readCandidateVersion(dir) {
  for (const markerName of ['.roomcast-embedded-obs.json', '.roomcast-prepared.json']) {
    const markerFile = path.join(dir, markerName);
    if (await exists(markerFile)) {
      try {
        const marker = JSON.parse(await readFile(markerFile, 'utf8'));
        const version = normalizeVersion(marker?.version || marker?.obsVersion);
        if (version) return { version, method: markerName };
      } catch {}
    }
  }

  const exe = path.join(dir, 'bin', '64bit', 'obs64.exe');
  if (!(await exists(exe)) || process.platform !== 'win32') return { version: '', method: 'unknown' };

  const ps = [
    "$ErrorActionPreference = 'Stop'",
    "$v = (Get-Item -LiteralPath $env:ROOMCAST_OBS_EXE).VersionInfo",
    "[Console]::Out.WriteLine(($v.ProductVersion + '|' + $v.FileVersion))",
  ].join('; ');
  let stdout = '';
  await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps,
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ROOMCAST_OBS_EXE: exe },
    });
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`读取 OBS 文件版本失败：${stderr.trim() || code}`)));
  });
  return { version: normalizeVersion(stdout), method: 'Windows FileVersion' };
}

async function findLocalExactObs() {
  const candidates = [];
  const explicit = String(process.env.ROOMCAST_OBS_LOCAL_DIR || '').trim();
  if (explicit) candidates.push(path.resolve(explicit));
  candidates.push(legacyRuntimeDir);
  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    candidates.push(path.join(programFiles, 'obs-studio'));
  }

  const seen = new Set();
  for (const dir of candidates) {
    const key = path.resolve(dir).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const exe = path.join(dir, 'bin', '64bit', 'obs64.exe');
    if (!(await exists(exe))) continue;
    try {
      await verifyBundle(dir);
      const detected = await readCandidateVersion(dir);
      console.log(`[OBS bundle] 本地候选：${dir} -> ${detected.version || 'unknown'} (${detected.method})`);
      if (detected.version === VERSION) return dir;
    } catch (error) {
      console.warn(`[OBS bundle] 忽略不可用的本地 OBS：${dir}：${describeError(error)}`);
    }
  }
  return '';
}

async function prepareBundleFromLocal(dir, destination = bundleDir) {
  const temporary = `${destination}.tmp-${process.pid}`;
  await rm(temporary, { recursive: true, force: true });
  await cp(dir, temporary, { recursive: true, force: true });
  await verifyBundle(temporary);
  const detected = await readCandidateVersion(temporary);
  if (detected.version !== VERSION) {
    await rm(temporary, { recursive: true, force: true });
    throw new Error(`本地 OBS 版本不一致：期望 ${VERSION}，实际 ${detected.version || 'unknown'}`);
  }
  await sanitizeBundleRoot(temporary);
  await writeFile(path.join(temporary, 'portable_mode.txt'), '');
  await writeBundleMarkers(temporary, {
    schema: 1,
    version: VERSION,
    platform: 'windows-x64',
    source: 'validated-local-exact-version',
    binarySha256: BINARY_SHA256,
    preparedAt: new Date().toISOString(),
  });
  await rm(destination, { recursive: true, force: true });
  await rename(temporary, destination);
  console.log(`[OBS bundle] 已从本机精确版本 OBS ${VERSION} 准备内置 Runtime：${destination}`);
}

async function currentBundleValid() {
  try {
    const { marker } = await readBundleMarker(bundleDir);
    if (marker?.version !== VERSION || marker?.binarySha256 !== BINARY_SHA256) return false;
    await verifyBundle(bundleDir);
    return true;
  } catch {
    return false;
  }
}

async function selfTest() {
  if (normalizeVersion('32.1.2') !== '32.1.2' || normalizeVersion('32.1.2.0') !== '32.1.2' || normalizeVersion('OBS Studio 32.1.2 (64 bit)') !== '32.1.2') {
    throw new Error('OBS 版本规范化自检失败');
  }
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'roomcast-obs-prepare-selftest-'));
  const payload = Buffer.from('roomcast-obs-download-selftest\n', 'utf8');
  const expected = createHash('sha256').update(payload).digest('hex');

  const server = createServer((req, res) => {
    if (req.url === '/artifact') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': payload.length });
      res.end(payload);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const address = server.address();
    const url = `http://127.0.0.1:${address.port}/artifact`;
    const target = path.join(temporaryRoot, 'artifact.bin');

    const first = await ensureDownloaded(url, target, expected);
    if (first.sha256 !== expected || !(await exists(target))) throw new Error('首次下载/哈希验证失败');

    await writeFile(target, 'corrupt');
    const second = await ensureDownloaded(url, target, expected);
    if (second.sha256 !== expected) throw new Error('损坏缓存自动恢复失败');

    const fakeObs = path.join(temporaryRoot, 'fake-obs');
    for (const relative of [
      'bin/64bit/obs64.exe',
      'data/obs-plugins/obs-websocket/locale/en-US.ini',
      'obs-plugins/64bit/obs-websocket.dll',
      'data/obs-plugins/win-capture/.keep',
      'data/obs-plugins/win-dshow/virtualcam-install.bat',
      'data/obs-plugins/win-dshow/obs-virtualcam-module32.dll',
      'data/obs-plugins/win-dshow/obs-virtualcam-module64.dll',
      'obs-plugins/64bit/win-dshow.dll',
      'data/obs-studio/license/gplv2.txt',
    ]) {
      const target = path.join(fakeObs, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, 'selftest');
    }
    await writeFile(path.join(fakeObs, '.roomcast-embedded-obs.json'), JSON.stringify({ version: VERSION, binarySha256: BINARY_SHA256 }));
    await mkdir(path.join(fakeObs, 'config', 'obs-studio', 'logs'), { recursive: true });
    await writeFile(path.join(fakeObs, 'config', 'obs-studio', 'logs', 'private.log'), 'must-not-ship');
    await writeFile(path.join(fakeObs, 'unexpected-local-file.txt'), 'must-not-ship');
    const fakeBundle = path.join(temporaryRoot, 'fake-bundle');
    await prepareBundleFromLocal(fakeObs, fakeBundle);
    await verifyBundle(fakeBundle);
    if (await exists(path.join(fakeBundle, 'config'))) throw new Error('OBS bundle 清理失败：config 被保留');
    if (await exists(path.join(fakeBundle, 'unexpected-local-file.txt'))) throw new Error('OBS bundle 清理失败：本机额外文件被保留');
    const fakeMarker = JSON.parse(await readFile(path.join(fakeBundle, 'roomcast-embedded-obs.json'), 'utf8'));
    const fakeDotMarker = JSON.parse(await readFile(path.join(fakeBundle, '.roomcast-embedded-obs.json'), 'utf8'));
    if (
      fakeMarker.version !== VERSION
      || fakeMarker.source !== 'validated-local-exact-version'
      || JSON.stringify(fakeMarker) !== JSON.stringify(fakeDotMarker)
    ) {
      throw new Error('本地精确版本 OBS 双 marker 自检失败');
    }

    const local = path.join(temporaryRoot, 'manual.bin');
    const copied = path.join(temporaryRoot, 'copied.bin');
    await writeFile(local, payload);
    const third = await ensureDownloaded('https://invalid.example/artifact', copied, expected, local);
    if (third.method !== '本地归档' || third.sha256 !== expected) throw new Error('本地归档回退失败');

    console.log('[OBS bundle self-test] PASS：下载、缓存恢复、本地归档、精确版本 Runtime 复制、SHA256 校验均通过。');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv.includes('--self-test')) {
  await selfTest();
  process.exit(0);
}

if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('Roomcast 内置 OBS Runtime 当前只为 Windows x64 构建。');
}

await mkdir(downloadsDir, { recursive: true });
await mkdir(sourceDir, { recursive: true });

const binaryOverride = String(process.env.ROOMCAST_OBS_BINARY_ARCHIVE || '').trim();
const sourceOverride = String(process.env.ROOMCAST_OBS_SOURCE_ARCHIVE || '').trim();

if (await currentBundleValid()) {
  const { marker } = await readBundleMarker(bundleDir);
  await sanitizeBundleRoot(bundleDir);
  await writeBundleMarkers(bundleDir, marker);
  console.log(`[OBS bundle] 已存在并验证通过：OBS ${VERSION} x64（已清理非运行时根目录并同步双 marker）`);
} else {
  const localExact = await findLocalExactObs();
  if (localExact) {
    await prepareBundleFromLocal(localExact);
  } else {
    const binary = await ensureDownloaded(BINARY_URL, binaryZip, BINARY_SHA256, binaryOverride);
    console.log(`[OBS bundle] 官方二进制 SHA256：${binary.sha256} (${binary.method})`);

    const temporary = `${bundleDir}.tmp-${process.pid}`;
    await rm(temporary, { recursive: true, force: true });
    await mkdir(temporary, { recursive: true });
    await expandZip(binaryZip, temporary);
    await verifyBundle(temporary);
    await sanitizeBundleRoot(temporary);
    await writeFile(path.join(temporary, 'portable_mode.txt'), '');
    await writeBundleMarkers(temporary, {
      schema: 1,
      version: VERSION,
      platform: 'windows-x64',
      source: 'official-release-archive',
      binaryUrl: BINARY_URL,
      binarySha256: BINARY_SHA256,
      preparedAt: new Date().toISOString(),
    });
    await rm(bundleDir, { recursive: true, force: true });
    await rename(temporary, bundleDir);
    console.log(`[OBS bundle] 已准备官方 OBS ${VERSION}：${bundleDir}`);
  }
}

await mkdir(sourceDir, { recursive: true });
await writeFile(path.join(sourceDir, 'OBS-SOURCE-NOTICE.txt'), [
  `Roomcast redistributes an unmodified OBS Studio ${VERSION} Windows x64 runtime as a separate program.`,
  'OBS Studio is licensed under GNU GPL v2 or later.',
  `Binary: ${BINARY_URL}`,
  `Binary SHA256: ${BINARY_SHA256}`,
  `Corresponding upstream source archive: ${SOURCE_URL}`,
  `Source SHA256: ${SOURCE_SHA256}`,
  '',
  'The source archive is shipped next to the Roomcast package resources.',
  'See runtime/obs-bundle/data/obs-studio/license/gplv2.txt for the bundled GPL text.',
  '',
].join('\n'));

if (releaseMode) {
  const source = await ensureDownloaded(SOURCE_URL, sourceArchive, SOURCE_SHA256, sourceOverride);
  console.log(`[OBS bundle] 官方源码归档 SHA256：${source.sha256} (${source.method})`);
} else {
  console.log('[OBS bundle] 开发模式：跳过 OBS 源码归档下载；最终 Release beforePack 会执行 --release。');
}
console.log('[OBS bundle] 完成。最终 Roomcast 发布包不依赖用户安装 OBS。');
