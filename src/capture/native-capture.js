import { createNativeFrameStream } from './frame-cadence.js';

export function startIntegratedCapture({ sourceId, width = 1920, height = 1080, fps = 30, systemAudio = false, microphone = false, applicationMuted = false, microphoneMuted = false, inputDeviceId = '', compatibilityCanvas = false } = {}) {
  if (window.roomcast?.selectCapture && !window.roomcast.selectCapture({ id: sourceId, audio: systemAudio })) throw new Error('所选屏幕或窗口已经不可用，请刷新后重试。');
  // Keep the display request in the original click's activation scope.
  const request = navigator.mediaDevices.getDisplayMedia({ video: true, audio: systemAudio });
  return request.then(async stream => {
    try {
      const track = stream.getVideoTracks()[0];
      if (!track) throw new Error('未获得屏幕画面。');
      const targetFps = Math.max(1, Math.min(120, Math.round(Number(fps) || 30)));
      try {
        await track.applyConstraints({ frameRate: window.roomcast?.desktop ? { min: targetFps, ideal: targetFps, max: targetFps } : { ideal: targetFps, max: targetFps } });
      } catch (error) {
        throw new Error(`无法锁定 ${targetFps} FPS：${error.message}`);
      }
      if (microphone) {
        let micStream;
        try {
          micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...(inputDeviceId ? { deviceId: { exact: inputDeviceId } } : {}) }, video: false });
        } catch (error) {
          throw new Error(error.name === 'NotAllowedError' ? '麦克风权限未开启，无法在共享中加入麦克风。' : `无法开启共享麦克风：${error.message}`);
        }
        const systemTracks = stream.getAudioTracks();
        if (systemTracks.length) {
          let context;
          stream.roomcastCleanup = () => {
            systemTracks.forEach(item => item.stop());
            micStream.getTracks().forEach(item => item.stop());
            void context?.close().catch(() => {});
          };
          context = new AudioContext();
          const destination = context.createMediaStreamDestination();
          const systemGain = context.createGain(); systemGain.gain.value = applicationMuted ? 0 : 1;
          const microphoneGain = context.createGain(); microphoneGain.gain.value = microphoneMuted ? 0 : 1;
          context.createMediaStreamSource(new MediaStream(systemTracks)).connect(systemGain).connect(destination);
          context.createMediaStreamSource(micStream).connect(microphoneGain).connect(destination);
          for (const audio of systemTracks) stream.removeTrack(audio);
          stream.addTrack(destination.stream.getAudioTracks()[0]);
          stream.roomcastAudioControls = { systemGain, microphoneGain };
        } else {
          stream.roomcastCleanup = () => micStream.getTracks().forEach(item => item.stop());
          const micTrack = micStream.getAudioTracks()[0];
          if (micTrack) { micTrack.enabled = !microphoneMuted; stream.addTrack(micTrack); }
        }
      } else {
        for (const audio of stream.getAudioTracks()) audio.enabled = !applicationMuted;
      }
      if ('contentHint' in track) track.contentHint = 'detail';
      for (const audio of stream.getAudioTracks()) if ('contentHint' in audio) audio.contentHint = 'music';
      if (window.roomcast?.desktop) {
        const rendered = await createNativeFrameStream(stream, { width, height, fps: targetFps, compatibilityCanvas });
        rendered.roomcastAudioControls = stream.roomcastAudioControls;
        return rendered;
      }
      const previousCleanup = stream.roomcastCleanup;
      stream.roomcastCleanup = () => { previousCleanup?.(); stream.getTracks().forEach(item => item.stop()); };
      return stream;
    } catch (error) {
      stream.roomcastCleanup?.();
      stream.getTracks().forEach(item => item.stop());
      throw error;
    }
  });
}
