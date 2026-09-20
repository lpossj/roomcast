'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { app, BrowserWindow, session, screen } = require('electron');
const { ObsFixedFpsEngine } = require('../electron/obs-fixed-fps.cjs');
const { summarizePhase, recoveryMs, bitratePhase, summarizeObsHealth } = require('./obs-transition-metrics.cjs');

function readArg(name, fallback) {
  const prefix = `--${name}=`;
  const raw = process.argv.find(arg => arg.startsWith(prefix));
  return raw ? raw.slice(prefix.length) : fallback;
}
function asInt(name, fallback, min, max) {
  const value = Number(readArg(name, fallback));
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`--${name} 必须是 ${min}~${max} 的整数。`);
  return value;
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function startLoopbackPage() {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Roomcast OBS static-motion probe</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'self'">
<style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#111;color:#fff;font-family:Arial,sans-serif}
#stage{position:absolute;inset:0;background:repeating-conic-gradient(#111 0 25%,#eee 0 50%) 0 0/80px 80px}
#block{position:absolute;width:38%;height:38%;left:8%;top:14%;background:#222;border:24px solid #fff;box-sizing:border-box}
#label{position:absolute;left:4%;bottom:5%;padding:16px 24px;background:#000;font-size:28px;font-weight:700}
html.moving #stage{animation:bgmove .45s linear infinite}
html.moving #block{animation:boxmove .7s ease-in-out infinite alternate}
html.moving #label::after{content:' — MOTION'}
@keyframes bgmove{from{background-position:0 0}to{background-position:160px 80px}}
@keyframes boxmove{from{transform:translate3d(0,0,0) rotate(0deg)}to{transform:translate3d(105%,70%,0) rotate(14deg)}}
</style></head><body><div id="stage"></div><div id="block"></div><div id="label">Roomcast OBS fixed-FPS probe</div></body></html>`;
  const server = http.createServer((req, res) => {
    if (req.url !== '/' && req.url !== '/index.html') { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` }));
  });
}

async function sampleObs(engine, totalMs) {
  const rows = [];
  const started = Date.now();
  while (Date.now() - started < totalMs) {
    await sleep(500);
    rows.push({ elapsedMs: Date.now() - started, ...(await engine.stats()) });
  }
  return rows;
}

function writeFailure(dataRoot, error, stage) {
  try {
    fs.mkdirSync(dataRoot, { recursive: true });
    const body = [
      new Date().toISOString(),
      `stage=${stage}`,
      String(error?.stack || error?.message || error),
      '',
    ].join('\r\n');
    const failurePath = path.join(dataRoot, 'last-failure.txt');
    fs.writeFileSync(failurePath, body, 'utf8');
    return failurePath;
  } catch {
    return '';
  }
}

