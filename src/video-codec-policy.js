// Prefer H.264 High only among browser-advertised profiles. Keep every codec
// and its original object so older peers can negotiate their existing fallback.
export function preferH264High(codecs = []) {
  const rank = codec => {
    if (codec.mimeType?.toLowerCase() !== 'video/h264') return 2;
    return /\bprofile-level-id=64[0-9a-f]{4}\b/i.test(codec.sdpFmtpLine || '') ? 0 : 1;
  };
  return [...codecs].sort((a, b) => rank(a) - rank(b));
}

let nativeReceiveSupport;
function nativeReceiveLevel() {
  if (!nativeReceiveSupport) {
    nativeReceiveSupport = (async () => {
      const capabilities = globalThis.navigator?.mediaCapabilities;
      if (typeof capabilities?.decodingInfo !== 'function') return null;
      let timeout;
      try {
        return await Promise.race([
          (async () => {
            for (const [level, width, height, framerate] of [
              ['2a', 1920, 1080, 60], ['28', 1920, 1080, 30], ['20', 1280, 720, 60],
            ]) {
              const info = await capabilities.decodingInfo({
                type: 'webrtc',
                video: { contentType: `video/H264;profile-level-id=6400${level};packetization-mode=1`,
                  width, height, bitrate: 6_500_000, framerate },
              });
              if (info?.supported === true && info?.smooth === true) return level;
            }
            return null;
          })(),
          new Promise(resolve => { timeout = setTimeout(() => resolve(null), 1500); }),
        ]);
      } catch {
        return null;
      } finally {
        clearTimeout(timeout);
      }
    })();
  }
  return nativeReceiveSupport;
}

// Chromium advertises H.264 using a default 720p30 level, not its maximum
// decoder capability. Raise only receiving High/mode-1 offers after querying
// the actual WebRTC decoder for the native sender's bounded 1080p60 format.
function receiveLevelSdp(sdp, level) {
  return sdp.split(/(?=^m=)/m).map(section => {
    if (!/^m=video [1-9]\d* /m.test(section) || !/^a=recvonly\r?$/m.test(section)) return section;
    const payloads = new Set([...section.matchAll(/^a=rtpmap:(\d+) H264\/90000\r?$/gmi)].map(match => match[1]));
    return section.replace(/^a=fmtp:(\d+) (.*)\r?$/gm, (line, pt, parameters) => {
      if (!payloads.has(pt) || !/(?:^|;)\s*packetization-mode=1\s*(?:;|$)/i.test(parameters)) return line;
      return line.replace(/\bprofile-level-id=6400(09|0a|0b|0c|0d|14|15|16|1e|1f|20|28|29)\b/i, (value, original) => {
        return parseInt(original, 16) < parseInt(level, 16) ? `profile-level-id=6400${level}` : value;
      });
    });
  }).join('');
}

export async function prepareNativeReceiveOffer(offer) {
  if (offer?.type !== 'offer' || typeof offer.sdp !== 'string' || receiveLevelSdp(offer.sdp, '2a') === offer.sdp) return offer;
  const level = await nativeReceiveLevel();
  if (!level) return offer;
  const sdp = receiveLevelSdp(offer.sdp, level);
  if (sdp === offer.sdp) return offer;
  return { type: offer.type, sdp };
}
