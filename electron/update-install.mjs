// Automatic update install for the Windows desktop build.
//
// This module owns everything that touches the installed program on disk. It is kept
// separate from update-check.mjs (network) so the rule "only a checksum-verified archive
// may be installed" cannot be bypassed by the caller: `prepareUpdateInstall` refuses an
// unverified download outright.
//
// Shape of the install:
//   1. detect what kind of install is running (portable single EXE vs. a program folder)
//   2. verify that target once more on disk
//   3. unpack the verified archive into %TEMP%\roomcast-update-<stamp>\payload
//   4. write a data plan for an independent transaction worker: stage, back up, swap,
//      restart, confirm the loaded version, or roll back
//   5. the caller starts that script detached and quits
//
// Nothing outside the temporary work directory is modified before the app exits, so a
// failure at any point before step 5 leaves the installed program untouched.

import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import fsPromises from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Installation touches physical archives. Electron's fs shim otherwise sees
// payload/resources/app.asar as a virtual directory and hashes its inner files.
const { mkdir, open, readFile, readdir, rm, stat, writeFile } = process.versions.electron
  ? createRequire(import.meta.url)('original-fs').promises : fsPromises;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN_LENGTH = 22;
const MAX_COMMENT_LENGTH = 0xffff;
const CENTRAL_HEADER_LENGTH = 46;
const LOCAL_HEADER_LENGTH = 30;
// A ZIP64 archive would need 64-bit fields this reader does not implement. Roomcast
// releases are ~2 100 entries and well under 4 GB, so refusing is honest and safe.
const ZIP64_MARKER = 0xffffffff;
const ZIP64_COUNT_MARKER = 0xffff;
// Explicit budgets keep a malformed, even checksum-verified, release from
// allocating unlimited memory or filling the disk during extraction.
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_CENTRAL_BYTES = 16 * 1024 * 1024;
const MAX_ENTRY_BYTES = 512 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ENTRIES = 20000;

export function updateWorkRoot(now = Date.now()) {
  return path.join(os.tmpdir(), `roomcast-update-${now}`);
}

// Pure: no filesystem access, so the rules can be unit tested directly.
export function describeInstallTarget({ platform, isPackaged, execPath, portableExecutableFile, appPath }) {
  if (platform !== 'win32') {
    return { supported: false, kind: 'unsupported', reason: '自动更新目前只支持 Windows 版本。' };
  }
  if (!isPackaged) {
    return { supported: false, kind: 'development', reason: '当前是源码/开发运行模式，不会覆盖程序目录；请手动下载安装包。' };
  }
  const portable = String(portableExecutableFile || '').trim();
  if (portable) {
    const targetPath = path.resolve(portable);
    return { supported: true, kind: 'portable-exe', targetPath, appDir: path.dirname(targetPath), launchPath: targetPath, reason: '' };
  }
  const executable = path.resolve(String(execPath || ''));
  if (path.basename(executable).toLowerCase() !== 'roomcast.exe') {
    return { supported: false, kind: 'unknown', reason: `当前可执行文件不是 Roomcast.exe（${path.basename(executable)}），已拒绝自动覆盖。` };
  }
  // Running from a source checkout means execPath is node_modules/electron/dist/electron.exe
  // with its name changed by the dev script; never overwrite a toolchain directory.
  if (/(^|[\\/])node_modules([\\/]|$)/i.test(path.dirname(executable))) {
    return { supported: false, kind: 'development', reason: '程序位于 node_modules 中，已拒绝自动覆盖。' };
  }
  // `process.execPath` is a string captured at startup, so it goes stale when the program
  // folder is renamed or moved while the app runs (observed in real testing: the app is
  // running from the asar below, but execPath still names the old folder). The asar the app
  // actually loaded is authoritative, so derive the folder from it when it looks like
  // `<folder>\resources\app.asar`.
  const loadedAsar = String(appPath || '').trim();
  const fromLoadedAsar = /[\\/]resources[\\/]app\.asar$/i.test(loadedAsar) ? path.resolve(loadedAsar) : '';
  const appDir = fromLoadedAsar ? path.dirname(path.dirname(fromLoadedAsar)) : path.dirname(executable);
  const launchPath = fromLoadedAsar ? path.join(appDir, path.basename(executable)) : executable;
  return {
    supported: true,
    kind: 'directory',
    targetPath: appDir,
    appDir,
    launchPath,
    asarPath: fromLoadedAsar || path.join(appDir, 'resources', 'app.asar'),
    // True when the folder came from the asar the app is running from: the strongest proof
    // that this is the installed program folder.
    fromLoadedAsar: Boolean(fromLoadedAsar),
    reason: '',
  };
}

