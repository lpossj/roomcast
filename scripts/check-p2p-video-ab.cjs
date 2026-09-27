// Local Chromium diagnostic: identical source, policy enabled vs paused.
// No signaling/TURN changes and no production diagnostic toggle.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { app, BrowserWindow } = require('electron');
const root = path.resolve(__dirname, '..');
const suffix = process.argv.find(v => v.startsWith('--label='))?.slice(8) || 'baseline';
const policySource = fs.readFileSync(path.join(root, 'src/p2p-video-policy.js'), 'utf8');
let win, server;
async function main() {
  await app.whenReady();
  server = http.createServer((req, res) => {
    if (req.url === '/policy.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(policySource); }
    else { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Roomcast isolated video A/B</title>'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: false } });
  await win.loadURL(`http://127.0.0.1:${server.address().port}/`);
  const output = await win.webContents.executeJavaScript(`(${renderer.toString()})()`);
  const outputPath = path.join(root, '.test', 'video-ab-' + suffix + '.json');
  fs.writeFileSync(outputPath, JSON.stringify({ at: new Date().toISOString(), scope: 'Actual Electron Chromium, canvas 1080p60, local host candidate pair; no public-network evidence', ...output }, null, 2));
  console.log(JSON.stringify({ outputPath, summary: output.summary }));
}
async function renderer() {
  const { createP2pVideoPolicy, recordP2pNetworkStats, readP2pDiagnostics } = await import('/policy.js');
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const canvas = document.createElement('canvas'); canvas.width = 1920; canvas.height = 1080;
  const ctx = canvas.getContext('2d', { alpha: false });
  let moving = false, frame = 0;
  function draw() {
    const shift = moving ? (++frame * 19) % 160 : 0;
    ctx.fillStyle = '#182839'; ctx.fillRect(0, 0, 1920, 1080);
    for (let y = 0; y < 1080; y += 40) for (let x = -160; x < 1920; x += 40) {
      ctx.fillStyle = ((x + y) / 40) % 2 ? '#eff4f8' : '#5a8fbd';
      ctx.fillRect(x + shift, y, 35, 35);
    }
    ctx.fillStyle = '#efbb29'; ctx.font = 'bold 40px sans-serif';
    ctx.fillText('Roomcast static / motion 1080p60 ' + (moving ? frame : 0), 90, 200);
  }
  draw();
  const stream = canvas.captureStream(0), track = stream.getVideoTracks()[0]; track.contentHint = 'motion';
  const timer = setInterval(() => { draw(); track.requestFrame(); }, 1000 / 60);
  const entries = [];
  const quality = { width: 1920, height: 1080, fps: 60, bitrate: 8000 };
  try {
    for (const mode of ['enabled', 'paused']) {
      const pc = new RTCPeerConnection({ iceServers: [] }), receiver = new RTCPeerConnection({ iceServers: [] });
      const entry = { mode, pc, receiver, video: null, policy: null, rows: [], qp: null }; entries.push(entry);
      pc.onicecandidate = e => { if (e.candidate) receiver.addIceCandidate(e.candidate).catch(() => {}); };
      receiver.onicecandidate = e => { if (e.candidate) pc.addIceCandidate(e.candidate).catch(() => {}); };
      receiver.ontrack = e => { const v = document.createElement('video'); v.muted = true; v.srcObject = e.streams[0]; document.body.append(v); void v.play(); entry.video = v; };
      const sender = pc.addTrack(track, stream);
      await pc.setLocalDescription(await pc.createOffer()); await receiver.setRemoteDescription(pc.localDescription);
      await receiver.setLocalDescription(await receiver.createAnswer()); await pc.setRemoteDescription(receiver.localDescription);
      for (let i = 0; pc.connectionState !== 'connected' && i < 100; i++) await sleep(100);
      if (pc.connectionState !== 'connected') throw Error('Local WebRTC setup failed');
      const p = sender.getParameters(); Object.assign(p.encodings[0], { maxBitrate: 8000000, maxFramerate: 60, scaleResolutionDownBy: 1, priority: 'high', networkPriority: 'high', bitratePriority: 2 }); p.degradationPreference = 'maintain-resolution'; await sender.setParameters(p);
      entry.sender = sender;
      if (mode === 'enabled') entry.policy = createP2pVideoPolicy({ pc, sender, quality });
    }
    const started = performance.now();
    for (let second = 0; second < 44; second++) {
      moving = second >= 30;
      await sleep(1000);
      for (const entry of entries) {
        let sample;
        if (entry.policy) { await entry.policy.poll(); sample = readP2pDiagnostics().connections.find(h => h.direction === 'publisher')?.samples.at(-1); }
        else sample = recordP2pNetworkStats(entry.pc, await entry.pc.getStats(), 'paused', { tierIndex: 0, appliedFps: 60 });
        const report = await entry.pc.getStats();
        const out = [...report.values()].find(s => s.type === 'outbound-rtp' && s.kind === 'video');
        const frames = entry.qp ? out.framesEncoded - entry.qp.frames : 0;
        const averageQp = frames > 0 && out.qpSum >= entry.qp.qp ? (out.qpSum - entry.qp.qp) / frames : null;
        entry.qp = { qp: out.qpSum, frames: out.framesEncoded };
        entry.rows.push({ elapsedMs: performance.now() - started, phase: moving ? 'motion' : 'static', ...sample, averageQp, codec: report.get(out.codecId)?.mimeType, parameters: entry.sender.getParameters() });
      }
    }
    const summary = entries.map(e => {
      const motion = e.rows.filter(r => r.phase === 'motion'), videos = motion.map(r => r.streams.find(s => s.kind === 'video'));
      return { mode: e.mode, tiers: motion.map(r => r.policy?.tierIndex), fps: videos.map(s => s?.framesPerSecond), bitrate: videos.map(s => s?.bitrate), available: videos.map(s => s?.availableOutgoingBitrate), qp: motion.map(r => r.averageQp), reason: videos.map(s => s?.qualityLimitationReason) };
    });
    return { summary, timelines: entries.map(e => ({ mode: e.mode, rows: e.rows })) };
  } finally {
    clearInterval(timer); track.stop();
    for (const entry of entries) { entry.policy?.stop(); entry.pc.close(); entry.receiver.close(); entry.video?.remove(); }
  }
}
main().then(() => { win?.destroy(); server?.close(); app.quit(); }).catch(e => { console.error(e.stack); win?.destroy(); server?.close(); app.quit(); process.exitCode = 1; });
