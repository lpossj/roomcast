import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const origin = 'https://roomcast-2dy.pages.dev';
const output = path.resolve('.test/live-beta7'); await mkdir(output, { recursive: true });
const site = path.resolve('release/Roomcast-0.14.4-beta.7-WebViewer');
const hash = value => createHash('sha256').update(value).digest('hex');
const report = { startedAt: new Date().toISOString(), origin, checks: [], errors: [] }; let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['microphone'] });
  const version = await context.request.get(`${origin}/version.json?check=${Date.now()}`); assert.equal(version.status(), 200);
  report.version = await version.json(); assert.equal(report.version.version, '0.14.4-beta.7');
  const index = await context.request.get(`${origin}/?check=${Date.now()}`);
  assert.equal(hash(await index.body()), hash(await readFile(path.join(site,'index.html'))));
  const paths = (await readdir(path.join(site, 'assets'))).filter(name => /\.(js|css)$/.test(name)).map(name => `/assets/${name}`);
  assert.ok(paths.length >= 2, 'Must verify actual production JS/CSS, not just HTML');
  report.assets = [];
  for (const relative of paths) { const response = await context.request.get(`${origin}${relative}`); assert.equal(response.status(),200); const digest = hash(await response.body()); assert.equal(digest, hash(await readFile(path.join(site,relative.slice(1))))); report.assets.push({ path:relative,sha256:digest }); }
  for (const relative of ['/api/config','/updater.exe']) assert.equal((await context.request.get(`${origin}${relative}`)).status(),404);
  report.checks.push('production domain version beta.7; actual HTML/entry JS/CSS bytes equal validated local artifacts; desktop API/updater remain absent');
  const page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message)); await page.goto(origin);
  await page.evaluate(() => { window.testAudios = []; const create = document.createElement.bind(document); document.createElement = (tag, ...args) => { const node = create(tag, ...args); if(tag === 'audio') window.testAudios.push(node); return node; }; });
  await page.getByRole('button',{name:'设置',exact:true}).click(); let dialog=page.getByRole('dialog');
  await dialog.getByLabel('选择头像图片').waitFor();
  await dialog.getByRole('button',{name:'音频与采集',exact:true}).click();
  assert.equal(await dialog.getByLabel('默认开启麦克风',{exact:true}).isChecked(),false);
  assert.equal(await dialog.getByLabel('默认开启成员声音',{exact:true}).isChecked(),false);
  await dialog.getByRole('button',{name:'开始测试',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('meter')?.value>0);
  await page.waitForFunction(() => window.testAudios.some(audio => audio.srcObject && !audio.muted && !audio.paused && audio.currentTime > 0));
  await page.screenshot({path:path.join(output,'online-audio-settings.png')});
  await dialog.getByRole('button',{name:'结束测试',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('meter')?.value===0);
  assert.equal(await page.evaluate(() => window.testAudios.every(audio => !audio.srcObject && audio.paused)),true);
  report.checks.push('production ear return plays and detaches on stop; actual production browser renders avatar upload, default-off audio options and working local mic meter');
  assert.deepEqual(report.errors,[]); report.ok=true;
} catch(error) { report.ok=false;report.failure=error.stack;process.exitCode=1; }
finally { await browser?.close();report.finishedAt=new Date().toISOString();await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2)); }
