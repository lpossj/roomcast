// End-to-end check of the generated update apply script.
//
// The automatic update replaces the installed program from a detached .cmd after the app
// exits. That script is the one piece static review cannot settle (cmd.exe labels, quoting,
// errorlevel and flow), so this check generates a real script with electron/update-install.mjs
// and runs it against a throwaway fake installation:
//
//   - a holder process occupies the recorded PID, proving the script really waits
//   - a fake "old" program folder and a fake "new" payload prove the copy happens
//   - the relaunch step is redirected to a marker .cmd, proving the app is started again
//   - the work directory must be gone afterwards, proving the success path cleans up
//
// It never touches a real Roomcast installation, downloads nothing, and is not part of
// `npm test` (it needs to spawn processes).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(check, { timeoutMs = 45000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await delay(intervalMs);
  }
  return false;
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('[update-apply] 跳过：该检查只适用于 Windows。');
    return;
  }
  const { buildApplyScript } = await import(pathToFileURL(path.join(__dirname, '..', 'electron', 'update-install.mjs')).href);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roomcast-apply-check-'));
  const install = path.join(root, 'install');
  const work = path.join(root, 'work');
  const payload = path.join(work, 'payload');
  const logPath = path.join(work, 'apply.log');
  const launchMarker = path.join(install, 'launch-marker.cmd');
  let holder = null;
  try {
    fs.mkdirSync(path.join(install, 'resources'), { recursive: true });
    fs.writeFileSync(path.join(install, 'resources', 'app.asar'), 'old-asar');
    fs.writeFileSync(path.join(install, 'Roomcast.exe'), 'old-exe');
    fs.writeFileSync(path.join(install, 'stale-only-file.dll'), 'keep-me');
    fs.writeFileSync(launchMarker, '@echo off\r\necho launched > "%~dp0launched.txt"\r\n');

    fs.mkdirSync(path.join(payload, 'resources'), { recursive: true });
    fs.writeFileSync(path.join(payload, 'resources', 'app.asar'), 'new-asar');
    fs.writeFileSync(path.join(payload, 'Roomcast.exe'), 'new-exe');
    fs.writeFileSync(path.join(payload, 'new-only-file.dll'), 'new-file');

    // A process that outlives the moment the script starts, so the wait loop must be used.
    holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2500)'], { stdio: 'ignore', windowsHide: true });
    await delay(300);

    const script = buildApplyScript({
      target: { kind: 'directory', appDir: install, launchPath: launchMarker },
      payloadDir: payload,
      workDir: work,
      logPath,
      pid: holder.pid,
    });
    fs.mkdirSync(work, { recursive: true });
    const scriptPath = path.join(work, 'apply.cmd');
    fs.writeFileSync(scriptPath, script, 'utf8');

    const startedAt = Date.now();
    const child = spawn('cmd.exe', ['/d', '/s', '/c', `"${scriptPath}"`], { stdio: 'ignore', windowsHide: true, cwd: os.tmpdir() });
    let spawnError = null;
    child.on('error', error => { spawnError = error; });

    const launched = await waitFor(() => fs.existsSync(path.join(install, 'launched.txt')) || spawnError);
    const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
    assert.ok(!spawnError, `无法启动替换脚本：${spawnError?.message || spawnError}`);
    assert.ok(launched, `替换脚本没有重新启动程序（pid=${child.pid}）。apply.cmd:\n${script}\napply.log:\n${log}`);
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= 1500, `脚本没有等待占用 PID 的进程退出（耗时 ${elapsed}ms）。apply.log:\n${log}`);

    assert.equal(fs.readFileSync(path.join(install, 'resources', 'app.asar'), 'utf8'), 'new-asar', '程序目录没有被覆盖');
    assert.equal(fs.readFileSync(path.join(install, 'Roomcast.exe'), 'utf8'), 'new-exe', '主程序没有被覆盖');
    assert.equal(fs.readFileSync(path.join(install, 'new-only-file.dll'), 'utf8'), 'new-file', '新增文件没有复制');
    // /E copies but must never purge: a file only the installed copy has must survive.
    assert.equal(fs.readFileSync(path.join(install, 'stale-only-file.dll'), 'utf8'), 'keep-me', '覆盖过程删除了目标目录里的多余文件');

    // The payload is dropped, but the script must NOT delete its own directory: doing that
    // while cmd.exe is still reading apply.cmd loses the remaining steps (the relaunch).
    const payloadGone = await waitFor(() => !fs.existsSync(payload), { timeoutMs: 15000 });
    assert.ok(payloadGone, '成功路径没有清理解压出来的 payload');
    assert.ok(fs.existsSync(logPath), 'apply.log 必须保留下来用于排障');
    assert.ok(!fs.existsSync(path.join(install, '..', 'update-failed.txt')), '成功路径不应写失败标记');
    child.kill();
    console.log(`[update-apply] 通过：等待 ${elapsed}ms → 覆盖成功 → 自动重启 → 清理 payload 并保留日志。`);
  } finally {
    if (holder) { try { holder.kill(); } catch { } }
    await delay(300);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error('[update-apply] 失败：', error?.message || error);
  process.exitCode = 1;
});
