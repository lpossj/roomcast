import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';

// Bundle the real ShareModal in memory; no production exports or files change.
const source = await readFile('src/App.jsx', 'utf8');
const bundle = await build({ stdin: { contents: source + `
import { createRoot } from 'react-dom/client';
const testRoot = createRoot(document.getElementById('root'));
testRoot.render(<ShareModal onClose={()=>{}} onStart={()=>{}} audioDevices={{preferences:{inputId:'',outputId:''},devices:{inputs:[],outputs:[]}}} busy={false}/>);
`, resolveDir: process.cwd() + '/src', loader: 'jsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  page.on('pageerror', error => console.error(error.message));
  await page.setContent('<div id="root"></div>');
  await page.evaluate(() => {
    window.audioRequests = [];
    window.roomcast = {
      desktop: true,
      getPreference: key => key === 'shareSettings' ? { audioMode: 'exclude', audioSourceId: '900' } : undefined,
      setPreference: (key, value) => { if (key === 'shareSettings') window.savedAudio = value; return true; },
      captureSources: async () => [{ id: 'screen:1', type: 'monitor', name: 'Screen' }],
      audioSources: () => new Promise((resolve, reject) => window.audioRequests.push({ resolve, reject })),
    };
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.waitForFunction(() => window.audioRequests.length === 1);
  await page.getByRole('button', { name: '刷新采集来源' }).click();
  await page.waitForFunction(() => window.audioRequests.length === 2);
  const chrome = { processId: '900', processName: 'chrome.exe', name: 'Chrome', sessionProcessIds: ['10'] };
  await page.evaluate(row => window.audioRequests[1].resolve([row]), chrome);
  await page.waitForFunction(() => document.body.textContent.includes('Chrome'));
  await page.evaluate(() => window.audioRequests[0].resolve([{ processId: '1', processName: 'old.exe', name: 'Old' }]));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.getByRole('button', { name: '从系统声音中排除', exact: true }).innerText(), 'Chrome');
  assert.equal(await page.evaluate(() => window.savedAudio.audioSourceId), '900');
  await page.getByRole('radio', { name: /所选程序声音/ }).check();
  assert.equal(await page.getByRole('button', { name: '选择游戏或应用', exact: true }).innerText(), 'Chrome');
  await page.getByRole('button', { name: '刷新采集来源' }).click();
  await page.waitForFunction(() => window.audioRequests.length === 3);
  await page.evaluate(() => window.audioRequests[2].reject(new Error('Windows audio access denied')));
  await page.waitForFunction(() => document.body.textContent.includes('Windows audio access denied'));
  assert.equal(await page.evaluate(() => window.savedAudio.audioSourceId), '900');
  console.log('PASS: stale native refresh ignored; both audio lists retain selection; enumeration failure displayed');
} finally { await browser.close(); }
