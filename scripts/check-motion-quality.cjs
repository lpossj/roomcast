// On-demand, local diagnostic. Not part of npm test and never captures other windows.
// Run: node scripts/check-motion-quality.cjs
// Focused: node scripts/check-motion-quality.cjs --backends=obs --bitrates=6500 --policy=off
// A completed run means valid measurements, not that motion quality passed.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename, ...process.argv.slice(2)], {
    cwd: root, env, windowsHide: true, stdio: 'inherit',
  });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const http = require('node:http');
  const esbuild = require('esbuild');
  const { app, BrowserWindow, session, desktopCapturer, screen } = require('electron');
  const { ObsFixedFpsEngine } = require('../electron/obs-fixed-fps.cjs');
  const arg = (name, fallback) => process.argv.find(value => value.startsWith(`--${name}=`))?.split('=').slice(1).join('=') || fallback;
  const backends = arg('backends', 'native,obs').split(',');
  const bitrates = arg('bitrates', '6500').split(',').map(Number);
  const hints = arg('hints', 'default').split(',');
  const codecs = arg('codecs', 'H264').split(',');
  const nativePaths = arg('native-paths', 'production').split(',');
  const duration = name => { const value = Number(arg(`${name}-seconds`, name === 'static' ? '30' : '8')); if (!Number.isInteger(value) || value < 4 || value > 60) throw Error(`Invalid ${name} duration`); return value; };
  const config = { staticSeconds: duration('static'), motionSeconds: duration('motion'), recoverySeconds: duration('recovery'), fps: Number(arg('fps', '60')), policy: arg('policy', 'on'), startOffer: arg('start-offer', 'off') };
  config.h264RateControl = arg('h264-rate-control', 'default');
  config.h264Profile = arg('h264-profile', 'default');
  config.h265RateControl = arg('h265-rate-control', 'default');
  config.vp9Profile = arg('vp9-profile', 'default');
  if (backends.some(value => !['native', 'obs'].includes(value)) || bitrates.some(value => !Number.isInteger(value) || value < 200 || value > 100000) || ![30, 45, 60].includes(config.fps) || !['on', 'off'].includes(config.policy)) throw Error('Invalid backend/bitrate/FPS/policy');
  if (hints.some(value => !['default', 'motion', 'detail', 'text'].includes(value)) || codecs.some(value => !['H264', 'H265', 'VP9', 'AV1'].includes(value))) throw Error('Invalid hint/codec');
  if (!['on', 'off'].includes(config.startOffer)) throw Error('Invalid start-offer mode');
  if (!['default', 'hardware'].includes(config.h264RateControl) || (config.h264RateControl === 'hardware' && process.platform !== 'win32')) throw Error('Invalid H264 rate control');
  if (!['default', 'high'].includes(config.h264Profile)) throw Error('Invalid H264 profile');
  if (!['default', 'software'].includes(config.h265RateControl)) throw Error('Invalid H265 rate control');
  if (!['default', '2'].includes(config.vp9Profile)) throw Error('Invalid VP9 profile');
  if (nativePaths.some(value => !['production', 'direct'].includes(value))) throw Error('Invalid native path');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const output = path.join(root, '.test', `motion-quality-${stamp}`);
  fs.mkdirSync(output, { recursive: true });
  app.setPath('userData', path.join(output, 'profile'));
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  app.commandLine.appendSwitch('force-color-profile', 'srgb');
  if (config.h264RateControl === 'hardware') app.commandLine.appendSwitch('disable-features', 'MediaFoundationUseSWBRCForH264Camera,MediaFoundationUseSWBRCForH264Desktop');
  if (config.h265RateControl === 'software') app.commandLine.appendSwitch('enable-features', 'MediaFoundationUseSWBRCForH265');
  let pattern, captureWindow, server, engine, activeCase = null;
  const cases = [];
  const title = `Roomcast controlled motion test ${stamp}`;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const mean = values => { const known = values.filter(Number.isFinite); return known.length ? known.reduce((a, b) => a + b, 0) / known.length : null; };
  const mbps = values => { const value = mean(values); return value === null ? null : value / 1e6; };
  const escape = value => String(value).replace(/[&<>"']/g, item => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[item]));

  function saveReport() {
    const report = { at: new Date().toISOString(), version: JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version,
      versions: process.versions, config, scope: 'Real controlled-window native/OBS capture and production P2PRoom.answerScreen over local host candidates. No public P2P/VDO/TURN test. Image measurements compare matched captured/decoded frames, not subjective scores.', cases };
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    const cell = value => value === null || value === undefined ? '未知' : Number(value).toFixed(2);
    const rows = cases.flatMap(item => (item.summary || []).map(phase => `<tr><td>${escape(item.label)}</td><td>${escape(phase.phase)}</td><td>${cell(phase.psnrDb)}</td><td>${cell(phase.averageQp)}</td><td>${cell(phase.bitrateMbps)}</td><td>${cell(phase.targetMbps)}</td><td>${cell(phase.sourceFps)}</td><td>${cell(phase.encodedFps)}</td><td>${escape(phase.sizes.join(', '))}</td><td>${escape(phase.tiers.map(value => value === null ? '未运行策略' : value).join(', '))}</td></tr>`)).join('');
    const images = cases.map(item => `<h2>${escape(item.label)}</h2>${item.error ? `<p>${escape(item.error)}</p>` : ''}${Object.entries(item.images || {}).map(([phase, pair]) => `<h3>${escape(phase)}：同一帧 ${pair.frameId}，PSNR ${cell(pair.psnrDb)} dB</h3><div class="pair"><figure><img src="${escape(pair.source)}"><figcaption>采集后、压缩前</figcaption></figure><figure><img src="${escape(pair.decoded)}"><figcaption>接收解码后</figcaption></figure></div>`).join('')}`).join('');
    fs.writeFileSync(path.join(output, 'report.html'), `<!doctype html><meta charset="utf-8"><title>Roomcast 动态画质实测</title><style>body{font:16px system-ui;margin:28px;color:#222}table{border-collapse:collapse}td,th{padding:8px;border:1px solid #ccc}.pair{display:flex;gap:20px}figure{margin:0}img{width:576px;image-rendering:pixelated;max-width:42vw}p{max-width:1000px;line-height:1.6}</style><h1>Roomcast 自动动态画质实测</h1><p>受控窗口 → 实际原生/OBS采集 → 当前生产P2P发送器 → 本机接收。静止${config.staticSeconds}秒 → 快速移动${config.motionSeconds}秒 → 恢复静止${config.recoverySeconds}秒。应用降档策略：${config.policy === 'off' ? '仅本测试关闭' : '开启，保持生产行为'}。测试图案包含复杂纹理，是压力场景。PSNR越高表示同帧像素误差越小；QP仅可在相同编码格式内比较。每组带宽估计独立，不把不同组差异直接视为调参收益。完成表示取得有效测量，不表示画质合格。没有测试真实公网、中继或用户的实际画面。</p><table><tr><th>设置</th><th>阶段</th><th>同帧PSNR</th><th>平均QP</th><th>实际Mbps</th><th>目标Mbps</th><th>源FPS</th><th>编码FPS</th><th>尺寸</th><th>策略档位</th></tr>${rows}</table>${images}`);
  }

  async function run() {
    const roomSource = fs.readFileSync(path.join(root, 'src/p2p.js'), 'utf8');
    const setterStart = roomSource.indexOf('function lockVideoBitrate('), setterEnd = roomSource.indexOf('\nconst withTimeout', setterStart);
    if (setterStart < 0 || setterEnd <= setterStart) throw Error('Production SDP bitrate helper unavailable');
    const bitrateSetter = roomSource.slice(setterStart, setterEnd);
    const bundle = await esbuild.build({ stdin: { contents: `import { P2PRoom } from './src/p2p.js'; import { startIntegratedCapture, startObsFixedFpsCapture } from './src/lib.js'; import { readP2pDiagnostics } from './src/p2p-video-policy.js'; import { preferH264High } from './src/video-codec-policy.js'; ${bitrateSetter}; window.motionModules={P2PRoom,startIntegratedCapture,startObsFixedFpsCapture,readP2pDiagnostics,lockVideoBitrate,preferH264High};`, resolveDir: root, loader: 'js' }, bundle: true, format: 'iife', write: false, external: ['./browser-room-service.js'], plugins: [{ name: 'local-native-direct-experiment', setup(build) {
      build.onLoad({ filter: /[\\/]src[\\/]lib\.js$/ }, args => {
        const original = fs.readFileSync(args.path, 'utf8');
        const marker = '    // Chromium desktop capture is allowed to stop producing fresh frames while';
        if (!original.includes(marker)) return { contents: original, loader: 'js' };
        const direct = `    if (globalThis.__roomcastTestNativeDirect) {\n      track.contentHint = 'motion';\n      const previousCleanup = stream.roomcastCleanup;\n      stream.roomcastCleanup = () => { previousCleanup?.(); stream.getTracks().forEach(item => item.stop()); };\n      return stream;\n    }\n\n`;
        return { contents: original.replace(marker, direct + marker), loader: 'js' };
      });
    } }] });
    const patternCode = fs.readFileSync(path.join(__dirname, 'motion-quality-renderer.js'), 'utf8');
    await app.whenReady(); app.on('window-all-closed', () => {});
    server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/modules.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(bundle.outputFiles[0].contents); return; }
      if (url.pathname === '/probe.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(patternCode); return; }
      if (url.pathname === '/phase' && ['static', 'motion', 'recovery'].includes(url.searchParams.get('name'))) {
        try { const name = url.searchParams.get('name'); await pattern.webContents.executeJavaScript(`window.setMotionPhase(${JSON.stringify(name)})`); console.log(`[motion-quality] ${activeCase}: ${name}`); res.end('ok'); } catch (error) { res.writeHead(500); res.end(error.message); }
        return;
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(url.pathname === '/pattern' ? `<!doctype html><title>${title}</title><style>html,body{margin:0;overflow:hidden;background:#222}canvas{width:100vw;height:100vh}</style><canvas width="1920" height="1080"></canvas><script src="/probe.js"></script><script>installMotionPattern();</script>` : '<!doctype html><meta charset="utf-8"><title>Roomcast local quality collector</title><script src="/modules.js"></script><script src="/probe.js"></script>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    pattern = new BrowserWindow({ width: 1920, height: 1080, useContentSize: true, frame: false, show: false, skipTaskbar: true, focusable: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    await pattern.loadURL(`${origin}/pattern`); pattern.showInactive();
    const captureSession = session.fromPartition(`motion-quality-${stamp}`, { cache: false });
    captureSession.setPermissionCheckHandler((contents, permission, requestingOrigin) => (!contents || contents === captureWindow?.webContents) && permission === 'media' && String(requestingOrigin).startsWith(origin));
    captureSession.setPermissionRequestHandler((contents, permission, callback, details) => callback(contents === captureWindow?.webContents && permission === 'media' && String(details.requestingUrl || contents.getURL()).startsWith(origin) && !details.mediaTypes?.includes('audio')));
    captureSession.setDisplayMediaRequestHandler(async (_request, callback) => {
      try { const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } }); const source = sources.find(item => item.name === title); if (!source) throw Error('Controlled test window unavailable'); callback({ video: source }); } catch (error) { console.error(error.message); callback({}); }
    });
    const bounds = screen.getPrimaryDisplay().workArea;
    captureWindow = new BrowserWindow({ width: 640, height: 400, x: bounds.x + Math.max(0, bounds.width - 640), y: bounds.y + Math.max(0, bounds.height - 400), show: false,
      webPreferences: { session: captureSession, nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    captureWindow.webContents.on('console-message', event => { if (event.level === 'error') console.error(event.message); });
    await captureWindow.loadURL(origin);
    // Hidden pages can suppress video frame callbacks even with timers unthrottled.
    captureWindow.showInactive();
    for (const { backend, bitrate, hint, codec, nativePath } of backends.flatMap(backend => bitrates.flatMap(bitrate => hints.flatMap(hint => codecs.flatMap(codec => (backend === 'native' ? nativePaths : ['production']).map(nativePath => ({ backend, bitrate, hint, codec, nativePath }))))))) {
        activeCase = `${backend}-${bitrate}K-${config.fps}fps-policy-${config.policy}-${hint}-${codec}-offer-${config.startOffer}-rc-${config.h264RateControl}-profile-${config.h264Profile}-hevc-${config.h265RateControl}-vp9-${config.vp9Profile}-native-${nativePath}`;
        console.log(`[motion-quality] start ${activeCase}`);
        try {
          if (backend === 'obs') {
            const portServer = http.createServer(); await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve)); const port = portServer.address().port; await new Promise(resolve => portServer.close(resolve));
            engine = new ObsFixedFpsEngine({ runtimeRoot: root, dataRoot: path.join(output, `obs-case-${cases.length + 1}`), port });
            await engine.launch({ width: 1920, height: 1080, fps: config.fps });
            const sources = await engine.sources(); const selected = sources.windows.find(item => item.name.includes(title)); if (!selected) throw Error('OBS cannot find controlled test window');
            await engine.selectSource({ type: 'window', id: selected.id, cursor: false }); await engine.startVirtualCamera();
          }
          const result = await captureWindow.webContents.executeJavaScript(`window.runMotionQuality(${JSON.stringify({ ...config, backend, bitrate, hint, codec, nativePath })})`, true);
          result.label = activeCase; result.images = {};
          for (const [phase, pair] of Object.entries(result.imagePairs)) {
            const source = `${activeCase}-${phase}-source.png`, decoded = `${activeCase}-${phase}-decoded.png`;
            fs.writeFileSync(path.join(output, source), Buffer.from(pair.source.split(',')[1], 'base64')); fs.writeFileSync(path.join(output, decoded), Buffer.from(pair.decoded.split(',')[1], 'base64'));
            result.images[phase] = { source, decoded, frameId: pair.frameId, psnrDb: pair.psnrDb };
          }
          delete result.imagePairs;
          result.summary = ['static', 'motion', 'recovery'].map(phase => {
            const stats = result.rows.filter(row => row.phase === phase && row.phaseMs >= (phase === 'static' ? 5000 : 1000));
            const quality = result.quality.filter(row => row.phase === phase && row.phaseMs >= 1000);
            return { phase, matchedFrames: quality.length, psnrDb: mean(quality.map(row => row.psnrDb)), averageQp: mean(stats.map(row => row.averageQp)), bitrateMbps: mbps(stats.map(row => row.bitrate)),
              targetMbps: mbps(stats.map(row => row.targetBitrate)), sourceFps: mean(stats.map(row => row.sourceFps)), encodedFps: mean(stats.map(row => row.encodedFps)), decodedFps: mean(stats.map(row => row.decodedFps)),
              sizes: [...new Set(stats.map(row => `${row.width}x${row.height}`))], tiers: [...new Set(stats.map(row => row.tierIndex))], reasons: [...new Set(stats.map(row => row.reason))] };
          });
          result.complete = result.summary.every(phase => phase.matchedFrames >= 3) && result.rows.some(row => row.encodedFps > 0);
          if (engine) result.obsHealth = await engine.stats();
          cases.push(result); console.log(JSON.stringify({ label: activeCase, complete: result.complete, summary: result.summary }));
        } catch (error) { cases.push({ label: activeCase, error: error?.message || String(error), complete: false }); console.error(`[motion-quality] ${activeCase}: ${error?.stack || String(error)}`); }
        finally { if (engine) { await engine.close().catch(error => console.error(error.message)); engine = null; } saveReport(); }
    }
    console.log(`[motion-quality] report ${path.join(output, 'report.html')}`);
    return cases.every(item => item.complete);
  }
  run().then(async ok => { captureWindow?.destroy(); pattern?.destroy(); server?.close(); app.exit(ok ? 0 : 1); })
    .catch(async error => { console.error(error.stack); if (engine) await engine.close().catch(() => {}); saveReport(); captureWindow?.destroy(); pattern?.destroy(); server?.close(); app.exit(1); });
}