export async function assertInstallTarget(target) {
  if (!target?.supported) {
    throw Object.assign(new Error(target?.reason || '当前运行方式不支持自动更新。'), { code: 'unsupported' });
  }
  if (target.kind === 'directory') {
    // Refuse anything that is not recognisably a Roomcast program folder.
    const marker = target.asarPath || path.join(target.appDir, 'resources', 'app.asar');
    let info = null;
    let failure = '';
    try {
      info = await stat(marker);
    } catch (error) {
      failure = String(error?.code || error?.message || error);
    }
    // Electron patches fs for asar archives, and the archive itself is reported as a VIRTUAL
    // DIRECTORY (its files live "inside" it), so `isFile()` is false for every real folder
    // install. Only the question "does this entry resolve at all" is meaningful here; a
    // layout where app.asar is a real directory is still a Roomcast program folder.
    const resolved = Boolean(info) && (info.isFile() || info.isDirectory());
    if (!resolved && !(failure && target.fromLoadedAsar)) {
      const entries = await readdir(target.appDir).catch(() => null);
      const detail = entries
        ? `目录内容：${entries.slice(0, 8).join('、')}${entries.length > 8 ? '…' : ''}`
        : '该目录也无法读取';
      const shape = info ? `（该路径既不是文件也不是目录）` : '';
      throw Object.assign(new Error(`程序目录缺少 resources/app.asar，不是 Roomcast 目录版，已取消自动更新。（检查路径：${marker}${failure ? `；读取失败：${failure}` : shape}；${detail}）`), { code: 'target' });
    }
  } else if (target.kind === 'portable-exe') {
    const info = await stat(target.targetPath).catch(() => null);
    if (!info?.isFile()) {
      throw Object.assign(new Error(`找不到正在运行的便携版 EXE（${target.targetPath}），已取消自动更新。`), { code: 'target' });
    }
  }
  return target;
}

// Zip-slip guard: an archive entry may never resolve outside the extraction root.
export function resolveEntryPath(root, name) {
  const normalized = String(name || '').replace(/\\/g, '/');
  if (!normalized.trim()) throw Object.assign(new Error('更新包包含空文件名。'), { code: 'archive' });
  if (normalized.includes('\0')) throw Object.assign(new Error('更新包文件名包含非法字符。'), { code: 'archive' });
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw Object.assign(new Error(`更新包包含绝对路径：${normalized}`), { code: 'archive' });
  }
  // NTFS alternate data streams ("name:stream") stay inside the extraction root but have no
  // business in a program archive.
  if (normalized.includes(':')) throw Object.assign(new Error(`更新包文件名包含非法字符：${normalized}`), { code: 'archive' });
  const parts = normalized.split('/').filter(part => part && part !== '.');
  if (parts.includes('..')) throw Object.assign(new Error(`更新包包含上级目录引用：${normalized}`), { code: 'archive' });
  const base = path.resolve(root);
  const target = path.resolve(base, ...parts);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw Object.assign(new Error(`更新包条目越出目标目录：${normalized}`), { code: 'archive' });
  }
  return target;
}

async function readExactly(handle, length, position) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
}

