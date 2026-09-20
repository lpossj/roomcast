import { build } from 'esbuild';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { _electron } from 'playwright';

const bundle = await build({
  stdin: {
    contents: `
import { createRoot } from 'react-dom/client';
import ScreenPlayer from './ScreenPlayer.jsx';
import { openFloatingPlayer } from './floating-player.js';
window.testOpenFloating = openFloatingPlayer;
const canvas=document.createElement('canvas'); canvas.width=320; canvas.height=180;
const ctx=canvas.getContext('2d'); let tick=0;
window.testPaint=setInterval(()=>{ctx.fillStyle=++tick%2?'red':'blue';ctx.fillRect(0,0,320,180);},50);
window.testStream=canvas.captureStream(20);
const host=document.createElement('div'); host.id='floating-test'; host.style.width='640px';document.body.append(host);
window.testRoot=createRoot(host);
window.testRoot.render(<ScreenPlayer stream={{memberId:'self',name:'Test',avatarColor:3,path:'test',settings:{}}} viewerMemberId="self" transport={{screenStream:window.testStream}} initiallyEntered={true}/>);
`, loader: 'jsx', resolveDir: path.resolve('src')
  }, bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }
});
const sourceCss = await Promise.all([
  readFile(path.resolve('src/styles.css'), 'utf8'),
  readFile(path.resolve('src/multi-share.css'), 'utf8'),
]).then(parts => parts.join('\n'));
const floatingWindowSource = await readFile(path.resolve('electron/floating-window.cjs'), 'utf8');
assert.match(floatingWindowSource, /frame:\s*false/, '独立小窗必须使用 frame:false 移除原生标题栏');
assert.doesNotMatch(floatingWindowSource, /titleBarOverlay/, '独立小窗不能继续使用原生 titleBarOverlay 按钮区域');

const env = { ...process.env, ROOMCAST_TEST_MODE: '1', ROOMCAST_PROFILE_DIR: path.resolve('test-results/floating/profile') };
delete env.ELECTRON_RUN_AS_NODE;
const app = await _electron.launch({
  args: ['.'],
  env,
});

let mouseMoveSequence = 0;
const moveMouseInside = async (targetPage, selector) => {
  const target = targetPage.locator(selector).first();
  await target.waitFor({ state: 'visible' });
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  assert.ok(box && box.width >= 8 && box.height >= 8, `无法取得鼠标目标区域：${selector}`);

  // Use real Playwright mouse input instead of dispatchEvent(). React's synthetic
  // event layer and Electron scheduling can make untrusted pointer events a poor
  // proxy for the actual product behavior. Alternate the target point so every
  // call produces genuine mouse movement even if the cursor was already inside.
  const phase = (mouseMoveSequence++ % 2) === 0 ? 0.37 : 0.63;
  const x = box.x + Math.max(4, Math.min(box.width - 4, box.width * phase));
  const y = box.y + Math.max(4, Math.min(box.height - 4, box.height * (1 - phase)));
  const viewport = await targetPage.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const startX = Math.max(1, Math.min(viewport.width - 2, x + (phase < 0.5 ? 18 : -18)));
  const startY = Math.max(1, Math.min(viewport.height - 2, y + (phase < 0.5 ? -14 : 14)));

  await targetPage.mouse.move(startX, startY);
  await targetPage.mouse.move(x, y, { steps: 4 });
};

const mainUiSnapshot = page => page.evaluate(() => {
  const player = document.querySelector('#floating-test .screen-player');
  const info = document.querySelector('#floating-test .player-info-overlay');
  const exit = document.querySelector('#floating-test .exit-view-button');
  const controls = document.querySelector('#floating-test .player-controls');
  return {
    exists: Boolean(player && info && exit && controls),
    visible: Boolean(player?.classList.contains('controls-visible')),
    hidden: Boolean(player?.classList.contains('controls-hidden')),
    cursor: player ? getComputedStyle(player).cursor : '',
    infoOpacity: info ? Number.parseFloat(getComputedStyle(info).opacity) : -1,
    exitOpacity: exit ? Number.parseFloat(getComputedStyle(exit).opacity) : -1,
    controlsOpacity: controls ? Number.parseFloat(getComputedStyle(controls).opacity) : -1,
  };
});

const showMainPlayerUi = async page => {
  await moveMouseInside(page, '#floating-test .screen-player');
  try {
    await page.waitForFunction(() => {
      const player = document.querySelector('#floating-test .screen-player');
      return player?.classList.contains('controls-visible') && getComputedStyle(player).cursor !== 'none';
    }, null, { timeout: 1500 });
    await page.waitForFunction(() => {
      const player = document.querySelector('#floating-test .screen-player');
      const info = document.querySelector('#floating-test .player-info-overlay');
      const exit = document.querySelector('#floating-test .exit-view-button');
      const controls = document.querySelector('#floating-test .player-controls');
      if (!player || !info || !exit || !controls) return false;
      return player.classList.contains('controls-visible')
        && !player.classList.contains('controls-hidden')
        && getComputedStyle(player).cursor !== 'none'
        && Number.parseFloat(getComputedStyle(info).opacity) > 0.95
        && Number.parseFloat(getComputedStyle(exit).opacity) > 0.95
        && Number.parseFloat(getComputedStyle(controls).opacity) > 0.95;
    }, null, { timeout: 1500 });
    return;
  } catch (error) {
    const snapshot = await mainUiSnapshot(page).catch(() => ({ snapshotFailed: true }));
    throw new Error(`主播放器 pointermove 后 UI 未恢复：${JSON.stringify(snapshot)}\n${error.message}`);
  }
};

const waitMainPlayerUiHidden = async page => {
  // It must not disappear immediately; the product requirement is a 2s idle delay.
  await page.waitForTimeout(900);
  const early = await mainUiSnapshot(page);
  assert.equal(early.visible, true, `主播放器 UI 在 2 秒前提前隐藏：${JSON.stringify(early)}`);
  await page.waitForFunction(() => {
    const player = document.querySelector('#floating-test .screen-player');
    const info = document.querySelector('#floating-test .player-info-overlay');
    const exit = document.querySelector('#floating-test .exit-view-button');
    const controls = document.querySelector('#floating-test .player-controls');
    if (!player || !info || !exit || !controls) return false;
    return player.classList.contains('controls-hidden')
      && getComputedStyle(player).cursor === 'none'
      && Number.parseFloat(getComputedStyle(info).opacity) < 0.05
      && Number.parseFloat(getComputedStyle(exit).opacity) < 0.05
      && Number.parseFloat(getComputedStyle(controls).opacity) < 0.05;
  }, null, { timeout: 3500 });
};

