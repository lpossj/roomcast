import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const root = process.cwd();
const output = path.join(root, 'test-results', 'desktop');
await mkdir(output, { recursive: true });
const apps = [];
const report = { startedAt: new Date().toISOString(), checks: [] };
const record = (name, data = true) => { report.checks.push({ name, data }); console.log(name, JSON.stringify(data)); };
async function launch(index) {
  const packaged = process.env.ROOMCAST_SMOKE_EXE;
  const cleanEnv = { ...process.env };
  delete cleanEnv.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    executablePath: packaged || path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
    args: [...(packaged ? [] : [root]), '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
    env: { ...cleanEnv, ROOMCAST_TEST_MODE: '1', ROOMCAST_PROFILE_DIR: path.join(output, `profile-${index}`), ROOMCAST_DATA_DIR: path.join(output, `data-${index}`), PORT: String(3230 + index) },
    timeout: 45000,
  });
  apps.push(app);
  const page = await app.firstWindow();
  page.on('pageerror', error => record(`pageerror-${index}`, error.message));
  await page.waitForURL(`http://127.0.0.1:${3230 + index}/`, { timeout: 25000 });
  await page.waitForLoadState('domcontentloaded');
  await page.addInitScript(() => {
    window.__pcs = [];
    const NativePC = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends NativePC { constructor(...args) { super(...args); window.__pcs.push(this); } };
  });
  await page.reload();
  await page.getByRole('heading', { name: '欢迎来到同屏' }).waitFor({ timeout: 20000 });
  record(`desktop-${index}-startup`);
  return page;
}
try {
  const host = await launch(0);
  const guest = await launch(1);
  await writeFile(path.join(output, 'welcome.txt'), await host.locator('body').innerText());
  await host.locator('.empty-actions').getByRole('button', { name: '创建房间', exact: true }).click();
  let dialog = host.getByRole('dialog');
  await dialog.getByLabel('你的昵称', { exact: true }).fill('测试房主');
  await dialog.getByLabel('房间名称', { exact: true }).fill('P2P 验证房间');
  await dialog.getByLabel('房间密码', { exact: false }).fill('local-test-6271');
  await dialog.getByRole('button', { name: '创建并进入房间' }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 35000 });
  record('public-signaling-create-room');
  await host.locator('.room-header-actions').getByRole('button', { name: '邀请朋友', exact: true }).click();
  dialog = host.getByRole('dialog');
  const invite = await dialog.getByLabel('邀请链接', { exact: true }).inputValue();
  assert.match(invite, /^roomcast:\/\/join\/[A-F0-9]{8}\?secret=[A-Za-z0-9_-]{43}(?:&relay=.+)?$/);
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await guest.locator('.empty-actions').getByRole('button', { name: '加入房间', exact: true }).click();
  dialog = guest.getByRole('dialog');
  await dialog.getByLabel('你的昵称', { exact: true }).fill('测试朋友');
  await dialog.getByLabel('房间号 / 邀请链接', { exact: true }).fill(invite);
  await dialog.getByLabel('房间密码', { exact: false }).fill('local-test-6271');
  await dialog.getByRole('button', { name: '进入房间', exact: true }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 55000 });
  record('public-signaling-p2p-invite-join');
  await guest.getByRole('textbox', { name: '发送消息', exact: true }).fill('P2P 文字通道验证');
  await guest.getByRole('button', { name: '发送消息', exact: true }).click();
  await host.getByText('P2P 文字通道验证', { exact: true }).waitFor();
  record('p2p-chat');
  await host.locator('.icon-rail').getByRole('button', { name: '设置', exact: true }).click();
  dialog = host.getByRole('dialog');
  const inputSelect = dialog.getByLabel('选择麦克风');
  const outputSelect = dialog.getByLabel('选择扬声器');
  await inputSelect.waitFor();
  const inputValues = await inputSelect.locator('option').evaluateAll(options => options.map(option => option.value).filter(Boolean));
  const outputValues = await outputSelect.locator('option').evaluateAll(options => options.map(option => option.value).filter(Boolean));
  if (inputValues[0]) await inputSelect.selectOption(inputValues[0]);
  if (outputValues[0]) await outputSelect.selectOption(outputValues[0]);
  const savedDevices = await host.evaluate(() => window.roomcast.getPreference('audioDevices') || {});
  assert.equal(savedDevices.inputId || '', inputValues[0] || '');
  assert.equal(savedDevices.outputId || '', outputValues[0] || '');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  record('audio-device-selection-persisted', { inputs: inputValues.length, outputs: outputValues.length });
  await host.locator('.voice-dock').getByRole('button', { name: '共享屏幕', exact: true }).click();
  dialog = host.getByRole('dialog');
  await dialog.locator('.source-card').first().waitFor({ timeout: 60000 });
  await dialog.getByLabel('共享宽度').fill('1366');
  await dialog.getByLabel('共享高度').fill('768');
  await dialog.getByLabel('共享帧率').fill('24');
  await dialog.getByLabel('共享码率').fill('3000');
  assert.match(await dialog.locator('.engine-banner').innerText(), /原生采集.*WebRTC/i);
  record('native-webrtc-share-mode');
  await dialog.getByRole('checkbox', { name: /加入麦克风/ }).check();
  const shareStartedAt = Date.now();
  await dialog.getByRole('button', { name: '开始共享', exact: true }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 45000 });
  await guest.getByRole('button', { name: '点击进入共享', exact: true }).waitFor();
  assert.equal(await guest.locator('video').evaluateAll(videos => videos.some(video => !!video.srcObject)), false);
  record('share-does-not-autoplay');
  await guest.getByRole('button', { name: '点击进入共享', exact: true }).click();
  await host.getByRole('button', { name: '点击进入共享', exact: true }).click();
  await guest.waitForFunction(() => { const v = document.querySelector('video'); return v && v.videoWidth > 0 && v.getVideoPlaybackQuality().totalVideoFrames > 20; }, undefined, { timeout: process.env.ROOMCAST_DIAG ? 15000 : 60000 });
  await host.waitForFunction(() => { const v = document.querySelector('video'); return v && v.videoWidth > 0 && v.getVideoPlaybackQuality().totalVideoFrames > 5; }, undefined, { timeout: 30000 });
  await guest.getByRole('slider', { name: '共享音量' }).fill('0.42');
  assert.equal(await guest.locator('video').first().evaluate(video => Math.round(video.volume * 100)), 42);
  await guest.getByRole('button', { name: '窗口模式', exact: true }).click();
  await guest.locator('.stream-view.floating-window').waitFor();
  await guest.getByRole('button', { name: '恢复嵌入模式', exact: true }).click();
  record('viewer-volume-and-floating-window');
  await host.locator('.voice-dock').getByRole('button', { name: '修改共享设置', exact: true }).click();
  dialog = host.getByRole('dialog');
  await dialog.locator('.source-card').first().waitFor({ timeout: 60000 });
  await dialog.getByLabel('共享码率').fill('3200');
  await dialog.getByRole('button', { name: '应用并重新共享', exact: true }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 60000 });
  await guest.waitForFunction(() => {
    const video = document.querySelector('video');
    return video && video.videoWidth > 0 && !document.querySelector('.player-loading button');
  }, undefined, { timeout: 60000 });
  record('share-settings-restart-restores-viewer');
  const selfPreviewEntry = host.getByRole('button', { name: '点击进入共享', exact: true });
  const pcCountBeforeSelfPreview = await host.evaluate(() => (window.__pcs || []).length);
  if (await selfPreviewEntry.count()) await selfPreviewEntry.click();
  await host.waitForFunction(() => {
    const video = document.querySelector('video');
    return video?.srcObject?.active && video.videoWidth > 0;
  }, undefined, { timeout: 30000 });
  const selfPreview = await host.evaluate(() => {
    const video = document.querySelector('video');
    const videoTrack = video?.srcObject?.getVideoTracks?.()[0] || null;
    const senderTracks = (window.__pcs || []).flatMap(pc => pc.getSenders().map(sender => sender.track).filter(Boolean));
    return {
      pcCount: (window.__pcs || []).length,
      active: Boolean(video?.srcObject?.active),
      muted: Boolean(video?.muted),
      reusesPublishedTrack: Boolean(videoTrack && senderTracks.includes(videoTrack)),
      trackId: videoTrack?.id || '',
    };
  });
  assert.equal(selfPreview.pcCount, pcCountBeforeSelfPreview, 'self preview created an extra RTCPeerConnection');
  assert.equal(selfPreview.active, true);
  assert.equal(selfPreview.muted, true);
  assert.equal(selfPreview.reusesPublishedTrack, true, 'self preview did not reuse the published MediaStream track');
  await host.getByRole('button', { name: '退出观看', exact: true }).click();
  assert.equal(await host.locator('.stream-view').count(), 1);
  await guest.waitForFunction(() => { const v = document.querySelector('video'); return v && v.getVideoPlaybackQuality().totalVideoFrames > 30; }, undefined, { timeout: 15000 });
  await host.getByRole('button', { name: '点击进入共享', exact: true }).click();
  assert.equal(await host.evaluate(() => (window.__pcs || []).length), pcCountBeforeSelfPreview);
  record('owner-self-preview-reuses-native-stream', selfPreview);
  const stats = await guest.evaluate(async () => {
    const video = document.querySelector('video');
    const streams = [];
    for (const pc of window.__pcs || []) {
      if (pc.connectionState !== 'connected') continue;
      const report = await pc.getStats();
      for (const stat of report.values()) {
        if (stat.type === 'inbound-rtp') {
          const codec = report.get(stat.codecId);
          streams.push({ kind: stat.kind, bytesReceived: stat.bytesReceived, framesDecoded: stat.framesDecoded, codec: codec?.mimeType, jitterBufferMs: stat.jitterBufferEmittedCount ? Math.round(stat.jitterBufferDelay / stat.jitterBufferEmittedCount * 1000) : undefined, decoder: stat.decoderImplementation });
        }
      }
    }
    return { width: video.videoWidth, height: video.videoHeight, frames: video.getVideoPlaybackQuality().totalVideoFrames, streams };
  });
  const sender = await host.evaluate(async () => {
    const localTrack = document.querySelector('video')?.srcObject?.getVideoTracks?.()[0];
    const capture = localTrack ? { settings: localTrack.getSettings(), probed: localTrack.roomcastSourceSize, dpr: devicePixelRatio } : null;
    for (const pc of window.__pcs || []) {
      const report = await pc.getStats();
      for (const stat of report.values()) if (stat.type === 'outbound-rtp' && stat.kind === 'video' && stat.bytesSent > 0) return { codec: report.get(stat.codecId)?.mimeType, bytesSent: stat.bytesSent, framesEncoded: stat.framesEncoded, frameWidth: stat.frameWidth, frameHeight: stat.frameHeight, encoder: stat.encoderImplementation, capture };
    }
    return null;
  });
  record('native-webrtc-to-p2p-viewer', { stablePlaybackMs: Date.now() - shareStartedAt, ...stats, sender });
  assert.ok(stats.width >= 1300 && stats.width <= 1368 && stats.height >= 730 && stats.height <= 770, `custom resolution was not applied accurately: ${stats.width}x${stats.height}`);
  const playerText = await guest.locator('.stream-parameter-bar').innerText();
  assert.match(playerText, /1366×768/);
  assert.match(playerText, /24 FPS/);
  assert.match(playerText, /3200 Kbps/);
  assert.match(playerText, /清晰度优先/);
  record('custom-share-parameters-visible');
  await guest.getByRole('button', { name: '全屏', exact: true }).click();
  await guest.waitForFunction(() => document.fullscreenElement?.classList.contains('screen-player'), undefined, { timeout: 10000 });
  record('player-enters-fullscreen');
  await guest.getByRole('button', { name: '退出全屏', exact: true }).click();
  await guest.waitForFunction(() => !document.fullscreenElement, undefined, { timeout: 10000 });
  const savedSettings = await host.evaluate(() => window.roomcast.getPreference('shareSettings'));
  assert.deepEqual({ width: savedSettings.width, height: savedSettings.height, fps: savedSettings.fps, bitrate: savedSettings.bitrate, performanceMode: savedSettings.performanceMode, microphone: savedSettings.microphone }, { width: 1366, height: 768, fps: 24, bitrate: 3200, performanceMode: 'quality', microphone: true });
  record('share-settings-persisted');
  await guest.locator('.icon-rail').getByRole('button', { name: '设置', exact: true }).click();
  dialog = guest.getByRole('dialog');
  await dialog.getByRole('button', { name: '低延迟兼容', exact: false }).click();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await guest.locator('.voice-dock').getByRole('button', { name: '共享屏幕', exact: true }).click();
  dialog = guest.getByRole('dialog');
  await dialog.locator('.source-card').first().waitFor({ timeout: 60000 });
  const applicationAudioToggle = dialog.getByRole('radio', { name: /所选程序声音/ });
  await applicationAudioToggle.check();
  await applicationAudioToggle.waitFor({ state: 'attached' });
  assert.equal(await applicationAudioToggle.isChecked(), true);
  assert.ok(await dialog.getByRole('button', { name: '低延迟兼容', exact: false }).evaluate(button => button.classList.contains('selected')));
  await dialog.getByRole('button', { name: '选择游戏或应用', exact: true }).click();
  const applicationMenu = dialog.locator('.app-select-menu');
  await applicationMenu.getByRole('option').first().waitFor({ timeout: 30000 });
  assert.equal(await applicationMenu.evaluate(menu => getComputedStyle(menu).overflowY), 'auto');
  await applicationMenu.getByRole('option').first().click();
  record('native-application-audio-keeps-mode-and-scrolls');
  await dialog.getByLabel('共享宽度').fill('1280');
  await dialog.getByLabel('共享高度').fill('720');
  await dialog.getByLabel('共享帧率').fill('20');
  await dialog.getByLabel('共享码率').fill('2000');
  await dialog.getByRole('button', { name: '开始共享', exact: true }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 45000 });
  await host.getByRole('button', { name: '点击进入共享', exact: true }).click();
  await guest.getByRole('button', { name: '点击进入共享', exact: true }).click();
  await host.waitForFunction(() => [...document.querySelectorAll('video')].filter(video => video.videoWidth > 0).length >= 2, undefined, { timeout: 60000 });
  await guest.waitForFunction(() => [...document.querySelectorAll('video')].filter(video => video.videoWidth > 0).length >= 2, undefined, { timeout: 60000 });
  assert.equal(await host.locator('.stream-view').count(), 2);
  assert.equal(await guest.locator('.stream-view').count(), 2);
  const hostInbound = await host.evaluate(async () => {
    const inbound = [];
    for (const pc of window.__pcs || []) {
      const report = await pc.getStats();
      for (const stat of report.values()) if (stat.type === 'inbound-rtp' && stat.kind === 'video' && stat.framesDecoded > 0) inbound.push({ framesDecoded: stat.framesDecoded, bytesReceived: stat.bytesReceived, decoder: stat.decoderImplementation || '', codec: report.get(stat.codecId)?.mimeType || '' });
    }
    return inbound;
  });
  assert.ok(hostInbound.length >= 1 && hostInbound.some(item => item.bytesReceived > 0 && item.framesDecoded > 0));
  record('host-decodes-guest-share', hostInbound);
  record('simultaneous-host-and-guest-sharing');
  await guest.getByRole('button', { name: '退出观看', exact: true }).first().click();
  await guest.waitForFunction(() => !document.querySelector('video')?.srcObject);
  record('leaving-view-detaches-media');
  await host.getByRole('button', { name: '停止共享', exact: true }).click();
  await guest.waitForFunction(() => document.querySelectorAll('.stream-view').length === 1, undefined, { timeout: 15000 });
  assert.match(await guest.locator('.stream-parameter-bar').innerText(), /1280×720/);
  record('stop-one-share-keeps-other-share');
  await guest.getByRole('button', { name: '停止共享', exact: true }).click();
  await host.waitForFunction(() => document.querySelectorAll('.stream-view').length === 0, undefined, { timeout: 15000 });
  await writeFile(path.join(output, 'room.txt'), await host.locator('body').innerText());
  await host.getByRole('button', { name: '离开房间', exact: true }).click();
  await guest.waitForFunction(() => document.body.innerText.includes('房主') && document.body.innerText.includes('测试朋友'), undefined, { timeout: 15000 });
  record('host-leave-transfers-ownership');
  report.ok = true;
} catch (error) {
  report.ok = false; report.error = error.stack;
  for (let i = 0; i < apps.length; i++) {
    const p = apps[i].windows()[0];
    if (!p) continue;
    report[`page${i}`] = (await p.locator('body').innerText().catch(() => '')).slice(-4000);
    report[`media${i}`] = await p.evaluate(async () => {
      const videos = [...document.querySelectorAll('video')].map(video => ({ width: video.videoWidth, height: video.videoHeight, readyState: video.readyState, networkState: video.networkState, paused: video.paused, error: video.error?.message || '', quality: video.getVideoPlaybackQuality() }));
      const rtp = [];
      for (const pc of window.__pcs || []) {
        const stats = await pc.getStats();
        for (const stat of stats.values()) if (stat.type === 'inbound-rtp') rtp.push({ ...Object.fromEntries(Object.entries(stat).filter(([key]) => ['kind', 'codecId', 'bytesReceived', 'packetsReceived', 'packetsLost', 'framesReceived', 'framesDecoded', 'keyFramesDecoded', 'framesDropped', 'firCount', 'pliCount', 'nackCount', 'decoderImplementation'].includes(key))), codec: stats.get(stat.codecId)?.mimeType, fmtp: stats.get(stat.codecId)?.sdpFmtpLine });
      }
      return { videos, rtp, peerConnections: (window.__pcs || []).map(pc => ({ state: pc.connectionState, local: pc.localDescription?.sdp || '', remote: pc.remoteDescription?.sdp || '', transceivers: pc.getTransceivers().map(item => ({ currentDirection: item.currentDirection, codecs: item.receiver.getParameters().codecs })) })) };
    }).catch(failure => ({ error: failure.message }));
  }
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const app of apps.reverse()) await app.close().catch(() => { });
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
}