async function main() {
  if (process.platform !== 'win32') throw new Error('此验收只支持 Windows x64。');
  const rootDir = path.resolve(__dirname, '..');
  const dataRoot = path.join(rootDir, 'runtime', 'obs-test-data-static-motion');
  const width = asInt('width', 1920, 320, 4096);
  const height = asInt('height', 1080, 240, 4096);
  const fps = asInt('fps', 60, 1, 120);
  const staticSeconds = asInt('static-seconds', 20, 5, 60);
  const motionSeconds = asInt('motion-seconds', 8, 4, 30);
  const intervalMs = asInt('interval-ms', 250, 100, 1000);
  const monitorIndex = asInt('monitor', 0, 0, 31);
  const port = asInt('port', 4462, 1024, 65535);

  await app.whenReady();
  // Keep the standalone probe alive even if its only BrowserWindow is torn down by a renderer failure.
  app.on('window-all-closed', () => {});

  const engine = new ObsFixedFpsEngine({ runtimeRoot: rootDir, dataRoot, port });
  let browser = null;
  let server = null;
  let stage = 'initializing';
  let caught = null;

  try {
    console.log(`[OBS static->motion] 启动：${width}x${height}@${fps}，静止 ${staticSeconds}s，运动 ${motionSeconds}s`);

    stage = 'launch-obs';
    await engine.launch({ width, height, fps });
    console.log('[OBS static->motion] 内置 OBS 已启动。');

    stage = 'select-source';
    const sources = await engine.sources();
    const selected = sources.monitors[monitorIndex];
    if (!selected) throw new Error(`不存在显示器 #${monitorIndex}。`);
    await engine.selectSource({ type: 'monitor', id: selected.id, cursor: false });
    console.log(`[OBS static->motion] OBS 捕获源：${selected.name}`);

    stage = 'start-virtual-camera';
    await engine.startVirtualCamera();
    console.log('[OBS static->motion] OBS Virtual Camera 已启动。');

    stage = 'start-loopback-page';
    const loopback = await startLoopbackPage();
    server = loopback.server;
    const partition = `roomcast-obs-transition-${Date.now()}`;
    const testSession = session.fromPartition(partition, { cache: false });
    let allowedContents = null;
    testSession.setPermissionCheckHandler((contents, permission, requestingOrigin) => (
      (!contents || contents === allowedContents) && permission === 'media' && /^http:\/\/127\.0\.0\.1:\d+$/.test(String(requestingOrigin || '').replace(/\/$/, ''))
    ));
    testSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      const origin = String(details.requestingUrl || contents.getURL() || '');
      const mediaTypes = Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
      callback(contents === allowedContents && permission === 'media' && origin.startsWith(loopback.url) && mediaTypes.includes('video') && !mediaTypes.includes('audio'));
    });

    stage = 'create-test-window';
    const primary = screen.getPrimaryDisplay();
    const bounds = primary.workArea;
    const patternWidth = Math.min(1280, Math.max(800, Math.round(bounds.width * 0.72)));
    const patternHeight = Math.min(720, Math.max(500, Math.round(bounds.height * 0.72)));
    browser = new BrowserWindow({
      show: false,
      frame: false,
      skipTaskbar: true,
      focusable: false,
      alwaysOnTop: true,
      x: bounds.x + Math.max(0, Math.floor((bounds.width - patternWidth) / 2)),
      y: bounds.y + Math.max(0, Math.floor((bounds.height - patternHeight) / 2)),
      width: patternWidth,
      height: patternHeight,
      webPreferences: { session: testSession, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
    });
    allowedContents = browser.webContents;

    browser.webContents.on('render-process-gone', (_event, details) => {
      console.error(`[OBS static->motion] Renderer 退出：reason=${details.reason} exitCode=${details.exitCode}`);
    });
    browser.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (isMainFrame) console.error(`[OBS static->motion] 页面加载失败：${errorCode} ${errorDescription} ${validatedURL}`);
    });
    browser.on('unresponsive', () => console.error('[OBS static->motion] 测试窗口无响应。'));

    await browser.loadURL(loopback.url);
    browser.setIgnoreMouseEvents(true);
    browser.showInactive();
    await sleep(1200);
    console.log('[OBS static->motion] 静态测试图案已显示。');

    stage = 'install-renderer-probe';
    const rendererSource = fs.readFileSync(path.join(__dirname, 'obs-static-motion-renderer.js'), 'utf8');
    // Important: always return a primitive. Returning the assigned async function itself can fail
    // Electron result serialization and previously made the window disappear before diagnostics printed.
    const installResult = await browser.webContents.executeJavaScript(`(() => {\n${rendererSource}\nreturn typeof window.runObsStaticMotionProbe;\n})()`, true);
    if (installResult !== 'function') throw new Error(`renderer probe 安装失败，结果=${JSON.stringify(installResult)}`);
    console.log('[OBS static->motion] Renderer probe 已安装。');

    stage = 'run-renderer-probe';
    console.log('[OBS static->motion] 开始全自动测试：先静止，随后自动进入高运动量动画。');
    const totalMs = (staticSeconds + motionSeconds) * 1000 + 2500;
    const rendererPromise = browser.webContents.executeJavaScript(
      `window.runObsStaticMotionProbe(${JSON.stringify({ width, height, fps, staticSeconds, motionSeconds, intervalMs })})`,
      true,
    );
    const [renderer, obsRows] = await Promise.all([rendererPromise, sampleObs(engine, totalMs)]);

    stage = 'summarize';
    const transitionMs = renderer.transitionMs;
    const staticStart = 2000;
    const staticEnd = Math.max(staticStart + 1000, transitionMs - 1000);
    const motionEnd = transitionMs + motionSeconds * 1000;

    const encodedStatic = summarizePhase(renderer.samples, 'framesEncoded', staticStart, staticEnd);
    const encodedTransition = summarizePhase(renderer.samples, 'framesEncoded', transitionMs, transitionMs + 1500);
    const encodedMotion = summarizePhase(renderer.samples, 'framesEncoded', transitionMs, motionEnd);
    const decodedMotion = summarizePhase(renderer.samples, 'framesDecoded', transitionMs, motionEnd);
    const sourceMotion = summarizePhase(renderer.samples, 'totalVideoFrames', transitionMs, motionEnd);
    const recovery = recoveryMs(renderer.samples, 'framesEncoded', transitionMs, fps, 500, 0.85, 2500);
    const staticBitrate = bitratePhase(renderer.samples, staticStart, staticEnd);
    const firstMotionBitrate = bitratePhase(renderer.samples, transitionMs, Math.min(motionEnd, transitionMs + 1500));
    const motionBitrate = bitratePhase(renderer.samples, transitionMs, motionEnd);
    const bitrateRatio = staticBitrate.averageBps > 0 ? motionBitrate.averageBps / staticBitrate.averageBps : 0;

    const threshold = fps * 0.80;
    const relevantObs = obsRows.filter(row => row.elapsedMs >= 1500);
    const obsHealth = summarizeObsHealth(relevantObs, fps);
    const obsOk = obsHealth.clockStable && obsHealth.skipHealth;
    const transitionOk = encodedTransition.averageFps >= threshold && encodedTransition.zeroIntervals === 0 && recovery !== null && recovery <= 500;
    const motionOk = encodedMotion.averageFps >= threshold && decodedMotion.averageFps >= threshold && sourceMotion.averageFps >= threshold;
    const staticOk = encodedStatic.averageFps >= threshold;

    const report = {
      ok: obsOk && staticOk && transitionOk && motionOk,
      target: { width, height, fps, staticSeconds, motionSeconds, intervalMs },
      source: selected,
      chromium: { device: renderer.device, trackSettings: renderer.trackSettings },
      fpsResults: {
        staticEncoded: encodedStatic,
        transitionFirst1500msEncoded: encodedTransition,
        motionEncoded: encodedMotion,
        motionDecoded: decodedMotion,
        motionSource: sourceMotion,
        recoveryMs: recovery,
      },
      bitrate: {
        static: staticBitrate,
        firstMotion1500ms: firstMotionBitrate,
        motion: motionBitrate,
        motionVsStaticRatio: bitrateRatio,
      },
      obs: obsHealth,
      verdict: {
        obsFixedFps: obsHealth.clockStable,
        obsRenderOutputHealth: obsHealth.skipHealth,
        staticEncodedFps: staticOk,
        noTransitionStall: transitionOk,
        motionEncodedDecodedFps: motionOk,
      },
    };

    fs.mkdirSync(dataRoot, { recursive: true });
    const reportPath = path.join(dataRoot, 'static-motion-report.json');
    fs.writeFileSync(reportPath, JSON.stringify({ ...report, raw: { rendererSamples: renderer.samples, obsRows } }, null, 2));
    console.log(JSON.stringify(report, null, 2));
    console.log(`[OBS static->motion] 完整报告：${reportPath}`);
    if (!report.ok) throw new Error(`静止→运动验收未完全通过：obsClock=${obsHealth.clockStable} obsHealth=${obsHealth.skipHealth} static=${staticOk} transition=${transitionOk} motion=${motionOk} recovery=${recovery}ms`);
    console.log('[OBS static->motion] PASS');
  } catch (error) {
    caught = error;
    const failurePath = writeFailure(dataRoot, error, stage);
    console.error(`[OBS static->motion] FAIL at ${stage}: ${error.stack || error.message}`);
    if (failurePath) console.error(`[OBS static->motion] 错误已写入：${failurePath}`);
    process.exitCode = 1;
  } finally {
    // Do cleanup only after PASS/FAIL has already been printed.
    try { if (browser && !browser.isDestroyed()) browser.destroy(); } catch { }
    try { if (server) await new Promise(resolve => server.close(resolve)); } catch { }
    try { await engine.close(); } catch (error) { console.error(`[OBS static->motion] OBS 清理警告：${error.message}`); }
  }

  return !caught;
}

main()
  .then(async ok => {
    await sleep(100);
    app.exit(ok ? 0 : 1);
  })
  .catch(async error => {
    console.error(`[OBS static->motion] FATAL: ${error.stack || error.message}`);
    await sleep(100);
    app.exit(1);
  });