const floatingUiSnapshot = child => child.evaluate(() => {
  const controls = document.querySelector('.floating-controls');
  const info = document.querySelector('.floating-info-card');
  const infoStyle = info ? getComputedStyle(info) : null;
  return {
    exists: Boolean(controls && info),
    visible: Boolean(controls?.classList.contains('visible')),
    cursorHidden: document.documentElement.classList.contains('cursor-hidden'),
    uiHidden: document.documentElement.classList.contains('ui-hidden'),
    infoDisplay: infoStyle?.display || '',
    infoOpacity: infoStyle ? Number.parseFloat(infoStyle.opacity) : -1,
  };
});

const showFloatingUi = async child => {
  await moveMouseInside(child, 'video');
  try {
    await child.waitForFunction(() => {
      const controls = document.querySelector('.floating-controls');
      const info = document.querySelector('.floating-info-card');
      const infoStyle = getComputedStyle(info);
      return Boolean(controls?.classList.contains('visible'))
        && !document.documentElement.classList.contains('cursor-hidden')
        && !document.documentElement.classList.contains('ui-hidden')
        && infoStyle.display !== 'none'
        && Number.parseFloat(infoStyle.opacity) > 0.95;
    }, null, { timeout: 1500 });
  } catch (error) {
    const snapshot = await floatingUiSnapshot(child).catch(() => ({ snapshotFailed: true }));
    throw new Error(`小窗 pointermove 后 UI 未恢复：${JSON.stringify(snapshot)}\n${error.message}`);
  }
};

const waitFloatingUiHidden = async child => {
  await child.waitForTimeout(900);
  const early = await floatingUiSnapshot(child);
  assert.equal(early.visible, true, `小窗 UI 在 2 秒前提前隐藏：${JSON.stringify(early)}`);
  await child.waitForFunction(() => {
    const controls = document.querySelector('.floating-controls');
    const info = document.querySelector('.floating-info-card');
    const infoStyle = getComputedStyle(info);
    return Boolean(controls && info)
      && !controls.classList.contains('visible')
      && document.documentElement.classList.contains('cursor-hidden')
      && document.documentElement.classList.contains('ui-hidden')
      && (infoStyle.display === 'none' || Number.parseFloat(infoStyle.opacity) < 0.05);
  }, null, { timeout: 3500 });
};

const mainButton = (page, name) => page.locator('#floating-test').getByRole('button', { name, exact: true });

const clickMainButton = async (page, name) => {
  // Match real usage: moving toward a control must first reveal/reset the UI,
  // and the control itself must win hit testing over the underlying <video>.
  await showMainPlayerUi(page);
  const button = mainButton(page, name);
  await button.hover({ timeout: 2500 });
  await button.click({ timeout: 2500 });
};

const clickFloatingButton = async (child, name) => {
  await showFloatingUi(child);
  const button = child.getByRole('button', { name, exact: true });
  await button.hover({ timeout: 2500 });
  await button.click({ timeout: 2500 });
};

