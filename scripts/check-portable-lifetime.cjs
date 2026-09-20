const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const root = process.cwd();
const { chromium } = createRequire(path.join(root, 'package.json'))('playwright');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const executable = path.resolve(process.argv[2]);

async function waitForExit(child, ms = 90000) {
  const deadline = Date.now() + ms;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(250);
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'portable wrapper did not exit');
}

async function main() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'Roomcast portable lifetime-'));
  const profile = path.join(temp, 'profile');
  const env = { ...process.env, ROOMCAST_TEST_MODE: '1', ROOMCAST_PROFILE_DIR: profile, ROOMCAST_DATA_DIR: path.join(temp, 'data') };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ROOMCAST_ALLOW_PARALLEL_INSTANCE;
  delete env.ROOMCAST_OBS_PREFLIGHT_RESULT;
  let first, second, browser;
  try {
    first = spawn(executable, ['--remote-debugging-port=0', '--enable-automation'], { env, windowsHide: true, stdio: 'ignore' });
    first.on('error', error => { console.error(error); });
    let port = 0;
    const deadline = Date.now() + 90000;
    while (!port && Date.now() < deadline) {
      port = Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '')).split('\n')[0]);
      if (!port) await delay(250);
    }
    assert.ok(port, 'first portable launch did not become ready');
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const session = await browser.newBrowserCDPSession();
    const { arguments: args } = await session.send('Browser.getBrowserCommandLine');
    const appExe = args.find(value => /[\\/]Roomcast\.exe$/i.test(value));
    assert.ok(appExe, 'could not identify the running app resources');
    const bundle = path.join(path.dirname(appExe), 'resources/runtime/obs-bundle');
    const marker = path.join(bundle, 'roomcast-embedded-obs.json');
    await fs.access(marker);
    const page = browser.contexts()[0].pages()[0];
    await page.waitForFunction(() => Boolean(window.roomcast?.obsCaptureSources));
    const before = await page.evaluate(() => window.roomcast.obsCaptureSources({ width: 1280, height: 720, fps: 30 }));
    assert.equal(before.ok, true, before.message);
    assert.ok(before.monitors.length > 0);
    await page.evaluate(() => window.roomcast.stopObsCapture());
    console.log('First launch: OBS bundle present. Starting the same portable EXE again.');
    second = spawn(executable, [], { env, windowsHide: true, stdio: 'ignore' });
    second.on('error', error => { console.error(error); });
    await waitForExit(second);
    const files = ['bin/64bit/obs64.exe', 'obs-plugins/64bit/obs-websocket.dll', 'roomcast-embedded-obs.json'];
    const missing = [];
    for (const file of files) if (!(await fs.stat(path.join(bundle, file)).catch(() => null))) missing.push(file);
    console.log(JSON.stringify({ firstStillRunning: first.exitCode === null, secondExitCode: second.exitCode, missing }));
    assert.deepEqual(missing, [], 'second portable launch deleted the first instance OBS runtime');
    const after = await page.evaluate(() => window.roomcast.obsCaptureSources({ width: 1280, height: 720, fps: 30 }));
    assert.equal(after.ok, true, after.message);
    assert.ok(after.monitors.length > 0);
    await page.evaluate(() => window.roomcast.captureSources());
    const backToObs = await page.evaluate(() => window.roomcast.obsCaptureSources({ width: 1280, height: 720, fps: 30 }));
    assert.equal(backToObs.ok, true, backToObs.message);
    await page.evaluate(() => window.roomcast.stopObsCapture());
    console.log('PASS: second launch exits without removing the running instance OBS resources.');
  } finally {
    if (browser) {
      for (const page of browser.contexts().flatMap(context => context.pages())) await page.evaluate(() => window.close()).catch(() => {});
      await browser.close().catch(() => {});
    }
    for (const child of [second, first]) {
      if (!child) continue;
      try { await waitForExit(child, 5000); } catch {
        await new Promise(resolve => {
          const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.on('error', resolve); killer.on('exit', resolve);
        });
      }
    }
    // temp was created exclusively by this test; never remove an app resource path.
    await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
