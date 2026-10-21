// A sparse/static source can spend 20ms on each of five frames per second
// without sustained encoder pressure. Require work across the actual sample
// window, not just a per-frame cost against the requested FPS.
export function hasSustainedEncoderCost(video, targetFps) {
  if (!(video?.delta?.framesEncoded > 0)) return false;
  const sustained = Number.isFinite(video.sampleIntervalMs) && video.sampleIntervalMs > 0
    && Number.isFinite(video.delta.totalEncodeTime)
    && video.delta.totalEncodeTime * 1000 >= video.sampleIntervalMs * 0.8;
  const expensive = Number.isFinite(video.encodeTimeMs) && video.encodeTimeMs >= 800 / targetFps;
  return sustained && expensive;
}

// Low FPS alone can be a static screen or a paused source. Require encoder
// evidence as well before sacrificing resolution to recover useful motion.
export function hasSevereEncoderPressure(video, targetFps) {
  if (!video?.fresh || !(video.delta?.framesEncoded > 0)) return false;
  if (!(video.framesPerSecond > 0 && video.framesPerSecond < Math.min(10, targetFps / 2))) return false;
  return video.qualityLimitationReason === 'cpu' || hasSustainedEncoderCost(video, targetFps);
}