try {
  console.log('[floating-player-check] 启动 Electron 测试窗口');
  const page = await app.firstWindow();
  page.on('pageerror', error => console.error(error.message));
  await page.waitForURL(/http:\/\/127\.0\.0\.1/);
  await page.waitForLoadState('load');
  await page.route('**/floating-test.js', route => route.fulfill({ contentType: 'text/javascript', body: bundle.outputFiles[0].text }));
  // The test renderer is bundled from current src. Inject the matching source CSS
  // as well so this check never mixes fresh JSX with a stale dist stylesheet.
  await page.addStyleTag({ content: sourceCss });
  await page.addScriptTag({ url: new URL('/floating-test.js', page.url()).href });
  await page.waitForFunction(() => document.querySelector('#floating-test video')?.videoWidth === 320);
  await page.evaluate(() => {
    window.originalVideo = document.querySelector('#floating-test video');
    window.originalSource = window.originalVideo.srcObject;
    window.forbiddenCalls = 0;
    window.RTCPeerConnection = class { constructor() { window.forbiddenCalls++; throw new Error('Unexpected renegotiation'); } };
  });
  const before = await page.locator('#floating-test .stream-view').boundingBox();

  // Normal in-room preview and fullscreen share the same inactivity behavior:
  // show immediately, then hide all player UI + cursor after two seconds.
  await showMainPlayerUi(page);
  assert.equal(await page.evaluate(() => document.querySelector('#floating-test .player-info-overlay')?.parentElement?.classList.contains('screen-player')), true);
  const previewLayout = await page.evaluate(() => {
    const player = document.querySelector('#floating-test .screen-player');
    const info = player?.querySelector('.player-info-overlay');
    const exit = player?.querySelector('.exit-view-button');
    const video = player?.querySelector('video');
    if (!player || !info || !exit || !video) return { missing: true };

    const playerBox = player.getBoundingClientRect();
    const videoBox = video.getBoundingClientRect();
    const infoBox = info.getBoundingClientRect();
    return {
      missing: false,
      infoPosition: getComputedStyle(info).position,
      infoParentIsPlayer: info.parentElement === player,
      exitParentIsStage: exit.parentElement === video.parentElement && exit.parentElement?.classList.contains('player-stage'),
      exitInsideInfo: info.contains(exit),
      infoOverlapsVideo: infoBox.left < videoBox.right
        && infoBox.right > videoBox.left
        && infoBox.top < videoBox.bottom
        && infoBox.bottom > videoBox.top,
      infoMatchesPlayerWidth: Math.abs(infoBox.width - playerBox.width) < 1,
      videoStartsBelowInfo: Math.abs(videoBox.top - infoBox.bottom) < 1,
      videoStartsInsidePlayer: videoBox.top >= playerBox.top - 1
        && videoBox.top <= playerBox.bottom + 1,
    };
  });
  assert.equal(previewLayout.missing, false, `主播放器必要 DOM 缺失：${JSON.stringify(previewLayout)}`);
  assert.equal(previewLayout.infoPosition, 'relative', `共享信息条必须参与正常布局，不能覆盖视频：${JSON.stringify(previewLayout)}`);
  assert.equal(previewLayout.infoParentIsPlayer, true, `共享信息条必须直接挂在 screen-player 下：${JSON.stringify(previewLayout)}`);
  assert.equal(previewLayout.exitParentIsStage, true, `退出观看必须位于独立的 player-stage 媒体层，不能塞进顶部信息条：${JSON.stringify(previewLayout)}`);
  assert.equal(previewLayout.exitInsideInfo, false, `退出观看不能位于共享信息条内部：${JSON.stringify(previewLayout)}`);
  assert.equal(previewLayout.infoOverlapsVideo, false, `共享信息条不能覆盖视频：${JSON.stringify(previewLayout)}`);
  assert.equal(previewLayout.infoMatchesPlayerWidth, true, `共享信息条应横向占满播放器顶部：${JSON.stringify(previewLayout)}`);
  assert.equal(previewLayout.videoStartsBelowInfo, true, `视频必须从共享信息条下方开始：${JSON.stringify(previewLayout)}`);
  assert.equal(previewLayout.videoStartsInsidePlayer, true, `视频应从播放器自身区域开始：${JSON.stringify(previewLayout)}`);
  assert.equal(await page.locator('#floating-test .player-info-overlay').getAttribute('class').then(value => value.includes('avatar-color-3')), true);
  assert.equal(await page.locator('#floating-test .player-info-overlay').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(83, 59, 56)');
  assert.equal(await page.locator('#floating-test .player-controls').evaluate(node => Number.parseInt(getComputedStyle(node).zIndex, 10) > 0), true, '底部控制栏必须位于 video 之上的可点击层');
  // Layout/color checks above can legitimately take longer than the 2s inactivity
  // timer. Re-activate the player immediately before asserting the visible state.
  await showMainPlayerUi(page);

  await waitMainPlayerUiHidden(page);
  await showMainPlayerUi(page);

  await clickMainButton(page, '全屏');
  await page.waitForFunction(() => document.fullscreenElement?.classList.contains('screen-player'));
  await page.waitForFunction(() => {
    const player = document.querySelector('#floating-test .screen-player');
    return player?.classList.contains('controls-visible')
      && !player.classList.contains('controls-hidden')
      && getComputedStyle(player).cursor !== 'none';
  }, null, { timeout: 1200 });
  const mainFullscreenLayout = await page.evaluate(() => {
    const player = document.querySelector('#floating-test .screen-player');
    const info = player?.querySelector('.player-info-overlay');
    const video = player?.querySelector('video');
    if (!player || !info || !video) return { missing: true };
    const playerBox = player.getBoundingClientRect();
    const infoBox = info.getBoundingClientRect();
    const videoBox = video.getBoundingClientRect();
    return {
      missing: false,
      infoPosition: getComputedStyle(info).position,
      infoTop: infoBox.top,
      playerTop: playerBox.top,
      infoWidth: infoBox.width,
      playerWidth: playerBox.width,
      videoTop: videoBox.top,
      infoBottom: infoBox.bottom,
      overlap: infoBox.left < videoBox.right
        && infoBox.right > videoBox.left
        && infoBox.top < videoBox.bottom
        && infoBox.bottom > videoBox.top,
    };
  });
  assert.equal(mainFullscreenLayout.missing, false, `主播放器全屏必要 DOM 缺失：${JSON.stringify(mainFullscreenLayout)}`);
  assert.equal(mainFullscreenLayout.infoPosition, 'relative', `全屏信息条必须参与正常布局：${JSON.stringify(mainFullscreenLayout)}`);
  assert.ok(Math.abs(mainFullscreenLayout.infoTop - mainFullscreenLayout.playerTop) < 1, `全屏信息条必须贴播放器顶部：${JSON.stringify(mainFullscreenLayout)}`);
  assert.ok(Math.abs(mainFullscreenLayout.infoWidth - mainFullscreenLayout.playerWidth) < 1, `全屏信息条必须横向占满播放器：${JSON.stringify(mainFullscreenLayout)}`);
  assert.ok(Math.abs(mainFullscreenLayout.videoTop - mainFullscreenLayout.infoBottom) < 1, `全屏视频必须从信息条下方开始：${JSON.stringify(mainFullscreenLayout)}`);
  assert.equal(mainFullscreenLayout.overlap, false, `全屏信息条不能覆盖视频：${JSON.stringify(mainFullscreenLayout)}`);
  // Reset from a real mouse movement, then verify the full 2s idle cycle.
  await showMainPlayerUi(page);
  await waitMainPlayerUiHidden(page);
  await showMainPlayerUi(page);
  await clickMainButton(page, '退出全屏');
  await page.waitForFunction(() => !document.fullscreenElement);
  await page.waitForFunction(() => {
    const player = document.querySelector('#floating-test .screen-player');
    return player?.classList.contains('controls-visible')
      && !player.classList.contains('controls-hidden')
      && !player.classList.contains('fullscreen-controls-hidden')
      && getComputedStyle(player).cursor !== 'none';
  }, null, { timeout: 1200 });
  // Ordinary preview resumes the same 2s auto-hide behavior after fullscreen.
  await showMainPlayerUi(page);
  await waitMainPlayerUiHidden(page);
  await showMainPlayerUi(page);
  console.log('[floating-player-check] 主播放器普通预览/全屏 UI 状态通过');

  const mainBoundsBefore = await app.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find(win => win.webContents.getURL() !== 'about:blank');
    return main.getBounds();
  });

  await showMainPlayerUi(page);
  await clickMainButton(page, '窗口模式');

  await page.waitForFunction(
    () => document.querySelector('#floating-test .stream-view')?.dataset.windowMode === 'FLOATING'
  );

  const child = app.windows().find(candidate => candidate !== page);
  assert.ok(child);
  await child.waitForFunction(() => document.querySelector('video')?.videoWidth === 320);
  await showFloatingUi(child);
  assert.equal(await child.locator('.floating-info-card').getAttribute('data-avatar-color'), '3');
  assert.equal(await child.locator('.floating-info-card').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(83, 59, 56)');
  assert.ok(await child.locator('.floating-info-card').evaluate(node => Number.parseFloat(getComputedStyle(node).opacity) > 0.95));
  assert.equal((await child.locator('.floating-info-card').innerText()).includes('Test'), true);
  const floatingLayout = await child.evaluate(() => {
    const card = document.querySelector('.floating-info-card');
    const video = document.querySelector('video');
    const cardBox = card.getBoundingClientRect();
    const videoBox = video.getBoundingClientRect();
    const cardStyle = getComputedStyle(card);
    return {
      cardPosition: cardStyle.position,
      cardTop: cardBox.top,
      cardBottom: cardBox.bottom,
      cardWidth: cardBox.width,
      viewportWidth: innerWidth,
      videoTop: videoBox.top,
      videoBottom: videoBox.bottom,
      viewportHeight: innerHeight,
      overlap: cardBox.left < videoBox.right
        && cardBox.right > videoBox.left
        && cardBox.top < videoBox.bottom
        && cardBox.bottom > videoBox.top,
      appRegion: cardStyle.getPropertyValue('-webkit-app-region'),
    };
  });
  assert.equal(floatingLayout.cardPosition, 'relative', `普通浮窗顶部信息框必须参与正常布局：${JSON.stringify(floatingLayout)}`);
  assert.ok(Math.abs(floatingLayout.cardTop) < 1, `顶部信息框必须贴 BrowserWindow content 顶部：${JSON.stringify(floatingLayout)}`);
  assert.ok(Math.abs(floatingLayout.cardWidth - floatingLayout.viewportWidth) < 1, `顶部信息框必须横向占满窗口内容区：${JSON.stringify(floatingLayout)}`);
  assert.ok(Math.abs(floatingLayout.videoTop - floatingLayout.cardBottom) < 1, `视频必须从顶部信息框下方开始：${JSON.stringify(floatingLayout)}`);
  assert.equal(floatingLayout.overlap, false, `普通浮窗顶部信息框不能覆盖视频：${JSON.stringify(floatingLayout)}`);
  assert.ok(Math.abs(floatingLayout.videoBottom - floatingLayout.viewportHeight) < 1, `视频区域必须填满顶部信息框以下剩余空间：${JSON.stringify(floatingLayout)}`);
  assert.equal(floatingLayout.appRegion, 'drag', `顶部信息框必须承担 frameless 窗口拖动：${JSON.stringify(floatingLayout)}`);

  const nativeFrameState = await app.evaluate(({ BrowserWindow }) => {
    const floating = BrowserWindow.getAllWindows().find(win => win.webContents.getURL() === 'about:blank');
    return {
      bounds: floating.getBounds(),
      contentBounds: floating.getContentBounds(),
      alwaysOnTop: floating.isAlwaysOnTop(),
      resizable: floating.isResizable(),
      minimizable: floating.isMinimizable(),
      maximizable: floating.isMaximizable(),
    };
  });
  assert.deepEqual(nativeFrameState.contentBounds, nativeFrameState.bounds, `frameless 浮窗不应保留原生标题栏占用：${JSON.stringify(nativeFrameState)}`);
  assert.equal(nativeFrameState.minimizable, false, '独立小窗不应保留原生最小化能力/按钮');
  assert.equal(nativeFrameState.maximizable, false, '独立小窗不应保留原生最大化能力/按钮');
  assert.equal(nativeFrameState.alwaysOnTop, true);
  assert.equal(nativeFrameState.resizable, true);

  const fullButton = child.getByRole('button', { name: '全屏', exact: true });
  const exitWindowButton = child.getByRole('button', { name: '退出小窗', exact: true });
  assert.equal((await fullButton.innerText()).trim(), '');
  assert.equal(await fullButton.getAttribute('title'), '全屏');
  assert.equal(await fullButton.locator('.floating-control-label').count(), 0);
  assert.equal((await exitWindowButton.innerText()).trim(), '');
  assert.equal(await exitWindowButton.getAttribute('title'), '退出小窗');
  assert.equal(await exitWindowButton.locator('.floating-control-label').count(), 0);

  await showFloatingUi(child);
  const dragStart = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => win.webContents.getURL() === 'about:blank').getBounds());
  const dragBox = await child.locator('.floating-info-card').boundingBox();
  assert.ok(dragBox && dragBox.width > 80 && dragBox.height > 20, '无法取得浮窗拖动区域');
  await child.mouse.move(dragBox.x + Math.min(120, dragBox.width / 2), dragBox.y + dragBox.height / 2);
  await child.mouse.down();
  await child.mouse.move(dragBox.x + Math.min(120, dragBox.width / 2) + 48, dragBox.y + dragBox.height / 2 + 32, { steps: 6 });
  await child.mouse.up();
  await child.waitForTimeout(150);
  const dragEnd = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => win.webContents.getURL() === 'about:blank').getBounds());
  assert.ok(dragEnd.x !== dragStart.x || dragEnd.y !== dragStart.y, `frameless 浮窗顶部信息框无法实际拖动窗口：${JSON.stringify({ dragStart, dragEnd })}`);
  await app.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows().find(win => win.webContents.getURL() === 'about:blank').setBounds(bounds), dragStart);

  await showFloatingUi(child);
  await waitFloatingUiHidden(child);
  await showFloatingUi(child);

  // about:blank inherits the preload, but main-process authorization must reject
  // every sensitive IPC call originating from the floating renderer itself.
  const security = await child.evaluate(async floatingId => {
    const bridge = window.roomcast;
    const rejects = async action => {
      try { await action(); return false; }
      catch { return true; }
    };
    return {
      hasBridge: Boolean(bridge),
      prepareBlocked: bridge?.prepareFloatingWindow?.() == null,
      preferenceReadBlocked: bridge?.getPreference?.('playbackVolume') === undefined,
      preferenceWriteBlocked: bridge?.setPreference?.('playbackVolume', 0.123456) === false,
      captureSelectBlocked: bridge?.selectCapture?.({ id: 'floating-test-invalid-source', audio: false }) === false,
      localBlocked: await rejects(() => bridge.localAction('status')),
      captureSourcesBlocked: await rejects(() => bridge.captureSources()),
      fullscreenBlocked: await rejects(() => bridge.prepareFullscreen()),
      clipboardBlocked: await rejects(() => bridge.copyText('floating-window-security-test')),
      audioSourcesBlocked: await rejects(() => bridge.audioSources()),
      ownFloatingActionBlocked: await rejects(() => bridge.floatingAction({ id: floatingId, action: 'fullscreen' })),
    };
  }, 'not-owned-by-floating-renderer');

  await child.evaluate(() => {
    window.open('about:blank', 'roomcast-nested-test');
    window.roomcast.closeReady();
  });

  assert.deepEqual(security, {
    hasBridge: true,
    prepareBlocked: true,
    preferenceReadBlocked: true,
    preferenceWriteBlocked: true,
    captureSelectBlocked: true,
    localBlocked: true,
    captureSourcesBlocked: true,
    fullscreenBlocked: true,
    clipboardBlocked: true,
    audioSourcesBlocked: true,
    ownFloatingActionBlocked: true,
  });

  await page.waitForTimeout(100);
  assert.equal((await app.windows()).length, 2);

  await child.evaluate(() => {
    const link = document.createElement('a');
    link.href = 'https://example.invalid/roomcast-floating-navigation-test';
    link.textContent = 'blocked navigation';
    document.body.append(link);
    link.click();
  });
  await page.waitForTimeout(100);
  assert.equal(child.url(), 'about:blank');

  const audioIsolation = {
    sourceMuted: await page.evaluate(() => window.originalVideo.muted),
    floatingMuted: await child.evaluate(() => document.querySelector('video').muted),
    floatingAudioTracks: await child.evaluate(() => document.querySelector('video').srcObject.getAudioTracks().length),
  };
  assert.deepEqual(audioIsolation, { sourceMuted: true, floatingMuted: true, floatingAudioTracks: 0 });

  // Self-view is always silent and does not expose misleading sound controls.
  assert.equal(await child.getByRole('button', { name: '播放共享声音', exact: true }).count(), 0);
  assert.equal(await child.getByRole('slider', { name: '共享音量', exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => window.originalVideo.muted), true);
  assert.equal(await child.evaluate(() => document.querySelector('video').muted && document.querySelector('video').srcObject.getAudioTracks().length === 0), true);

  // Floating mode visually detaches the main player without moving/replacing its
  // source video DOM or transport. The room view keeps only the detached placeholder:
  // no duplicate picture, stats strip, exit button, or player controls remain visible.
  assert.deepEqual(await page.evaluate(() => ({
    opacity: getComputedStyle(window.originalVideo).opacity,
    placeholder: document.querySelector('#floating-test .floating-detached-placeholder')?.textContent.includes('画面已移至小窗') || false,
    info: document.querySelectorAll('#floating-test .player-info-overlay').length,
    top: document.querySelectorAll('#floating-test .player-top').length,
    exit: document.querySelectorAll('#floating-test .exit-view-button').length,
    controls: document.querySelectorAll('#floating-test .player-controls').length,
  })), { opacity: '0', placeholder: true, info: 0, top: 0, exit: 0, controls: 0 });
  await showFloatingUi(child);
  await waitFloatingUiHidden(child);
  await showFloatingUi(child);

  await child.evaluate(() => {
    const video = document.querySelector('video');
    window.__floatingFrameCount = 0;

    const countFrame = () => {
      window.__floatingFrameCount++;
      video.requestVideoFrameCallback(countFrame);
    };

    video.requestVideoFrameCallback(countFrame);
  });

  await child.waitForFunction(() => window.__floatingFrameCount >= 3);
  const framesBeforeMinimize = await child.evaluate(() => window.__floatingFrameCount);

  await app.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find(
      win => win.webContents.getURL() !== 'about:blank'
    );
    main.minimize();
  });

  await page.waitForTimeout(1000);

  const minimizedResult = await app.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows();
    const main = windows.find(win => win.webContents.getURL() !== 'about:blank');
    const floating = windows.find(win => win.webContents.getURL() === 'about:blank');

    return {
      minimized: main.isMinimized(),
      floatingVisible: floating.isVisible(),
      floatingMinimized: floating.isMinimized(),
    };
  });

  const framesAfterMinimize = await child.evaluate(() => window.__floatingFrameCount);

  assert.equal(minimizedResult.minimized, true);
  assert.equal(minimizedResult.floatingVisible, true);
  assert.equal(minimizedResult.floatingMinimized, false);
  assert.ok(
    framesAfterMinimize > framesBeforeMinimize,
    `浮窗在主窗口最小化后停止出帧：${framesBeforeMinimize} -> ${framesAfterMinimize}`
  );

  await app.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find(
      win => win.webContents.getURL() !== 'about:blank'
    );
    main.restore();
  });
  const native = await app.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows();
    const child = windows.find(w => w.webContents.getURL() === 'about:blank');
    child.setBounds({ x: 10, y: 10, width: 1000, height: 700 });
    return { top: child.isAlwaysOnTop(), resizable: child.isResizable(), bounds: child.getBounds() };
  });
  assert.equal(native.top, true);
  assert.equal(native.resizable, true);
  assert.equal(native.bounds.width, 1000);
  assert.equal(native.bounds.height, 700);
  await showFloatingUi(child);
  await clickFloatingButton(child, '全屏');
  await page.waitForFunction(() => document.querySelector('#floating-test .stream-view').dataset.windowMode === 'FLOATING_FULLSCREEN');
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL() === 'about:blank').isFullScreen()), true);
  await showFloatingUi(child);
  const floatingFullscreenLayout = await child.evaluate(() => {
    const card = document.querySelector('.floating-info-card');
    const video = document.querySelector('video');
    if (!card || !video) return { missing: true };
    const cardBox = card.getBoundingClientRect();
    const videoBox = video.getBoundingClientRect();
    return {
      missing: false,
      cardPosition: getComputedStyle(card).position,
      cardTop: cardBox.top,
      cardBottom: cardBox.bottom,
      cardWidth: cardBox.width,
      viewportWidth: innerWidth,
      videoTop: videoBox.top,
      videoBottom: videoBox.bottom,
      viewportHeight: innerHeight,
      overlap: cardBox.left < videoBox.right
        && cardBox.right > videoBox.left
        && cardBox.top < videoBox.bottom
        && cardBox.bottom > videoBox.top,
    };
  });
  assert.equal(floatingFullscreenLayout.missing, false, `全屏浮窗必要 DOM 缺失：${JSON.stringify(floatingFullscreenLayout)}`);
  assert.equal(floatingFullscreenLayout.cardPosition, 'relative', `全屏浮窗信息条必须参与正常布局：${JSON.stringify(floatingFullscreenLayout)}`);
  assert.ok(Math.abs(floatingFullscreenLayout.cardTop) < 1, `全屏浮窗信息条必须贴窗口顶部：${JSON.stringify(floatingFullscreenLayout)}`);
  assert.ok(Math.abs(floatingFullscreenLayout.cardWidth - floatingFullscreenLayout.viewportWidth) < 1, `全屏浮窗信息条必须横向占满窗口：${JSON.stringify(floatingFullscreenLayout)}`);
  assert.ok(Math.abs(floatingFullscreenLayout.videoTop - floatingFullscreenLayout.cardBottom) < 1, `全屏浮窗视频必须从信息条下方开始：${JSON.stringify(floatingFullscreenLayout)}`);
  assert.equal(floatingFullscreenLayout.overlap, false, `全屏浮窗信息条不能覆盖视频：${JSON.stringify(floatingFullscreenLayout)}`);
  assert.ok(Math.abs(floatingFullscreenLayout.videoBottom - floatingFullscreenLayout.viewportHeight) < 1, `全屏浮窗视频必须填满信息条以下空间：${JSON.stringify(floatingFullscreenLayout)}`);
  await child.waitForFunction(() => {
    const controls = document.querySelector('.floating-controls');
    return controls?.classList.contains('visible')
      && !document.documentElement.classList.contains('ui-hidden')
      && !document.documentElement.classList.contains('cursor-hidden');
  }, null, { timeout: 1200 });
  const exitFullscreenButton = child.getByRole('button', { name: '取消全屏', exact: true });
  assert.equal((await exitFullscreenButton.innerText()).trim(), '');
  assert.equal(await exitFullscreenButton.getAttribute('title'), '取消全屏');
  assert.equal(await exitFullscreenButton.locator('.floating-control-label').count(), 0);

  // Fullscreen shows controls/cursor for two seconds, then hides both until the
  // mouse moves again. Re-arm with real mouse input before timing the idle cycle.
  await showFloatingUi(child);
  await waitFloatingUiHidden(child);
  await showFloatingUi(child);

  await clickFloatingButton(child, '取消全屏');
  await page.waitForFunction(() => document.querySelector('#floating-test .stream-view').dataset.windowMode === 'FLOATING');
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL() === 'about:blank').isFullScreen()), false);
  await child.waitForFunction(() => {
    const controls = document.querySelector('.floating-controls');
    return controls?.classList.contains('visible')
      && !document.documentElement.classList.contains('ui-hidden')
      && !document.documentElement.classList.contains('cursor-hidden');
  }, null, { timeout: 1200 });
  await showFloatingUi(child);
  console.log('[floating-player-check] 小窗 UI / 全屏 / 安全 / 最小化出帧通过');
  await clickFloatingButton(child, '退出小窗');
  await page.waitForFunction(() => document.querySelector('#floating-test .stream-view').dataset.windowMode === 'MAIN');
  assert.deepEqual(await page.locator('#floating-test .stream-view').boundingBox(), before);
  assert.deepEqual(await app.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find(win => win.webContents.getURL() !== 'about:blank');
    return main.getBounds();
  }), mainBoundsBefore);
  assert.deepEqual(await page.evaluate(() => ({
    opacity: getComputedStyle(window.originalVideo).opacity,
    placeholder: Boolean(document.querySelector('#floating-test .floating-detached-placeholder')),
  })), { opacity: '1', placeholder: false });
  assert.equal(await page.evaluate(() => window.originalVideo === document.querySelector('#floating-test video') && window.originalVideo.srcObject === window.originalSource && window.testStream.getVideoTracks()[0].readyState === 'live' && window.forbiddenCalls === 0), true);
  // Reopen the floating player after a complete close.
  await page.waitForTimeout(100);

  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().filter(
        win => win.webContents.getURL() === 'about:blank'
      ).length
    ),
    0
  );

  assert.equal(child.isClosed(), true);

  await showMainPlayerUi(page);
  await clickMainButton(page, '窗口模式');

  await page.waitForFunction(
    () => document.querySelector('#floating-test .stream-view')?.dataset.windowMode === 'FLOATING'
  );

  const secondChild = app.windows().find(
    candidate => candidate !== page && !candidate.isClosed()
  );

  assert.ok(secondChild);

  await secondChild.waitForFunction(
    () => document.querySelector('video')?.videoWidth === 320
  );

  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().filter(
        win => win.webContents.getURL() === 'about:blank'
      ).length
    ),
    1
  );

  await showFloatingUi(secondChild);
  await clickFloatingButton(secondChild, '退出小窗');

  await page.waitForFunction(
    () => document.querySelector('#floating-test .stream-view')?.dataset.windowMode === 'MAIN'
  );

  await page.waitForTimeout(100);

  assert.equal(secondChild.isClosed(), true);

  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().filter(
        win => win.webContents.getURL() === 'about:blank'
      ).length
    ),
    0
  );

  assert.deepEqual(
    await page.locator('#floating-test .stream-view').boundingBox(),
    before
  );

  assert.equal(
    await page.evaluate(() =>
      window.originalVideo === document.querySelector('#floating-test video') &&
      window.originalVideo.srcObject === window.originalSource &&
      window.testStream.getVideoTracks()[0].readyState === 'live' &&
      window.forbiddenCalls === 0
    ),
    true
  );
  // Verify two independent floating windows can coexist.
  await page.evaluate(async () => {
    window.multiSourceA = document.createElement('video');
    window.multiSourceB = document.createElement('video');

    for (const video of [window.multiSourceA, window.multiSourceB]) {
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      video.srcObject = window.testStream;
      document.body.append(video);
      await video.play();
    }

    window.multiFloatA = window.testOpenFloating(window.multiSourceA, {
      title: 'Multi A'
    });

    window.multiFloatB = window.testOpenFloating(window.multiSourceB, {
      title: 'Multi B'
    });
  });

  await page.waitForFunction(() => {
    const floats = [window.multiFloatA, window.multiFloatB];
    return floats.every(item => item?.id);
  });

  await page.waitForTimeout(200);

  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().filter(
        win => win.webContents.getURL() === 'about:blank'
      ).length
    ),
    2
  );

  const multiIds = await page.evaluate(() => [
    window.multiFloatA.id,
    window.multiFloatB.id
  ]);

  assert.notEqual(multiIds[0], multiIds[1]);

  await page.evaluate(() => window.multiFloatA.close());

  await page.waitForTimeout(200);

  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().filter(
        win => win.webContents.getURL() === 'about:blank'
      ).length
    ),
    1
  );

  assert.equal(
    await page.evaluate(() =>
      window.testStream.getVideoTracks()[0].readyState === 'live'
    ),
    true
  );

  await page.evaluate(() => window.multiFloatB.close());

  await page.waitForTimeout(200);

  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().filter(
        win => win.webContents.getURL() === 'about:blank'
      ).length
    ),
    0
  );

  assert.equal(
    await page.evaluate(() => {
      const live = window.testStream.getVideoTracks()[0].readyState === 'live';

      window.multiSourceA.remove();
      window.multiSourceB.remove();

      return live;
    }),
    true
  );
  // Floating audio controls mirror the main video state, while the floating
  // video itself stays muted and contains video tracks only.
  await page.evaluate(async () => {
    window.audioSource = document.createElement('video');
    window.audioSource.autoplay = true;
    window.audioSource.playsInline = true;
    window.audioSource.muted = false;
    window.audioSource.volume = 0.35;
    window.audioSource.srcObject = window.testStream;
    document.body.append(window.audioSource);
    await window.audioSource.play();
    window.audioFloat = window.testOpenFloating(window.audioSource, {
      title: 'Audio sync',
      onSound: enabled => { window.audioSource.muted = !enabled; },
      onVolume: value => { window.audioSource.volume = value; },
    });
  });

  const audioChild = app.windows().find(candidate => candidate !== page && !candidate.isClosed());
  assert.ok(audioChild);
  await audioChild.waitForFunction(() => document.querySelector('video')?.videoWidth === 320);
  assert.deepEqual(await audioChild.evaluate(() => ({
    muted: document.querySelector('video').muted,
    audioTracks: document.querySelector('video').srcObject.getAudioTracks().length,
    soundLabel: document.querySelector('button[aria-label="关闭共享声音"]')?.getAttribute('aria-label') || '',
    volume: document.querySelector('input[type="range"]').value,
  })), { muted: true, audioTracks: 0, soundLabel: '关闭共享声音', volume: '0.35' });

  await page.evaluate(() => {
    window.audioSource.muted = true;
    window.audioSource.volume = 0.62;
  });
  await audioChild.waitForFunction(() => {
    const sound = document.querySelector('button[aria-label="播放共享声音"]');
    return Boolean(sound) && document.querySelector('input[type="range"]').value === '0.62';
  });

  await showFloatingUi(audioChild);
  await clickFloatingButton(audioChild, '播放共享声音');
  await page.waitForFunction(() => window.audioSource.muted === false);
  await audioChild.getByRole('button', { name: '关闭共享声音', exact: true }).waitFor();

  await audioChild.evaluate(() => {
    const input = document.querySelector('input[type="range"]');
    input.value = '0.27';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => Math.abs(window.audioSource.volume - 0.27) < 0.001);

  await page.evaluate(() => window.audioFloat.close());
  await page.waitForTimeout(100);
  assert.equal(audioChild.isClosed(), true);
  assert.equal(await page.evaluate(() => window.testStream.getVideoTracks()[0].readyState === 'live'), true);
  await page.evaluate(() => window.audioSource.remove());

  // Track additions/removals/ending in a MediaStream must be reflected in the
  // floating copy, and closing it must never stop the original source track.
  await page.evaluate(async () => {
    window.dynamicSource = document.createElement('video');
    window.dynamicSource.autoplay = true;
    window.dynamicSource.muted = true;
    window.dynamicSource.playsInline = true;
    window.dynamicStream = new MediaStream([window.testStream.getVideoTracks()[0]]);
    window.dynamicSource.srcObject = window.dynamicStream;
    document.body.append(window.dynamicSource);
    await window.dynamicSource.play();

    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 180;
    canvas.getContext('2d').fillRect(0, 0, 320, 180);
    window.dynamicExtraStream = canvas.captureStream(5);
    window.dynamicExtraTrack = window.dynamicExtraStream.getVideoTracks()[0];
    window.dynamicFloat = window.testOpenFloating(window.dynamicSource, { title: 'Track lifecycle' });
  });

  const dynamicChild = app.windows().find(candidate => candidate !== page && !candidate.isClosed());
  assert.ok(dynamicChild);
  await dynamicChild.waitForFunction(() => document.querySelector('video')?.srcObject?.getVideoTracks().length === 1);

  await page.evaluate(() => window.dynamicStream.addTrack(window.dynamicExtraTrack));
  await dynamicChild.waitForFunction(() => document.querySelector('video')?.srcObject?.getVideoTracks().length === 2);

  await page.evaluate(() => window.dynamicStream.removeTrack(window.dynamicExtraTrack));
  await dynamicChild.waitForFunction(() => document.querySelector('video')?.srcObject?.getVideoTracks().length === 1);
  assert.equal(await page.evaluate(() => window.dynamicExtraTrack.readyState), 'live');

  await page.evaluate(() => window.dynamicStream.addTrack(window.dynamicExtraTrack));
  await dynamicChild.waitForFunction(() => document.querySelector('video')?.srcObject?.getVideoTracks().length === 2);
  await page.evaluate(() => window.dynamicExtraTrack.stop());
  await dynamicChild.waitForFunction(() => document.querySelector('video')?.srcObject?.getVideoTracks().length === 1);

  await page.evaluate(() => window.dynamicFloat.close());
  await page.waitForTimeout(100);
  assert.equal(dynamicChild.isClosed(), true);
  assert.deepEqual(await page.evaluate(() => ({
    original: window.testStream.getVideoTracks()[0].readyState,
    extra: window.dynamicExtraTrack.readyState,
  })), { original: 'live', extra: 'ended' });
  await page.evaluate(() => window.dynamicSource.remove());

  // Exercise the same MediaSource path used by QT, without creating a tunnel.
  await page.evaluate(async () => {
    window.mseVideo = document.createElement('video'); window.mseVideo.muted = true; window.mseVideo.autoplay = true; document.body.append(window.mseVideo);
    window.mse = new MediaSource(); window.mseVideo.src = URL.createObjectURL(window.mse);
    await new Promise(resolve => window.mse.addEventListener('sourceopen', resolve, { once: true }));
    const buffer = window.mse.addSourceBuffer('video/webm; codecs="vp8"'); const queue = [];
    const pump = () => { if (!buffer.updating && queue.length) buffer.appendBuffer(queue.shift()); }; buffer.addEventListener('updateend', pump);
    window.recorder = new MediaRecorder(window.testStream, { mimeType: 'video/webm; codecs=vp8' });
    window.recorder.ondataavailable = async event => { queue.push(await event.data.arrayBuffer()); pump(); }; window.recorder.start(100);
  });
  await page.waitForFunction(() => window.mseVideo.videoWidth === 320);
  await page.evaluate(async () => {
    await window.mseVideo.play();
  });

  await page.waitForFunction(() =>
    !window.mseVideo.paused &&
    window.mseVideo.currentTime > 0
  );

  await page.evaluate(() => { window.mseFloat = window.testOpenFloating(window.mseVideo); });

  const mseChild = app.windows().find(candidate => candidate !== page);
  await mseChild.waitForFunction(() => document.querySelector('video')?.videoWidth === 320);

  await page.evaluate(() => localStorage.removeItem('roomcast-test-mse-mirror-state'));
  const mseMirror = await mseChild.evaluate(() => {
    const video = document.querySelector('video');
    const track = video.srcObject.getVideoTracks()[0];
    window.addEventListener('pagehide', () => {
      localStorage.setItem('roomcast-test-mse-mirror-state', track.readyState);
    }, { once: true });
    return {
      id: track.id,
      muted: video.muted,
      audioTracks: video.srcObject.getAudioTracks().length,
    };
  });

  assert.deepEqual({
    differentTrack: mseMirror.id !== await page.evaluate(() => window.testStream.getVideoTracks()[0].id),
    muted: mseMirror.muted,
    audioTracks: mseMirror.audioTracks,
  }, { differentTrack: true, muted: true, audioTracks: 0 });

  await page.evaluate(() => window.mseFloat.close());
  await page.waitForFunction(() => localStorage.getItem('roomcast-test-mse-mirror-state') === 'ended');

  assert.equal(await page.evaluate(() => window.mse.readyState === 'open' && !window.mseVideo.paused && window.testStream.getVideoTracks()[0].readyState === 'live' && window.forbiddenCalls === 0), true);
  // Verify the user-facing exit path does not stop the underlying source track.
  // The detached MAIN view intentionally exposes only the placeholder, so close the
  // floating window through its own "退出小窗" control, then exercise "退出观看" in MAIN.
  await showMainPlayerUi(page);
  await clickMainButton(page, '窗口模式');
  await page.waitForFunction(
    () => document.querySelector('#floating-test .stream-view')?.dataset.windowMode === 'FLOATING'
  );
  const exitChild = app.windows().find(candidate => candidate !== page && !candidate.isClosed());
  assert.ok(exitChild);
  await exitChild.waitForFunction(() => document.querySelector('video')?.videoWidth === 320);
  await showFloatingUi(exitChild);
  await clickFloatingButton(exitChild, '退出小窗');
  await page.waitForFunction(
    () => document.querySelector('#floating-test .stream-view')?.dataset.windowMode === 'MAIN'
  );
  await page.waitForTimeout(100);
  assert.equal(exitChild.isClosed(), true);
  await showMainPlayerUi(page);
  await clickMainButton(page, '退出观看');
  await mainButton(page, '点击进入共享').waitFor({ state: 'visible' });
  assert.equal(
    await page.evaluate(() => window.testStream.getVideoTracks()[0].readyState === 'live' && window.forbiddenCalls === 0),
    true
  );

  // Re-enter so the existing unmount cleanup test can continue.
  await mainButton(page, '点击进入共享').click();

  await page.waitForFunction(
    () => document.querySelector('#floating-test video')?.videoWidth === 320
  );
  // Verify component unmount closes its floating window without stopping the source track.
  await showMainPlayerUi(page);
  await clickMainButton(page, '窗口模式');

  await page.waitForFunction(
    () => document.querySelector('#floating-test .stream-view')?.dataset.windowMode === 'FLOATING'
  );

  const unmountChild = app.windows().find(
    candidate => candidate !== page && !candidate.isClosed()
  );

  assert.ok(unmountChild);

  await unmountChild.waitForFunction(
    () => document.querySelector('video')?.videoWidth === 320
  );

  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().filter(
        win => win.webContents.getURL() === 'about:blank'
      ).length
    ),
    1
  );

  await page.evaluate(() => {
    window.testRoot.unmount();
  });

  await page.waitForTimeout(200);

  assert.equal(unmountChild.isClosed(), true);

  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().filter(
        win => win.webContents.getURL() === 'about:blank'
      ).length
    ),
    0
  );

  assert.equal(
    await page.evaluate(() =>
      window.testStream.getVideoTracks()[0].readyState === 'live' &&
      window.forbiddenCalls === 0
    ),
    true
  );
  // Verify a main-window reload closes all floating windows.
  await page.evaluate(async () => {
    window.reloadSource = document.createElement('video');
    window.reloadSource.autoplay = true;
    window.reloadSource.muted = true;
    window.reloadSource.playsInline = true;
    window.reloadSource.srcObject = window.testStream;
    document.body.append(window.reloadSource);

    await window.reloadSource.play();

    window.reloadFloat = window.testOpenFloating(window.reloadSource, {
      title: 'Reload cleanup'
    });
  });

  await page.waitForFunction(() => window.reloadFloat?.id);

  const reloadChild = app.windows().find(
    candidate => candidate !== page && !candidate.isClosed()
  );

  assert.ok(reloadChild);

  await reloadChild.waitForFunction(
    () => document.querySelector('video')?.videoWidth === 320
  );

  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().filter(
        win => win.webContents.getURL() === 'about:blank'
      ).length
    ),
    1
  );

  // Stop test-only producers before the renderer is reloaded.
  await page.evaluate(() => {
    window.recorder.stop();
    clearInterval(window.testPaint);
  });

  await page.reload();
  await page.waitForLoadState('load');

  await page.waitForTimeout(200);

  assert.equal(reloadChild.isClosed(), true);

  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().filter(
        win => win.webContents.getURL() === 'about:blank'
      ).length
    ),
    0
  );

  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().length
    ),
    1
  );
  // Verify a crashed main renderer closes all floating windows.
  await page.evaluate(() => {
    const id = window.roomcast.prepareFloatingWindow();
    if (!id) throw new Error('Failed to prepare crash-test floating window');

    window.__crashTestPopup = window.open(
      'about:blank',
      id,
      'width=500,height=320'
    );

    if (!window.__crashTestPopup) {
      throw new Error('Failed to open crash-test floating window');
    }
  });

  await page.waitForTimeout(200);

  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().filter(
        win => win.webContents.getURL() === 'about:blank'
      ).length
    ),
    1
  );

  await app.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find(
      win => win.webContents.getURL() !== 'about:blank'
    );

    main.webContents.forcefullyCrashRenderer();
  });

  await new Promise(resolve => setTimeout(resolve, 500));

  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().filter(
        win => win.webContents.getURL() === 'about:blank'
      ).length
    ),
    0
  );
} finally { await app.close(); }

