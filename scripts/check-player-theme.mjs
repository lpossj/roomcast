import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron } from 'playwright';

const output = path.resolve(process.argv.find(value => value.startsWith('--output-dir='))?.slice('--output-dir='.length) || '.test/player-theme');
await mkdir(output, { recursive: true });
const bundle = await build({ stdin: { contents: `
import {createRoot} from 'react-dom/client';
import ScreenPlayer from './ScreenPlayer.jsx';
import {openFloatingPlayer} from './floating-player.js';
window.themeOpen=openFloatingPlayer;
const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;
const ctx=canvas.getContext('2d');window.themePaint=setInterval(()=>{ctx.fillStyle='#4d7cbf';ctx.fillRect(0,0,640,360);ctx.fillStyle='#fff';ctx.font='26px sans-serif';ctx.fillText('Roomcast',245,185);},50);
window.themeStream=canvas.captureStream(20);document.querySelector('.app-shell').style.display='none';
const host=document.createElement('div');host.id='theme-player';host.style.cssText='width:920px;max-width:calc(100vw - 48px);height:518px;margin:24px auto';document.body.append(host);
window.themeRoot=createRoot(host);window.themeRoot.render(<ScreenPlayer stream={{memberId:'self',name:'主题预览',avatarColor:3,settings:{},viewers:[]}} viewerMemberId="self" transport={{screenStream:window.themeStream}} initiallyEntered={true}/>);
`, loader: 'jsx', resolveDir: path.resolve('src') }, bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
const css = (await Promise.all(['styles.css','enhancements.css','multi-share.css','appearance.css'].map(file => readFile(path.resolve('src', file), 'utf8')))).join('\n');
const env = { ...process.env, ROOMCAST_TEST_MODE: '1', ROOMCAST_PROFILE_DIR: path.join(output, 'profile'), ROOMCAST_DATA_DIR: path.join(output, 'data') }; delete env.ELECTRON_RUN_AS_NODE;
const report = { startedAt: new Date().toISOString(), scope: 'actual Electron player + native floating window; synthetic canvas video', errors: [] };
let app;
try {
  app = await _electron.launch({ args: ['.'], env }); const main = await app.firstWindow();
  await main.locator('.app-shell').waitFor(); main.on('pageerror', error => report.errors.push(error.message));
  await main.route('**/player-theme-test.js', route => route.fulfill({ contentType: 'text/javascript', body: bundle.outputFiles[0].text }));
  await main.addStyleTag({ content: css }); await main.addScriptTag({ url: new URL('/player-theme-test.js', main.url()).href });
  await main.waitForFunction(() => document.querySelector('#theme-player video')?.videoWidth > 0);
  const ids = await main.evaluate(() => window.themeStream.getTracks().map(track => track.id));
  const popup = app.waitForEvent('window');
  await main.evaluate(() => { window.themeFloating = window.themeOpen(document.querySelector('#theme-player video'), { title: '主题预览', volume: 0.5, info: { title: '主题预览', avatarColor: 3 } }); });
  const child = await popup; child.on('pageerror', error => report.errors.push(error.message));
  await child.waitForFunction(() => document.querySelector('video')?.videoWidth > 0);
  const brightness = target => target.locator('.floating-control-button').first().evaluate(node => {
    const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d'); canvas.width = canvas.height = 1;
    ctx.fillStyle = getComputedStyle(node).backgroundColor; ctx.fillRect(0,0,1,1); const rgb = ctx.getImageData(0,0,1,1).data;
    return (rgb[0] + rgb[1] + rgb[2]) / 3;
  });
  await main.bringToFront(); await main.evaluate(() => { document.documentElement.dataset.appearance = 'light'; });
  await child.waitForFunction(() => document.documentElement.dataset.appearance === 'light');
  await main.waitForFunction(() => {
    const node=document.querySelector('.player-controls button'), canvas=document.createElement('canvas'), ctx=canvas.getContext('2d');canvas.width=canvas.height=1;
    ctx.fillStyle=getComputedStyle(node).backgroundColor;ctx.fillRect(0,0,1,1);const rgb=ctx.getImageData(0,0,1,1).data;return (rgb[0]+rgb[1]+rgb[2])/3 > 185;
  }, null, { timeout: 5000 });
  assert.ok(await main.locator('.player-controls button').first().evaluate(node => {
    const canvas=document.createElement('canvas'), ctx=canvas.getContext('2d');canvas.width=canvas.height=1;
    ctx.fillStyle=getComputedStyle(node).backgroundColor;ctx.fillRect(0,0,1,1);const rgb=ctx.getImageData(0,0,1,1).data;return (rgb[0]+rgb[1]+rgb[2])/3;
  }) > 185);
  assert.ok(await brightness(child) > 185); await child.mouse.move(160, 140);
  await main.screenshot({ path: path.join(output, 'day-preview.png') }); await child.screenshot({ path: path.join(output, 'day-floating.png') });
  await child.mouse.move(20, 90); await child.waitForTimeout(2400);
  await main.evaluate(() => { document.documentElement.dataset.appearance = 'dark'; });
  await child.waitForFunction(() => document.documentElement.dataset.appearance === 'dark'); assert.ok(await brightness(child) < 130);
  await main.evaluate(() => { document.documentElement.dataset.appearance = 'light'; document.documentElement.style.setProperty('--accent','#78ddbd'); });
  await child.waitForFunction(() => document.documentElement.dataset.appearance === 'light' && getComputedStyle(document.documentElement).getPropertyValue('--green').trim() === '#78ddbd');
  assert.deepEqual(await main.evaluate(() => window.themeStream.getTracks().filter(track => track.readyState === 'live').map(track => track.id)), ids);
  assert.deepEqual(await child.locator('video').evaluate(node => node.srcObject.getTracks().map(track => track.id)), ids);
  const closed = child.waitForEvent('close'); await main.evaluate(() => window.themeFloating.close()); await closed;
  await main.evaluate(() => { document.documentElement.dataset.appearance = 'dark'; });
  assert.deepEqual(await main.evaluate(() => window.themeStream.getTracks().filter(track => track.readyState === 'live').map(track => track.id)), ids);
  assert.deepEqual(report.errors, []); report.ok = true;
  report.checks = ['main/floating day and night controls, live accent sync after auto-hide, shared tracks unchanged, close releases theme observer without stopping source'];
} catch (error) { report.ok = false; report.failure = error.stack; process.exitCode = 1; }
finally { await app?.close(); report.finishedAt = new Date().toISOString(); await writeFile(path.join(output, 'report.json'), JSON.stringify(report,null,2)); console.log(JSON.stringify(report,null,2)); }
