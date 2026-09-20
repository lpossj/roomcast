let tokenPromise;

export async function localAction(action, payload = {}) {
  if (window.roomcast?.localAction) return window.roomcast.localAction(action, payload);
  if (!tokenPromise) tokenPromise = fetch('/api/local/token').then(async response => {
    const value = await response.json();
    if (!response.ok || !value.token) throw new Error(value.error || '请使用桌面客户端或本机地址执行本地媒体操作');
    return value.token;
  }).catch(error => { tokenPromise = undefined; throw error; });
  const token = await tokenPromise;
  const response = await fetch(`/api/local/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Roomcast-Local': token },
    body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (!response.ok || result.ok === false) throw new Error(result.error || '本地媒体操作失败');
  return result;
}

export async function integratedSources({ backend = 'native', width = 1920, height = 1080, fps = 30 } = {}) {
  if (backend === 'obs') {
    if (!window.roomcast?.obsCaptureSources) throw new Error('当前桌面版本不支持 OBS 采集。');
    const sources = await window.roomcast.obsCaptureSources({ width, height, fps });
    if (sources?.ok === false) {
      const phase = String(sources?.phase || 'sources');
      const error = new Error(String(sources.message || `OBS ${phase} 阶段暂不可用。`));
      error.code = String(sources?.code || 'OBS_BACKEND_UNAVAILABLE');
      error.obsPhase = phase;
      if (sources?.fallbackNative) error.fallbackBackend = 'native';
      throw error;
    }
    return {
      monitors: Array.isArray(sources?.monitors) ? sources.monitors : [],
      windows: Array.isArray(sources?.windows) ? sources.windows : [],
    };
  }
  if (!window.roomcast?.captureSources) return { monitors: [{ id: 'browser', name: '由浏览器选择屏幕或窗口' }], windows: [] };
  const sources = await window.roomcast.captureSources();
  return {
    monitors: sources.filter(source => source.type === 'monitor'),
    windows: sources.filter(source => source.type === 'window'),
  };
}

const OBS_VIRTUAL_CAMERA = /OBS\s+Virtual\s+Camera/i;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function findObsVirtualCamera(timeoutMs = 8000) {
  const deadline = performance.now() + timeoutMs;
  let labels = [];
  do {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videos = devices.filter(device => device.kind === 'videoinput');
    labels = videos.map(device => device.label || '(无标签)');
    const found = videos.find(device => OBS_VIRTUAL_CAMERA.test(device.label || ''));
    if (found?.deviceId) return found;
    await wait(120);
  } while (performance.now() < deadline);
  throw new Error(`Chromium 未发现 OBS Virtual Camera。当前视频输入：${labels.join('、') || '无'}。`);
}

export async function startObsFixedFpsCapture({ sourceType = 'monitor', sourceId, width = 1920, height = 1080, fps = 30, microphone = false, microphoneMuted = false, inputDeviceId = '' } = {}) {
  if (!window.roomcast?.startObsCapture || !window.roomcast?.stopObsCapture) throw new Error('当前桌面版本不支持 OBS 采集。');
  let stream = null;
  let microphoneStream = null;
  let removeBackendEnded = null;
  let cleaned = false;
  let videoTrack = null;
  let backendEndedReason = '';
  const requestedCaptureId = globalThis.crypto?.randomUUID?.() || `obs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
  let backendCaptureId = requestedCaptureId;
  let backendStopPromise = null;
  const stopBackend = () => {
    if (!backendStopPromise) {
      backendStopPromise = window.roomcast.stopObsCapture(backendCaptureId).catch(() => ({ ok: false }));
    }
    return backendStopPromise;
  };
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    removeBackendEnded?.();
    removeBackendEnded = null;
    for (const track of stream?.getTracks() || []) track.stop();
    for (const track of microphoneStream?.getTracks() || []) track.stop();
    void stopBackend();
  };
  try {
    if (window.roomcast?.onObsCaptureEnded) {
      removeBackendEnded = window.roomcast.onObsCaptureEnded(payload => {
        if (cleaned) return;
        const endedCaptureId = String(payload?.captureId || '');
        if (endedCaptureId && endedCaptureId !== backendCaptureId && endedCaptureId !== requestedCaptureId) return;
        backendEndedReason = String(payload?.reason || 'OBS 采集进程意外退出，当前屏幕共享已停止。');
        if (!videoTrack) return;
        videoTrack.roomcastBackendEndedReason = backendEndedReason;
        cleanup();
        // MediaStreamTrack.stop() does not fire ended. Dispatch it so the
        // existing Roomcast share lifecycle tears down P2P/VDO sessions and
        // releases the room share claim without touching the control room.
        videoTrack.dispatchEvent(new Event('ended'));
      });
    }

    const started = await window.roomcast.startObsCapture({ captureId: requestedCaptureId, sourceType, sourceId, width, height, fps, cursor: true, clientArea: true });
    if (started?.ok === false) {
      const failure = new Error(String(started.message || 'OBS 采集启动失败。'));
      failure.obsPhase = String(started?.phase || 'start');
      failure.code = started?.busy ? 'OBS_BACKEND_BUSY' : String(started?.code || 'OBS_BACKEND_UNAVAILABLE');
      if (started?.fallbackNative) failure.fallbackBackend = 'native';
      throw failure;
    }
    backendCaptureId = String(started?.captureId || requestedCaptureId);

    const device = await findObsVirtualCamera();
    if (backendEndedReason) throw new Error(backendEndedReason);
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        deviceId: { exact: device.deviceId },
        width: { ideal: width },
        height: { ideal: height },
        frameRate: { ideal: fps, max: fps },
      },
    });
    const track = stream.getVideoTracks()[0];
    videoTrack = track || null;
    if (!track) throw new Error('OBS Virtual Camera 未返回视频轨道。');
    if (backendEndedReason) throw new Error(backendEndedReason);
    if (!OBS_VIRTUAL_CAMERA.test(track.label || device.label || '')) throw new Error(`打开了错误的视频设备：${track.label || '未知设备'}。`);
    if ('contentHint' in track) track.contentHint = 'motion';

    if (microphone) {
      try {
        microphoneStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...(inputDeviceId ? { deviceId: { exact: inputDeviceId } } : {}) }, video: false });
      } catch (error) {
        throw new Error(error.name === 'NotAllowedError' ? '麦克风权限未开启，无法在共享中加入麦克风。' : `无法开启共享麦克风：${error.message}`);
      }
      const micTrack = microphoneStream.getAudioTracks()[0];
      if (micTrack) {
        micTrack.enabled = !microphoneMuted;
        if ('contentHint' in micTrack) micTrack.contentHint = 'speech';
        stream.addTrack(micTrack);
      }
    }

    stream.roomcastCaptureBackend = 'obs';
    stream.roomcastCaptureId = backendCaptureId;
    stream.roomcastCleanup = cleanup;
    track.addEventListener('ended', () => { if (!cleaned) void stopBackend(); }, { once: true });
    return stream;
  } catch (error) {
    cleanup();
    throw error;
  }
}