export async function readZipEntries(handle, fileSize) {
  if (!Number.isSafeInteger(fileSize) || fileSize < EOCD_MIN_LENGTH || fileSize > MAX_ARCHIVE_BYTES) {
    throw Object.assign(new Error('更新包大小超出安全限制。'), { code: 'archive' });
  }
  const tailLength = Math.min(fileSize, EOCD_MIN_LENGTH + MAX_COMMENT_LENGTH);
  const tail = await readExactly(handle, tailLength, fileSize - tailLength);
  let eocd = -1;
  for (let index = tail.length - EOCD_MIN_LENGTH; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) === EOCD_SIGNATURE) { eocd = index; break; }
  }
  if (eocd < 0) throw Object.assign(new Error('更新包不是有效的 ZIP 文件（找不到中央目录）。'), { code: 'archive' });
  const total = tail.readUInt16LE(eocd + 10);
  const centralSize = tail.readUInt32LE(eocd + 12);
  const centralOffset = tail.readUInt32LE(eocd + 16);
  if (total === ZIP64_COUNT_MARKER || centralSize === ZIP64_MARKER || centralOffset === ZIP64_MARKER) {
    throw Object.assign(new Error('更新包使用 ZIP64 格式，当前版本不支持自动解压。'), { code: 'archive' });
  }
  if (total > MAX_ENTRIES || centralSize > MAX_CENTRAL_BYTES) {
    throw Object.assign(new Error('更新包条目数或中央目录大小超出安全限制。'), { code: 'archive' });
  }
  // A corrupt file that happens to contain an end-of-central-directory signature must not
  // be able to make this process allocate an arbitrary buffer.
  if (centralSize > fileSize || centralOffset > fileSize || centralOffset + centralSize > fileSize) {
    throw Object.assign(new Error('更新包中央目录位置越界，文件可能已损坏。'), { code: 'archive' });
  }
  const central = await readExactly(handle, centralSize, centralOffset);
  if (central.length !== centralSize) {
    throw Object.assign(new Error('更新包中央目录不完整，文件可能已损坏。'), { code: 'archive' });
  }
  const entries = [];
  let expandedBytes = 0;
  let cursor = 0;
  while (cursor + CENTRAL_HEADER_LENGTH <= central.length && entries.length < total) {
    if (central.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) break;
    const method = central.readUInt16LE(cursor + 10);
    const flags = central.readUInt16LE(cursor + 8);
    const compressedSize = central.readUInt32LE(cursor + 20);
    const uncompressedSize = central.readUInt32LE(cursor + 24);
    const nameLength = central.readUInt16LE(cursor + 28);
    const extraLength = central.readUInt16LE(cursor + 30);
    const commentLength = central.readUInt16LE(cursor + 32);
    const externalAttributes = central.readUInt32LE(cursor + 38);
    const localOffset = central.readUInt32LE(cursor + 42);
    const nextCursor = cursor + CENTRAL_HEADER_LENGTH + nameLength + extraLength + commentLength;
    expandedBytes += uncompressedSize;
    if (flags & 1 || nextCursor > central.length || compressedSize > MAX_ENTRY_BYTES
      || uncompressedSize > MAX_ENTRY_BYTES || expandedBytes > MAX_EXPANDED_BYTES
      || localOffset + LOCAL_HEADER_LENGTH + compressedSize > centralOffset) {
      throw Object.assign(new Error('更新包条目损坏或超出安全大小限制。'), { code: 'archive' });
    }
    const name = central.toString('utf8', cursor + CENTRAL_HEADER_LENGTH, cursor + CENTRAL_HEADER_LENGTH + nameLength);
    // Unix mode lives in the high 16 bits; 0xA000 marks a symlink, which we never extract.
    const unixMode = (externalAttributes >>> 16) & 0xffff;
    entries.push({
      name,
      method,
      compressedSize,
      uncompressedSize,
      localOffset,
      isDirectory: name.endsWith('/'),
      isSymlink: (unixMode & 0xf000) === 0xa000,
      centralOffset,
    });
    cursor = nextCursor;
  }
  if (entries.length !== total || cursor !== central.length) {
    throw Object.assign(new Error('更新包中央目录条目不完整。'), { code: 'archive' });
  }
  if (!entries.length) throw Object.assign(new Error('更新包内容为空。'), { code: 'archive' });
  return entries;
}

