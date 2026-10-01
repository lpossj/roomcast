// Prefer H.264 High only among browser-advertised profiles. Keep every codec
// and its original object so older peers can negotiate their existing fallback.
export function preferH264High(codecs = []) {
  const rank = codec => {
    if (codec.mimeType?.toLowerCase() !== 'video/h264') return 2;
    return /\bprofile-level-id=64[0-9a-f]{4}\b/i.test(codec.sdpFmtpLine || '') ? 0 : 1;
  };
  return [...codecs].sort((a, b) => rank(a) - rank(b));
}