export async function nativeAudioSources() {
  if (!window.roomcast?.audioSources) return [];
  const sources = await window.roomcast.audioSources();
  if (!Array.isArray(sources)) throw new Error('音频应用枚举返回格式无效。');
  return sources.filter(item => /^\d+$/.test(String(item?.processId || ''))).map(item => ({ ...item, id: String(item.processId), processId: String(item.processId), name: String(item.name || item.title || item.processName || item.processId) }));
}

export function startIntegratedCapture({ sourceId, width = 1920, height = 1080, fps = 30, systemAudio = false, microphone = false, applicationMuted = false, microphoneMuted = false, inputDeviceId = '', compatibilityCanvas = false } = {}) {
  if (window.roomcast?.selectCapture && !window.roomcast.selectCapture({ id: sourceId, audio: systemAudio })) throw new Error('所选屏幕或窗口已经不可用，请刷新后重试。');
  // Call getDisplayMedia before yielding so Chromium can associate the request
  // with the user's click. Electron's trusted main process grants the source
  // selected in Roomcast's own picker.
  const request = navigator.mediaDevices.getDisplayMedia({ video: true, audio: systemAudio });
  return request.then(async stream => {
    const track = stream.getVideoTracks()[0];
    if (!track) { for (const item of stream.getTracks()) item.stop(); throw new Error('未获得屏幕画面。'); }
    // Desktop tracks can apply width twice (capture resize plus RTP scaling) on
    // Chromium. Keep the source at native resolution and resize once in the
    // sender so the viewer receives the requested dimensions predictably.
    const targetFps = Math.max(1, Math.min(120, Math.round(Number(fps) || 30)));
    try {
      // Ask desktop capture for the selected source cadence as a hard bound.
      // Chromium may still suppress unchanged desktop frames even when this
      // constraint is satisfied, so the fixed outbound cadence is enforced
      // separately below rather than relying on this constraint alone.
      await track.applyConstraints({ frameRate: { min: targetFps, ideal: targetFps, max: targetFps } });
    } catch (error) {
      stream.getTracks().forEach(item => item.stop());
      throw new Error(`无法锁定 ${targetFps} FPS：${error.message}`);
    }
    if (microphone) {
      let micStream;
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...(inputDeviceId ? { deviceId: { exact: inputDeviceId } } : {}) }, video: false });
      } catch (error) {
        stream.getTracks().forEach(item => item.stop());
        throw new Error(error.name === 'NotAllowedError' ? '麦克风权限未开启，无法在共享中加入麦克风。' : `无法开启共享麦克风：${error.message}`);
      }
      const systemTracks = stream.getAudioTracks();
      if (systemTracks.length) {
        const context = new AudioContext();
        const destination = context.createMediaStreamDestination();
        const systemGain = context.createGain(); systemGain.gain.value = applicationMuted ? 0 : 1;
        const microphoneGain = context.createGain(); microphoneGain.gain.value = microphoneMuted ? 0 : 1;
        context.createMediaStreamSource(new MediaStream(systemTracks)).connect(systemGain).connect(destination);
        context.createMediaStreamSource(micStream).connect(microphoneGain).connect(destination);
        for (const audio of systemTracks) stream.removeTrack(audio);
        stream.addTrack(destination.stream.getAudioTracks()[0]);
        stream.roomcastAudioControls = { systemGain, microphoneGain };
        stream.roomcastCleanup = () => { systemTracks.forEach(item => item.stop()); micStream.getTracks().forEach(item => item.stop()); context.close().catch(() => {}); };
      } else {
        const micTrack = micStream.getAudioTracks()[0];
        if (micTrack) { micTrack.enabled = !microphoneMuted; stream.addTrack(micTrack); }
        stream.roomcastCleanup = () => micStream.getTracks().forEach(item => item.stop());
      }
    }
    else for (const audio of stream.getAudioTracks()) audio.enabled = !applicationMuted;
    if ('contentHint' in track) track.contentHint = 'detail';
    for (const audio of stream.getAudioTracks()) if ('contentHint' in audio) audio.contentHint = 'music';

    // Chromium desktop capture is allowed to stop producing fresh frames while
    // the desktop is static. A frameRate constraint only describes the desired
    // capture rate; it does not force duplicate frames to be emitted. Roomcast
    // therefore decouples source updates from the outbound cadence:
    //   1) update the canvas only when the desktop source really changes;
    //   2) request a canvas capture frame on every selected FPS tick, even when
    //      the pixels are identical to the previous frame.
    // This keeps the encoder warm at 15/30/60 FPS without redrawing a full
    // desktop-sized canvas on every duplicate frame.
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = new MediaStream([track]);
    await video.play();
    if (!video.videoWidth || !video.videoHeight) await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('屏幕画面初始化超时。')), 8000);
      video.addEventListener('loadeddata', () => { clearTimeout(timer); resolve(); }, { once: true });
    }).catch(error => { stream.getTracks().forEach(item => item.stop()); throw error; });

    const targetWidth = compatibilityCanvas
      ? Math.max(320, Math.floor(Number(width) / 2) * 2)
      : Math.max(2, video.videoWidth);
    const targetHeight = compatibilityCanvas
      ? Math.max(240, Math.floor(Number(height) / 2) * 2)
      : Math.max(2, video.videoHeight);
    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const context = canvas.getContext('2d', { alpha: false, colorSpace: 'srgb', desynchronized: true });
    if (!context) { stream.getTracks().forEach(item => item.stop()); throw new Error('无法初始化固定帧率画面轨道。'); }

    let cleaned = false;
    let cadenceActive = true;
    let sourceFrameHandle = 0;
    let sourcePollTimer = 0;
    let cadenceTimer = 0;
    const drawSourceFrame = () => {
      if (!cadenceActive) return;
      context.drawImage(video, 0, 0, targetWidth, targetHeight);
      if (video.requestVideoFrameCallback) sourceFrameHandle = video.requestVideoFrameCallback(drawSourceFrame);
    };
    drawSourceFrame();
    if (!video.requestVideoFrameCallback) {
      sourcePollTimer = setInterval(
        () => {
          if (cadenceActive) context.drawImage(video, 0, 0, targetWidth, targetHeight);
        },
        Math.max(8, Math.round(1000 / targetFps)),
      );
    }

    const rendered = canvas.captureStream(0);
    const renderedTrack = rendered.getVideoTracks()[0];
    if (!renderedTrack || typeof renderedTrack.requestFrame !== 'function') {
      stream.getTracks().forEach(item => item.stop());
      throw new Error('当前 Chromium 不支持 Roomcast 固定帧率输出。');
    }
    if ('contentHint' in renderedTrack) renderedTrack.contentHint = 'motion';
    for (const audio of stream.getAudioTracks()) {
      if ('contentHint' in audio) audio.contentHint = 'music';
      rendered.addTrack(audio);
    }

    const framePeriod = 1000 / targetFps;
    let nextFrameAt = performance.now();
    const requestOutboundFrame = () => {
      if (!cadenceActive) return;
      renderedTrack.requestFrame();
      nextFrameAt += framePeriod;
      const now = performance.now();
      if (nextFrameAt < now - framePeriod) nextFrameAt = now + framePeriod;
      cadenceTimer = setTimeout(requestOutboundFrame, Math.max(0, nextFrameAt - performance.now()));
    };
    // Emit the first frame immediately, then keep an independent fixed cadence.
    requestOutboundFrame();

    const stopCadence = () => {
      if (!cadenceActive) return;
      cadenceActive = false;
      if (sourceFrameHandle && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(sourceFrameHandle);
      clearInterval(sourcePollTimer);
      clearTimeout(cadenceTimer);
      video.pause();
      video.srcObject = null;
    };
    const sourceCleanup = stream.roomcastCleanup;
    rendered.roomcastCleanup = () => {
      if (cleaned) return;
      cleaned = true;
      stopCadence();
      for (const item of rendered.getTracks()) item.stop();
      for (const item of stream.getTracks()) item.stop();
      sourceCleanup?.();
    };
    track.addEventListener('ended', () => {
      stopCadence();
      if (renderedTrack.readyState !== 'ended') renderedTrack.stop();
      // MediaStreamTrack.stop() intentionally does not fire `ended`; propagate
      // the desktop-capture termination so Roomcast's existing share cleanup
      // still runs when the user presses Chromium's "Stop sharing" control.
      renderedTrack.dispatchEvent(new Event('ended'));
    }, { once: true });
    return rendered;
  });
}

