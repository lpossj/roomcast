// Offline packaged-ASAR installer -> native worker -> real app confirmation.
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
async function preparationProbe() {
  const { app } = require('electron');
  await app.whenReady();
  const input = JSON.parse(await fs.readFile(process.argv[process.argv.indexOf('--prepare-probe') + 1], 'utf8'));
  let plan;
  try {
    const { prepareUpdateInstall, startUpdateWorker, waitForUpdateWorkerStart } = await import(input.moduleUrl);
    plan = await prepareUpdateInstall(input.options);
    await fs.writeFile(input.report, JSON.stringify({ plan }));
    const launch = startUpdateWorker(plan);
    assert.ok(launch.pid); assert.equal(await waitForUpdateWorkerStart(plan.logPath), true);
    await fs.writeFile(input.report, JSON.stringify({ ok: true, plan, moduleUrl: input.moduleUrl }));
    app.exit(0);
  } catch (error) {
    await fs.writeFile(input.report, JSON.stringify({ ok: false, plan, error: error.stack }));
    app.exit(1);
  }
}
async function main() {
  const root = process.cwd();
  const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
  const build = path.resolve(process.argv[2] || path.join(root, 'release'));
  const output = await fs.mkdtemp(path.join(root, '.test/packaged-update-'));
  const directory = process.argv.includes('--directory');
  const baseline = path.join(root, 'release/beta7-compact-volume-20261002');
  const oldVersion = JSON.parse(require('@electron/asar').extractFile(path.join(baseline, 'win-unpacked/resources/app.asar'), 'package.json')).version;
  const appDir = path.join(output, '当前 Roomcast');
  const targetPath = directory ? appDir : path.join(output, '当前 Roomcast.exe');
  const launchPath = directory ? path.join(appDir, 'Roomcast.exe') : targetPath;
  const profile = path.join(output, 'profile');
  await fs.mkdir(profile);
  if (directory) await fs.cp(path.join(baseline, 'win-unpacked'), appDir, { recursive: true });
  else await fs.copyFile(path.join(baseline, `Roomcast-${oldVersion}-Windows.exe`), targetPath);
  const env = { ROOMCAST_TEST_MODE: '1', ROOMCAST_PROFILE_DIR: profile, ROOMCAST_DATA_DIR: path.join(output, 'data') };
  Object.assign(process.env, env); delete process.env.ELECTRON_RUN_AS_NODE;
  const source = path.join(build, `Roomcast-${version}-Windows.${directory ? 'zip' : 'exe'}`);
  const downloaded = path.join(output, `verified-new.${directory ? 'zip' : 'exe'}`);
  await fs.copyFile(source, downloaded);
  const sha256 = createHash('sha256').update(await fs.readFile(source)).digest('hex');
  const moduleUrl = pathToFileURL(path.join(build, 'win-unpacked/resources/app.asar/electron/update-install.mjs')).href;
  let browser, old, nextPid;
  let plan;
  try {
    old = spawn(launchPath, ['--remote-debugging-port=0', '--enable-automation'], { env: process.env, windowsHide: true, stdio: 'ignore' });
    let launchError;
    old.once('error', error => { launchError = error; });
    const port = await waitFor(async () => { if (launchError) throw launchError; return Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '')).split('\n')[0]); });
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const page = await waitFor(async () => browser.contexts().flatMap(context => context.pages()).find(page => /^http:\/\/127\.0\.0\.1:/.test(page.url())));
    await page.waitForSelector('.app-shell');
    const session = await browser.newBrowserCDPSession();
    const info = await session.send('SystemInfo.getProcessInfo');
    const pid = Number(info.processInfo.find(entry => entry.type === 'browser').id);
    const options = {
      target: { supported: true, kind: directory ? 'directory' : 'portable-exe', targetPath, appDir, launchPath },
      download: { path: downloaded, verified: true, sha256, expected: sha256 }, pid,
      parentPid: old.pid, version, workDir: path.join(output, 'work'), failureMarkerPath: path.join(profile, 'update-failed.txt'),
      workerSourcePath: path.join(build, 'win-unpacked/resources/runtime/update-launcher/RoomcastUpdateLauncher.exe'),
    };
    const input = path.join(output, 'prepare-input.json'), report = path.join(output, 'prepare-result.json');
    await fs.writeFile(input, JSON.stringify({ options, report, moduleUrl }));
    const probe = spawn(require('electron'), [__filename, '--prepare-probe', input], { env: process.env, windowsHide: true, stdio: 'ignore' });
    const code = await new Promise((resolve, reject) => { probe.once('exit', resolve); probe.once('error', reject); });
    const prepared = JSON.parse(await fs.readFile(report, 'utf8'));
    plan = prepared.plan;
    assert.equal(code, 0, prepared.error); assert.equal(prepared.ok, true, prepared.error);
    await page.evaluate(() => window.close()).catch(() => {});
    await browser.close().catch(() => {}); browser = null;
    await waitFor(async () => /COMMITTED|FAILED/.test(await fs.readFile(plan.logPath, 'utf8').catch(() => '')));
    const log = await fs.readFile(plan.logPath, 'utf8');
    const match = log.match(/restart started pid=(\d+)/); nextPid = Number(match?.[1]);
    assert.ok(log.includes(`COMMITTED version=${version}`), log);
    const receipt = JSON.parse(await fs.readFile(plan.receiptPath, 'utf8'));
    assert.equal(receipt.version, version);
    const installed = directory ? path.join(targetPath, 'resources/app.asar') : targetPath;
    const expected = directory ? path.join(build, 'win-unpacked/resources/app.asar') : source;
    const targetHash = createHash('sha256').update(await fs.readFile(installed)).digest('hex');
    assert.equal(targetHash, createHash('sha256').update(await fs.readFile(expected)).digest('hex'));
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ kind: options.target.kind, old: oldVersion, new: receipt.version, moduleUrl, oldProcessExited: old.exitCode !== null, confirmedMainPid: receipt.pid, targetHash }, null, 2));
    console.log(`[packaged-update] PASS ${options.target.kind} ${oldVersion} -> ${version}: packed installer, old process exit, atomic swap, real renderer ready, version receipt, committed. Evidence: ${output}`);
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
(process.versions.electron && process.argv.includes('--prepare-probe') ? preparationProbe() : main()).catch(error => { console.error(error); process.exitCode = 1; });