async function readZipEntry(handle, entry) {
  const header = await readExactly(handle, LOCAL_HEADER_LENGTH, entry.localOffset);
  if (header.length < LOCAL_HEADER_LENGTH || header.readUInt32LE(0) !== LOCAL_SIGNATURE) {
    throw Object.assign(new Error(`更新包条目损坏：${entry.name}`), { code: 'archive' });
  }
  const dataOffset = entry.localOffset + LOCAL_HEADER_LENGTH + header.readUInt16LE(26) + header.readUInt16LE(28);
  if (header.readUInt16LE(6) & 1 || header.readUInt16LE(8) !== entry.method
    || dataOffset + entry.compressedSize > entry.centralOffset) {
    throw Object.assign(new Error(`更新包条目数据越界或不一致：${entry.name}`), { code: 'archive' });
  }
  const raw = await readExactly(handle, entry.compressedSize, dataOffset);
  if (raw.length !== entry.compressedSize) {
    throw Object.assign(new Error(`更新包条目读取不完整：${entry.name}`), { code: 'archive' });
  }
  if (entry.method === 0) {
    if (raw.length !== entry.uncompressedSize) throw Object.assign(new Error(`更新包条目大小不符：${entry.name}`), { code: 'archive' });
    return raw;
  }
  if (entry.method !== 8) {
    throw Object.assign(new Error(`更新包使用了不支持的压缩方式（${entry.method}）：${entry.name}`), { code: 'archive' });
  }
  let inflated;
  try {
    inflated = inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.uncompressedSize) });
  } catch (error) {
    throw Object.assign(new Error(`更新包条目解压失败：${entry.name}（${error.message}）`), { code: 'archive' });
  }
  if (inflated.length !== entry.uncompressedSize) {
    throw Object.assign(new Error(`更新包条目解压大小不符：${entry.name}`), { code: 'archive' });
  }
  return inflated;
}

// Extracts a ZIP archive without any external program: Windows' tar.exe is not guaranteed
// to exist and Expand-Archive is slow for ~2 000 files.
export async function extractZip(zipPath, destination, { onProgress, only } = {}) {
  const handle = await open(zipPath, 'r');
  try {
    const { size } = await handle.stat();
    const entries = await readZipEntries(handle, size);
    const selected = entries.filter(entry => !entry.isDirectory && !entry.isSymlink && (!only || only(entry.name)));
    if (!selected.length) throw Object.assign(new Error('更新包里没有可用的程序文件。'), { code: 'archive' });
    await mkdir(destination, { recursive: true });
    let done = 0;
    for (const entry of selected) {
      const target = resolveEntryPath(destination, entry.name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, await readZipEntry(handle, entry));
      done += 1;
      if (typeof onProgress === 'function') {
        try { onProgress({ phase: 'extracting', done, total: selected.length, name: entry.name }); } catch { }
      }
    }
    return { files: done, entries: entries.length };
  } finally {
    await handle.close();
  }
}

