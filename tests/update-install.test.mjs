import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { deflateRawSync, crc32 } from 'node:zlib';
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertInstallTarget,
  buildApplyScript,
  cleanupStaleUpdateWorkDirs,
  describeInstallTarget,
  extractZip,
  prepareUpdateInstall,
  resolveEntryPath,
  startApplyScript,
  waitForApplyScriptStart,
} from '../electron/update-install.mjs';

// Minimal ZIP writer used only by these tests: enough of the format to exercise the
// reader (central directory, store and deflate entries, directory entries).
function makeZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const dosTime = 0;
  const dosDate = 0x21;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const raw = Buffer.from(file.content ?? '');
    const method = file.method ?? (file.deflate ? 8 : 0);
    const data = method === 8 ? deflateRawSync(raw) : raw;
    const checksum = (file.crc ?? crc32(raw)) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, data);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(dosTime, 12);
    header.writeUInt16LE(dosDate, 14);
    header.writeUInt32LE(checksum, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(raw.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE((file.unixMode ?? (0o100644 << 16)) >>> 0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    offset += local.length + name.length + data.length;
  }
  const centralBuffer = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBuffer, eocd]);
}

let workRoot;
test.before(async () => { workRoot = await mkdtemp(path.join(os.tmpdir(), 'roomcast-install-test-')); });
test.after(async () => { await rm(workRoot, { recursive: true, force: true }); });

test('install target detection refuses development and unknown layouts', () => {
  const development = describeInstallTarget({ platform: 'win32', isPackaged: false, execPath: 'C:\\dev\\node_modules\\electron\\dist\\electron.exe' });
  assert.equal(development.supported, false);
  assert.equal(development.kind, 'development');
  assert.match(development.reason, /源码\/开发/);

  const nodeModules = describeInstallTarget({ platform: 'win32', isPackaged: true, execPath: 'C:\\dev\\node_modules\\electron\\dist\\Roomcast.exe' });
  assert.equal(nodeModules.supported, false);
  assert.equal(nodeModules.kind, 'development');

  const foreign = describeInstallTarget({ platform: 'win32', isPackaged: true, execPath: 'C:\\Program Files\\Other\\other.exe' });
  assert.equal(foreign.supported, false);
  assert.equal(foreign.kind, 'unknown');

  const mac = describeInstallTarget({ platform: 'darwin', isPackaged: true, execPath: '/Applications/Roomcast.app' });
  assert.equal(mac.supported, false);
  assert.equal(mac.kind, 'unsupported');
});

test('install target detection covers folder installs and the portable EXE', () => {
  const folder = describeInstallTarget({ platform: 'win32', isPackaged: true, execPath: 'D:\\Roomcast\\Roomcast.exe' });
  assert.equal(folder.supported, true);
  assert.equal(folder.kind, 'directory');
  assert.equal(folder.appDir, 'D:\\Roomcast');
  assert.equal(folder.launchPath, 'D:\\Roomcast\\Roomcast.exe');
  assert.equal(folder.asarPath, path.join('D:\\Roomcast', 'resources', 'app.asar'));
  assert.equal(folder.fromLoadedAsar, false);

  const portable = describeInstallTarget({
    platform: 'win32',
    isPackaged: true,
    execPath: 'C:\\Users\\me\\AppData\\Local\\Temp\\abc\\Roomcast.exe',
    portableExecutableFile: 'D:\\Tools\\Roomcast-0.14.3-beta.2-Windows.exe',
  });
  assert.equal(portable.supported, true);
  assert.equal(portable.kind, 'portable-exe');
  assert.equal(portable.targetPath, 'D:\\Tools\\Roomcast-0.14.3-beta.2-Windows.exe');
});

