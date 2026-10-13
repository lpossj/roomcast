import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { patchEasyTier } from './easytier-source-patch.mjs';

async function buildRoot(workspace) {
  if (/^[\x20-\x7e]+$/.test(workspace)) return workspace;
  const alias = path.join(os.tmpdir(), `Roomcast-EasyTier-${createHash('sha256').update(workspace).digest('hex').slice(0, 12)}`);
  if (!/^[\x20-\x7e]+$/.test(alias)) throw new Error('EasyTier 构建需要不含非 ASCII 字符的 TEMP 目录。');
  const existing = await fs.lstat(alias).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!existing) await fs.symlink(workspace, alias, 'junction');
  else if (!existing.isSymbolicLink()) throw new Error('EasyTier 构建目录映射已被其他文件占用。');
  const [resolved, intended] = await Promise.all([fs.realpath(alias), fs.realpath(workspace)]);
  if (resolved.toLowerCase() !== intended.toLowerCase()) throw new Error('EasyTier 构建目录映射目标不符。');
  return alias;
}
const root = await buildRoot(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const cache = path.join(root, 'runtime/easytier-downloads/source');
const output = path.join(root, 'runtime/easytier');
const commit = '8428a89d2dabc94c97d370ec607c6ca142473626';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const psString = value => `'${value.replace(/'/g, "''")}'`;
const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const trustPath = path.join(root, 'electron/campus-runtime-manifest.json');
const recipe = digest(Buffer.concat(await Promise.all([
  fs.readFile(fileURLToPath(import.meta.url)),
  fs.readFile(path.join(root, 'scripts/easytier-source-patch.mjs')),
  fs.readFile(path.join(root, 'electron/campus-supervisor.ps1')),
])));
function run(command, args, cwd = root, env = process.env, capture = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', windowsHide: true });
    let output = '';
    if (capture) child.stdout.on('data', bytes => { output += bytes.toString(); });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(output) : reject(new Error(`${path.basename(command)} failed (${code})`)));
  });
}
async function download(name, url, expected) {
  const target = path.join(cache, name);
  const existing = await fs.readFile(target).catch(() => null);
  if (existing && digest(existing) === expected) return target;
  if (existing) throw new Error(`Cached dependency hash mismatch: ${name}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Dependency download failed: ${name} (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (digest(bytes) !== expected) throw new Error(`Dependency hash mismatch: ${name}`);
  await fs.writeFile(target, bytes, { flag: 'wx' });
  return target;
}
async function unzip(archive, destination) {
  const command = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; Expand-Archive -LiteralPath ${psString(archive)} -DestinationPath ${psString(destination)} -Force`;
  await run(ps, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')]);
}
async function prepare() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('EasyTier preparation requires Windows x64.');
  await fs.mkdir(cache, { recursive: true });
  await fs.mkdir(output, { recursive: true });
  const old = JSON.parse(await fs.readFile(trustPath, 'utf8').catch(() => 'null'));
  if (old?.recipe === recipe) {
    let reusable = true;
    for (const [name, hash] of Object.entries(old.files)) {
      const bytes = await fs.readFile(path.join(output, name)).catch(() => null);
      if (!bytes || digest(bytes) !== hash) reusable = false;
    }
    if (reusable) return;
  }
  // No downloaded executable is silently used as a fallback. A missing toolchain
  // is a build prerequisite failure, never an excuse to ship the Npcap binary.
  const localTools = path.join(root, 'runtime/build-tools');
  const localCargo = path.join(localTools, 'cargo/bin/cargo.exe');
  const useLocal = !process.env.CARGO && await fs.access(localCargo).then(() => true, () => false);
  const cargo = process.env.CARGO || (useLocal ? localCargo : 'cargo.exe');
  const sourceZip = await download('easytier-source.zip', `https://codeload.github.com/EasyTier/EasyTier/zip/${commit}`, 'f1dd7cdad133c521715fa836f8af1b1851f0cdab9360cb897f2e346c36068075');
  const pnetCrate = await download('pnet_datalink-0.35.0.crate', 'https://static.crates.io/crates/pnet_datalink/pnet_datalink-0.35.0.crate', 'e79e70ec0be163102a332e1d2d5586d362ad76b01cec86f830241f2b6452a7b7');
  const driverZip = await download('wintun-0.14.1.zip', 'https://www.wintun.net/builds/wintun-0.14.1.zip', '07c256185d6ee3652e09fa55c0b673e2624b565e02c4b9091c79ca7d2f24ef51');
  const thunksZip = await download('YY-Thunks-Objs-1.1.7.zip', 'https://github.com/Chuyu-Team/YY-Thunks/releases/download/v1.1.7/YY-Thunks-Objs.zip', 'c3066f3f074ebc2a89b2def5f427bdea238dee17349d2bab579af519781691ab');
  const thunksSource = await download('YY-Thunks-Source-1.1.7.zip', 'https://codeload.github.com/Chuyu-Team/YY-Thunks/zip/refs/tags/v1.1.7', '9ca8f401641a5ee371c97f359301565bc72539584f98a4ce60cbdffe4d30040e');
  const thunksDirectory = path.join(localTools, 'YY-Thunks-1.1.7');
  if (!process.env.YY_THUNKS) await unzip(thunksZip, thunksDirectory);
  const vcArchive = await download('VC-LTL-Binary-5.2.2.7z', 'https://github.com/Chuyu-Team/VC-LTL5/releases/download/v5.2.2/VC-LTL-Binary.7z', '04aa46a7d2af655bcf42c4937504525eb7e66a75910ed42fd25a1cdcec587df0');
  const vcSource = await download('VC-LTL-Source-5.2.2.zip', 'https://codeload.github.com/Chuyu-Team/VC-LTL5/zip/refs/tags/v5.2.2', '54977ee0fdfda7a71200f47bfcfe2ac16dc231a93fefcbeb6b20effc6e66f787');
  const vcDirectory = path.join(localTools, 'VC-LTL-5.2.2');
  if (!process.env.VC_LTL && !await fs.access(path.join(vcDirectory, 'TargetPlatform/6.0.6000.0/lib/x64')).then(() => true, () => false)) {
    await run('7z.exe', ['x', '-y', '-bso0', vcArchive, `-o${vcDirectory}`]);
  }
  const patchId = digest(await fs.readFile(path.join(root, 'scripts/easytier-source-patch.mjs'))).slice(0, 12);
  const work = path.join(cache, `build-${commit.slice(0, 8)}-${patchId}`);
  await fs.mkdir(work, { recursive: true });
  const source = path.join(work, `EasyTier-${commit}`);
  const patched = path.join(work, 'patched');
  if (!await fs.access(patched).then(() => true, () => false)) {
    await unzip(sourceZip, work);
    await run('tar.exe', ['-xf', pnetCrate, '-C', work]);
    await fs.cp(path.join(work, 'pnet_datalink-0.35.0'), path.join(source, 'roomcast-pnet'), { recursive: true });
    await patchEasyTier(source, path.join(source, 'roomcast-pnet'));
    await fs.writeFile(patched, patchId);
  }
  const target = path.join(cache, 'cargo-target');
  const sourceConfig = path.join(source, '.cargo/config.toml');
  const vendorBackup = path.join(source, '.cargo/roomcast-vendor.toml');
  // Offline source delivery uses vendor; the build cache uses Cargo's shorter
  // registry paths so MSVC includes do not exceed its Windows path limit.
  await fs.rename(sourceConfig, vendorBackup).catch(error => { if (error.code !== 'ENOENT') throw error; });
  let protocEnv = {};
  if (!process.env.PROTOC) {
    const protocZip = await download('protoc-26.0-rc-1-win64.zip', 'https://github.com/protocolbuffers/protobuf/releases/download/v26.0-rc1/protoc-26.0-rc-1-win64.zip', '61d80fdd57b9ea1072625085cbad085dd00310652ea494b8e38c6b76c9ee0516');
    const protobuf = path.join(target, 'release/protobuf');
    await unzip(protocZip, protobuf);
    protocEnv = { PROTOC: path.join(protobuf, 'bin/protoc.exe'), PROTOC_INCLUDE: path.join(protobuf, 'include') };
  }
  const env = { ...process.env, ...protocEnv, YY_THUNKS: process.env.YY_THUNKS || thunksDirectory, VC_LTL: process.env.VC_LTL || vcDirectory, CARGO_TARGET_DIR: target, CARGO_NET_GIT_FETCH_WITH_CLI: 'true', ...(useLocal ? {
    CARGO_HOME: path.join(localTools, 'cargo'), RUSTUP_HOME: path.join(localTools, 'rustup'), RUSTUP_TOOLCHAIN: '1.95.0',
  } : {}) };
  // Cargo retains the upstream lockfile; only the local pnet override updates it.
  await run(cargo, ['build', '--release', '-p', 'easytier', '--bin', 'easytier-core', '--no-default-features', '--features', 'tun,wireguard'], source, env);
  await fs.copyFile(path.join(target, 'release/easytier-core.exe'), path.join(output, 'easytier-core.exe'));
  await unzip(driverZip, path.join(work, 'driver'));
  await fs.copyFile(path.join(work, 'driver/wintun/bin/amd64/wintun.dll'), path.join(output, 'wintun.dll'));
  await fs.copyFile(path.join(work, 'driver/wintun/LICENSE.txt'), path.join(output, 'WINTUN-LICENSE.txt'));
  await fs.copyFile(path.join(source, 'LICENSE'), path.join(output, 'EASYTIER-LICENSE.txt'));
  // Windows PowerShell 5.1 needs a BOM to read the shipped UTF-8 script reliably.
  await fs.writeFile(path.join(output, 'campus-supervisor.ps1'), '\ufeff' + (await fs.readFile(path.join(root, 'electron/campus-supervisor.ps1'), 'utf8')).replace(/^\ufeff/, ''));
  // Supply corresponding dependency sources, patched code, lockfile and recipe.
  const vendorConfig = await run(cargo, ['vendor', '--locked', '--versioned-dirs', 'vendor'], source, env, true);
  await fs.mkdir(path.join(source, '.cargo'), { recursive: true });
  await fs.writeFile(sourceConfig, vendorConfig);
  await fs.copyFile(path.join(root, 'scripts/easytier-source-patch.mjs'), path.join(source, 'roomcast-source-patch.mjs'));
  await unzip(thunksSource, path.join(source, 'roomcast-compat-sources'));
  await unzip(vcSource, path.join(source, 'roomcast-compat-sources'));
  await fs.copyFile(path.join(source, 'roomcast-compat-sources/YY-Thunks-1.1.7/LICENSE'), path.join(output, 'YY-THUNKS-LICENSE.txt'));
  await fs.copyFile(path.join(source, 'roomcast-compat-sources/VC-LTL5-5.2.2/LICENSE'), path.join(output, 'VC-LTL-LICENSE.txt'));
  await fs.writeFile(path.join(source, 'ROOMCAST-BUILD.txt'), `Roomcast EasyTier 2.6.4+roomcast.1, commit ${commit}\nModified: ${new Date().toISOString()}\nRPC listener removed; raw packet capture disabled; DHCP limited to configured subnet; upstream broad firewall rules disabled.\nWindows x64, Rust 1.95.0, MSVC Build Tools. Set PROTOC and PROTOC_INCLUDE to protobuf 26.0-rc1 bin/protoc.exe and include.\nSet YY_THUNKS to the extracted YY-Thunks 1.1.7 object directory and VC_LTL to the extracted VC-LTL 5.2.2 directory. Both upstream corresponding sources and licenses are supplied in roomcast-compat-sources.\nBuild: cargo build --release -p easytier --bin easytier-core --no-default-features --features tun,wireguard\nThe supplied source already contains the Roomcast patches. Do not reapply them.\nUse an ASCII build path because protobuf 26.0-rc1 cannot resolve non-ASCII Windows include paths.\nNo Npcap Packet.dll is included. Wintun's signed DLL uses its accompanying redistribution license.\n`);
  // Upstream's source tree itself contains the same non-redistributed Npcap DLL.
  // Exclude it and its unused import library from corresponding-source delivery.
  try {
    await run('tar.exe', ['-a', '-cf', path.join(output, 'sources.zip'), '--exclude=Packet.dll', '--exclude=Packet.lib', '-C', work, `EasyTier-${commit}`]);
  } finally {
    await fs.rename(sourceConfig, vendorBackup);
  }
  const files = {};
  for (const name of ['easytier-core.exe', 'wintun.dll', 'campus-supervisor.ps1', 'sources.zip', 'WINTUN-LICENSE.txt', 'EASYTIER-LICENSE.txt', 'YY-THUNKS-LICENSE.txt', 'VC-LTL-LICENSE.txt']) files[name] = digest(await fs.readFile(path.join(output, name)));
  await fs.writeFile(trustPath, JSON.stringify({ version: '2.6.4-roomcast.1', commit, recipe, files }, null, 2));
}
prepare().catch(error => { console.error(`EasyTier 准备失败：${error.message}\n需要 Rust >=1.95 和 Windows C++ 编译环境；没有使用第三方核心替代。`); process.exitCode = 1; });
