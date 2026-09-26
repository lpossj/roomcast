// End-to-end check of the automatic update flow against a real packaged build.
//
// What it does, entirely on its own:
//   1. takes a directory install (Roomcast.exe + resources/app.asar)
//   2. copies it to a scratch folder so repeated runs start from the same version
//   3. launches it in test mode (windows hidden, isolated profile/data)
//   4. drives the real UI API over CDP: check -> target -> start automatic update
//   5. watches the dedicated progress window's state until it fails or restarts
//   6. waits for this process to exit, the files to be replaced and the app to come back
//   7. asserts the installed asar really is the new version
//
// Usage:
//   node scripts/check-auto-update.cjs --install <dir with Roomcast.exe> [--expect <version>]
//        [--timeout-ms 300000] [--keep] [--in-place]
//
// The install must be a build older than the published release, otherwise there is nothing
// to update to. Test mode is required: it hides both windows so a scripted run is invisible.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');

const root = process.cwd();
const require1 = createRequire(path.join(root, 'package.json'));
const { chromium } = require1('playwright');
const asar = require1('@electron/asar');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function parseArgs(argv) {
  const options = { install: '', expect: '', timeoutMs: 420000, keep: false, inPlace: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--install') options.install = argv[++index] || '';
    else if (value === '--expect') options.expect = argv[++index] || '';
    else if (value === '--timeout-ms') options.timeoutMs = Number(argv[++index]) || options.timeoutMs;
    else if (value === '--keep') options.keep = true;
    else if (value === '--in-place') options.inPlace = true;
    else throw new Error(`未知参数：${value}`);
  }
  return options;
}

// @electron/asar caches the parsed archive header per archive path
// (node_modules/@electron/asar/lib/disk.js: filesystemCache). When the install is replaced
// under the same path, later reads keep using the OLD header and return fragments of other
// files — the real failure looked like `Unexpected token 'm', "     membership" is not valid
// JSON` and the version check never recovered. Always drop the cache before reading a file
// that may have been replaced. Verified locally without any network access.
const readAsarFile = (archive, filename) => {
  asar.uncache(archive);
  return asar.extractFile(archive, filename);
};
const asarVersion = archive => JSON.parse(readAsarFile(archive, 'package.json').toString('utf8')).version;
const hasUpdater = archive => readAsarFile(archive, 'electron/main.cjs').toString('utf8').includes('roomcast:update-start');

async function copyInstall(source, destination) {
  await fsp.rm(destination, { recursive: true, force: true });
  await fsp.mkdir(destination, { recursive: true });
  await fsp.cp(source, destination, { recursive: true, force: true });
}

async function waitFor(check, { timeoutMs, intervalMs = 250, label = 'condition' }) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await delay(intervalMs);
  }
  throw new Error(`等待超时：${label}（${timeoutMs}ms）`);
}