test('a stale execPath is corrected by the asar the app actually loaded', async () => {
  // Real failure: the program folder was moved/renamed while the app was running, so
  // process.execPath still named the old location and the folder check failed even though
  // the app was clearly running from the new one.
  const target = describeInstallTarget({
    platform: 'win32',
    isPackaged: true,
    execPath: 'C:\\OldLocation\\Roomcast.exe',
    appPath: 'D:\\Moved Folder\\resources\\app.asar',
  });
  assert.equal(target.kind, 'directory');
  assert.equal(target.appDir, 'D:\\Moved Folder');
  assert.equal(target.launchPath, path.join('D:\\Moved Folder', 'Roomcast.exe'));
  assert.equal(target.asarPath, 'D:\\Moved Folder\\resources\\app.asar');
  assert.equal(target.fromLoadedAsar, true);

  // The folder exists and holds the loaded asar: the check must pass even though the stale
  // execPath has nothing to do with it.
  const dir = path.join(workRoot, 'moved-folder');
  await mkdir(path.join(dir, 'resources'), { recursive: true });
  await writeFile(path.join(dir, 'resources', 'app.asar'), 'asar');
  const live = describeInstallTarget({
    platform: 'win32',
    isPackaged: true,
    execPath: path.join(workRoot, 'gone', 'Roomcast.exe'),
    appPath: path.join(dir, 'resources', 'app.asar'),
  });
  assert.equal((await assertInstallTarget(live)).appDir, dir);
});

test('a folder install without app.asar is rejected before anything is written', async () => {
  const dir = path.join(workRoot, 'not-roomcast');
  await mkdir(dir, { recursive: true });
  const target = { supported: true, kind: 'directory', targetPath: dir, appDir: dir, launchPath: path.join(dir, 'Roomcast.exe') };
  await assert.rejects(() => assertInstallTarget(target), /缺少 resources\/app.asar/);

  await mkdir(path.join(dir, 'resources'), { recursive: true });
  await writeFile(path.join(dir, 'resources', 'app.asar'), 'asar');
  assert.equal((await assertInstallTarget(target)).kind, 'directory');
});

test('an app.asar that resolves as a virtual directory is accepted (Electron asar shim)', async () => {
  // Electron reports the asar archive itself as a directory, so the earlier strict isFile()
  // check rejected every real folder install (found in real testing, never in unit tests).
  const dir = path.join(workRoot, 'virtual-asar-install');
  await mkdir(path.join(dir, 'resources', 'app.asar'), { recursive: true });
  const target = describeInstallTarget({
    platform: 'win32',
    isPackaged: true,
    execPath: path.join(dir, 'Roomcast.exe'),
    appPath: path.join(dir, 'resources', 'app.asar'),
  });
  assert.equal((await assertInstallTarget(target)).appDir, dir);

  // The same must hold without the loaded-asar hint (plain execPath target).
  const plain = { supported: true, kind: 'directory', targetPath: dir, appDir: dir, launchPath: path.join(dir, 'Roomcast.exe'), asarPath: path.join(dir, 'resources', 'app.asar') };
  assert.equal((await assertInstallTarget(plain)).kind, 'directory');
});

test('zip entry paths cannot escape the extraction root', () => {
  assert.equal(resolveEntryPath('C:\\stage', 'resources/app.asar'), path.resolve('C:\\stage', 'resources', 'app.asar'));
  assert.equal(resolveEntryPath('C:\\stage', 'resources\\\\nested//file.txt'), path.resolve('C:\\stage', 'resources', 'nested', 'file.txt'));
  for (const name of ['../evil.txt', 'a/../../evil.txt', '/absolute.txt', 'C:/windows/evil.txt', 'a\\..\\..\\evil.txt', '']) {
    assert.throws(() => resolveEntryPath('C:\\stage', name), /更新包/);
  }
});

test('extraction unpacks stored and deflated entries and skips symlinks', async () => {
  const zipPath = path.join(workRoot, 'bundle.zip');
  const destination = path.join(workRoot, 'payload');
  const zip = makeZip([
    { name: 'Roomcast.exe', content: 'binary-roomcast', deflate: true },
    { name: 'resources/app.asar', content: 'asar-bytes' },
    { name: 'locales/', content: '' },
    { name: 'link', content: 'target', unixMode: 0o120777 << 16 },
  ]);
  await writeFile(zipPath, zip);
  const progress = [];
  const result = await extractZip(zipPath, destination, { onProgress: update => progress.push(update) });
  assert.equal(result.files, 2);
  assert.equal(await readFile(path.join(destination, 'Roomcast.exe'), 'utf8'), 'binary-roomcast');
  assert.equal(await readFile(path.join(destination, 'resources', 'app.asar'), 'utf8'), 'asar-bytes');
  await assert.rejects(() => stat(path.join(destination, 'link')));
  assert.ok(progress.every(update => update.phase === 'extracting' && update.total === 2));
  assert.equal(progress.at(-1).done, 2);
});

