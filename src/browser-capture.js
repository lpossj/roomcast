import { browserCapabilities } from './browser-capabilities.js';

export function startCameraCapture({ width = 1920, height = 1080, fps = 30, facingMode = 'user', microphone = false, microphoneMuted = false, inputDeviceId = '' } = {}) {
  const capabilities = browserCapabilities(window);
  if (!capabilities.camera) throw new Error('当前浏览器或页面权限不支持摄像头共享。');
  if (microphone && !capabilities.microphone) throw new Error('当前页面未允许使用麦克风。');
  // The request starts directly from the click, before room claiming awaits network I/O.
  return navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: fps, max: fps }, facingMode: { ideal: facingMode === 'environment' ? 'environment' : 'user' } },
    audio: microphone ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...(inputDeviceId ? { deviceId: { exact: inputDeviceId } } : {}) } : false,
  }).then(stream => {
    const cleanup = () => stream.getTracks().forEach(track => track.stop());
    const track = stream.getVideoTracks()[0];
    if (!track) { cleanup(); throw new Error('未获得摄像头画面。'); }
    try {
      if ('contentHint' in track) track.contentHint = 'motion';
      for (const audio of stream.getAudioTracks()) audio.enabled = !microphoneMuted;
      stream.roomcastCaptureBackend = 'camera';
      stream.roomcastCleanup = cleanup;
      return stream;
    } catch (error) { cleanup(); throw error; }
  }, error => {
    throw new Error(error.name === 'NotAllowedError' ? '摄像头或麦克风权限未开启，请在浏览器设置中允许后重试。' : error.name === 'NotFoundError' ? '没有可用的摄像头或麦克风。' : `无法开启摄像头：${error.message}`);
  });
}
