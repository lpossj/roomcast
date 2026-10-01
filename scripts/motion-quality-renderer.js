// Only the controlled diagnostic window contains this pattern and frame checksum.
window.installMotionPattern = function () {
  const canvas = document.querySelector('canvas'), ctx = canvas.getContext('2d', { alpha: false });
  const texture = document.createElement('canvas'); texture.width = 1920; texture.height = 1080;
  const tx = texture.getContext('2d'); let seed = 834725;
  for (let y = 0; y < 1080; y += 8) for (let x = 0; x < 1920; x += 8) {
    seed = (seed * 1664525 + 1013904223) >>> 0; const c = seed >>> 24;
    tx.fillStyle = `rgb(${c},${(c * 5) % 256},${(c * 11) % 256})`; tx.fillRect(x, y, 8, 8);
  }
  let phase = 'static', frameId = 1, moving = false, needsDraw = true;
  window.setMotionPhase = name => { if (phase !== name) frameId++; phase = name; moving = name === 'motion'; needsDraw = true; };
  const draw = () => {
    if (moving) frameId++;
    if (moving || needsDraw) {
      const offset = moving ? frameId * 19 % 1920 : (frameId > 1 ? frameId * 19 % 1920 : 0);
      ctx.drawImage(texture, -offset, 0); ctx.drawImage(texture, 1920 - offset, 0);
      ctx.fillStyle = '#ececec'; ctx.fillRect(60, 90, 1500, 280); ctx.fillStyle = '#202020'; ctx.font = '20px monospace';
      const textOffset = moving ? frameId * 13 % 80 : 0;
      for (let y = 118; y < 355; y += 27) ctx.fillText('Roomcast screen detail ABCDEF 0123456789 — matched-frame quality', 75 + textOffset, y);
      ctx.fillStyle = '#111'; ctx.fillRect(0, 0, 340, 58);
      const word = frameId | (((frameId * 131 + 17) & 255) << 16);
      for (let bit = 0; bit < 24; bit++) { ctx.fillStyle = word & (1 << bit) ? '#efefef' : '#111'; ctx.fillRect(16 + bit * 12, 16, 12, 24); }
      needsDraw = false;
    }
    requestAnimationFrame(draw);
  };
  draw();
};

