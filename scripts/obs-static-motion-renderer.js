'use strict';

window.runObsStaticMotionProbe = async function runObsStaticMotionProbe(config) {
  const wantedWidth = Number(config.width);
  const wantedHeight = Number(config.height);
  const wantedFps = Number(config.fps);
  const staticSeconds = Number(config.staticSeconds);
  const motionSeconds = Number(config.motionSeconds);
  const intervalMs = Number(config.intervalMs);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function waitForIceGathering(pc, timeoutMs = 8000) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('本机 WebRTC ICE gathering 超时。')); }, timeoutMs);
      const onState = () => { if (pc.iceGatheringState === 'complete') { cleanup(); resolve(); } };
      const cleanup = () => { clearTimeout(timer); pc.removeEventListener('icegatheringstatechange', onState); };
      pc.addEventListener('icegatheringstatechange', onState);
    });
  }

  function waitForConnection(pc, timeoutMs = 8000) {
    if (pc.connectionState === 'connected') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('本机 WebRTC loopback 连接超时：' + pc.connectionState)); }, timeoutMs);
      const onState = () => {
        if (pc.connectionState === 'connected') { cleanup(); resolve(); }
        else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') { cleanup(); reject(new Error('本机 WebRTC loopback 失败：' + pc.connectionState)); }
      };
      const cleanup = () => { clearTimeout(timer); pc.removeEventListener('connectionstatechange', onState); };
      pc.addEventListener('connectionstatechange', onState);
    });
  }

  async function findVideoStat(report, type) {
    for (const item of report.values()) {
      if (item.type !== type) continue;
      const kind = item.kind || item.mediaType;
      if (kind === 'video' && !item.isRemote) return item;
    }
    return null;
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  const videos = devices.filter(device => device.kind === 'videoinput');
  const obs = videos.find(device => /OBS\s+Virtual\s+Camera/i.test(device.label || ''));
  if (!obs) throw new Error('Chromium 未发现 OBS Virtual Camera。');

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
  if (!track) throw new Error('OBS Virtual Camera 没有返回视频轨。');
  if ('contentHint' in track) track.contentHint = 'motion';

  const sourceVideo = document.createElement('video');
  sourceVideo.muted = true;
  sourceVideo.playsInline = true;
  sourceVideo.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;';
  sourceVideo.srcObject = stream;
  document.body.append(sourceVideo);
  await sourceVideo.play();
  if (!sourceVideo.videoWidth) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待 OBS Virtual Camera 首帧超时。')), 8000);
      sourceVideo.addEventListener('loadeddata', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }

  const senderPc = new RTCPeerConnection({ iceServers: [] });
  const receiverPc = new RTCPeerConnection({ iceServers: [] });
  let receiver = null;
  let remoteTrack = null;
  const remoteTrackPromise = new Promise(resolve => {
    receiverPc.addEventListener('track', event => {
      receiver = event.receiver;
      remoteTrack = event.track;
      resolve();
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

  try {
    const parameters = sender.getParameters();
    if (!Array.isArray(parameters.encodings) || !parameters.encodings.length) parameters.encodings = [{}];
    parameters.encodings[0].maxFramerate = wantedFps;
    parameters.encodings[0].maxBitrate = 20_000_000;
    parameters.degradationPreference = 'maintain-framerate';
    await sender.setParameters(parameters);
  } catch { }

  const remoteVideo = document.createElement('video');
  remoteVideo.muted = true;
  remoteVideo.playsInline = true;
  remoteVideo.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;';
  remoteVideo.srcObject = new MediaStream([remoteTrack]);
  document.body.append(remoteVideo);
  await remoteVideo.play();
  await sleep(1000);

  async function counters(elapsedMs, phase) {
    const quality = sourceVideo.getVideoPlaybackQuality ? sourceVideo.getVideoPlaybackQuality() : null;
    const outbound = await findVideoStat(await sender.getStats(), 'outbound-rtp');
    const inbound = receiver ? await findVideoStat(await receiver.getStats(), 'inbound-rtp') : null;
    return {
      elapsedMs,
      phase,
      totalVideoFrames: Number(quality?.totalVideoFrames ?? sourceVideo.webkitDecodedFrameCount ?? 0),
      droppedVideoFrames: Number(quality?.droppedVideoFrames ?? sourceVideo.webkitDroppedFrameCount ?? 0),
      framesEncoded: Number(outbound?.framesEncoded || 0),
      framesSent: Number(outbound?.framesSent || 0),
      bytesSent: Number(outbound?.bytesSent || 0),
      keyFramesEncoded: Number(outbound?.keyFramesEncoded || 0),
      framesDecoded: Number(inbound?.framesDecoded || 0),
      framesReceived: Number(inbound?.framesReceived || 0),
      bytesReceived: Number(inbound?.bytesReceived || 0),
    };
  }

  document.documentElement.classList.remove('moving');
  const samples = [];
  const started = performance.now();
  const transitionMs = staticSeconds * 1000;
  const finishMs = transitionMs + motionSeconds * 1000;
  let nextSample = 0;
  let movingStarted = false;

  while (true) {
    const elapsed = performance.now() - started;
    if (!movingStarted && elapsed >= transitionMs) {
      document.documentElement.classList.add('moving');
      movingStarted = true;
    }
    if (elapsed >= nextSample) {
      samples.push(await counters(elapsed, movingStarted ? 'motion' : 'static'));
      nextSample += intervalMs;
    }
    if (elapsed >= finishMs) break;
    await sleep(Math.min(25, Math.max(1, nextSample - elapsed)));
  }
  samples.push(await counters(performance.now() - started, 'motion'));

  const settings = track.getSettings();
  try { senderPc.close(); } catch { }
  try { receiverPc.close(); } catch { }
  stream.getTracks().forEach(item => item.stop());
  sourceVideo.remove();
  remoteVideo.remove();

  return {
    device: { label: obs.label, deviceIdPresent: Boolean(obs.deviceId) },
    trackSettings: settings,
    transitionMs,
    staticSeconds,
    motionSeconds,
    intervalMs,
    samples,
  };
};

void 0;