const taskkill = pid => new Promise(resolve => {
  const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  killer.on('error', resolve);
  killer.on('exit', resolve);
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (process.platform !== 'win32') {
    console.log('[auto-update] 跳过：该检查只适用于 Windows。');
    return;
  }
  assert.ok(options.install, '必须用 --install 指定一个“目录版”安装（含 Roomcast.exe 与 resources/app.asar）');
  const sourceInstall = path.resolve(options.install);
  const sourceExe = path.join(sourceInstall, 'Roomcast.exe');
  const sourceAsar = path.join(sourceInstall, 'resources', 'app.asar');
  assert.ok(fs.existsSync(sourceExe), `找不到 ${sourceExe}`);
  assert.ok(fs.existsSync(sourceAsar), `找不到 ${sourceAsar}`);
  const installedVersion = asarVersion(sourceAsar);
  assert.ok(hasUpdater(sourceAsar), '该构建里没有自动更新代码，无法用于本检查（请用当前源码重新打包）');
  console.log(`[auto-update] 源安装：${sourceInstall}（当前版本 ${installedVersion}）`);

  const stamp = Date.now();
  const runRoot = path.join(root, '..', 'roomcast-update-test', 'runs', String(stamp));
  const install = options.inPlace ? sourceInstall : path.join(runRoot, 'install');
  const profile = path.join(runRoot, 'profile');
  const data = path.join(runRoot, 'data');
  if (!options.inPlace) await copyInstall(sourceInstall, install);
  await fsp.mkdir(profile, { recursive: true });
  await fsp.mkdir(data, { recursive: true });
  const exe = path.join(install, 'Roomcast.exe');
  const asarPath = path.join(install, 'resources', 'app.asar');

  const env = { ...process.env, ROOMCAST_TEST_MODE: '1', ROOMCAST_PROFILE_DIR: profile, ROOMCAST_DATA_DIR: data };
  delete env.ELECTRON_RUN_AS_NODE;
  let app = null;
  let browser = null;
  let relaunched = 0;
  let succeeded = false;
  try {
    app = spawn(exe, ['--remote-debugging-port=0', '--enable-automation'], { env, windowsHide: true, stdio: 'ignore' });
    app.on('error', error => console.error('[auto-update] 启动失败：', error.message));
    const firstPid = app.pid;

    const port = await waitFor(async () => {
      const raw = await fsp.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '');
      return Number(String(raw).split('\n')[0]) || 0;
    }, { timeoutMs: 90000, label: '程序启动并打开调试端口' });
    console.log(`[auto-update] 已启动 pid=${firstPid}，调试端口 ${port}`);

    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const pages = () => browser.contexts().flatMap(context => context.pages());
    const mainPage = await waitFor(async () => {
      for (const page of pages()) {
        if (!/\/updater\.html$/.test(page.url())) {
          const ready = await page.evaluate(() => Boolean(window.roomcast?.checkForUpdates)).catch(() => false);
          if (ready) return page;
        }
      }
      return null;
    }, { timeoutMs: 60000, label: '主界面加载完成' });

    const check = await mainPage.evaluate(() => window.roomcast.checkForUpdates());
    console.log('[auto-update] 检查更新：', JSON.stringify({ available: check?.available, version: check?.version, viaManifest: check?.viaManifest, assets: check?.assets?.map(asset => asset.name) }));
    assert.equal(check?.available, true, '当前安装之上没有可用更新，无法测试更新流程');
    const expected = options.expect || check.version;

    const target = await mainPage.evaluate(() => window.roomcast.updateTarget());
    console.log('[auto-update] 安装目标：', JSON.stringify(target));
    assert.equal(target?.kind, 'directory', `期望目录版安装，实际 ${target?.kind}：${target?.reason || ''}`);
    assert.equal(target?.supported, true, `该安装不支持自动更新：${target?.reason || ''}`);

    // Fire and forget: starting the update closes this window, so awaiting it would race.
    await mainPage.evaluate(() => { window.roomcast.startAutomaticUpdate(); return true; }).catch(() => { });

    const updaterPage = await waitFor(async () => pages().find(page => /\/updater\.html$/.test(page.url())) || null,
      { timeoutMs: 60000, label: '更新进度窗口出现' });
    // Read the state the main process pushes (the progress window's own status() call is a
    // separate IPC path and must not be the only way to observe the flow).
    await waitFor(async () => {
      const armed = await updaterPage.evaluate(() => {
        if (window.__autoUpdateStates) return true;
        window.__autoUpdateStates = [];
        window.roomcastUpdater?.onState?.(state => window.__autoUpdateStates.push(state));
        return Boolean(window.roomcastUpdater);
      }).catch(() => false);
      return armed;
    }, { timeoutMs: 30000, label: '进度窗口准备好接收状态' });
    console.log('[auto-update] 进度窗口已出现，开始跟踪状态');

    let lastPhase = '';
    let seen = '';
    const readState = async () => updaterPage.evaluate(() => {
      const pushed = window.__autoUpdateStates?.at(-1);
      return pushed || null;
    }).catch(() => null);
    const finalState = await waitFor(async () => {
      const state = await readState();
      if (!state) return null;
      if (state.phase !== lastPhase) {
        lastPhase = state.phase;
        const progress = state.phase === 'downloading' && state.total
          ? ` ${Math.round((state.received / state.total) * 100)}%`
          : state.phase === 'extracting' && state.files ? ` ${state.done}/${state.files}` : '';
        console.log(`[auto-update] 阶段：${state.phase}${progress}`);
      }
      if (state.status === 'failed') return { failed: true, state };
      if (state.phase === 'restarting') return { failed: false, state };
      return null;
    }, { timeoutMs: options.timeoutMs, label: '更新流程结束（失败或进入重启）' });
    if (finalState.failed) {
      throw new Error(`更新流程失败：${finalState.state.error}`);
    }

    // The replacement happens after this process exits, then the app is started again.
    await waitFor(async () => {
      try { process.kill(firstPid, 0); return false; } catch { return true; }
    }, { timeoutMs: 120000, label: '旧进程退出' });
    console.log('[auto-update] 旧进程已退出，等待文件替换与自动重启');

    await waitFor(async () => {
      const missing = !fs.existsSync(asarPath);
      if (missing) return false;
      let version = '';
      try { version = asarVersion(asarPath); } catch (error) {
        if (seen !== `err:${error.message}`) { seen = `err:${error.message}`; console.log(`[auto-update] 读取安装版本失败：${error.message}`); }
        return false;
      }
      if (version !== seen) { seen = version; console.log(`[auto-update] 安装目录当前版本：${version}（期望 ${expected}）`); }
      return version === expected;
    }, { timeoutMs: 180000, intervalMs: 1000, label: `安装目录被覆盖为 ${expected}` });
    console.log(`[auto-update] 安装目录已更新为 ${expected}`);

    relaunched = await waitFor(async () => {
      // The relaunched instance is started by the apply script without a debug port, so the
      // only trustworthy signal is "a Roomcast process is running from this install folder".
      // (An earlier version fell back to "DevToolsActivePort exists", which is a stale file
      // from the first launch and produced a false positive.)
      const output = await new Promise(resolve => {
        const child = spawn('tasklist.exe', ['/FI', 'IMAGENAME eq Roomcast.exe', '/FO', 'CSV', '/NH'], { windowsHide: true });
        let text = '';
        child.stdout.on('data', chunk => { text += chunk; });
        child.on('exit', () => resolve(text));
        child.on('error', () => resolve(''));
      });
      return output.split(/\r?\n/).filter(line => line.includes(install)).length;
    }, { timeoutMs: 120000, intervalMs: 1000, label: '程序自动重新打开' });
    assert.ok(relaunched > 0, '程序没有自动重新打开');
    console.log(`[auto-update] 程序已自动重新打开（副本目录内有 ${relaunched} 个进程）`);

    console.log(`[auto-update] 通过：${installedVersion} → ${expected}（下载 → SHA256 校验 → 解压 → 退出 → 覆盖 → 自动重启）`);
    succeeded = true;
  } finally {
    if (browser) await browser.close().catch(() => { });
    // Keep the scene when something went wrong so the failure can be inspected afterwards.
    const keep = options.keep || options.inPlace || !succeeded;
    // Kill anything still running from this scratch install (the relaunched instance included).
    await new Promise(resolve => {
      const child = spawn('tasklist.exe', ['/FI', 'IMAGENAME eq Roomcast.exe', '/FO', 'CSV', '/NH'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.on('exit', async () => {
        for (const line of output.split(/\r?\n/)) {
          if (!line.includes(install.replace(/\\/g, '\\\\')) && !line.includes(install)) continue;
          const pid = Number((line.match(/^"Roomcast\.exe","(\d+)"/) || [])[1]);
          if (pid) await taskkill(pid);
        }
        resolve();
      });
      child.on('error', resolve);
    });
    if (app && app.exitCode === null) { try { app.kill(); } catch { } }
    if (keep) console.log(`[auto-update] 保留现场：${runRoot}`);
    else await fsp.rm(runRoot, { recursive: true, force: true }).catch(() => { });
  }
}

main().catch(async error => {
  console.error('[auto-update] 失败：', error?.message || error);
  // Leave enough evidence behind to debug without reproducing by hand.
  try {
    const temp = os.tmpdir();
    const dirs = (await fsp.readdir(temp).catch(() => []))
      .filter(name => /^roomcast-update-\d+$/.test(name))
      .sort()
      .reverse();
    for (const name of dirs.slice(0, 2)) {
      const dir = path.join(temp, name);
      const entries = await fsp.readdir(dir).catch(() => []);
      console.error(`[auto-update] 工作目录 ${dir}：${entries.join('、') || '(空)'}`);
      const log = await fsp.readFile(path.join(dir, 'apply.log'), 'utf8').catch(() => '');
      if (log) console.error(`[auto-update] apply.log：\n${log.trim()}`);
      else console.error('[auto-update] 没有 apply.log —— 替换脚本没有真正执行');
    }
  } catch { }
  process.exitCode = 1;
});
