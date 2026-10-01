import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { deflateRawSync, crc32 } from 'node:zlib';
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assertInstallTarget,
  confirmUpdateStartup,
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
    local.writeUInt32LE(file.declaredSize ?? raw.length, 22);
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
    header.writeUInt32LE(file.declaredSize ?? raw.length, 24);
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

test('malformed archives cannot exceed declared inflate sizes or extraction budgets', async () => {
  const cases = [
    [{ name: 'bomb', content: 'x'.repeat(1024 * 1024), deflate: true, declaredSize: 1 }],
    [{ name: 'zero', content: 'x'.repeat(4096), deflate: true, declaredSize: 0 }],
    [{ name: 'stored', content: '123', declaredSize: 0 }],
    [{ name: 'oversize', content: '', declaredSize: 512 * 1024 * 1024 + 1 }],
    Array.from({ length: 5 }, (_, i) => ({ name: `total-${i}`, content: '', declaredSize: 512 * 1024 * 1024 })),
  ];
  for (let i = 0; i < cases.length; i++) {
    const zip = path.join(workRoot, `bounded-${i}.zip`);
    const target = path.join(workRoot, `bounded-${i}`);
    await writeFile(zip, makeZip(cases[i]));
    await assert.rejects(() => extractZip(zip, target), error => error.code === 'archive');
    assert.deepEqual(await import('node:fs/promises').then(fs => fs.readdir(target).catch(() => [])), []);
  }
  const incomplete = makeZip([{ name: 'a', content: 'valid' }]);
  incomplete.writeUInt16LE(2, incomplete.length - 12);
  const zip = path.join(workRoot, 'incomplete.zip');
  await writeFile(zip, incomplete);
  await assert.rejects(() => extractZip(zip, path.join(workRoot, 'incomplete')), /中央目录条目不完整/);
});

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

