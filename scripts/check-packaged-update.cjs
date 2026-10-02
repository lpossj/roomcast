// Offline real NSIS wrapper -> current worker -> new packaged app confirmation.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(read, timeout = 90000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const value = await read(); if (value) return value; await delay(250); }
  throw new Error('Packaged update timed out');
}
const killTree = pid => new Promise(resolve => {
  const child = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  child.once('exit', resolve); child.once('error', resolve);
});
async function main() {
  const root = process.cwd();
  const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
  const build = path.resolve(process.argv[2] || path.join(root, 'release'));
  const output = await fs.mkdtemp(path.join(root, '.test/packaged-update-'));
  const targetPath = path.join(output, '当前 Roomcast.exe');
  const profile = path.join(output, 'profile');
  await fs.mkdir(profile);
  await fs.copyFile(path.join(root, 'release/Roomcast-0.14.4-beta.6-Windows.exe'), targetPath);
  const env = { ROOMCAST_TEST_MODE: '1', ROOMCAST_PROFILE_DIR: profile, ROOMCAST_DATA_DIR: path.join(output, 'data') };
  Object.assign(process.env, env); delete process.env.ELECTRON_RUN_AS_NODE;
  const source = path.join(build, `Roomcast-${version}-Windows.exe`);
  const downloaded = path.join(output, 'verified-new.exe');
  await fs.copyFile(source, downloaded);
  const sha256 = createHash('sha256').update(await fs.readFile(source)).digest('hex');
  const { prepareUpdateInstall, startApplyScript, waitForApplyScriptStart } = await import(pathToFileURL(path.join(root, 'electron/update-install.mjs')));
  let browser, old, nextPid;
  let plan;
  try {
    old = spawn(targetPath, ['--remote-debugging-port=0', '--enable-automation'], { env: process.env, windowsHide: true, stdio: 'ignore' });
    old.once('error', error => { throw error; });
    const port = await waitFor(async () => Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '')).split('\n')[0]));
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const page = await waitFor(async () => browser.contexts().flatMap(context => context.pages()).find(page => /^http:\/\/127\.0\.0\.1:/.test(page.url())));
    await page.waitForSelector('.app-shell');
    const session = await browser.newBrowserCDPSession();
    const info = await session.send('SystemInfo.getProcessInfo');
    const pid = Number(info.processInfo.find(entry => entry.type === 'browser').id);
    plan = await prepareUpdateInstall({
      target: { supported: true, kind: 'portable-exe', targetPath, launchPath: targetPath },
      download: { path: downloaded, verified: true, sha256, expected: sha256 }, pid,
      parentPid: old.pid, version, workDir: path.join(output, 'work'), failureMarkerPath: path.join(profile, 'update-failed.txt'),
    });
    const launch = startApplyScript(plan.scriptPath, { launcherPath: path.join(build, 'win-unpacked/resources/runtime/update-launcher/RoomcastUpdateLauncher.exe') });
    assert.ok(launch.pid); assert.equal(await waitForApplyScriptStart(plan.logPath), true);
    await page.evaluate(() => window.close()).catch(() => {});
    await browser.close().catch(() => {}); browser = null;
    await waitFor(async () => /COMMITTED|FAILED/.test(await fs.readFile(plan.logPath, 'utf8').catch(() => '')));
    const log = await fs.readFile(plan.logPath, 'utf8');
    const match = log.match(/restart started pid=(\d+)/); nextPid = Number(match?.[1]);
    assert.ok(log.includes(`COMMITTED version=${version}`), log);
    const receipt = JSON.parse(await fs.readFile(plan.receiptPath, 'utf8'));
    assert.equal(receipt.version, version);
    assert.equal(createHash('sha256').update(await fs.readFile(targetPath)).digest('hex'), sha256);
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ old: '0.14.4-beta.6', new: receipt.version, wrapperExited: old.exitCode !== null, confirmedMainPid: receipt.pid, targetHash: sha256 }, null, 2));
    console.log(`[packaged-update] PASS beta.6 -> ${version}: real NSIS wrapper exit, atomic swap, real renderer ready, version receipt, committed. Evidence: ${output}`);
  } catch (error) {
    error.message += '\n' + (plan ? await fs.readFile(plan.logPath, 'utf8').catch(() => 'no worker log') : 'no plan'); throw error;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (!nextPid && plan) nextPid = Number((await fs.readFile(plan.logPath, 'utf8').catch(() => '')).match(/restart started pid=(\d+)/)?.[1]);
    if (nextPid) await killTree(nextPid);
    if (old && old.exitCode === null) await killTree(old.pid);
    // Keep logs/receipts/backup and the isolated installation for review.
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