window.runMotionQuality = async function (config) {
  const { P2PRoom, startIntegratedCapture, startObsFixedFpsCapture, readP2pDiagnostics, lockVideoBitrate, preferH264High } = window.motionModules;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const ensure = (condition, message) => { if (!condition) throw Error(message); };
  window.roomcast = { desktop: true, selectCapture: () => true, startObsCapture: async () => ({ ok: true, captureId: 'owned-test' }), stopObsCapture: async () => ({ ok: true }) };
  await fetch('/phase?name=static');
  const room = new P2PRoom(); room.id = 'test-host'; room.connected = true; room.mediaIceServers = [];
  const previousConnections = new Set(readP2pDiagnostics().connections.map(item => item.connection));
  const policyHistory = () => readP2pDiagnostics().connections.findLast(item => item.direction === 'publisher' && !previousConnections.has(item.connection)) ?? null;
  const viewer = new RTCPeerConnection({ iceServers: [] });
  let source, sourceVideo, decodedVideo, publisher, sourceFrame = 0, decodedFrame = 0, cancelled = false;
  let stage = 'capture';
  const pendingToPublisher = [], pendingToViewer = [], quality = [], rows = [], references = new Map(), imagePairs = {};
  let phase = 'initial', phaseStarted = performance.now(), sourceReadCount = 0, decodedReadCount = 0, checksumFailures = 0, unmatchedFrames = 0, lastMeasured = -Infinity;
  const idCanvas = document.createElement('canvas'); idCanvas.width = 24; idCanvas.height = 1; const idCtx = idCanvas.getContext('2d', { willReadFrequently: true });
  const sourceCanvas = document.createElement('canvas'), decodedCanvas = document.createElement('canvas');
  sourceCanvas.width = decodedCanvas.width = 384; sourceCanvas.height = decodedCanvas.height = 144;
  const sourceCtx = sourceCanvas.getContext('2d', { willReadFrequently: true }), decodedCtx = decodedCanvas.getContext('2d', { willReadFrequently: true });
  const decodeId = video => {
    idCtx.drawImage(video, video.videoWidth * 16 / 1920, video.videoHeight * 16 / 1080, video.videoWidth * 288 / 1920, video.videoHeight * 24 / 1080, 0, 0, 24, 1);
    const pixels = idCtx.getImageData(0, 0, 24, 1).data; let word = 0;
    for (let bit = 0; bit < 24; bit++) if (pixels[bit * 4] > 128) word |= 1 << bit;
    const id = word & 65535; return ((word >>> 16) & 255) === ((id * 131 + 17) & 255) ? id : null;
  };
  const roi = (video, ctx) => {
    ctx.drawImage(video, video.videoWidth * 80 / 1920, video.videoHeight * 140 / 1080, video.videoWidth * 384 / 1920, video.videoHeight * 144 / 1080, 0, 0, 384, 144);
    return ctx.getImageData(0, 0, 384, 144);
  };
  const videoFor = async stream => { const video = document.createElement('video'); video.muted = true; video.playsInline = true; video.srcObject = stream; document.body.append(video); await video.play(); for (let n = 0; !video.videoWidth && n < 80; n++) await sleep(100); ensure(video.videoWidth > 0, 'Video first frame timeout'); return video; };
  const sourceTick = () => {
    if (cancelled) return;
    const id = decodeId(sourceVideo); sourceReadCount++;
    if (id !== null && !references.has(id)) { references.set(id, roi(sourceVideo, sourceCtx)); if (references.size > 90) references.delete(references.keys().next().value); }
    sourceFrame = sourceVideo.requestVideoFrameCallback(sourceTick);
  };
  const decodedTick = () => {
    if (cancelled) return;
    decodedReadCount++;
    const now = performance.now();
    if (now - lastMeasured >= 100) {
      lastMeasured = now;
      const id = decodeId(decodedVideo), reference = references.get(id);
      if (id === null) checksumFailures++; else if (!reference) unmatchedFrames++;
      else {
        const decoded = roi(decodedVideo, decodedCtx); let squared = 0;
        for (let i = 0; i < decoded.data.length; i += 4) { const delta = 0.2126 * (decoded.data[i] - reference.data[i]) + 0.7152 * (decoded.data[i + 1] - reference.data[i + 1]) + 0.0722 * (decoded.data[i + 2] - reference.data[i + 2]); squared += delta * delta; }
        const mse = squared / (384 * 144), psnrDb = mse > 0 ? 10 * Math.log10(255 * 255 / mse) : 100;
        const sample = { at: now, phase, phaseMs: now - phaseStarted, frameId: id, psnrDb }; quality.push(sample);
        if (sample.phaseMs >= 1500 && (!imagePairs[phase] || (phase === 'motion' ? psnrDb < imagePairs[phase].psnrDb : psnrDb > imagePairs[phase].psnrDb))) {
          sourceCtx.putImageData(reference, 0, 0); imagePairs[phase] = { source: sourceCanvas.toDataURL('image/png'), decoded: decodedCanvas.toDataURL('image/png'), frameId: id, psnrDb };
        }
      }
    }
    decodedFrame = decodedVideo.requestVideoFrameCallback(decodedTick);
  };
  try {
    window.__roomcastTestNativeDirect = config.nativePath === 'direct';
    const settings = { width: 1920, height: 1080, fps: config.fps, bitrate: config.bitrate, performanceMode: 'quality' };
    source = config.backend === 'obs' ? await startObsFixedFpsCapture({ ...settings, sourceType: 'window', sourceId: 'controlled-test' }) : await startIntegratedCapture({ ...settings, sourceId: 'controlled-test' });
    if (config.hint !== 'default') source.getVideoTracks()[0].contentHint = config.hint;
    stage = 'source-first-frame';
    sourceVideo = await videoFor(source); sourceTick(); room.screenStream = source; room.screenSettings = settings;
    const transceiver = viewer.addTransceiver('video', { direction: 'recvonly' });
    // ScreenPlayer always offers an audio section, even for a silent share.
    viewer.addTransceiver('audio', { direction: 'recvonly' });
    const codecs = RTCRtpReceiver.getCapabilities('video').codecs, preferred = codecs.filter(codec => codec.mimeType.toLowerCase() === `video/${config.codec.toLowerCase()}`);
    ensure(preferred.length > 0, `${config.codec} receiver capability unavailable`);
    if (config.codec === 'H264' && config.h264Profile === 'high') {
      ensure(preferred.some(codec => /profile-level-id=64/i.test(codec.sdpFmtpLine || '')), 'H264 High profile receiver capability unavailable');
      preferred.sort((a, b) => Number(/profile-level-id=64/i.test(b.sdpFmtpLine || '')) - Number(/profile-level-id=64/i.test(a.sdpFmtpLine || '')));
    }
    if (config.codec === 'VP9' && config.vp9Profile === '2') {
      ensure(preferred.some(codec => /profile-id=2/.test(codec.sdpFmtpLine || '')), 'VP9 profile2 receiver capability unavailable');
      preferred.sort((a, b) => Number(/profile-id=2/.test(b.sdpFmtpLine || '')) - Number(/profile-id=2/.test(a.sdpFmtpLine || '')));
    }
    transceiver.setCodecPreferences(config.codec === 'H264' ? preferH264High(codecs) : [...preferred, ...codecs.filter(codec => !preferred.includes(codec))]);
    let resolveRemote; const remoteStream = new Promise(resolve => { resolveRemote = resolve; });
    viewer.ontrack = event => resolveRemote(new MediaStream([event.track]));
    viewer.onicecandidate = event => { if (publisher?.remoteDescription) publisher.addIceCandidate(event.candidate).catch(() => {}); else pendingToPublisher.push(event.candidate); };
    room.request = async (event, payload) => { if (event === 'screen:signal' && payload.kind === 'candidate') { if (viewer.remoteDescription) await viewer.addIceCandidate(payload.candidate); else pendingToViewer.push(payload.candidate); } return { ok: true }; };
    stage = 'production-answer';
    await viewer.setLocalDescription(await viewer.createOffer());
    const offeredSdp = config.startOffer === 'on' ? lockVideoBitrate(viewer.localDescription.sdp, config.bitrate) : viewer.localDescription.sdp;
    const answer = await room.answerScreen('test-viewer', offeredSdp, 'test-request');
    const entry = room.screenSessions.get(answer.session);
    publisher = entry.pc;
    // Test-only comparison: stop before connection so no policy parameter write occurs.
    if (config.policy === 'off') entry.videoPolicy?.stop();
    await viewer.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
    for (const candidate of pendingToPublisher) await publisher.addIceCandidate(candidate);
    for (const candidate of pendingToViewer) await viewer.addIceCandidate(candidate);
    for (let n = 0; publisher.connectionState !== 'connected' && n < 100; n++) await sleep(100);
    ensure(publisher.connectionState === 'connected', 'Production P2P sender local connection failed');
    stage = 'decoded-first-frame';
    decodedVideo = await videoFor(await remoteStream); decodedTick();
    const sender = publisher.getSenders().find(item => item.track?.kind === 'video');
    const firstParameters = sender.getParameters(); let previous = null;
    stage = 'measurement';
    for (const [name, seconds] of [['static', config.staticSeconds], ['motion', config.motionSeconds], ['recovery', config.recoverySeconds]]) {
      phase = name; await fetch(`/phase?name=${name}`); phaseStarted = performance.now();
      const started = phaseStarted;
      while (performance.now() - started < seconds * 1000) {
        await sleep(500);
        const report = await publisher.getStats(), received = await viewer.getStats();
        const out = [...report.values()].find(stat => stat.type === 'outbound-rtp' && stat.kind === 'video' && !stat.isRemote);
        const inbound = [...received.values()].find(stat => stat.type === 'inbound-rtp' && stat.kind === 'video' && !stat.isRemote);
        const elapsed = previous ? out.timestamp - previous.timestamp : 0;
        const difference = key => previous && Number.isFinite(out[key]) && Number.isFinite(previous[key]) && out[key] >= previous[key] ? out[key] - previous[key] : null;
        const frames = difference('framesEncoded'), qp = difference('qpSum'), encodedTime = difference('totalEncodeTime');
        const pair = report.get(report.get(out.transportId)?.selectedCandidatePairId), params = sender.getParameters();
        const history = policyHistory();
        rows.push({ phase, phaseMs: performance.now() - started, at: Date.now(), width: out.frameWidth ?? null, height: out.frameHeight ?? null,
          encodedFps: elapsed > 0 && frames !== null ? frames * 1000 / elapsed : null,
          sourceFps: elapsed > 0 && Number.isFinite(previous?.sourceFrames) ? Math.max(0, sourceVideo.getVideoPlaybackQuality().totalVideoFrames - previous.sourceFrames) * 1000 / elapsed : null,
          decodedFps: elapsed > 0 && Number.isFinite(inbound?.framesDecoded) && Number.isFinite(previous?.decodedFrames) ? Math.max(0, inbound.framesDecoded - previous.decodedFrames) * 1000 / elapsed : null,
          averageQp: frames > 0 && qp !== null ? qp / frames : null, encodeTimeMs: frames > 0 && encodedTime !== null ? encodedTime * 1000 / frames : null,
          bitrate: elapsed > 0 && difference('bytesSent') !== null ? difference('bytesSent') * 8000 / elapsed : null,
          targetBitrate: out.targetBitrate ?? null, availableOutgoingBitrate: pair?.availableOutgoingBitrate ?? null, rtt: pair?.currentRoundTripTime ?? null,
          packetSendDelayMs: difference('packetsSent') > 0 && difference('totalPacketSendDelay') !== null ? difference('totalPacketSendDelay') * 1000 / difference('packetsSent') : null,
          reportedRemoteLoss: report.get(out.remoteId)?.fractionLost ?? null,
          keyFrames: difference('keyFramesEncoded'), reason: out.qualityLimitationReason ?? null, codec: report.get(out.codecId)?.mimeType ?? null,
          codecParameters: report.get(out.codecId)?.sdpFmtpLine ?? null,
          encoderImplementation: out.encoderImplementation ?? null, tierIndex: history?.samples.at(-1)?.policy?.tierIndex ?? null,
          visibility: document.visibilityState,
          maxBitrate: params.encodings?.[0]?.maxBitrate ?? null, maxFramerate: params.encodings?.[0]?.maxFramerate ?? null, degradationPreference: params.degradationPreference ?? null });
        previous = { timestamp: out.timestamp, framesEncoded: out.framesEncoded, qpSum: out.qpSum, totalEncodeTime: out.totalEncodeTime,
          bytesSent: out.bytesSent, packetsSent: out.packetsSent, totalPacketSendDelay: out.totalPacketSendDelay,
          keyFramesEncoded: out.keyFramesEncoded, decodedFrames: inbound?.framesDecoded, sourceFrames: sourceVideo.getVideoPlaybackQuality().totalVideoFrames };
      }
    }
    ensure(rows.some(row => row.codec?.toLowerCase() === `video/${config.codec.toLowerCase()}`), `Requested ${config.codec} was not negotiated`);
    if (config.codec === 'H264' && config.h264Profile === 'high') ensure(rows.some(row => /profile-level-id=64/i.test(row.codecParameters || '')), 'H264 High profile was not negotiated');
    if (config.codec === 'VP9' && config.vp9Profile === '2') ensure(rows.some(row => /profile-id=2/.test(row.codecParameters || '')), 'VP9 profile2 was not negotiated');
    return { backend: config.backend, bitrate: config.bitrate, requestedFps: config.fps, requestedHint: config.hint, requestedCodec: config.codec, startOffer: config.startOffer, policyMode: config.policy, policyHistory: policyHistory(),
      capture: { width: sourceVideo.videoWidth, height: sourceVideo.videoHeight, hint: source.getVideoTracks()[0].contentHint },
      firstParameters: { encodings: firstParameters.encodings, degradationPreference: firstParameters.degradationPreference },
      sourceReadCount, decodedReadCount, checksumFailures, unmatchedFrames, rows, quality, imagePairs };
  } catch (error) {
    throw new Error(`${stage}: ${error?.name || 'Error'}: ${error?.message || String(error)}`);
  } finally {
    cancelled = true; if (sourceFrame) sourceVideo?.cancelVideoFrameCallback(sourceFrame); if (decodedFrame) decodedVideo?.cancelVideoFrameCallback(decodedFrame);
    room.stopScreenStream(); source?.roomcastCleanup?.(); source?.getTracks().forEach(track => track.stop()); viewer.close(); sourceVideo?.remove(); decodedVideo?.remove();
  }
};
