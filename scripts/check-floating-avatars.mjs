import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron } from 'playwright';

const output = path.resolve('.test/floating-avatars'); await mkdir(output, { recursive: true });
const bundle = await build({ stdin: { resolveDir: path.resolve('src'), loader: 'js', contents: `
import { openFloatingPlayer } from './floating-player.js';
document.querySelector('.app-shell').style.display='none';
const canvas=document.createElement('canvas'); canvas.width=320;canvas.height=180;
const ctx=canvas.getContext('2d');ctx.fillStyle='#518871';ctx.fillRect(0,0,320,180);
const stream=canvas.captureStream(10); window.avatarSource=stream;
const video=document.createElement('video');video.autoplay=true;video.muted=true;video.srcObject=stream;video.style.width='640px';document.body.append(video);
const button=document.createElement('button');button.textContent='打开头像小窗';document.body.append(button);
window.avatarData=canvas.toDataURL('image/png');
button.onclick=()=>{window.avatarFloating=openFloatingPlayer(video,{title:'共享头像验证',soundAvailable:false,info:{title:'共享头像验证',avatarColor:2,viewers:[{memberId:'viewer',name:'头像朋友',avatarColor:1,avatar:window.avatarData}]}});};
window.changeFloatingAvatar=()=>{ctx.fillStyle='#397acd';ctx.fillRect(0,0,320,180);const avatar=canvas.toDataURL('image/png');window.avatarFloating.updateInfo({viewers:[{memberId:'viewer',name:'更新头像',avatarColor:3,avatar}]});return avatar;};
` }, bundle: true, write: false, format: 'iife' });
const report = { startedAt: new Date().toISOString(), checks: [], errors: [] };
const env = { ...process.env, ROOMCAST_TEST_MODE: '1', ROOMCAST_ALLOW_PARALLEL_INSTANCE: '1', ROOMCAST_PROFILE_DIR: path.join(output, 'profile') }; delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await _electron.launch({ args: ['.'], env }); const page = await app.firstWindow();
  await page.waitForURL(/http:\/\/127\.0\.0\.1/); await page.locator('.app-shell').waitFor();
  page.on('pageerror', error => report.errors.push(error.message));
  await page.route('**/floating-avatars.js', route => route.fulfill({ contentType: 'text/javascript', body: bundle.outputFiles[0].text }));
  await page.addScriptTag({ url: new URL('/floating-avatars.js', page.url()).href });
  const opened = app.waitForEvent('window'); await page.getByRole('button', { name: '打开头像小窗' }).click(); const child = await opened;
  child.on('pageerror', error => report.errors.push(error.message));
  await child.locator('.floating-viewer img').waitFor();
  assert.equal(await child.locator('.floating-viewer img').getAttribute('src'), await page.evaluate(() => window.avatarData));
  const wake = async (x = 160) => { await child.mouse.move(x, 140); await child.waitForTimeout(180); };
  await wake(); assert.equal(await child.locator('.floating-viewers').evaluate(node => Number(getComputedStyle(node).opacity)), 1);
  await child.waitForTimeout(2300); assert.equal(await child.locator('.floating-viewers').evaluate(node => Number(getComputedStyle(node).opacity)), 0);
  await wake(180);
  const click = async name => { const button = child.getByRole('button', { name, exact: true }); const box = await button.boundingBox(); await child.mouse.move(box.x + box.width / 2, box.y + box.height / 2); assert.ok(await button.evaluate(node => { const r = node.getBoundingClientRect(); return node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); })); await child.mouse.click(box.x + box.width / 2, box.y + box.height / 2); };
  await click('全屏'); await child.waitForFunction(() => document.documentElement.classList.contains('is-fullscreen'));
  await wake(220); assert.equal(await child.locator('.floating-viewers').evaluate(node => Number(getComputedStyle(node).opacity)), 1);
  const next = await page.evaluate(() => window.changeFloatingAvatar());
  await child.waitForFunction(value => document.querySelector('.floating-viewer img')?.getAttribute('src') === value, next);
  assert.equal(await child.locator('.floating-viewer.is-speaking').count(), 0);
  await wake(250); await child.screenshot({ path: path.join(output, 'fullscreen.png') });
  await child.waitForTimeout(2300); assert.equal(await child.locator('.floating-viewers').evaluate(node => Number(getComputedStyle(node).opacity)), 0);
  await wake(280); await click('取消全屏'); await child.waitForFunction(() => !document.documentElement.classList.contains('is-fullscreen'));
  await child.close(); assert.equal(await page.evaluate(() => window.avatarSource.getTracks().every(track => track.readyState === 'live')), true);
  report.checks.push('actual desktop small window and fullscreen show same custom avatar, live profile update, pointer wake/idle hide, no speaking ring, source tracks remain owned by main renderer');
  assert.deepEqual(report.errors, []); report.ok = true;
} catch (error) { report.ok = false; report.failure = error.stack; process.exitCode = 1; }
finally { await app?.close(); report.finishedAt = new Date().toISOString(); await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); }
