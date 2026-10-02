import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium, firefox, webkit } from 'playwright';

const { createStaticViewer } = createRequire(import.meta.url)('../electron/web-invite.cjs');
const server = createStaticViewer(path.resolve('dist'));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const output = path.resolve('.test/browser-compatibility'); await mkdir(output, { recursive: true });
const report = { startedAt: new Date().toISOString(), engines: [], errors: [] };
try {
  for (const [name, engine, options] of [['edge', chromium, { channel: 'msedge' }], ['firefox', firefox, {}], ['webkit', webkit, {}]]) {
    if (process.argv.includes('--engine') && process.argv[process.argv.indexOf('--engine') + 1] !== name) continue;
    let browser, host;
    const result = { name, checks: [] }; report.engines.push(result);
    const stage = value => { result.stage = value; console.log(`[compatibility] ${name}: ${value}`); };
    const watchdog = setTimeout(() => {
      result.ok = false; result.failure = `Browser stalled at ${result.stage}`; report.ok = false;
      writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.error(JSON.stringify(report, null, 2)); process.exit(1);
    }, 120_000);
    try {
      stage('launch');
      browser = await engine.launch({ headless: true, ...options, ...(name === 'firefox' && process.env.ROOMCAST_FIREFOX_EXECUTABLE ? { executablePath: process.env.ROOMCAST_FIREFOX_EXECUTABLE } : {}) });
      stage('context');
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const peers = new Map();
      await context.routeWebSocket('**/*', socket => {
        const url = new URL(socket.url()), id = url.searchParams.get('id');
        if (!url.hostname.endsWith('peerjs.com')) { socket.close(); return; }
        peers.set(id, socket);
        socket.onMessage(data => { const message = JSON.parse(String(data)); if (message.dst) peers.get(message.dst)?.send(JSON.stringify({ ...message, src: id })); });
        socket.onClose(() => peers.delete(id)); socket.send(JSON.stringify({ type: 'OPEN' }));
      });
      await context.addInitScript(() => {
        window.testBackground = false;
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => window.testBackground ? 'hidden' : 'visible' });
        window.testPointers = [];
        for (const type of ['pointerdown', 'pointermove', 'pointerup', 'gotpointercapture', 'lostpointercapture']) document.addEventListener(type, event => window.testPointers.push({ type, x: event.clientX, button: event.button, target: event.target.className }));
      });
      stage('pages'); host = await context.newPage(); const guest = await context.newPage();
      for (const page of [host, guest]) page.on('pageerror', error => report.errors.push(`${name}: ${error.message}`));
      const origin = `http://127.0.0.1:${server.address().port}`;
      stage('load'); await host.goto(origin); await host.locator('.app-shell').waitFor();
      result.capabilities = await host.evaluate(() => ({ secure: isSecureContext, microphone: typeof navigator.mediaDevices?.getUserMedia === 'function', rtc: typeof RTCPeerConnection === 'function', audio: typeof globalThis.AudioContext === 'function', mediaDestination: typeof globalThis.AudioContext?.prototype.createMediaStreamDestination === 'function' }));
      const rail = await host.locator('.icon-rail').evaluate(node => node.offsetWidth);
      const handle = host.getByRole('separator', { name: '调整成员栏宽度' });
      await handle.press('ArrowRight'); await host.waitForFunction(() => document.querySelector('.channel-sidebar').offsetWidth === 250);
      assert.equal(await host.locator('.channel-sidebar').evaluate(node => node.offsetWidth), 250);
      const box = await handle.boundingBox(); await host.mouse.move(box.x + 4, box.y + box.height / 2); await host.mouse.down();
      await host.mouse.move(box.x + 34, box.y + box.height / 2); await host.mouse.up();
      await host.waitForFunction(() => document.querySelector('.channel-sidebar').offsetWidth === 280);
      assert.equal(await host.locator('.channel-sidebar').evaluate(node => node.offsetWidth), 280);
      assert.equal(await host.locator('.icon-rail').evaluate(node => node.offsetWidth), rail);
      stage('theme'); await host.getByRole('button', { name: '切换日间主题', exact: true }).click();
      await host.waitForFunction(() => document.documentElement.dataset.appearance === 'light');
      await host.locator('.theme-confetti').waitFor({ state: 'detached' });
      assert.equal(await host.locator('.theme-confetti').count(), 0);
      stage('reload'); await host.reload(); await host.locator('.app-shell').waitFor(); assert.equal(await host.locator('html').getAttribute('data-appearance'), 'light');
      await host.getByRole('button', { name: '设置', exact: true }).click(); let dialog = host.getByRole('dialog');
      assert.equal(await dialog.getByLabel('后台状态通知').count(), 0);
      if (result.capabilities.microphone) {
        await dialog.getByRole('button', { name: '音频与采集', exact: true }).click();
        assert.equal(await dialog.getByText('测试时本地耳返，不会开启房间麦克风').count(), 0);
      } else assert.equal(await dialog.getByRole('button', { name: '音频与采集', exact: true }).count(), 0);
      await dialog.getByRole('button', { name: '关闭', exact: true }).click();
      stage('audio'); if (result.capabilities.audio) {
        await host.evaluate(() => {
          const button = document.createElement('button'); button.textContent = '兼容音频测试'; button.className = 'compat-audio-test';
          button.style.cssText = 'position:fixed;top:0;left:300px;z-index:99999';
          button.onclick = () => { window.testAudioReady = (async () => {
        const context = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
        window.testAudioContext = context;
        const oscillator = context.createOscillator(), gain = context.createGain(), analyser = context.createAnalyser();
        const destination = context.createMediaStreamDestination?.(); if (destination) destination.channelCount = 1;
        oscillator.connect(gain); if (destination) gain.connect(destination); gain.connect(analyser); gain.connect(context.destination);
        gain.gain.value = 0.02; oscillator.start(); let timeout;
        try {
          await Promise.race([context.resume(), new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('Interactive audio did not start within 5 seconds')), 5000); })]);
          await new Promise(resolve => setTimeout(resolve, 150));
          const samples = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(samples);
          return { state: context.state, rate: context.sampleRate, nonzero: samples.some(value => Math.abs(value) > 0.001), track: destination?.stream.getAudioTracks()[0]?.readyState, viewTransition: typeof document.startViewTransition === 'function' };
        } finally {
          clearTimeout(timeout); oscillator.stop(); oscillator.disconnect(); gain.disconnect(); analyser.disconnect(); destination?.stream.getTracks().forEach(track => track.stop());
          void context.close().catch(() => {});
        }
          })(); };
          document.body.append(button);
        });
        await host.getByRole('button', { name: '兼容音频测试', exact: true }).click();
        result.audio = await host.evaluate(() => window.testAudioReady);
        await host.locator('.compat-audio-test').evaluate(node => node.remove());
      }
      if (result.capabilities.audio) { assert.equal(result.audio.state, 'running'); assert.equal(result.audio.nonzero, true); }
      if (result.capabilities.mediaDestination) assert.equal(result.audio.track, 'live');
      result.checks.push('desktop pointer/keyboard resizing, fixed rail, saved day theme and concise settings');
      if (result.capabilities.audio) result.checks.push('interactive Web Audio graph produces actual nonzero PCM');
      if (!result.capabilities.rtc) {
        result.unverified = 'Windows Playwright WebKit does not expose WebRTC/getUserMedia; real Safari hardware room/audio/background behavior cannot be tested on this engine.';
        await host.setViewportSize({ width: 390, height: 844 });
        assert.equal(await host.getByRole('separator', { name: '调整成员栏宽度' }).isVisible(), false);
        await host.getByRole('button', { name: '查看成员', exact: true }).click(); assert.equal(await host.locator('.channel-sidebar').isVisible(), true);
        await host.screenshot({ path: path.join(output, `${name}-mobile.png`) });
        await host.getByRole('button', { name: '关闭成员栏', exact: true }).click();
        await host.getByRole('button', { name: '切换夜间主题', exact: true }).click(); await host.waitForFunction(() => document.documentElement.dataset.appearance === 'dark');
        await host.waitForTimeout(1000); await host.locator('.theme-confetti').waitFor({ state: 'detached' });
        result.checks.push('390px mobile drawer and theme; unavailable audio UI correctly omitted'); result.ok = true; continue;
      }
      stage('room'); await host.locator('.empty-actions').getByRole('button', { name: '创建房间', exact: true }).click(); dialog = host.getByRole('dialog');
      await dialog.getByLabel('你的昵称').fill('兼容房主'); await dialog.getByRole('button', { name: '创建并进入房间' }).click(); await dialog.waitFor({ state: 'hidden' });
      await host.getByRole('button', { name: '邀请朋友', exact: true }).click(); dialog = host.getByRole('dialog');
      const invite = await dialog.getByLabel('邀请链接', { exact: true }).inputValue(); await dialog.getByRole('button', { name: '关闭', exact: true }).click();
      stage('join'); await guest.goto(`${origin}/#room=${encodeURIComponent(invite)}`); dialog = guest.getByRole('dialog');
      await dialog.getByLabel('你的昵称').fill('兼容成员'); await dialog.getByRole('button', { name: '进入房间', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
      await host.waitForFunction(() => document.querySelectorAll('.member-row').length === 2);
      await guest.evaluate(() => { window.testBackground = true; document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })); });
      assert.equal(await guest.title(), '同屏 · 后台聊天');
      await guest.evaluate(() => { window.testBackground = false; document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); });
      assert.equal(await guest.title(), '同屏 Roomcast');
      await guest.getByRole('textbox', { name: '发送消息', exact: true }).fill(`${name}兼容聊天`);
      await guest.getByRole('textbox', { name: '发送消息', exact: true }).press('Enter'); await host.getByText(`${name}兼容聊天`, { exact: true }).waitFor();
      await guest.setViewportSize({ width: 390, height: 844 });
      assert.equal(await guest.getByRole('separator', { name: '调整成员栏宽度' }).isVisible(), false);
      await guest.getByRole('button', { name: '查看成员', exact: true }).click(); assert.equal(await guest.locator('.channel-sidebar').isVisible(), true);
      await guest.screenshot({ path: path.join(output, `${name}-mobile.png`) });
      await guest.getByRole('button', { name: '关闭成员栏', exact: true }).click();
      await guest.getByRole('button', { name: '切换夜间主题', exact: true }).click();
      await guest.waitForFunction(() => document.documentElement.dataset.appearance === 'dark');
      await guest.waitForTimeout(1000); await guest.locator('.theme-confetti').waitFor({ state: 'detached' });
      assert.equal(await guest.locator('html').getAttribute('data-appearance'), 'dark');
      await guest.getByRole('button', { name: '离开房间', exact: true }).click(); await host.waitForFunction(() => document.querySelectorAll('.member-row').length === 1);
      result.checks.push('real RTC room/chat, BFCache/background title without leave, 390px mobile drawer/theme and voluntary cleanup');
      result.ok = true;
    } catch (error) { result.ok = false; result.failure = error.stack; try { result.debug = await host.evaluate(() => ({ audioState: window.testAudioContext?.state, body: document.body.innerText, width: document.querySelector('.channel-sidebar')?.offsetWidth, pointers: window.testPointers?.slice(-12), drag: document.querySelector('.app-shell')?.className })); await host.screenshot({ path: path.join(output, `${name}-failure.png`) }); } catch {} }
    finally { stage('close'); await browser?.close(); clearTimeout(watchdog); }
  }
  assert.ok(report.engines.length > 0 && report.engines.every(result => result.ok), 'Every selected browser engine must pass');
  assert.deepEqual(report.errors, []); report.ok = true;
} catch (error) { report.ok = false; report.failure = error.stack; process.exitCode = 1; }
finally { await new Promise(resolve => server.close(resolve)); report.finishedAt = new Date().toISOString(); await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); }
