const path = require('node:path');
const http = require('node:http');
const { app, BrowserWindow, session } = require('electron');
const { ObsFixedFpsEngine } = require('../electron/obs-fixed-fps.cjs');
const { summarizeCounter, withinTarget } = require('./obs-bridge-metrics.cjs');

function readArg(name, fallback) {
  const prefix = `--${name}=`;
  const raw = process.argv.find(arg => arg.startsWith(prefix));
  return raw ? raw.slice(prefix.length) : fallback;
}

function asInt(name, fallback, min, max) {
  const value = Number(readArg(name, fallback));
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`--${name} 必须是 ${min}~${max} 的整数。`);
  }
  return value;
}

function startLoopbackPage() {
  const html = '<!doctype html><meta charset="utf-8"><title>Roomcast OBS bridge check</title><body>Roomcast OBS bridge check</body>';
  const server = http.createServer((req, res) => {
    if (req.url !== '/' && req.url !== '/index.html') {
      res.writeHead(404); res.end(); return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; script-src 'none'; style-src 'none'; img-src 'none'; connect-src 'self'",
    });
    res.end(html);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, url: `http://127.0.0.1:${address.port}/` });
    });
  });
}

async function sampleObs(engine, seconds) {
  const rows = [];
  for (let i = 0; i < seconds; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    const value = await engine.stats();
    rows.push(value);
    console.log(`[OBS -> Electron] OBS activeFps=${value.activeFps.toFixed(2)} renderSkipped=${value.renderSkippedFrames}/${value.renderTotalFrames} outputSkipped=${value.outputSkippedFrames}/${value.outputTotalFrames}`);
  }
  return rows;
}

function summarizeRendererSamples(samples) {
  return {
    sourceTotalVideoFrames: summarizeCounter(samples, 'totalVideoFrames'),
    sourcePresentedFrames: summarizeCounter(samples, 'presentedFrames'),
    outboundFramesEncoded: summarizeCounter(samples, 'framesEncoded'),
    outboundFramesSent: summarizeCounter(samples, 'framesSent'),
    inboundFramesDecoded: summarizeCounter(samples, 'framesDecoded'),
    inboundFramesReceived: summarizeCounter(samples, 'framesReceived'),
    bytesSent: summarizeCounter(samples, 'bytesSent'),
  };
}