export async function attachNativeAudio(stream, options = {}) {
  if (!(stream instanceof MediaStream)) throw new Error('低延迟画面尚未建立。');
  if (!window.roomcast?.startAudioCapture || !window.roomcast?.stopAudioCapture || !window.roomcast?.onAudioCaptureData) throw new Error('当前版本不支持游戏声音捕获。');
  const audioMode = String(options.audioMode || '');
  const mode = audioMode.includes('exclude') ? 'exclude' : audioMode.includes('application') ? 'application' : 'system';
  const processId = mode === 'system' ? 0 : Number(options.audioSourceId);
  if (mode !== 'system' && (!Number.isInteger(processId) || processId <= 0)) throw new Error(mode === 'exclude' ? '请选择要从系统声音中排除的应用。' : '请选择要共享声音的游戏或应用。');
  const context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  const destination = context.createMediaStreamDestination();
  const sharedGain = context.createGain(); sharedGain.gain.value = options.applicationMuted === true ? 0 : 1;
  let pcmNode = null;
  try {
    if (!context.audioWorklet) throw new Error('当前 Chromium 不支持 AudioWorklet。');
    await context.audioWorklet.addModule('/roomcast-pcm-worklet.js');
    pcmNode = new AudioWorkletNode(context, 'roomcast-pcm-playout', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
    pcmNode.connect(sharedGain).connect(destination);
  } catch (error) {
    void context.close().catch(() => { });
    throw new Error(`无法初始化低抖动声音缓冲：${error.message}`);
  }
  let captureId = '', removeData = () => {}, removeEnded = () => {}, microphoneStream = null, cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    removeData(); removeEnded();
    microphoneStream?.getTracks().forEach(track => track.stop());
    destination.stream.getTracks().forEach(track => track.stop());
    try { pcmNode?.port.postMessage({ type: 'reset' }); } catch { }
    try { pcmNode?.disconnect(); } catch { }
    try { sharedGain.disconnect(); } catch { }
    void context.close().catch(() => { });
    if (captureId) void window.roomcast.stopAudioCapture(captureId).catch(() => { });
  };
  try {
    const started = await window.roomcast.startAudioCapture({ mode, ...(mode !== 'system' ? { processId } : {}) });
    captureId = String(started?.captureId || '');
    if (!captureId) throw new Error('游戏声音捕获没有返回有效会话。');
    if (Number(started?.sampleRate) !== 48000 || Number(started?.channels) !== 2 || String(started?.sampleFormat || '') !== 's16le') throw new Error('游戏声音组件返回了不兼容的 PCM 格式。');
    removeData = window.roomcast.onAudioCaptureData(packet => {
      if (cleaned || packet?.captureId !== captureId || !packet.chunk) return;
      const bytes = packet.chunk instanceof Uint8Array ? packet.chunk : new Uint8Array(packet.chunk);
      if (!bytes.byteLength) return;
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      pcmNode.port.postMessage({ type: 'pcm-s16le', buffer }, [buffer]);
    });
    removeEnded = window.roomcast.onAudioCaptureEnded?.(packet => {
      if (packet?.captureId !== captureId) return;
      sharedGain.gain.setValueAtTime(0, context.currentTime);
      try { pcmNode.port.postMessage({ type: 'reset' }); } catch { }
      window.dispatchEvent(new CustomEvent('roomcast:audio-capture-ended', { detail: String(packet.reason || '声音来源已不可用。') }));
    }) || (() => {});
    if (options.microphone === true) {
      try {
        microphoneStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...(options.inputDeviceId ? { deviceId: { exact: options.inputDeviceId } } : {}) }, video: false });
      } catch (error) {
        throw new Error(error.name === 'NotAllowedError' ? '麦克风权限未开启，无法在共享中加入麦克风。' : `无法开启共享麦克风：${error.message}`);
      }
      const microphoneGain = context.createGain(); microphoneGain.gain.value = options.microphoneMuted === true ? 0 : 1;
      context.createMediaStreamSource(microphoneStream).connect(microphoneGain).connect(destination);
      stream.roomcastAudioControls = { systemGain: sharedGain, microphoneGain };
    } else stream.roomcastAudioControls = { systemGain: sharedGain };
    await context.resume();
    for (const track of stream.getAudioTracks()) { stream.removeTrack(track); track.stop(); }
    const track = destination.stream.getAudioTracks()[0];
    if (!track) throw new Error('无法建立游戏声音轨道。');
    if ('contentHint' in track) track.contentHint = 'music';
    stream.addTrack(track);
    const previousCleanup = stream.roomcastCleanup;
    stream.roomcastCleanup = () => { previousCleanup?.(); cleanup(); };
    return stream;
  } catch (error) {
    cleanup();
    throw error;
  }
}

