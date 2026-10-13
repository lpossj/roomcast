import { recordLifecycle } from '../lifecycle-diagnostics.js';

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
  const operationStarted = performance.now();
  recordLifecycle('capture', 'started');
  let diagnosticPhase = 'completed';
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
    recordLifecycle('capture', diagnosticPhase, performance.now() - operationStarted);
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
    diagnosticPhase = error?.code === 'OBS_CAPTURE_CANCELLED' ? 'cancelled' : 'failed';
    cleanup();
    throw error;
  }
}

