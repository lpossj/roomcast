// Native transaction regression for EXE and directory distributions. No network;
// only isolated fixtures are replaced, launched or stopped.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { crc32 } = require('node:zlib');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function makeZip(files) {
  const chunks = [], directory = []; let offset = 0;
  for (const [name, bytes] of files) {
    const filename = Buffer.from(name), local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(bytes), 14); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(filename.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc32(bytes), 16); central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
    chunks.push(local, filename, bytes); directory.push(central, filename); offset += 30 + filename.length + bytes.length;
  }
  const index = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, index, end]);
}
async function waitFor(check, timeout = 20000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await check()) return; await delay(100); }
  throw new Error('Portable update fixture timed out');
}
async function run() {
  if (process.platform !== 'win32') return console.log('Skipped: Windows only');
  const installerUrl = pathToFileURL(path.join(__dirname, '../electron/update-install.mjs')).href;
  const { prepareUpdateInstall } = await import(installerUrl);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "roomcast portable !% '& [中文] "));
  const oldImage = await fs.readFile(process.execPath);
  const newImage = Buffer.concat([oldImage, Buffer.from('Roomcast update fixture')]);
  const children = [];
  const preload = path.join(root, 'fixture.cjs');
  await fs.writeFile(preload, `const fs=require('node:fs');
if(process.env.ROOMCAST_UPDATE_RECEIPT){const file=process.env.ROOMCAST_UPDATE_RECEIPT;fs.writeFileSync(file+'.tmp',JSON.stringify({version:process.env.ROOMCAST_FIXTURE_VERSION,token:process.env.ROOMCAST_UPDATE_TOKEN,pid:process.pid}));fs.renameSync(file+'.tmp',file);setTimeout(()=>{},30000);}`);
  try {
    for (const mode of ['locked-success', 'tampered', 'restart-failure', 'startup-mismatch', 'directory-success', 'directory-mismatch']) {
      const dir = path.join(root, mode);
      await fs.mkdir(dir);
      const isDirectory = mode.startsWith('directory-');
      const install = isDirectory ? path.join(dir, 'install') : dir;
      await fs.mkdir(path.join(install, 'resources'), { recursive: true });
      const targetPath = path.join(install, 'Roomcast.exe');
      const assetPath = path.join(dir, isDirectory ? 'new.zip' : 'new.exe');
      const asset = isDirectory ? makeZip([['Roomcast.exe', newImage], ['resources/app.asar', Buffer.from('new-asar')]]) : newImage;
      const workDir = path.join(dir, 'work');
      const marker = path.join(dir, 'update-failed.txt');
      await fs.writeFile(targetPath, oldImage);
      await fs.writeFile(path.join(install, 'resources/app.asar'), 'old-asar');
      await fs.writeFile(path.join(install, 'user-file.txt'), 'preserve');
      await fs.writeFile(assetPath, asset);
      const holder = spawn(process.execPath, ['-e', 'setTimeout(()=>{},4000)'], { windowsHide: true, stdio: 'ignore' });
      children.push(holder);
      let blocker;
      if (mode === 'locked-success') {
        blocker = spawn(targetPath, ['-e', 'setTimeout(()=>{},30000)'], { windowsHide: true, stdio: 'ignore' });
        children.push(blocker);
        await delay(300);
        await assert.rejects(() => fs.copyFile(assetPath, targetPath), 'direct overwrite should fail while the image is mapped');
      }
      const plan = await prepareUpdateInstall({
        target: { supported: true, kind: isDirectory ? 'directory' : 'portable-exe', targetPath: isDirectory ? install : targetPath, appDir: install, launchPath: mode === 'restart-failure' ? path.join(dir, 'missing.exe') : targetPath },
        download: { verified: true, path: assetPath, sha256: digest(asset), expected: digest(asset) },
        pid: holder.pid, parentPid: process.pid, version: '0.14.4-beta.6', failureMarkerPath: marker, workDir,
      });
      if (mode === 'tampered') await fs.writeFile(assetPath, 'tampered');
      // Use the production launcher, then exit its parent before replacement.
      const driver = path.join(dir, 'driver.mjs');
      await fs.writeFile(driver, `import {startApplyScript,waitForApplyScriptStart} from ${JSON.stringify(installerUrl)};
const result=startApplyScript(${JSON.stringify(plan.scriptPath)});
process.exit(result.pid && await waitForApplyScriptStart(${JSON.stringify(plan.logPath)}) ? 0 : 1);`);
      const started = Date.now();
      const env = { ...process.env, NODE_OPTIONS: '--require "' + preload.replace(/\\/g, '/') + '"', ROOMCAST_FIXTURE_VERSION: mode.includes('mismatch') ? 'wrong-version' : '0.14.4-beta.6' };
      const child = spawn(process.execPath, [driver], { stdio: 'ignore', windowsHide: true, env });
      children.push(child);
      const code = await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
      assert.equal(code, 0, 'production launcher must acknowledge startup');
      assert.equal(digest(await fs.readFile(targetPath)), digest(oldImage), 'must wait for the old app PID');
      try {
        await waitFor(async () => /COMMITTED|previous image restarted|restart failed|ROLLBACK FAILED/.test(await fs.readFile(plan.logPath, 'utf8').catch(() => '')));
      } catch (error) {
        error.message += '\n' + await fs.readFile(plan.logPath, 'utf8').catch(() => 'no log');
        throw error;
      }
      const log = await fs.readFile(plan.logPath, 'utf8');
      for (const match of log.matchAll(/(?:restart started|previous image restarted) pid=(\d+)/g)) {
        // PIDs created by this fixture's worker only; never inspect or stop user apps.
        try { process.kill(Number(match[1])); } catch {}
      }
      assert.ok(Date.now() - started >= 2000, 'worker skipped waiting for the recorded app');
      if (mode === 'locked-success' || mode === 'directory-success') {
        assert.equal(digest(await fs.readFile(targetPath)), digest(newImage), log);
        const backups = (await fs.readdir(dir)).filter(name => name.includes('.previous-'));
        assert.equal(backups.length, 1);
        assert.equal(digest(await fs.readFile(isDirectory ? path.join(dir, backups[0], 'Roomcast.exe') : path.join(dir, backups[0]))), digest(oldImage));
        if (blocker) assert.equal(blocker.exitCode, null, 'must not kill another process to replace the image');
        assert.equal(await fs.stat(marker).catch(() => null), null);
        assert.match(log, /COMMITTED version=/);
      } else {
        assert.equal(digest(await fs.readFile(targetPath)), digest(oldImage), log);
        assert.match(await fs.readFile(marker, 'utf8'), /^0\.14\.4-beta\.6/);
        if (mode === 'restart-failure' || mode.includes('mismatch')) assert.match(log, /rolled back to previous image/);
        else assert.match(log, /changed after checksum verification/);
      }
      assert.equal(await fs.readFile(path.join(install, 'user-file.txt'), 'utf8'), 'preserve');
      if (isDirectory) assert.equal(await fs.readFile(path.join(install, 'resources/app.asar'), 'utf8'), mode === 'directory-success' ? 'new-asar' : 'old-asar');
      assert.ok(!(await fs.readdir(dir)).some(name => name.endsWith('.tmp')), 'stage must be removed');
      console.log(`[update-apply] PASS ${mode}: wait, hidden launcher survival, literal paths, hashes and recovery`);
    }
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    await delay(500);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