async function main() {
  if (process.platform !== 'win32') throw new Error('此验收只支持 Windows x64。');
  const rootDir = path.resolve(__dirname, '..');
  const dataRoot = path.join(rootDir, 'runtime', 'obs-test-data-electron-bridge');
  const width = asInt('width', 1920, 320, 4096);
  const height = asInt('height', 1080, 240, 4096);
  const fps = asInt('fps', 60, 1, 120);
  const seconds = asInt('seconds', 10, 6, 30);
  const monitorIndex = asInt('monitor', 0, 0, 31);
  const port = asInt('port', 4461, 1024, 65535);

  await app.whenReady();
  const engine = new ObsFixedFpsEngine({ runtimeRoot: rootDir, dataRoot, port });
  let browser = null;
  let server = null;
  try {
    console.log(`[OBS -> Electron] 启动内置 OBS：${width}x${height}@${fps}`);
    await engine.launch({ width, height, fps });
    const sources = await engine.sources();
    const selected = sources.monitors[monitorIndex];
    if (!selected) throw new Error(`不存在显示器 #${monitorIndex}。当前仅有 ${sources.monitors.length} 个显示器。`);
    await engine.selectSource({ type: 'monitor', id: selected.id, cursor: true });
    console.log(`[OBS -> Electron] OBS 捕获源：${selected.name}`);

    try {
      await engine.startVirtualCamera();
    } catch (error) {
      throw new Error(`OBS Virtual Camera 无法启动：${error.message}`);
    }
    console.log('[OBS -> Electron] OBS Virtual Camera 已启动。');
    console.log('[OBS -> Electron] 本轮将同时测：Chromium 视频计数、WebRTC framesEncoded、接收端 framesDecoded。');

    const loopback = await startLoopbackPage();
    server = loopback.server;
    const partition = `roomcast-obs-bridge-check-${Date.now()}`;
    const testSession = session.fromPartition(partition, { cache: false });
    let allowedContents = null;
    testSession.setPermissionCheckHandler((contents, permission, requestingOrigin) => (
      (!contents || contents === allowedContents)
      && permission === 'media'
      && /^http:\/\/127\.0\.0\.1:\d+$/.test(String(requestingOrigin || '').replace(/\/$/, ''))
    ));
    testSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      const origin = String(details.requestingUrl || contents.getURL() || '');
      const mediaTypes = Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
      const ok = contents === allowedContents
        && permission === 'media'
        && origin.startsWith(loopback.url)
        && mediaTypes.includes('video')
        && !mediaTypes.includes('audio');
      callback(ok);
    });

    browser = new BrowserWindow({
      show: false,
      width: 480,
      height: 320,
      webPreferences: {
        session: testSession,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
      },
    });
    allowedContents = browser.webContents;
    await browser.loadURL(loopback.url);

    const rendererPromise = browser.webContents.executeJavaScript(`(async () => {
      const wantedWidth = ${width};
      const wantedHeight = ${height};
      const wantedFps = ${fps};
      const seconds = ${seconds};
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

      function waitForIceGathering(pc, timeoutMs = 8000) {
        if (pc.iceGatheringState === 'complete') return Promise.resolve();
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            cleanup();
            reject(new Error('本机 WebRTC ICE gathering 超时。'));
          }, timeoutMs);
          const onState = () => {
            if (pc.iceGatheringState !== 'complete') return;
            cleanup();
            resolve();
          };
          const cleanup = () => {
            clearTimeout(timer);
            pc.removeEventListener('icegatheringstatechange', onState);
          };
          pc.addEventListener('icegatheringstatechange', onState);
        });
      }

      function waitForConnection(pc, timeoutMs = 8000) {
        if (pc.connectionState === 'connected') return Promise.resolve();
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            cleanup();
            reject(new Error('本机 WebRTC loopback 连接超时，state=' + pc.connectionState + ', ice=' + pc.iceConnectionState));
          }, timeoutMs);
          const onState = () => {
            if (pc.connectionState === 'connected') {
              cleanup();
              resolve();
            } else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
              cleanup();
              reject(new Error('本机 WebRTC loopback 连接失败，state=' + pc.connectionState));
            }
          };
          const cleanup = () => {
            clearTimeout(timer);
            pc.removeEventListener('connectionstatechange', onState);
          };
          pc.addEventListener('connectionstatechange', onState);
        });
      }

      async function findStat(report, type) {
        for (const item of report.values()) {
          if (item.type !== type) continue;
          const kind = item.kind || item.mediaType;
          if (kind === 'video' && !item.isRemote) return item;
        }
        return null;
      }

      const devices = await navigator.mediaDevices.enumerateDevices();
      const videos = devices.filter(device => device.kind === 'videoinput').map(device => ({ deviceId: device.deviceId, label: device.label }));
      const obs = videos.find(device => /OBS\\s+Virtual\\s+Camera/i.test(device.label || ''));
      if (!obs) throw new Error('Chromium 未发现 OBS Virtual Camera。video inputs=' + JSON.stringify(videos.map(v => v.label || '(无标签)')));

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          deviceId: { exact: obs.deviceId },
          width: { ideal: wantedWidth },
          height: { ideal: wantedHeight },
          frameRate: { ideal: wantedFps, max: wantedFps },
        },
      });
      const track = stream.getVideoTracks()[0];
      if (!track) throw new Error('OBS Virtual Camera 未返回视频轨道。');
      if ('contentHint' in track) track.contentHint = 'motion';

      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      document.body.append(video);
      await video.play();
      await new Promise((resolve, reject) => {
        if (video.videoWidth && video.videoHeight) return resolve();
        const timer = setTimeout(() => reject(new Error('等待 OBS Virtual Camera 首帧超时。')), 8000);
        video.addEventListener('loadeddata', () => { clearTimeout(timer); resolve(); }, { once: true });
      });

      let rvfcCallbacks = 0;
      let firstPresentedFrames = 0;
      let lastPresentedFrames = 0;
      let firstPresentedAt = 0;
      let lastPresentedAt = 0;
      let rvfcActive = true;
      if (typeof video.requestVideoFrameCallback === 'function') {
        const onFrame = (now, metadata) => {
          if (!rvfcActive) return;
          rvfcCallbacks += 1;
          const presented = Number(metadata.presentedFrames || 0);
          if (!firstPresentedAt) {
            firstPresentedAt = now;
            firstPresentedFrames = presented;
          }
          lastPresentedAt = now;
          lastPresentedFrames = presented;
          video.requestVideoFrameCallback(onFrame);
        };
        video.requestVideoFrameCallback(onFrame);
      }

      const senderPc = new RTCPeerConnection({ iceServers: [] });
      const receiverPc = new RTCPeerConnection({ iceServers: [] });
      let receiver = null;
      let remoteTrack = null;
      const remoteTrackPromise = new Promise(resolve => {
        receiverPc.addEventListener('track', event => {
          remoteTrack = event.track;
          receiver = event.receiver;
          resolve(event);
        }, { once: true });
      });
      const sender = senderPc.addTrack(track, stream);

      const offer = await senderPc.createOffer();
      await senderPc.setLocalDescription(offer);
      await waitForIceGathering(senderPc);
      await receiverPc.setRemoteDescription(senderPc.localDescription);
      const answer = await receiverPc.createAnswer();
      await receiverPc.setLocalDescription(answer);
      await waitForIceGathering(receiverPc);
      await senderPc.setRemoteDescription(receiverPc.localDescription);
      await Promise.all([waitForConnection(senderPc), waitForConnection(receiverPc), remoteTrackPromise]);

      let senderParameterError = '';
      try {
        const parameters = sender.getParameters();
        if (!Array.isArray(parameters.encodings) || !parameters.encodings.length) parameters.encodings = [{}];
        parameters.encodings[0].maxFramerate = wantedFps;
        parameters.encodings[0].maxBitrate = 20_000_000;
        parameters.degradationPreference = 'maintain-framerate';
        await sender.setParameters(parameters);
      } catch (error) {
        senderParameterError = String(error?.message || error);
      }

      const remoteVideo = document.createElement('video');
      remoteVideo.muted = true;
      remoteVideo.playsInline = true;
      remoteVideo.srcObject = new MediaStream([remoteTrack]);
      document.body.append(remoteVideo);
      await remoteVideo.play();
      await sleep(1200);

      async function counters(elapsedMs) {
        const quality = typeof video.getVideoPlaybackQuality === 'function' ? video.getVideoPlaybackQuality() : null;
        const outbound = await findStat(await sender.getStats(), 'outbound-rtp');
        const inbound = receiver ? await findStat(await receiver.getStats(), 'inbound-rtp') : null;
        return {
          elapsedMs,
          totalVideoFrames: Number(quality?.totalVideoFrames ?? video.webkitDecodedFrameCount ?? 0),
          droppedVideoFrames: Number(quality?.droppedVideoFrames ?? video.webkitDroppedFrameCount ?? 0),
          presentedFrames: Number(lastPresentedFrames || 0),
          rvfcCallbacks,
          framesEncoded: Number(outbound?.framesEncoded || 0),
          framesSent: Number(outbound?.framesSent || 0),
          bytesSent: Number(outbound?.bytesSent || 0),
          keyFramesEncoded: Number(outbound?.keyFramesEncoded || 0),
          framesDecoded: Number(inbound?.framesDecoded || 0),
          framesReceived: Number(inbound?.framesReceived || 0),
          bytesReceived: Number(inbound?.bytesReceived || 0),
          outboundCodecId: outbound?.codecId || null,
        };
      }

      const samples = [];
      const started = performance.now();
      samples.push(await counters(0));
      for (let index = 1; index <= seconds; index += 1) {
        const due = started + index * 1000;
        const wait = Math.max(0, due - performance.now());
        if (wait) await sleep(wait);
        samples.push(await counters(performance.now() - started));
      }

      const settings = track.getSettings();
      rvfcActive = false;
      const rvfcElapsedMs = Math.max(0, lastPresentedAt - firstPresentedAt);
      const rvfcPresentedDelta = Math.max(0, lastPresentedFrames - firstPresentedFrames);
      const videoSize = { width: video.videoWidth || settings.width || 0, height: video.videoHeight || settings.height || 0 };

      try { senderPc.close(); } catch {}
      try { receiverPc.close(); } catch {}
      stream.getTracks().forEach(item => item.stop());
      remoteVideo.srcObject = null;
      video.srcObject = null;
      remoteVideo.remove();
      video.remove();

      return {
        device: { label: obs.label, deviceIdPresent: Boolean(obs.deviceId) },
        videoSize,
        trackSettings: settings,
        senderParameterError,
        rvfc: {
          callbackCount: rvfcCallbacks,
          firstPresentedFrames,
          lastPresentedFrames,
          presentedFrameDelta: rvfcPresentedDelta,
          elapsedMs: rvfcElapsedMs,
          presentedFps: rvfcElapsedMs > 0 ? rvfcPresentedDelta / (rvfcElapsedMs / 1000) : 0,
        },
        samples,
      };
    })()`, true);

    const [rendererTask, obsSamples] = await Promise.all([
      rendererPromise,
      sampleObs(engine, seconds + 2),
    ]);

    const metrics = summarizeRendererSamples(rendererTask.samples);
    const sourceFps = Math.max(metrics.sourceTotalVideoFrames.averageFps, metrics.sourcePresentedFrames.averageFps, rendererTask.rvfc.presentedFps || 0);
    const encodedFps = metrics.outboundFramesEncoded.averageFps;
    const decodedFps = metrics.inboundFramesDecoded.averageFps;
    const lowerBound = Math.max(1, fps * 0.85);
    const upperBound = fps * 1.15;
    const obsRelevant = obsSamples.slice(Math.max(0, obsSamples.length - seconds));
    const obsOk = obsRelevant.every(item => item.activeFps >= lowerBound && item.activeFps <= upperBound && item.renderSkippedFrames === 0);
    const outputAdvanced = obsRelevant.length < 2 || obsRelevant.at(-1).outputTotalFrames > obsRelevant[0].outputTotalFrames;
    const sourceOk = withinTarget(sourceFps, fps, 0.85);
    const encoderOk = withinTarget(encodedFps, fps, 0.85);
    const decoderOk = withinTarget(decodedFps, fps, 0.80);

    const result = {
      ok: obsOk && outputAdvanced && sourceOk && encoderOk && decoderOk,
      target: { width, height, fps, seconds },
      source: selected,
      chromium: {
        device: rendererTask.device,
        videoSize: rendererTask.videoSize,
        trackSettings: rendererTask.trackSettings,
        senderParameterError: rendererTask.senderParameterError,
        rvfc: rendererTask.rvfc,
        metrics,
        effectiveFps: {
          source: sourceFps,
          encoded: encodedFps,
          decoded: decodedFps,
        },
        samples: rendererTask.samples,
      },
      obs: {
        averageActiveFps: obsRelevant.reduce((sum, row) => sum + row.activeFps, 0) / Math.max(1, obsRelevant.length),
        outputTotalFramesStart: obsRelevant[0]?.outputTotalFrames ?? 0,
        outputTotalFramesEnd: obsRelevant.at(-1)?.outputTotalFrames ?? 0,
        renderSkippedFrames: obsRelevant.at(-1)?.renderSkippedFrames ?? 0,
        outputSkippedFrames: obsRelevant.at(-1)?.outputSkippedFrames ?? 0,
      },
      verdict: {
        obsRenderer60: obsOk,
        obsOutputAdvanced: outputAdvanced,
        chromiumSourceFps: sourceOk,
        webrtcEncoderFps: encoderOk,
        webrtcDecoderFps: decoderOk,
      },
    };

    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      throw new Error(`固定帧率链路未完全通过：OBS=${obsOk} source=${sourceFps.toFixed(2)}fps encoded=${encodedFps.toFixed(2)}fps decoded=${decodedFps.toFixed(2)}fps。`);
    }
  } finally {
    try { if (browser && !browser.isDestroyed()) browser.destroy(); } catch { }
    try { if (server) await new Promise(resolve => server.close(resolve)); } catch { }
    try { await engine.close(); } catch { }
    app.quit();
  }
}

main().catch(error => {
  console.error(`[OBS -> Electron] FAIL: ${error.stack || error.message}`);
  app.quit();
  process.exitCode = 1;
});