export function normalizeServer(value) {
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('请输入 http:// 或 https:// 开头的服务地址');
  return url.origin;
}

export function ack(socket, event, payload, timeout = 15000) {
  return new Promise((resolve, reject) => {
    if (!socket?.connected) return reject(new Error('尚未连接房间服务'));
    socket.timeout(timeout).emit(event, payload, (error, result) => {
      if (error) reject(new Error('服务响应超时，请检查网络后重试'));
      else if (!result?.ok) reject(new Error(result?.error || '操作未完成'));
      else resolve(result);
    });
  });
}

export function initials(name = '') { return [...name.trim()][0]?.toUpperCase() || '访'; }
export function timeLabel(value) { return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); }

export function waitForIce(pc, signal, timeout = 12000) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); pc.removeEventListener('icegatheringstatechange', check); signal?.removeEventListener('abort', aborted); };
    const check = () => { if (pc.iceGatheringState === 'complete') { cleanup(); resolve(); } };
    const aborted = () => { cleanup(); reject(new DOMException('Aborted', 'AbortError')); };
    // Some networks silently drop STUN instead of rejecting it. Host candidates
    // are gathered first and can still establish LAN/public direct links, so use
    // the candidates already present instead of failing the whole screen session.
    const timer = setTimeout(() => { cleanup(); resolve(); }, timeout);
    pc.addEventListener('icegatheringstatechange', check);
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}
