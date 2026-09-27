import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const { createStaticViewer } = require('../electron/web-invite.cjs');
const server = createStaticViewer(path.resolve('dist'));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const localOrigin = `http://127.0.0.1:${server.address().port}`;
const origin = 'https://roomcast.test';
const output = path.resolve('.test/browser-host');
await mkdir(output, { recursive: true });
const report = { startedAt: new Date().toISOString(), scope: 'Production static UI; real Chromium fake camera + real WebRTC; local modeled signaling, no public network or real phone', checks: [], errors: [] };
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['camera', 'microphone'] });
  const peers = new Map();
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.fulfill({ response: await route.fetch({ url: `${localOrigin}${url.pathname}${url.search}` }) });
    if (url.hostname.endsWith('peerjs.com') && url.pathname.endsWith('/id')) return route.fulfill({ body: randomUUID(), headers: { 'access-control-allow-origin': '*' } });
    return route.abort();
  });
  await context.routeWebSocket('**/*', socket => {
    const url = new URL(socket.url());
    if (!url.hostname.endsWith('peerjs.com')) { socket.close(); return; }
    const id = url.searchParams.get('id');
    peers.set(id, socket);
    socket.onMessage(data => {
      const message = JSON.parse(String(data));
      if (message.dst) peers.get(message.dst)?.send(JSON.stringify({ ...message, src: id }));
    });
    socket.onClose(() => peers.delete(id));
    socket.send(JSON.stringify({ type: 'OPEN' }));
  });
  // A phone without getDisplayMedia must still offer camera and room creation.
  await context.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: undefined });
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    window.roomcastTestTracks = [];
    navigator.mediaDevices.getUserMedia = options => original(options).then(stream => { window.roomcastTestTracks.push(...stream.getTracks()); return stream; });
  });
  const host = await context.newPage();
  host.on('pageerror', error => report.errors.push(error.message));
  await host.goto(origin);
  await host.locator('.empty-actions').getByRole('button', { name: '创建房间', exact: true }).click();
  let dialog = host.getByRole('dialog');
  await dialog.getByLabel('你的昵称').fill('网页房主');
  await dialog.getByLabel('房间名称').fill('网页验证房间');
  await dialog.getByRole('button', { name: '创建并进入房间' }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 25000 });
  assert.match(await host.locator('.connection-pill').innerText(), /P2P/);
  await host.getByRole('button', { name: '邀请朋友', exact: true }).click();
  dialog = host.getByRole('dialog');
  const invite = await dialog.getByLabel('邀请链接', { exact: true }).inputValue();
  assert.match(invite, /^roomcast:\/\/join\/.*secret=/);
  assert.ok(await dialog.getByLabel('电脑／手机网页观看链接').inputValue());
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  report.checks.push('static browser creates room and generates authenticated desktop/web invitations without /api/config');
  const guest = await context.newPage();
  guest.on('pageerror', error => report.errors.push(error.message));
  await guest.goto(`${origin}/#room=${encodeURIComponent(invite)}`);
  dialog = guest.getByRole('dialog');
  await dialog.getByLabel('你的昵称').fill('网页朋友');
  await dialog.getByRole('button', { name: '进入房间', exact: true }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 25000 });
  await guest.getByRole('textbox', { name: '发送消息' }).fill('网页双向鉴权聊天');
  await guest.getByRole('button', { name: '发送消息', exact: true }).click();
  await host.getByText('网页双向鉴权聊天', { exact: true }).waitFor();
  report.checks.push('second browser joins with current Host proof and chats through real datachannel');
  await host.getByRole('button', { name: '共享画面', exact: true }).click();
  dialog = host.getByRole('dialog');
  assert.equal(await dialog.getByRole('button', { name: '屏幕或窗口' }).count(), 0);
  assert.equal(await dialog.getByRole('button', { name: '摄像头', exact: true }).count(), 1);
  for (const text of ['所选程序声音', '排除所选程序', '浏览器允许的声音']) assert.equal(await dialog.getByText(text, { exact: true }).count(), 0);
  await dialog.getByRole('button', { name: '开始共享', exact: true }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 20000 });
  await guest.getByRole('button', { name: '点击进入共享', exact: true }).click();
  await guest.waitForFunction(() => [...document.querySelectorAll('video')].some(video => video.videoWidth > 0 && video.readyState >= 2), { timeout: 20000 });
  report.cameraFrame = await guest.locator('video').first().evaluate(video => ({ width: video.videoWidth, height: video.videoHeight, readyState: video.readyState }));
  await guest.screenshot({ path: path.join(output, 'camera-viewer.png'), fullPage: true });
  await host.getByRole('button', { name: '停止共享', exact: true }).click();
  await host.waitForFunction(() => window.roomcastTestTracks.length > 0 && window.roomcastTestTracks.every(track => track.readyState === 'ended'));
  await guest.locator('video').waitFor({ state: 'detached' });
  report.checks.push('camera publishes through existing P2P, guest decodes real frame, stop releases capture and removes viewer');
  // Denied camera + missing screen API must not expose a nonfunctional publishing button.
  const blocked = await browser.newContext();
  await blocked.route(`${origin}/**`, async route => route.fulfill({ response: await route.fetch({ url: `${localOrigin}${new URL(route.request().url()).pathname}` }) }));
  await blocked.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { value: undefined });
    navigator.permissions.query = async () => ({ state: 'denied', addEventListener() {}, removeEventListener() {} });
  });
  const blockedPage = await blocked.newPage();
  await blockedPage.goto(origin);
  await blockedPage.locator('.empty-actions').getByRole('button', { name: '创建房间', exact: true }).waitFor();
  await blockedPage.waitForFunction(() => !document.querySelector('.share-button'));
  report.checks.push('denied camera and absent display API hide publishing while supported browser room creation stays available');
  assert.deepEqual(report.errors, []);
  report.ok = true;
} catch (error) { report.ok = false; report.failure = error.stack; process.exitCode = 1; }
finally {
  await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