function verified(path, bytes) {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return { path, verified: true, sha256, expected: sha256 };
}
test('transaction preparation verifies the actual file and preserves the installation', async () => {
  const dir = path.join(workRoot, "便携 !% '& [中文]");
  await mkdir(dir, { recursive: true });
  const targetPath = path.join(dir, 'Roomcast.exe');
  const assetPath = path.join(dir, 'new.exe');
  await writeFile(targetPath, 'old'); await writeFile(assetPath, 'new');
  const target = { supported: true, kind: 'portable-exe', targetPath, launchPath: targetPath };
  const args = { target, download: verified(assetPath, 'new'), pid: process.pid, parentPid: process.ppid, version: '0.14.4-beta.7' };
  await assert.rejects(() => prepareUpdateInstall({ ...args, download: { ...args.download, verified: false } }), /SHA256/);
  await assert.rejects(() => prepareUpdateInstall({ ...args, download: { ...args.download, expected: '0'.repeat(64) } }), /SHA256/);
  await assert.rejects(() => prepareUpdateInstall({ ...args, download: verified(assetPath, 'changed') }), /改变/);
  await assert.rejects(() => prepareUpdateInstall({ ...args, pid: 0 }), /进程标识/);
  const plan = await prepareUpdateInstall(args);
  try {
    assert.match(plan.scriptPath, /apply\.ps1$/);
    const data = JSON.parse(await readFile(path.join(plan.workDir, 'update-plan.json'), 'utf8'));
    assert.equal(data.targetPath, targetPath); assert.equal(data.sha256, args.download.sha256);
    assert.match(data.token, /^[a-f0-9]{64}$/);
    assert.equal(await readFile(targetPath, 'utf8'), 'old');
    assert.equal((await readFile(plan.scriptPath, 'utf8')).charCodeAt(0), 0xfeff);
  } finally { await rm(plan.workDir, { recursive: true, force: true }); }
});
test('directory transaction validates its layout and hashes every extracted file', async () => {
  const dir = path.join(workRoot, 'directory-install');
  await mkdir(path.join(dir, 'resources'), { recursive: true });
  await writeFile(path.join(dir, 'resources/app.asar'), 'old');
  const zipPath = path.join(workRoot, 'new.zip');
  const bytes = makeZip([{ name: 'Roomcast.exe', content: 'new-exe' }, { name: 'resources/app.asar', content: 'new-asar', deflate: true }]);
  await writeFile(zipPath, bytes);
  const target = { supported: true, kind: 'directory', targetPath: dir, appDir: dir, launchPath: path.join(dir, 'Roomcast.exe') };
  const args = { target, download: verified(zipPath, bytes), pid: process.pid, version: '0.14.4-beta.7' };
  const plan = await prepareUpdateInstall(args);
  try {
    const data = JSON.parse(await readFile(path.join(plan.workDir, 'update-plan.json'), 'utf8'));
    assert.equal(data.files.length, 2);
    for (const entry of data.files) assert.equal(entry.sha256, createHash('sha256').update(await readFile(path.join(plan.payloadDir, entry.name))).digest('hex'));
    assert.equal(await readFile(path.join(dir, 'resources/app.asar'), 'utf8'), 'old');
    assert.ok(await stat(zipPath));
  } finally { await rm(plan.workDir, { recursive: true, force: true }); }
  const incomplete = makeZip([{ name: 'other.txt', content: 'incomplete' }]);
  await writeFile(zipPath, incomplete);
  await assert.rejects(() => prepareUpdateInstall({ ...args, download: verified(zipPath, incomplete) }), /必要的程序文件/);
});
test('the launcher encodes literal paths and uses an independent hidden worker', () => {
  const calls = [];
  const scriptPath = "C:\\Users\\me\\!% 中文 '& [目录]\\apply.ps1";
  const started = startApplyScript(scriptPath, { spawnImpl(file, args, options) { calls.push({ file, args, options }); return { pid: 42, on() {}, unref() {} }; } });
  assert.equal(started.pid, 42); assert.equal(started.via, 'native-breakaway');
  assert.equal(calls[0].options.detached, true); assert.equal(calls[0].options.windowsHide, true);
  const encoded = calls[0].args[0];
  assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), "& '" + scriptPath.replace(/'/g, "''") + "'");
  assert.match(calls[0].file, /RoomcastUpdateLauncher\.exe$/);
});
test('start guard requires a real start record rather than a failure log', async () => {
  const log = path.join(workRoot, 'start.log');
  await writeFile(log, 'FAILED: permission denied');
  assert.equal(await waitForApplyScriptStart(log, { timeoutMs: 200, intervalMs: 20 }), false);
  await writeFile(log, '[timestamp] update start kind=portable-exe pid=1');
  assert.equal(await waitForApplyScriptStart(log), true);
});
test('startup receipt records the actual version and consumes inherited transaction state', async () => {
  const receiptPath = path.join(workRoot, 'receipt.json');
  const env = { ROOMCAST_UPDATE_RECEIPT: receiptPath, ROOMCAST_UPDATE_TOKEN: 'a'.repeat(64) };
  assert.equal(await confirmUpdateStartup('0.14.4-beta.7', env), true);
  assert.deepEqual(JSON.parse(await readFile(receiptPath, 'utf8')), { version: '0.14.4-beta.7', token: 'a'.repeat(64), pid: process.pid });
  assert.equal(await confirmUpdateStartup('0.14.4-beta.7', env), false);
  assert.equal(await stat(receiptPath + '.tmp').catch(() => null), null);
});
test('cleanup retains failed/incomplete work and removes only old committed transactions', async () => {
  const root = path.join(workRoot, 'cleanup');
  const past = new Date(Date.now() - 48 * 3600 * 1000);
  for (const [name, log] of [['roomcast-update-1', 'COMMITTED version=1'], ['roomcast-update-2', 'FAILED'], ['roomcast-update-3', 'update start kind=directory'], ['unrelated', 'COMMITTED version=1']]) {
    await mkdir(path.join(root, name), { recursive: true });
    await writeFile(path.join(root, name, 'apply.log'), log);
    await utimes(path.join(root, name), past, past);
  }
  assert.equal(await cleanupStaleUpdateWorkDirs({ root }), 1);
  for (const name of ['roomcast-update-2', 'roomcast-update-3', 'unrelated']) assert.ok(await stat(path.join(root, name)));
});
