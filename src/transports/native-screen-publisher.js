// Only OBS desktop capture can provide an already encoded native video source.
// Browsers and other capture backends retain the existing WebRTC encoder.
export function createNativeScreenPublisher(stream, quality) {
  const api = globalThis.window?.roomcast;
  if (!api?.nativeMediaStart || stream.roomcastCaptureBackend !== 'obs') return null;
  // The native profile is currently validated up to 1080p60 at the existing
  // 6.5 Mbps ceiling. Preserve larger/custom sharing profiles unchanged.
  if (!(quality.bitrate >= 300 && quality.bitrate <= 6500) || quality.width > 1920 || quality.height > 1080 || quality.fps > 60) return null;
  const captureId = stream.roomcastCaptureId;
  const peers = new Map();
  let closed = false, reader, audioEncoder, audioTrack;
  function failPeers() {
    for (const peer of [...peers.values()]) { peer.connectionState = 'failed'; peer.onconnectionstatechange?.(); }
    void close();
  }
  const removeEvents = api.onNativeMediaPeer(message => {
    const peer = peers.get(message.id);
    if (!peer || closed) return;
    if (message.event === 'candidate') {
      peer.onicecandidate?.({ candidate: { toJSON: () => ({ candidate: message.candidate, sdpMid: message.mid, sdpMLineIndex: null }) } });
    } else if (message.event === 'state') {
      peer.connectionState = message.state;
      peer.onconnectionstatechange?.();
    }
  });

  const ready = (async () => {
    const sourceAudio = stream.getAudioTracks().find(track => track.readyState === 'live');
    let audioConfig;
    if (sourceAudio) {
      if (!globalThis.AudioEncoder || !globalThis.MediaStreamTrackProcessor) throw new Error('当前运行时不支持原生共享音频。');
      const channels = Math.max(1, Math.min(2, sourceAudio.getSettings().channelCount || 2));
      audioConfig = { codec: 'opus', sampleRate: sourceAudio.getSettings().sampleRate || 48000, numberOfChannels: channels, bitrate: 128000 };
      if (!(await AudioEncoder.isConfigSupported(audioConfig)).supported) throw new Error('当前运行时不能编码 Opus。');
    }
    if (closed) throw new Error('共享已停止。');
    const result = await api.nativeMediaStart({ captureId, bitrateKbps: quality.bitrate });
    if (closed) { void api.nativeMediaStop(captureId); throw new Error('共享已停止。'); }
    if (!result?.ok) throw new Error(result?.message || '原生编码器不可用。');
    if (sourceAudio) {
      audioTrack = sourceAudio.clone();
      audioTrack.enabled = true; // Mute is applied from the original track per frame below.
      reader = new MediaStreamTrackProcessor({ track: audioTrack }).readable.getReader();
      audioEncoder = new AudioEncoder({
        output: chunk => {
          if (closed) return;
          const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data);
          api.nativeMediaAudio({ captureId, data, ptsUs: performance.timeOrigin * 1000 + chunk.timestamp });
        },
        error: failPeers,
      });
      audioEncoder.configure(audioConfig);
      void (async () => {
        let lastTimestamp = -Infinity;
        try {
          while (!closed) {
            const { value, done } = await reader.read();
            if (done) { if (!closed) failPeers(); break; }
            try {
              if (value.timestamp > lastTimestamp && audioEncoder.state === 'configured' && audioEncoder.encodeQueueSize < 5) {
                lastTimestamp = value.timestamp;
                // A cloned track has its own enabled flag. Honor the original
                // sharing mute on every frame, including after capture starts.
                if (!sourceAudio.enabled || sourceAudio.muted) {
                  const silence = new AudioData({ format: 'f32-planar', sampleRate: value.sampleRate, numberOfFrames: value.numberOfFrames,
                    numberOfChannels: value.numberOfChannels, timestamp: value.timestamp,
                    data: new Float32Array(value.numberOfFrames * value.numberOfChannels) });
                  try { audioEncoder.encode(silence); } finally { silence.close(); }
                } else audioEncoder.encode(value);
              }
            } finally { value.close(); }
          }
        } catch { if (!closed) failPeers(); }
      })();
    }
    return { audio: !!sourceAudio, ...result };
  })();
  // Availability is consumed by answer(); an unsupported GPU must not create an
  // unhandled rejection while the ordinary browser publisher remains usable.
  ready.catch(() => { void close(); });

  async function close() {
    if (closed) return;
    closed = true; removeEvents();
    for (const peer of [...peers.values()]) peer.close();
    try { await reader?.cancel(); } catch { }
    audioTrack?.stop();
    if (audioEncoder && audioEncoder.state !== 'closed') audioEncoder.close();
    await api.nativeMediaStop(captureId).catch(() => {});
  }

  async function answer({ id, offer, iceServers, onCandidate, onState, onPeer }) {
    const metadata = await ready;
    if (closed) throw new Error('原生共享已停止。');
    let negotiated = false;
    const candidates = [];
    const peer = {
      remoteDescription: { type: 'offer', sdp: offer },
      connectionState: 'new',
      onicecandidate: onCandidate,
      onconnectionstatechange: onState,
      addIceCandidate: async candidate => {
        if (peers.get(id) !== peer) return;
        if (negotiated) api.nativeMediaCandidate({ captureId, id, candidate });
        else if (candidates.length < 128) candidates.push(candidate);
      },
      close() {
        if (peers.get(id) !== peer) return;
        peers.delete(id); peer.connectionState = 'closed';
        candidates.length = 0;
        api.nativeMediaClosePeer({ captureId, id });
      },
    };
    peers.set(id, peer);
    try {
      onPeer?.(peer);
      const result = await api.nativeMediaAnswer({ captureId, id, offer, iceServers, audio: metadata.audio });
      if (closed || peers.get(id) !== peer) throw new Error('原生媒体会话已取消。');
      if (!result?.ok) throw new Error(result?.message || '原生媒体协商失败。');
      negotiated = true;
      for (const candidate of candidates.splice(0)) api.nativeMediaCandidate({ captureId, id, candidate });
      peer.localDescription = { type: 'answer', sdp: result.sdp };
      return peer;
    } catch (error) { peer.close(); throw error; }
  }

  return { ready, answer, close };
}
