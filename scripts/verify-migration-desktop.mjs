import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';

const root = process.cwd(), apps = [];
const runId = Date.now();
const cleanEnv = { ...process.env }; delete cleanEnv.ELECTRON_RUN_AS_NODE;
async function launch(index) {
  const app = await electron.launch({
    args: [root, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
    env: { ...cleanEnv, ROOMCAST_TEST_MODE: '1', ROOMCAST_PROFILE_DIR: path.join(root, 'test-results', `migration-profile-${runId}-${index}`), ROOMCAST_DATA_DIR: path.join(root, 'test-results', `migration-data-${index}`), PORT: '0' },
    timeout: 30000,
  });
  apps.push(app);
  const page = await app.firstWindow();
  page.on('console', message => { if (message.type() === 'error') console.log('renderer-error', index, message.text().replace(/[A-Za-z0-9_-]{43,}/g, '[redacted]')); });
  page.on('pageerror', error => console.log('renderer-failure', index, error.message));
  await page.getByRole('heading', { name: '欢迎来到同屏' }).waitFor();
  assert.equal(await page.evaluate(() => window.roomcast.setPreference('captureEngine', 'legacy-external')), false);
  await page.reload();
  return page;
}
async function enter(page, name, invite) {
  await page.locator('.empty-actions').getByRole('button', { name: invite ? '加入房间' : '创建房间', exact: true }).click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel('你的昵称', { exact: true }).fill(name);
  if (invite) await modal.getByLabel('房间号 / 邀请链接', { exact: true }).fill(invite);
  await modal.getByRole('button', { name: invite ? '进入房间' : '创建并进入房间', exact: true }).click();
  await modal.waitFor({ state: 'hidden', timeout: 55000 });
}
async function share(page) {
  await page.locator('.voice-dock').getByRole('button', { name: '共享屏幕', exact: true }).click();
  const modal = page.getByRole('dialog');
  await modal.locator('.source-card').first().waitFor();
  await modal.getByRole('button', { name: '开始共享', exact: true }).click();
  await modal.waitFor({ state: 'hidden', timeout: 30000 });
}
async function watch(page, name) {
  const player = page.locator('.stream-view').filter({ has: page.locator('.stream-parameter-bar strong', { hasText: name }) });
  await player.getByRole('button', { name: '点击进入共享', exact: true }).click();
  await player.locator('video').evaluate(video => new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (video.videoWidth && video.getVideoPlaybackQuality().totalVideoFrames > 5) { clearInterval(timer); resolve(); }
      else if (Date.now() - started > 30000) { clearInterval(timer); reject(new Error('no decoded video')); }
    }, 200);
  }));
}
try {
  const a = await launch(0), b = await launch(1), c = await launch(2);
  await enter(a, 'MigrationA');
  await a.locator('.room-header-actions').getByRole('button', { name: '邀请朋友', exact: true }).click();
  const invite = await a.getByLabel('邀请链接', { exact: true }).inputValue();
  assert.match(invite, /^roomcast:\/\/join\/[A-F0-9]{8}\?secret=[A-Za-z0-9_-]{43}$/);
  await a.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await enter(b, 'MigrationB', invite); await enter(c, 'MigrationC', invite);
  console.log('Three real Electron peers joined');
  await share(b); await share(c);
  await watch(b, 'MigrationC'); await watch(c, 'MigrationB');
  console.log('B and C decode each other before departure');
  await a.getByRole('button', { name: '离开房间', exact: true }).click();
  await a.getByRole('heading', { name: '欢迎来到同屏' }).waitFor({ timeout: 30000 });
  await b.waitForFunction(() => document.querySelectorAll('.member-row').length === 2, undefined, { timeout: 30000 });
  for (const page of [b,c]) {
    await page.waitForFunction(() => [...document.querySelectorAll('video')].some(video => video.videoWidth > 0 && !video.paused), undefined, { timeout: 30000 });
  }
  await c.getByRole('textbox', { name: '发送消息', exact: true }).fill('chat after coordinator migration');
  await c.getByRole('button', { name: '发送消息', exact: true }).click();
  await b.getByText('chat after coordinator migration', { exact: true }).waitFor();
  console.log('A departed; B/C playback and chat survived');
  for (const page of [b,c]) await page.getByRole('button', { name: '停止共享', exact: true }).click();
  await share(b); await watch(c, 'MigrationB');
  await share(c); await watch(b, 'MigrationC');
  console.log('B/C restarted shares and decoded both directions after migration');
} catch (error) {
  console.error(error.name + ': ' + String(error.message).replace(/[A-Za-z0-9_-]{43,}/g, '[redacted]'));
  for (let index = 0; index < apps.length; index++) {
    const page = apps[index].windows()[0];
    console.log('diagnostic', index, await page.locator('.toast, .player-loading, .sidebar-members, .chat-message').allTextContents().catch(() => []));
    console.log('transport', index, await page.evaluate(() => {
      const element = document.querySelector('.app-shell');
      let fiber = element?.[Object.keys(element).find(key => key.startsWith('__reactFiber'))];
      while (fiber) {
        let hook = fiber.memoizedState;
        while (hook) {
          const value = hook.memoizedState?.current;
          if (value?.mediaP2P) return { isHost: value.isHost, connected: value.connected, migrating: value.migrating, closed: value.closed, peerOpen: value.peer?.open, peerDestroyed: value.peer?.destroyed, remoteOpen: value.remote?.open, pending: value.pending.size, prepared: !!value.preparedMigration, localConnected: value.local?.connected, guests: value.guests.size };
          hook = hook.next;
        }
        fiber = fiber.return;
      }
      return null;
    }).catch(() => null));
  }
  process.exitCode = 1;
}
finally {
  for (const app of apps.reverse()) {
    const timer = setTimeout(() => app.process().kill(), 5000);
    await app.close().catch(() => {}); clearTimeout(timer);
  }
}
