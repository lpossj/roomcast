import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const root = process.cwd();
const closeMessage = process.env.ROOMCAST_EXIT_MESSAGE === 'SC_CLOSE' ? 'SC_CLOSE' : 'WM_CLOSE';
const report = { closeMessage, startedAt: new Date().toISOString(), testMode: false, checks: [] };
const output = path.join(root, `.test/exit-cancel-${process.env.ROOMCAST_SMOKE_EXE ? 'packaged' : 'dev'}-${closeMessage}`);
await mkdir(output, { recursive: true });
let app;
const record = (name, data = true) => { report.checks.push({ name, data }); console.log(name, JSON.stringify(data)); };
try {
  const env = { ...process.env, ROOMCAST_ALLOW_PARALLEL_INSTANCE: '1', ROOMCAST_PROFILE_DIR: path.join(output, 'profile'), ROOMCAST_DATA_DIR: path.join(output, 'data') };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ROOMCAST_TEST_MODE;
  app = await electron.launch({ executablePath: process.env.ROOMCAST_SMOKE_EXE || path.join(root, 'node_modules/electron/dist/electron.exe'),
    args: process.env.ROOMCAST_SMOKE_EXE ? [] : [root], env, timeout: 45000 });
  const page = await app.firstWindow();
  await page.locator('.empty-actions').getByRole('button', { name: '创建房间', exact: true }).waitFor({ timeout: 30000 });
  record('real-desktop-started-without-test-mode');
  let pendingConfig;
  await page.route('**/api/config', route => { pendingConfig = route; });
  await page.locator('.empty-actions').getByRole('button', { name: '创建房间', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('你的昵称', { exact: true }).fill('取消回归');
  await dialog.getByRole('button', { name: '创建并进入房间', exact: true }).click();
  await dialog.getByRole('button', { name: '停止连接', exact: true }).waitFor();
  assert.equal(await dialog.getByRole('button', { name: '关闭', exact: true }).isEnabled(), true);
  await dialog.getByRole('button', { name: '停止连接', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  record('hung-config-can-stop-and-close-dialog');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('heading', { name: '设置', exact: true }).waitFor();
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  record('another-operation-available-after-cancel');
  // Resolve the old request after cancellation; it cannot open a room or popup.
  if (pendingConfig) await pendingConfig.fulfill({ json: { peerServer: '' } }).catch(() => {});
  await page.locator('.empty-actions').getByRole('button', { name: '创建房间', exact: true }).click();
  await dialog.getByLabel('你的昵称', { exact: true }).fill('第二次取消');
  await dialog.getByRole('button', { name: '创建并进入房间', exact: true }).click();
  await dialog.getByRole('button', { name: '停止连接', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  record('escape-stops-second-hung-connection');
  await page.locator('.empty-actions').getByRole('button', { name: '创建房间', exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'after-cancel.png') });
  const processIds = async () => {
    const query = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = ''; query.stdout.on('data', data => { text += data; });
    assert.equal(await new Promise(resolve => query.once('exit', resolve)), 0);
    return JSON.parse(text);
  };
  const rootPid = app.process().pid;
  const before = await processIds(), tracked = new Set([rootPid]);
  let changed = true;
  while (changed) { changed = false; for (const item of before) {
    if (tracked.has(item.ParentProcessId) && !tracked.has(item.ProcessId)) { tracked.add(item.ProcessId); changed = true; }
  } }
  // Protect against both a beforeunload veto and a renderer that cannot reply.
  await page.evaluate(() => { window.onbeforeunload = () => false; });
  const hwnd = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => !win.isDestroyed()).getNativeWindowHandle().readBigUInt64LE().toString());
  const exited = new Promise(resolve => app.process().once('exit', (code, signal) => resolve({ code, signal, at: Date.now() })));
  void page.evaluate(() => { for (;;) {} }).catch(() => {});
  const native = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public static class RoomcastExitTest { [DllImport("user32.dll", SetLastError=true)] public static extern bool PostMessageW(IntPtr h, uint m, IntPtr w, IntPtr l); }\'; $now=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); if(-not [RoomcastExitTest]::PostMessageW([IntPtr]::new([Int64]'+hwnd+'), '+(closeMessage === 'SC_CLOSE' ? '274, [IntPtr]::new(61536)' : '16, [IntPtr]::Zero')+', [IntPtr]::Zero)){exit 2}; Write-Output $now'],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  native.stdout.on('data', data => { stdout += data; }); native.stderr.on('data', data => { stderr += data; });
  assert.equal(await new Promise(resolve => native.once('exit', resolve)), 0, stderr);
  let timer;
  const exit = await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('native close did not exit within 3 seconds')), 3000); })]).finally(() => clearTimeout(timer));
  const elapsedMs = exit.at - Number(stdout.trim());
  assert.equal(exit.code, 0);
  assert.ok(elapsedMs >= 0 && elapsedMs < 1500, `exit took ${elapsedMs} ms`);
  record(`native-${closeMessage}-exits-with-frozen-renderer-and-beforeunload-veto`, { ...exit, elapsedMs });
  const after = await processIds();
  const remaining = after.filter(item => tracked.has(item.ProcessId));
  assert.deepEqual(remaining, [], 'test process descendants must not survive native exit');
  record('no-surviving-test-process-descendants', { checked: tracked.size });
  app = null;
  report.ok = true;
} catch (error) {
  report.ok = false; report.error = error.stack; throw error;
} finally {
  if (app) app.process().kill(); // only the isolated process this script created
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
}