test('a truncated or non-zip archive fails without touching the destination', async () => {
  const brokenPath = path.join(workRoot, 'broken.zip');
  await writeFile(brokenPath, Buffer.from('this is not a zip archive at all'));
  const destination = path.join(workRoot, 'payload-broken');
  await assert.rejects(() => extractZip(brokenPath, destination), /不是有效的 ZIP/);
  assert.equal(await stat(destination).catch(() => null), null);

  const good = makeZip([{ name: 'a.txt', content: 'a'.repeat(2048), deflate: true }]);
  const truncated = path.join(workRoot, 'truncated.zip');
  await writeFile(truncated, good.subarray(0, good.length - 40));
  await assert.rejects(() => extractZip(truncated, path.join(workRoot, 'payload-truncated')));
});

test('the apply script waits, replaces and restarts, and never uses a destructive mirror copy', () => {
  const target = { kind: 'directory', appDir: 'D:\\Roomcast', launchPath: 'D:\\Roomcast\\Roomcast.exe' };
  const script = buildApplyScript({
    target,
    payloadDir: 'C:\\Temp\\roomcast-update-1\\payload',
    workDir: 'C:\\Temp\\roomcast-update-1',
    logPath: 'C:\\Temp\\roomcast-update-1\\apply.log',
    pid: 4321,
  });
  // An exact PID test: `find "4321"` would also match PID 54321.
  assert.match(script, /tasklist \/FI "PID eq 4321" \/NH \/FO CSV/);
  assert.ok(!/find "4321"/.test(script), 'PID detection must not be a substring match');
  assert.match(script, /if not defined FOUND goto waitroomcastgone/);
  // A stuck app must abort the update instead of overwriting files it still has open.
  assert.match(script, /if !TRIES! GEQ 180 goto giveup/);
  assert.match(script, /robocopy "C:\\Temp\\roomcast-update-1\\payload" "D:\\Roomcast" \/E /);
  assert.ok(!/\/MIR/.test(script), 'must not mirror: /MIR would delete files the user added');
  assert.match(script, /start "" "D:\\Roomcast\\Roomcast\.exe"/);
  // Regression guard: deleting the work directory from inside apply.cmd kills cmd.exe while
  // it is still reading the script, so the relaunch after it never happens.
  assert.ok(!/rmdir \/s \/q "C:\\Temp\\roomcast-update-1"/.test(script), 'the script must not delete its own directory');
  assert.match(script, /rmdir \/s \/q "C:\\Temp\\roomcast-update-1\\payload"/);
  // Without tasklist the PID check cannot be trusted, so the update must abort.
  assert.match(script, /if not exist "%SystemRoot%\\System32\\tasklist\.exe" goto giveup/);
  assert.match(script, /exit \/b 0/);
  assert.match(script, /exit \/b 1/);
});

