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
//   4. write a small .cmd that waits for this process to exit, copies the payload over the
//      program folder (or copies the new EXE over the portable EXE), starts it again and
//      cleans up
//   5. the caller starts that script detached and quits
//
// Nothing outside the temporary work directory is modified before the app exits, so a
// failure at any point before step 5 leaves the installed program untouched.

import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { mkdir, open, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

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
// robocopy exit codes 0-7 mean success (1 = files copied, 2 = extra files, 4 = mismatches);
// 8 and above mean at least one file failed.
const ROBOCOPY_FAILURE_CODE = 8;

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
  let cursor = 0;
  while (cursor + CENTRAL_HEADER_LENGTH <= central.length && entries.length < total) {
    if (central.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) break;
    const method = central.readUInt16LE(cursor + 10);
    const compressedSize = central.readUInt32LE(cursor + 20);
    const uncompressedSize = central.readUInt32LE(cursor + 24);
    const nameLength = central.readUInt16LE(cursor + 28);
    const extraLength = central.readUInt16LE(cursor + 30);
    const commentLength = central.readUInt16LE(cursor + 32);
    const externalAttributes = central.readUInt32LE(cursor + 38);
    const localOffset = central.readUInt32LE(cursor + 42);
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
    });
    cursor += CENTRAL_HEADER_LENGTH + nameLength + extraLength + commentLength;
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
  const raw = await readExactly(handle, entry.compressedSize, dataOffset);
  if (raw.length !== entry.compressedSize) {
    throw Object.assign(new Error(`更新包条目读取不完整：${entry.name}`), { code: 'archive' });
  }
  if (entry.method === 0) return raw;
  if (entry.method !== 8) {
    throw Object.assign(new Error(`更新包使用了不支持的压缩方式（${entry.method}）：${entry.name}`), { code: 'archive' });
  }
  let inflated;
  try {
    inflated = inflateRawSync(raw);
  } catch (error) {
    throw Object.assign(new Error(`更新包条目解压失败：${entry.name}（${error.message}）`), { code: 'archive' });
  }
  if (entry.uncompressedSize && inflated.length !== entry.uncompressedSize) {
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

// Human readable script; every failure is appended to apply.log next to it.
//
// Two Windows details drive the shape of this script:
//   * Portable builds run as launcher.exe (the downloaded EXE) -> inner extracted
//     Roomcast.exe (confirmed in app-builder-lib/templates/nsis/portable.nsi: the launcher
//     ExecWaits the inner app and only then removes $INSTDIR). `process.ppid` is therefore
//     the launcher, and the launcher keeps the downloaded EXE locked until it exits, so the
//     portable path must wait for both PIDs and still retry the copy.
//   * `tasklist /FI "PID eq N" /FO CSV` matched with `for /f` gives an exact PID test.
//     A plain `find "N"` would be a substring match, and a tasklist failure must not be
//     read as "the app has exited" (the copy retry loop below is the second safety net).
export function buildApplyScript({ target, payloadDir = '', assetPath = '', workDir, logPath, pid, parentPid = 0, failureMarkerPath = '', version = '' }) {
  const kind = target?.kind === 'portable-exe' ? 'portable-exe' : 'directory';
  const waitForPid = (variable, waitPid, limit, timeoutLabel) => [
    `set "TRIES=0"`,
    `:${variable}`,
    'set "FOUND="',
    `for /f "tokens=2 delims=," %%P in ('tasklist /FI "PID eq ${waitPid}" /NH /FO CSV 2^>NUL') do set "FOUND=%%~P"`,
    `if not defined FOUND goto ${variable}gone`,
    'set /a TRIES+=1',
    `if !TRIES! GEQ ${limit} goto ${timeoutLabel}`,
    'ping -n 2 127.0.0.1 >NUL',
    `goto ${variable}`,
    `:${variable}gone`,
  ];
  const lines = [
    '@echo off',
    'setlocal enabledelayedexpansion',
    `set "LOG=${logPath}"`,
    ...(failureMarkerPath ? [`set "FAIL=${failureMarkerPath}"`, 'if defined FAIL del "%FAIL%" 2>NUL'] : []),
    // Never overwrite a running program: if tasklist is unavailable the PID check cannot be
    // trusted, so abort instead of copying files the app may have open.
    'if not exist "%SystemRoot%\\System32\\tasklist.exe" goto giveup',
    `echo [%DATE% %TIME%] update start kind=${kind} pid=${pid} version=${version}>>"%LOG%"`,
    // If the app itself is still running after three minutes, do not overwrite files it has
    // open: abort, leave the installation untouched and tell the user on the next start.
    ...waitForPid('waitroomcast', pid, 180, 'giveup'),
  ];
  // A stuck launcher must not stall the update forever: the copy loop below retries until
  // the launcher has really released its image.
  if (kind === 'portable-exe' && Number(parentPid) > 0) {
    lines.push(
      'echo [%DATE% %TIME%] app exited, waiting for the portable launcher>>"%LOG%"',
      ...waitForPid('waitlauncher', Number(parentPid), 120, 'waitlaunchergone'),
    );
  }
  if (kind === 'portable-exe') {
    lines.push(
      'set "COPIES=0"',
      ':copynew',
      `copy /Y "${assetPath}" "${target.targetPath}" >>"%LOG%" 2>&1`,
      'if not errorlevel 1 goto copied',
      'set /a COPIES+=1',
      'if !COPIES! GEQ 30 goto failed',
      'ping -n 2 127.0.0.1 >NUL',
      'goto copynew',
      ':copied',
    );
  } else {
    lines.push(
      `robocopy "${payloadDir}" "${target.appDir}" /E /R:2 /W:1 /NFL /NDL /NJH /NJS >>"%LOG%" 2>&1`,
      `if errorlevel ${ROBOCOPY_FAILURE_CODE} goto failed`,
    );
  }
  lines.push(
    'echo [%DATE% %TIME%] files replaced, restarting>>"%LOG%"',
    `start "" "${target.launchPath}"`,
    'goto cleanup',
    ':giveup',
    'echo [%DATE% %TIME%] gave up waiting for the previous instance>>"%LOG%"',
    'goto failed',
    ':failed',
    'echo [%DATE% %TIME%] FAILED; restarting whatever is installed now>>"%LOG%"',
  );
  if (failureMarkerPath) {
    // The app has already exited, so it cannot report this failure itself. The next launch
    // reads this marker and tells the user instead of silently staying on the old version.
    lines.push(
      `>"%FAIL%" echo ${version}`,
      `>>"%FAIL%" echo ${workDir}`,
      '>>"%FAIL%" echo replacement failed, see apply.log',
    );
  }
  lines.push(
    `start "" "${target.launchPath}"`,
    // Keep apply.log plus the marker for diagnosis; drop the payload so a failure does not
    // leave ~600 MB behind. The work directory itself is removed on the next app start.
    ...(payloadDir ? [`rmdir /s /q "${payloadDir}" 2>NUL`] : []),
    'endlocal',
    'exit /b 1',
    ':cleanup',
    // Never delete the work directory here: apply.cmd lives in it, and removing it while
    // cmd.exe is still reading the script kills the remaining steps (the relaunch was lost
    // this way in testing). The next app start removes stale work directories instead.
    ...(payloadDir ? [`rmdir /s /q "${payloadDir}" 2>NUL`] : []),
    ...(kind === 'portable-exe' ? [`if exist "${assetPath}" del /q "${assetPath}" 2>NUL`] : []),
    'endlocal',
    'exit /b 0',
    '',
  );
  return lines.join('\r\n');
}

export function startApplyScript(scriptPath, { cwd = os.tmpdir(), spawnImpl = spawn, onError, comspec = process.env.ComSpec || 'cmd.exe' } = {}) {
  // Do NOT pre-quote the path, and do NOT use /s. Node quotes Windows arguments itself and
  // escapes any embedded quote as \" — which cmd.exe does not understand — so the previous
  // `/d /s /c "<path>"` form made cmd.exe fail before running a single line (verified: the
  // script produced no log at all, in a normal shell as well as in the sandbox). Passing the
  // bare path lets Node add quotes only when the path needs them, which cmd.exe handles
  // correctly for paths with and without spaces.
  //
  // `detached` must stay OFF: libuv maps it to DETACHED_PROCESS, and Windows ignores
  // CREATE_NO_WINDOW (what `windowsHide` sets) when DETACHED_PROCESS is present. The script
  // then has no console, so every console child it runs (tasklist, ping, robocopy) allocates
  // a NEW VISIBLE console window — users saw three console windows pop up during a real
  // update. With `windowsHide` alone the script gets one hidden console and all children
  // inherit it, so nothing is ever shown. Windows does not kill child processes when their
  // parent exits, so the script still outlives the app.
  // Measured with a visible-console counter: detached -> +1..3 windows, windowsHide only -> 0.
  const child = spawnImpl(comspec, ['/d', '/c', scriptPath], {
    cwd,
    stdio: 'ignore',
    windowsHide: true,
  });
  // spawn() reports failures asynchronously; without a listener that would be an unhandled
  // 'error' event in the main process.
  child.on?.('error', error => { if (typeof onError === 'function') onError(error); });
  child.unref?.();
  // pid is undefined when the process could not be started at all.
  return { pid: Number(child.pid) || 0 };
}

// A successful spawn only proves a pid was handed out: the process can still die before
// executing a single line (observed in heavily sandboxed environments, where cmd.exe is
// started and then fails to initialise). The script writes its first log line before it
// waits for anything, so "log file has content" is a reliable "it is really running" signal.
// Without this check the app would quit and nothing would replace the files.
export async function waitForApplyScriptStart(logPath, { timeoutMs = 8000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const info = await stat(logPath).catch(() => null);
    if (info?.size > 0) return true;
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

// Unpack a verified download into a work directory and write the apply script.
// `download.verified` must be true: an archive whose SHA256 could not be checked against
// the release page is never installed. Callers may pass a `workDir` they already created
// (for example to download straight into it); then it is theirs to clean up.
export async function prepareUpdateInstall({ target, download, pid, parentPid = 0, failureMarkerPath = '', version = '', onProgress, workDir: existingWorkDir = '' } = {}) {
  if (!download?.path) throw Object.assign(new Error('没有可用的更新包。'), { code: 'download' });
  if (!download.verified) {
    throw Object.assign(new Error('发布页未提供校验值，自动更新已取消；请用"打开发布页"手动下载。'), { code: 'checksum' });
  }
  await assertInstallTarget(target);
  const workDir = existingWorkDir || updateWorkRoot();
  // The apply script is a .cmd: `!` and `%` in a path would be expanded by cmd.exe.
  if (/[!%]/.test(workDir)) {
    throw Object.assign(new Error(`临时目录路径包含 cmd 无法安全处理的字符（! 或 %）：${workDir}`), { code: 'target' });
  }
  const logPath = path.join(workDir, 'apply.log');
  await mkdir(workDir, { recursive: true });
  const payloadDir = target.kind === 'directory' ? path.join(workDir, 'payload') : '';
  try {
    if (target.kind === 'directory') {
      await extractZip(download.path, payloadDir, { onProgress }).catch(error => {
        // A ~600 MB payload needs real free space; say so instead of surfacing ENOSPC.
        if (error?.code === 'ENOSPC' || /no space left/i.test(String(error?.message || ''))) {
          throw Object.assign(new Error('磁盘剩余空间不足，无法解压更新包；请清理临时目录后重试。'), { code: 'space' });
        }
        throw error;
      });
      // The archive is no longer needed and is the largest thing in the work directory.
      await unlink(download.path).catch(() => { });
    }
    const scriptPath = path.join(workDir, 'apply.cmd');
    await writeFile(scriptPath, buildApplyScript({
      target,
      payloadDir,
      assetPath: download.path,
      workDir,
      logPath,
      pid,
      parentPid,
      failureMarkerPath,
      version,
    }), 'utf8');
    return { workDir, payloadDir, scriptPath, logPath, kind: target.kind };
  } catch (error) {
    if (!existingWorkDir) await rm(workDir, { recursive: true, force: true }).catch(() => { });
    throw error;
  }
}

// The apply script cannot delete its own directory, so stale work directories are removed
// on the next app start. Anything touched in the last ten minutes is left alone so a
// concurrently running apply script is never disturbed.
export async function cleanupStaleUpdateWorkDirs({ now = Date.now(), maxAgeMs = 10 * 60 * 1000, root = os.tmpdir() } = {}) {
  let removed = 0;
  const names = await readdir(root).catch(() => []);
  for (const name of names) {
    if (!/^roomcast-update-\d+$/.test(name)) continue;
    const target = path.join(root, name);
    const info = await stat(target).catch(() => null);
    if (!info?.isDirectory()) continue;
    if (now - info.mtimeMs < maxAgeMs) continue;
    await rm(target, { recursive: true, force: true }).then(() => { removed += 1; }, () => { });
  }
  return removed;
}
