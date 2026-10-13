// Native desktop capture can suppress unchanged frames. Canvas capture needs
// both a frame request and a paint, so keep them together on every cadence tick.
export async function createNativeFrameStream(source, { width, height, fps, compatibilityCanvas = false }) {
  const sourceTrack = source.getVideoTracks()[0];
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([sourceTrack]);
  let rendered = null, timer = null, stopped = false;
  const sourceCleanup = source.roomcastCleanup;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    video.pause();
    video.srcObject = null;
    for (const track of rendered?.getTracks() || []) track.stop();
    for (const track of source.getTracks()) track.stop();
    sourceCleanup?.();
  };
  try {
    await video.play();
    if (!video.videoWidth || !video.videoHeight) {
      await new Promise((resolve, reject) => {
        const finish = error => {
          clearTimeout(timeout);
          video.removeEventListener('loadeddata', loaded);
          sourceTrack.removeEventListener('ended', ended);
          error ? reject(error) : resolve();
        };
        const loaded = () => finish();
        const ended = () => finish(new Error('屏幕采集在初始化时结束。'));
        const timeout = setTimeout(() => finish(new Error('屏幕画面初始化超时。')), 8000);
        video.addEventListener('loadeddata', loaded, { once: true });
        sourceTrack.addEventListener('ended', ended, { once: true });
        if (sourceTrack.readyState === 'ended') ended();
        else if (video.videoWidth && video.videoHeight) loaded();
      });
    }
    if (sourceTrack.readyState === 'ended') throw new Error('屏幕采集已经结束。');
    const canvas = document.createElement('canvas');
    // Paint only the pixels the viewer requested. Repeating a full 4K canvas
    // for a 1080p share wastes capture/encoding work before RTP downsizes it.
    const requestedWidth = Math.max(2, Number(width) || video.videoWidth);
    const requestedHeight = Math.max(2, Number(height) || video.videoHeight);
    const scale = Math.max(1, video.videoWidth / requestedWidth, video.videoHeight / requestedHeight);
    canvas.width = compatibilityCanvas ? Math.max(320, Math.floor(requestedWidth / 2) * 2) : Math.max(2, Math.floor(video.videoWidth / scale / 2) * 2);
    canvas.height = compatibilityCanvas ? Math.max(240, Math.floor(requestedHeight / 2) * 2) : Math.max(2, Math.floor(video.videoHeight / scale / 2) * 2);
    const context = canvas.getContext('2d', { alpha: false, colorSpace: 'srgb', desynchronized: true });
    if (!context) throw new Error('无法初始化固定帧率画面轨道。');
    rendered = canvas.captureStream(0);
    const track = rendered.getVideoTracks()[0];
    if (!track || typeof track.requestFrame !== 'function') throw new Error('当前 Chromium 不支持 Roomcast 固定帧率输出。');
    if ('contentHint' in track) track.contentHint = 'motion';
    for (const audio of source.getAudioTracks()) rendered.addTrack(audio);
    rendered.roomcastCaptureBackend = 'native';
    rendered.roomcastCleanup = stop;
    const endOutput = reason => {
      if (stopped) return;
      if (reason) track.roomcastBackendEndedReason = reason;
      stop();
      // stop() does not emit ended: forward it to the existing share lifecycle.
      track.dispatchEvent(new Event('ended'));
    };
    sourceTrack.addEventListener('ended', () => endOutput(), { once: true });
    const period = 1000 / fps;
    let nextFrameAt = performance.now();
    const tick = () => {
      if (stopped) return;
      if (track.readyState === 'ended') { stop(); return; }
      try {
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          track.requestFrame();
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
        }
      } catch {
        endOutput('原生屏幕画面输出中断，请重新开启共享。');
        return;
      }
      nextFrameAt += period;
      const now = performance.now();
      // Resume at the current cadence after a stall; never burst stale frames.
      if (nextFrameAt < now - period) nextFrameAt = now + period;
      timer = setTimeout(tick, Math.max(0, nextFrameAt - now));
    };
    tick();
    return rendered;
  } catch (error) {
    stop();
    throw error;
  }
}