test('the portable apply script waits for the launcher and retries the locked EXE copy', () => {
  const script = buildApplyScript({
    target: { kind: 'portable-exe', targetPath: 'D:\\Tools\\Roomcast.exe', launchPath: 'D:\\Tools\\Roomcast.exe' },
    assetPath: 'C:\\Temp\\roomcast-update-2\\Roomcast-0.14.3-beta.2-Windows.exe',
    payloadDir: '',
    workDir: 'C:\\Temp\\roomcast-update-2',
    logPath: 'C:\\Temp\\roomcast-update-2\\apply.log',
    pid: 99,
    parentPid: 4242,
  });
  // electron-builder's portable launcher ExecWaits the inner app and only then exits, so it
  // keeps the downloaded EXE locked; both PIDs must be awaited.
  assert.match(script, /tasklist \/FI "PID eq 99" \/NH \/FO CSV/);
  assert.match(script, /tasklist \/FI "PID eq 4242" \/NH \/FO CSV/);
  assert.match(script, /:waitlauncher/);
  assert.match(script, /:copynew/);
  assert.match(script, /if !COPIES! GEQ 30 goto failed/);
  assert.match(script, /copy \/Y "C:\\Temp\\roomcast-update-2\\Roomcast-0\.14\.3-beta\.2-Windows\.exe" "D:\\Tools\\Roomcast\.exe"/);
  assert.ok(!/robocopy/.test(script));
  assert.match(script, /exit \/b 1/);

  // Without a launcher PID the copy still retries, and no launcher wait is generated.
  const noParent = buildApplyScript({
    target: { kind: 'portable-exe', targetPath: 'D:\\Tools\\Roomcast.exe', launchPath: 'D:\\Tools\\Roomcast.exe' },
    assetPath: 'C:\\Temp\\roomcast-update-3\\new.exe',
    payloadDir: '',
    workDir: 'C:\\Temp\\roomcast-update-3',
    logPath: 'C:\\Temp\\roomcast-update-3\\apply.log',
    pid: 99,
  });
  assert.ok(!/:waitlauncher/.test(noParent));
  assert.match(noParent, /:copynew/);
});

test('the apply script leaves a failure marker so the next launch can report it', () => {
  const script = buildApplyScript({
    target: { kind: 'directory', appDir: 'D:\\Roomcast', launchPath: 'D:\\Roomcast\\Roomcast.exe' },
    payloadDir: 'C:\\Temp\\roomcast-update-4\\payload',
    workDir: 'C:\\Temp\\roomcast-update-4',
    logPath: 'C:\\Temp\\roomcast-update-4\\apply.log',
    pid: 7,
    failureMarkerPath: 'C:\\Users\\me\\AppData\\Roaming\\Roomcast\\update-failed.txt',
    version: '0.14.4-beta.1',
  });
  assert.match(script, /set "FAIL=C:\\Users\\me\\AppData\\Roaming\\Roomcast\\update-failed\.txt"/);
  // A previous marker must be cleared at the start of every attempt...
  assert.match(script, /if defined FAIL del "%FAIL%" 2>NUL/);
  // ...and only the failure path writes a new one.
  assert.match(script, />"%FAIL%" echo 0\.14\.4-beta\.1/);
  assert.match(script, />>"%FAIL%" echo C:\\Temp\\roomcast-update-4/);
  // Only the failure branch may create the marker (the single `>` form, not the appends).
  assert.equal(script.match(/(?<!>)>"%FAIL%" echo/g).length, 1, 'only one branch may create the marker');
});

test('the apply script start guard waits for the first log line', async () => {
  // The app must not quit unless the replacement script really began running; a spawn that
  // returns a pid can still die before executing anything.
  const logPath = path.join(workRoot, 'guard', 'apply.log');
  await mkdir(path.dirname(logPath), { recursive: true });
  assert.equal(await waitForApplyScriptStart(logPath, { timeoutMs: 400, intervalMs: 50 }), false, '没有日志时必须报未启动');
  await writeFile(logPath, '[time] update start kind=directory pid=1\n');
  assert.equal(await waitForApplyScriptStart(logPath, { timeoutMs: 400, intervalMs: 50 }), true, '日志有内容即视为已启动');
  // An empty file is not a start signal either.
  const emptyLog = path.join(workRoot, 'guard', 'empty.log');
  await writeFile(emptyLog, '');
  assert.equal(await waitForApplyScriptStart(emptyLog, { timeoutMs: 300, intervalMs: 50 }), false);
});

