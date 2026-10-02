import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron } from 'playwright';

const output = await mkdtemp(path.resolve('.test/desktop-profile-'));
const profile = path.join(output, 'profile'); await mkdir(profile);
const env = { ...process.env, ROOMCAST_TEST_MODE: '1', ROOMCAST_ALLOW_PARALLEL_INSTANCE: '1', ROOMCAST_PROFILE_DIR: profile, ROOMCAST_DATA_DIR: path.join(output, 'data') };
delete env.ELECTRON_RUN_AS_NODE;
const samples = 48000, wav = Buffer.alloc(44 + samples * 2);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
for (let index = 0; index < samples; index++) wav.writeInt16LE(Math.round(Math.sin(index * 2 * Math.PI * 440 / 48000) * 11000), 44 + index * 2);
const wavPath = path.join(output, 'microphone.wav'); await writeFile(wavPath, wav);
const args = ['.', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${wavPath}`];
const report = { startedAt: new Date().toISOString(), checks: [], errors: [] }; let app, page;
try {
  app = await _electron.launch({ args, env }); page = await app.firstWindow();
  await page.waitForURL(/http:\/\/127\.0\.0\.1/); await page.locator('.app-shell').waitFor();
  page.on('pageerror', error => report.errors.push(error.message));
  const avatar = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128;
    const ctx = canvas.getContext('2d'), image = ctx.createImageData(128, 128);
    for (let i = 0; i < image.data.length; i += 4) { image.data[i] = (i * 7) % 255; image.data[i + 1] = (i * 11) % 255; image.data[i + 2] = i % 255; image.data[i + 3] = 255; }
    ctx.putImageData(image, 0, 0); return canvas.toDataURL('image/jpeg', 0.8);
  });
  assert.equal(await page.evaluate(value => window.roomcast.setPreference('avatar', value), avatar), true);
  assert.equal(await page.evaluate(() => window.roomcast.setPreference('voiceSettings', { microphoneVolume: 0.42, outputVolume: 0.31, defaultMicrophone: false, defaultOutput: false })), true);
  assert.equal(await page.evaluate(() => window.roomcast.setPreference('autoCheckUpdates', false)), true);
  assert.equal(await page.evaluate(() => window.roomcast.setPreference('panelWidths', { members: 280, chat: 300 })), true);
  assert.equal(await page.evaluate(() => window.roomcast.setPreference('appearance', 'light')), true);
  await app.close(); app = await _electron.launch({ args, env }); page = await app.firstWindow();
  await page.waitForURL(/http:\/\/127\.0\.0\.1/); await page.locator('.rail-avatar img').waitFor();
  page.on('pageerror', error => report.errors.push(error.message));
  assert.equal(await page.locator('.rail-avatar img').getAttribute('src'), avatar);
  assert.equal(await page.getByLabel('麦克风音量').inputValue(), '0.42');
  assert.equal(await page.getByLabel('成员声音音量').inputValue(), '0.31');
  assert.equal(await page.locator('html').getAttribute('data-appearance'), 'light');
  assert.equal(await page.locator('.channel-sidebar').evaluate(node => node.offsetWidth), 280);
  report.checks.push('desktop appearance and panel widths persist across restart');
  report.checks.push('encrypted desktop avatar and voice settings persist across a real Electron restart');
  await page.evaluate(() => {

      window.testMonitors = []; window.testContexts = [];
      const NativeContext = window.AudioContext;
      window.AudioContext = class extends NativeContext { constructor(...args) { super(...args); window.testContexts.push(this); } };
      const connectNode = AudioNode.prototype.connect, disconnectNode = AudioNode.prototype.disconnect;
      AudioNode.prototype.connect = function (target, ...args) {
        const result = connectNode.call(this, target, ...args);
        if (this instanceof GainNode && target === this.context.destination) {
          const analyser = this.context.createAnalyser(); connectNode.call(this, analyser);
          window.testMonitors.push({ node: this, analyser, connected: true });
        }
        return result;
      };
      AudioNode.prototype.disconnect = function (...args) { for (const monitor of window.testMonitors) if (monitor.node === this) monitor.connected = false; return disconnectNode.apply(this, args); };
    window.testAudios = []; const create = document.createElement.bind(document);
    document.createElement = (tag, ...args) => { const node = create(tag, ...args); if (tag === 'audio') window.testAudios.push(node); return node; };
    window.testTracks = []; const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = options => original(options).then(stream => { window.testTracks.push(...stream.getTracks()); return stream; });
  });
  await page.getByRole('button', { name: '设置', exact: true }).click(); const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '音频与采集', exact: true }).click();
  await dialog.getByRole('button', { name: '开始测试', exact: true }).click();
  await page.waitForFunction(() => window.testTracks.length > 0 && document.querySelector('meter')?.value > 0);
  await page.waitForFunction(() => window.testMonitors.some(monitor => { const samples = new Float32Array(128); monitor.analyser.getFloatTimeDomainData(samples); return monitor.connected && monitor.node.gain.value === 1 && monitor.node.context.state === 'running' && samples.some(value => Math.abs(value) > 0.001); }));
  await page.screenshot({ path: path.join(output, 'desktop-microphone-test.png') });
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.waitForFunction(() => window.testTracks.every(track => track.readyState === 'ended'));
  assert.equal(await page.evaluate(() => window.testAudios.every(audio => !audio.srcObject && audio.paused) && window.testMonitors.every(monitor => !monitor.connected || monitor.node.gain.value === 0)), true);
  report.checks.push('desktop ear return plays and detaches; actual desktop media permission permits microphone test, closing settings ends capture');
  assert.deepEqual(report.errors, []); report.ok = true;
} catch (error) { report.ok = false; report.failure = error.stack; try { report.debug = await page.evaluate(() => ({ errors: [...document.querySelectorAll('.inline-error')].map(node => node.textContent), meter: document.querySelector('meter')?.value, monitors: window.testMonitors?.map(monitor => ({ connected: monitor.connected, gain: monitor.node.gain.value, state: monitor.node.context.state, sinkId: monitor.node.context.sinkId })) })); } catch {} process.exitCode = 1; }
finally { await app?.close(); report.finishedAt = new Date().toISOString(); await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ output, ...report }, null, 2)); }