// A second short launch verifies the native main-window close path itself, which
// ends the first renderer and therefore cannot be tested after the crash case.
const closeEnv = { ...env, ROOMCAST_PROFILE_DIR: path.resolve('test-results/floating/close-profile') };
const closeApp = await _electron.launch({ args: ['.'], env: closeEnv });
try {
  const closePage = await closeApp.firstWindow();
  await closePage.waitForURL(/http:\/\/127\.0\.0\.1/);
  await closePage.waitForLoadState('load');
  await closePage.evaluate(() => {
    const id = window.roomcast.prepareFloatingWindow();
    if (!id) throw new Error('Failed to prepare close-test floating window');
    const popup = window.open('about:blank', id, 'width=500,height=320');
    if (!popup) throw new Error('Failed to open close-test floating window');
  });

  await new Promise(resolve => setTimeout(resolve, 200));
  const closeChild = closeApp.windows().find(candidate => candidate !== closePage);
  assert.ok(closeChild);
  const childClosed = closeChild.waitForEvent('close');

  await closeApp.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find(win => win.webContents.getURL() !== 'about:blank');
    main.close();
  });

  await childClosed;
  assert.equal(closeChild.isClosed(), true);
} finally {
  await closeApp.close().catch(() => {});
}

console.log('PASS: main preview/fullscreen auto-hide + cursor; compact avatar-colored overlay cards; independent exit-view control; detached main player; floating preview/fullscreen auto-hide; exact floating labels; audio sync; native floating lifecycle; IPC isolation; track/MSE cleanup; no renegotiation');
