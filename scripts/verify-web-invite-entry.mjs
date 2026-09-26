import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const { createStaticViewer } = require('../electron/web-invite.cjs');
const server = process.env.ROOMCAST_VIEWER_URL ? null : createStaticViewer(path.resolve('dist'));
if (server) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = process.env.ROOMCAST_VIEWER_URL || `http://127.0.0.1:${server.address().port}/`;
const { version } = JSON.parse(await readFile(path.resolve('package.json'), 'utf8'));
const report = { startedAt: new Date().toISOString(), base, version, checks: [], errors: [] };
const output = path.resolve(`.test/web-invite-entry-${version}-${server ? 'local' : 'online'}`);
await mkdir(output, { recursive: true });
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  // Model a phone without screen capture; desktop Chromium retains its native API.
  await context.addInitScript(() => {
    if (navigator.mediaDevices) Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { value: undefined });
  });
  const page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  // Reuse an already loaded document as a phone does when only the fragment changes.
  await page.goto(base);
  await page.locator('.empty-actions').getByRole('button', { name: '加入房间', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '创建房间', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '共享屏幕', exact: true }).count(), 0);
  report.checks.push('phone without capture API: join only, no create or share');
  await page.evaluate(() => { window.roomcastEntryMarker = 'same-document'; });
  const first = 'roomcast://join/ABCDEF12?secret=' + 'a'.repeat(43);
  const second = 'roomcast://join/DEADBEEF?secret=' + 'b'.repeat(43);
  const show = async (invite, method) => {
    await page.evaluate(({ invite, method }) => {
      if (method === 'hash') location.hash = `room=${encodeURIComponent(invite)}`;
      else {
        history.pushState(null, '', `?room=${encodeURIComponent(invite)}`);
        dispatchEvent(new PopStateEvent('popstate'));
      }
    }, { invite, method });
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    assert.equal(await dialog.getByLabel('邀请链接', { exact: true }).inputValue(), invite);
    assert.equal(await page.evaluate(() => window.roomcastEntryMarker), 'same-document');
    assert.equal(await dialog.getByRole('button', { name: '进入房间', exact: true }).isEnabled(), true);
    assert.equal(await page.locator('.connection-pill').innerText(), '房间连接：未连接');
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    report.checks.push(`${method}: new invite prefilled, confirmation required, first X closes`);
  };
  await show(first, 'hash');
  await show(second, 'hash');
  await show(first, 'popstate');
  // A fresh query navigation must beat the invite remembered from the old document.
  await page.goto(`${base}?room=${encodeURIComponent(second)}`);
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  assert.equal(await dialog.getByLabel('邀请链接', { exact: true }).inputValue(), second);
  await dialog.getByLabel('邀请链接', { exact: true }).fill(`https://viewer.example/#room=${encodeURIComponent(first)}`);
  assert.equal(await dialog.getByLabel('邀请链接', { exact: true }).inputValue(), first);
  report.checks.push('query invite overrides stored invite; pasted full viewer URL unwraps');
  await page.screenshot({ path: path.join(output, 'mobile-join-confirmation.png'), fullPage: true });
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const desktopPage = await desktop.newPage();
  desktopPage.on('pageerror', error => report.errors.push(error.message));
  await desktopPage.goto(base);
  await desktopPage.locator('.empty-actions').getByRole('button', { name: '加入房间', exact: true }).waitFor();
  assert.equal(await desktopPage.getByRole('button', { name: '创建房间', exact: true }).count(), 0);
  await desktopPage.getByRole('button', { name: '共享屏幕', exact: true }).click();
  await desktopPage.getByRole('dialog').waitFor();
  assert.equal(await desktopPage.getByRole('heading', { name: '加入房间', exact: true }).count(), 1);
  assert.equal(await desktopPage.getByRole('button', { name: '创建并进入房间', exact: true }).count(), 0);
  report.checks.push('desktop browser retains share action, requests join first, cannot create');
  assert.deepEqual(report.errors, []);
  report.ok = true;
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.ok = false; report.failure = error.stack;
  throw error;
} finally {
  await browser?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
}
