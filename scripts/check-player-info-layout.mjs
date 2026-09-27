import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { _electron } from 'playwright';

const output = path.resolve('.test/player-info-0.14.4-beta.1');
await mkdir(output, { recursive: true });
const { outputFiles } = await build({ stdin: { contents: `
import { createRoot } from 'react-dom/client';
import ScreenPlayer from './ScreenPlayer.jsx';
const canvas=document.createElement('canvas');canvas.width=1920;canvas.height=1080;
canvas.getContext('2d').fillStyle='#315950';canvas.getContext('2d').fillRect(0,0,1920,1080);
window.testStream=canvas.captureStream(30);
const host=document.createElement('div');host.id='player-layout-test';host.style.width='640px';document.body.append(host);
createRoot(host).render(<ScreenPlayer stream={{memberId:'self',name:'共享者长昵称测试'.repeat(8),avatarColor:3,settings:{}}} viewerMemberId="self" transport={{screenStream:window.testStream}} initiallyEntered={true}/>);
`, loader: 'jsx', resolveDir: path.resolve('src') }, bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
const css = (await Promise.all(['src/styles.css', 'src/multi-share.css'].map(file => readFile(file, 'utf8')))).join('\n');
const env = { ...process.env, ROOMCAST_TEST_MODE: '1', ROOMCAST_ALLOW_PARALLEL_INSTANCE: '1',
  ROOMCAST_PROFILE_DIR: path.join(output, 'profile'), ROOMCAST_DATA_DIR: path.join(output, 'data') };
delete env.ELECTRON_RUN_AS_NODE;
const report = { startedAt: new Date().toISOString(), checks: [], ok: false };
let app;
const videoBox = page => page.locator('video').last().boundingBox();
const unchanged = (before, after) => {
  for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(before[key] - after[key]) < 0.5, `${key} changed when the info bar appeared`);
};
const wake = async (page, selector = 'video') => {
  const box = await page.locator(selector).last().boundingBox();
  await page.mouse.move(box.x + box.width * .48, box.y + box.height * .5);
  await page.mouse.move(box.x + box.width * .52, box.y + box.height * .5);
  await page.waitForTimeout(200);
};
const clickVisible = async (page, name) => {
  await wake(page);
  const button = page.getByRole('button', { name, exact: true }).last();
  const box = await button.boundingBox();
  assert.ok(await button.evaluate(node => {
    const r = node.getBoundingClientRect();
    return node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  }), `${name} is not receiving pointer input`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
};
try {
  app = await _electron.launch({ args: ['.'], env });
  report.testPid = app.process().pid;
  const page = await app.firstWindow();
  await page.waitForURL(/http:\/\/127\.0\.0\.1:/);
  await page.waitForLoadState('load');
  await page.addStyleTag({ content: css + '\n#root{display:none}body{margin:0;padding:0;overflow:hidden}#player-layout-test{position:absolute;left:0;top:0}' });
  await page.route('**/player-info-layout-test.js', route => route.fulfill({ contentType: 'text/javascript', body: outputFiles[0].text }));
  await page.addScriptTag({ url: new URL('/player-info-layout-test.js', page.url()).href });
  await page.locator('#player-layout-test video').waitFor();
  await page.waitForFunction(() => document.querySelector('#player-layout-test video').videoWidth > 0);
  for (const width of [640, 320]) {
    await page.evaluate(width => { document.querySelector('#player-layout-test').style.width = `${width}px`; }, width);
    await wake(page);
    const before = await videoBox(page);
    const info = page.locator('.player-info-overlay').last();
    const layout = await info.evaluate(node => ({ position: getComputedStyle(node).position, wrap: getComputedStyle(node).flexWrap,
      fits: node.scrollWidth <= node.clientWidth, spans: node.querySelectorAll('span').length,
      nameFits: node.querySelector('strong').scrollWidth > node.querySelector('strong').clientWidth }));
    assert.deepEqual(layout, { position: 'absolute', wrap: 'nowrap', fits: true, spans: 2, nameFits: true });
    await page.screenshot({ path: path.join(output, `preview-${width}.png`) });
    await page.mouse.move(1000, 700);
    await page.waitForFunction(() => document.querySelector('#player-layout-test .screen-player').classList.contains('controls-hidden'));
    unchanged(before, await videoBox(page));
    await wake(page); unchanged(before, await videoBox(page));
    report.checks.push(`preview ${width}px: long name truncated; all requested measurements stay on one row; hidden/shown video geometry unchanged`);
  }
  const fullButton = page.getByRole('button', { name: '全屏', exact: true }).last();
  report.beforeFullscreen = await fullButton.evaluate(node => {
    const box = node.getBoundingClientRect();
    return { box: box.toJSON(), hit: document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.outerHTML,
      controls: { pointerEvents: getComputedStyle(node.closest('.player-controls')).pointerEvents,
        z: getComputedStyle(node.closest('.player-controls')).zIndex, opacity: getComputedStyle(node.closest('.player-controls')).opacity },
      playerClass: node.closest('.screen-player').className };
  });
  console.log(JSON.stringify(report.beforeFullscreen));
  await clickVisible(page, '全屏');
  await page.waitForFunction(() => Boolean(document.fullscreenElement));
  await wake(page);
  assert.equal(await page.locator('.player-info-overlay').last().evaluate(node => getComputedStyle(node).display), 'none');
  const fullBefore = await videoBox(page);
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert.ok(Math.abs(fullBefore.height - viewport.height) < 1);
  await page.waitForTimeout(2300);
  unchanged(fullBefore, await videoBox(page));
  await wake(page); unchanged(fullBefore, await videoBox(page));
  await page.screenshot({ path: path.join(output, 'main-fullscreen.png') });
  await clickVisible(page, '退出全屏');
  await page.waitForFunction(() => !document.fullscreenElement);
  report.checks.push('main fullscreen: no metadata even on pointer movement; picture fills viewport and stays the same size');
  await page.evaluate(() => { document.querySelector('#player-layout-test').style.width = '640px'; });
  await wake(page);
  const popupEvent = app.waitForEvent('window');
  await clickVisible(page, '窗口模式');
  const popup = await popupEvent;
  await popup.locator('video').waitFor();
  await popup.waitForFunction(() => document.querySelector('video').videoWidth > 0);
  await wake(popup);
  const popupBefore = await videoBox(popup);
  assert.equal(await popup.locator('.floating-info-card').evaluate(node => getComputedStyle(node).position), 'absolute');
  await popup.screenshot({ path: path.join(output, 'floating.png') });
  await popup.waitForTimeout(2300);
  unchanged(popupBefore, await videoBox(popup));
  await wake(popup); unchanged(popupBefore, await videoBox(popup));
  await clickVisible(popup, '全屏');
  await popup.waitForFunction(() => document.documentElement.classList.contains('is-fullscreen'));
  await wake(popup);
  assert.equal(await popup.locator('.floating-info-card').evaluate(node => getComputedStyle(node).display), 'none');
  const floatingFullBefore = await videoBox(popup);
  await popup.waitForTimeout(2300);
  unchanged(floatingFullBefore, await videoBox(popup));
  await wake(popup); unchanged(floatingFullBefore, await videoBox(popup));
  await clickVisible(popup, '取消全屏');
  await popup.waitForFunction(() => !document.documentElement.classList.contains('is-fullscreen'));
  assert.equal(await page.evaluate(() => window.testStream.getVideoTracks()[0].readyState), 'live');
  await clickVisible(popup, '退出小窗');
  await page.waitForFunction(() => document.querySelector('#player-layout-test .stream-view').dataset.windowMode === 'MAIN');
  report.checks.push('floating normal/fullscreen: show/hide never resizes video; fullscreen hides metadata; source track remains alive after closing popup');
  report.ok = true;
} finally {
  await app?.close();
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