test('the apply script is launched detached through a hidden launcher', () => {
  // Regression coverage for the existing hidden launcher: cmd quoting, survival
  // after the app exits, and hidden descendants. On Windows, libuv adds
  // non-detached children to its own job; detached skips that assignment.
  // detached and windowsHide are compatible options, but CREATE_NO_WINDOW is
  // ignored with DETACHED_PROCESS, so the explicit hidden launcher still matters.
  const calls = [];
  const spawnImpl = (file, args, options) => {
    calls.push({ file, args, options });
    return { pid: 4242, on() { }, unref() { } };
  };
  const scriptPath = 'C:\\Users\\me\\AppData\\Local\\Temp\\roomcast-update-1\\apply.cmd';
  const started = startApplyScript(scriptPath, { spawnImpl, comspec: 'C:\\Windows\\System32\\cmd.exe' });
  assert.equal(started.pid, 4242);
  assert.equal(started.via, 'powershell-hidden');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'powershell.exe');
  assert.deepEqual(calls[0].args.slice(0, 4), ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden']);
  assert.equal(calls[0].args[4], '-Command');
  assert.match(calls[0].args[5], /Start-Process -FilePath \$env:ComSpec/);
  assert.match(calls[0].args[5], /-WindowStyle Hidden$/);
  assert.ok(calls[0].args[5].includes(scriptPath), '必须把脚本路径交给启动器');
  assert.ok(!calls[0].args[5].includes('/s '), '不能使用 /s');
  assert.equal(calls[0].options.detached, true, '必须 detached，否则程序退出时脚本会被一起杀掉');
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.stdio, 'ignore');

  // A path with spaces must be quoted for cmd.exe, not for Node.
  const spaced = [];
  startApplyScript('C:\\Users\\me\\App Data\\apply.cmd', {
    spawnImpl: (file, args, options) => { spaced.push({ file, args, options }); return { pid: 1, on() { }, unref() { } }; },
  });
  assert.ok(spaced[0].args[5].includes("'\"C:\\Users\\me\\App Data\\apply.cmd\"'"), '含空格路径必须由 cmd 侧加引号');

  // If PowerShell cannot be started, fall back to a detached cmd.exe so the update still
  // happens (windows may flash), and report which path was used.
  const fallback = [];
  const started2 = startApplyScript(scriptPath, {
    spawnImpl: (file, args, options) => {
      fallback.push({ file, args, options });
      return { pid: fallback.length === 1 ? 0 : 777, on() { }, unref() { } };
    },
    comspec: 'C:\\Windows\\System32\\cmd.exe',
  });
  assert.equal(started2.via, 'cmd-detached');
  assert.equal(started2.pid, 777);
  assert.equal(fallback.length, 2);
  assert.equal(fallback[1].file, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(fallback[1].args, ['/d', '/c', scriptPath]);
  assert.equal(fallback[1].options.detached, true);
  assert.equal(fallback[1].options.windowsHide, true);
});

test('an unverified download is never installed', async () => {
  const dir = path.join(workRoot, 'folder-install');
  await mkdir(path.join(dir, 'resources'), { recursive: true });
  await writeFile(path.join(dir, 'resources', 'app.asar'), 'asar');
  const target = { supported: true, kind: 'directory', targetPath: dir, appDir: dir, launchPath: path.join(dir, 'Roomcast.exe') };
  await assert.rejects(
    () => prepareUpdateInstall({ target, download: { path: 'ignored.zip', verified: false }, pid: 1 }),
    /发布页未提供校验值/,
  );
  await assert.rejects(
    () => prepareUpdateInstall({ target, download: null, pid: 1 }),
    /没有可用的更新包/,
  );
});