// One independent transaction worker serves both Windows distribution formats.
// References: electron-updater BaseUpdater; Velopack apply_windows_impl.
async function hashFile(file) {
  const handle = await open(file, 'r');
  const digest = createHash('sha256');
  try { for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk); }
  finally { await handle.close(); }
  return digest.digest('hex');
}
async function payloadFiles(root, relative = '') {
  const files = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await payloadFiles(root, name));
    else if (entry.isFile()) files.push({ name, sha256: await hashFile(path.join(root, name)) });
    else throw new Error('更新包包含不支持的文件类型。');
  }
  return files;
}
export async function prepareUpdateInstall({ target, download, pid, parentPid = 0, failureMarkerPath = '', version = '', onProgress, workDir: existingWorkDir = '' } = {}) {
  if (!download?.path) throw Object.assign(new Error('没有可用的更新包。'), { code: 'download' });
  if (!download.verified || !/^[0-9a-f]{64}$/i.test(download.sha256 || '') || download.sha256 !== download.expected) {
    throw Object.assign(new Error('发布页未提供匹配的 SHA256 校验值，已取消自动更新。'), { code: 'checksum' });
  }
  await assertInstallTarget(target);
  if (!['portable-exe', 'directory'].includes(target.kind)) throw new Error('不支持当前安装方式。');
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(parentPid) || parentPid < 0) throw new Error('更新进程标识无效。');
  if (!/^[A-Za-z0-9._+-]+$/.test(version)) throw new Error('更新版本标识无效。');
  if (await hashFile(download.path) !== download.sha256) throw Object.assign(new Error('更新文件在校验后被改变。'), { code: 'checksum' });
  const workDir = existingWorkDir || updateWorkRoot();
  const logPath = path.join(workDir, 'apply.log');
  const scriptPath = path.join(workDir, 'apply.ps1');
  const receiptPath = path.join(workDir, 'receipt.json');
  const payloadDir = target.kind === 'directory' ? path.join(workDir, 'payload') : '';
  await mkdir(workDir, { recursive: true });
  try {
    let files = [];
    if (payloadDir) {
      await extractZip(download.path, payloadDir, { onProgress });
      for (const name of ['Roomcast.exe', 'resources/app.asar']) {
        if (!(await stat(path.join(payloadDir, name)).catch(() => null))?.isFile()) throw new Error('更新包缺少必要的程序文件：' + name);
      }
      files = await payloadFiles(payloadDir);
    }
    const plan = {
      kind: target.kind, targetPath: target.targetPath, launchPath: target.launchPath,
      assetPath: download.path, payloadDir, files, sha256: download.sha256,
      workDir, logPath, receiptPath, token: randomBytes(32).toString('hex'),
      lockPath: target.targetPath + '.update.lock', pid, parentPid, failureMarkerPath, version,
    };
    await writeFile(path.join(workDir, 'update-plan.json'), JSON.stringify(plan), 'utf8');
    const worker = await readFile(new URL('./update-worker.ps1', import.meta.url), 'utf8');
    await writeFile(scriptPath, '\ufeff' + worker, 'utf8');
    return { workDir, payloadDir, scriptPath, logPath, receiptPath, kind: target.kind };
  } catch (error) {
    if (!existingWorkDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
export function startApplyScript(scriptPath, { cwd = os.tmpdir(), spawnImpl = spawn, onError,
  launcherPath = process.resourcesPath ? path.join(process.resourcesPath, 'runtime/update-launcher/RoomcastUpdateLauncher.exe') : fileURLToPath(new URL('../runtime/update-launcher/RoomcastUpdateLauncher.exe', import.meta.url)),
} = {}) {
  const worker = Buffer.from("& '" + scriptPath.replace(/'/g, "''") + "'", 'utf16le').toString('base64');
  const child = spawnImpl(launcherPath, [worker], { cwd, stdio: 'ignore', windowsHide: true, detached: true });
  child.on?.('error', error => { if (typeof onError === 'function') onError(error); });
  child.unref?.();
  return { pid: Number(child.pid) || 0, via: 'native-breakaway' };
}
export async function waitForApplyScriptStart(logPath, { timeoutMs = 8000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const log = await readFile(logPath, 'utf8').catch(() => '');
    if (/update start kind=/.test(log)) return true;
    if (/FAILED/.test(log) || Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}
export async function confirmUpdateStartup(version, env = process.env) {
  const receiptPath = env.ROOMCAST_UPDATE_RECEIPT;
  const token = env.ROOMCAST_UPDATE_TOKEN;
  delete env.ROOMCAST_UPDATE_RECEIPT;
  delete env.ROOMCAST_UPDATE_TOKEN;
  if (!receiptPath || !/^[a-f0-9]{64}$/.test(token || '') || path.basename(receiptPath) !== 'receipt.json') return false;
  const temporary = receiptPath + '.tmp';
  await writeFile(temporary, JSON.stringify({ version, token, pid: process.pid }), 'utf8');
  await (await import('node:fs/promises')).rename(temporary, receiptPath);
  return true;
}
export async function cleanupStaleUpdateWorkDirs({ now = Date.now(), maxAgeMs = 24 * 60 * 60 * 1000, root = os.tmpdir() } = {}) {
  let removed = 0;
  for (const name of await readdir(root).catch(() => [])) {
    if (!/^roomcast-update-\d+$/.test(name)) continue;
    const directory = path.join(root, name);
    const info = await stat(directory).catch(() => null);
    if (!info?.isDirectory() || now - info.mtimeMs < maxAgeMs) continue;
    const log = await readFile(path.join(directory, 'apply.log'), 'utf8').catch(() => '');
    if (!/COMMITTED version=/.test(log)) continue;
    await rm(directory, { recursive: true, force: true }).then(() => { removed++; }, () => {});
  }
  return removed;
}
