export { recordLifecycle, getLifecycleDiagnostics } from './lifecycle-diagnostics.js';

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

export { startObsFixedFpsCapture } from './capture/obs-capture.js';

export async function nativeAudioSources() {
  if (!window.roomcast?.audioSources) return [];
  const sources = await window.roomcast.audioSources();
  if (!Array.isArray(sources)) throw new Error('音频应用枚举返回格式无效。');
  return sources.filter(item => /^\d+$/.test(String(item?.processId || ''))).map(item => ({ ...item, id: String(item.processId), processId: String(item.processId), name: String(item.name || item.title || item.processName || item.processId) }));
}

export { startIntegratedCapture } from './capture/native-capture.js';

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
