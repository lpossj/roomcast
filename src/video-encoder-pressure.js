// Low FPS alone can be a static screen or a paused source. Require encoder
// evidence as well before sacrificing resolution to recover useful motion.
export function hasSevereEncoderPressure(video, targetFps) {
  if (!video?.fresh || !(video.delta?.framesEncoded > 0)) return false;
  if (!(video.framesPerSecond > 0 && video.framesPerSecond < Math.min(10, targetFps / 2))) return false;
  const expensive = Number.isFinite(video.encodeTimeMs) && video.encodeTimeMs >= 800 / targetFps;
  return video.qualityLimitationReason === 'cpu' || expensive;
}