test('prepareUpdateInstall unpacks a verified archive and writes a runnable script', async () => {
  const dir = path.join(workRoot, 'real-install');
  await mkdir(path.join(dir, 'resources'), { recursive: true });
  await writeFile(path.join(dir, 'resources', 'app.asar'), 'old-asar');
  const target = { supported: true, kind: 'directory', targetPath: dir, appDir: dir, launchPath: path.join(dir, 'Roomcast.exe') };
  const zipPath = path.join(workRoot, 'update.zip');
  await writeFile(zipPath, makeZip([
    { name: 'Roomcast.exe', content: 'new-exe', deflate: true },
    { name: 'resources/app.asar', content: 'new-asar', deflate: true },
  ]));
  const plan = await prepareUpdateInstall({ target, download: { path: zipPath, verified: true }, pid: process.pid });
  try {
    assert.equal(await readFile(path.join(plan.payloadDir, 'resources', 'app.asar'), 'utf8'), 'new-asar');
    const script = await readFile(plan.scriptPath, 'utf8');
    assert.match(script, new RegExp(`roomcast-update-`));
    assert.match(script, new RegExp(String(process.pid)));
    // The archive itself is dropped once unpacked; the payload is what gets copied.
    assert.equal(await stat(zipPath).catch(() => null), null);
    assert.ok(plan.logPath.startsWith(plan.workDir));
  } finally {
    await rm(plan.workDir, { recursive: true, force: true });
  }
});

test('stale update work directories are removed on a later start', async () => {
  const root = path.join(workRoot, 'temp-root');
  const staleRoot = path.join(root, 'roomcast-update-1000');
  await mkdir(staleRoot, { recursive: true });
  await writeFile(path.join(staleRoot, 'apply.log'), 'old');
  const past = new Date(Date.now() - 60 * 60 * 1000);
  await utimes(staleRoot, past, past);
  const freshRoot = path.join(root, `roomcast-update-${Date.now()}`);
  await mkdir(freshRoot, { recursive: true });
  const unrelated = path.join(root, 'some-other-folder');
  await mkdir(unrelated, { recursive: true });
  const removed = await cleanupStaleUpdateWorkDirs({ root });
  assert.equal(removed, 1);
  assert.equal(await stat(staleRoot).catch(() => null), null);
  // A directory created by a still-running update must survive, and unrelated temp
  // folders must never be touched.
  assert.ok(await stat(freshRoot).catch(() => null));
  assert.ok(await stat(unrelated).catch(() => null));
});

test('the real release archive parses and extracts with this reader', async t => {
  const archive = fileURLToPath(new URL('../release/Roomcast-0.14.3-beta.1-Windows.zip', import.meta.url));
  const info = await stat(archive).catch(() => null);
  if (!info) return t.skip('release archive not present in this checkout');
  const destination = path.join(workRoot, 'real-release');
  const wanted = new Set(['resources/NOTICE', 'version', 'resources/app.asar']);
  const result = await extractZip(archive, destination, { only: name => wanted.has(name) });
  assert.equal(result.files, 3);

  // Structural checks that hold for any electron-builder archive: every entry we asked
  // for came out non-empty, the payload is a real multi-megabyte asar, and a second,
  // independent read of the same entries is byte identical (central directory and local
  // headers agree, so the reader is not silently truncating or padding).
  const first = new Map();
  for (const name of wanted) {
    const bytes = await readFile(path.join(destination, ...name.split('/')));
    assert.ok(bytes.length > 0, `${name} must not be empty`);
    first.set(name, bytes);
  }
  assert.ok(first.get('resources/app.asar').length > 1_000_000, 'app.asar must carry the whole app');
  const again = path.join(workRoot, 'real-release-again');
  const second = await extractZip(archive, again, { only: name => wanted.has(name) });
  assert.equal(second.files, 3);
  for (const name of wanted) {
    const bytes = await readFile(path.join(again, ...name.split('/')));
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      createHash('sha256').update(first.get(name)).digest('hex'),
      `${name} must read identically twice`,
    );
  }

  // When the archive has already been unpacked next to itself, compare byte for byte:
  // a full 221 MB, 2 101 entry electron-builder ZIP must round-trip exactly. The
  // unpacked folder is build scratch that may have been cleaned, so it is optional and
  // its absence must not be reported as a reader failure.
  const reference = fileURLToPath(new URL('../release/Roomcast-0.14.3-beta.1-Windows/', import.meta.url));
  if (!(await stat(reference).catch(() => null))) return;
  for (const name of wanted) {
    const original = await readFile(path.join(reference, ...name.split('/')));
    assert.equal(
      createHash('sha256').update(first.get(name)).digest('hex'),
      createHash('sha256').update(original).digest('hex'),
      `${name} must match the extracted release build`,
    );
  }
});
