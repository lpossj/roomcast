// Encoder-load protection, independent of network congestion and codec QP ranges.
// A high QP or a low measured FPS alone is not evidence of CPU overload.
export function createVideoFrameBalance(fps, now = Date.now) {
  const target = Math.max(1, Math.min(120, Number(fps) || 30));
  const steps = [...new Set([target, ...[60, 45, 30].filter(value => value < target)])];
  let index = 0, bad = 0, good = 0, lastChange = -Infinity;
  return {
    get targetFps() { return target; },
    get fps() { return steps[index]; },
    inspect(video, ceiling = target) {
      const appliedFps = Math.min(steps[index], ceiling);
      const active = video?.delta?.framesEncoded > 0;
      const cost = video?.encodeTimeMs;
      const knownCost = typeof cost === 'number' && Number.isFinite(cost) && cost > 0;
      const overloaded = active && appliedFps > 30 && (
        video.qualityLimitationReason === 'cpu' || (knownCost && cost >= 800 / appliedFps)
      );
      const nextFps = steps[Math.max(0, index - 1)];
      const healthy = active && video.qualityLimitationReason === 'none'
        && knownCost && cost <= 450 / nextFps;
      bad = overloaded ? bad + 1 : 0;
      good = healthy ? good + 1 : 0;
      let desiredIndex = index;
      if (bad >= 3 && now() - lastChange >= 3000 && index < steps.length - 1) desiredIndex++;
      else if (good >= 8 && now() - lastChange >= 10000 && index > 0) desiredIndex--;
      return { index: desiredIndex, fps: steps[desiredIndex], overloaded, badSamples: bad, healthySamples: good };
    },
    commit(decision) {
      if (index !== decision.index) { index = decision.index; lastChange = now(); bad = good = 0; }
    },
    reject() { bad = good = 0; },
  };
}

// For publishers whose network adaptation is owned by Chromium/the VDO SDK.
// Preserve a lower cap applied by another controller and every bitrate/scale field.
export async function applyVideoFrameBalance(sender, video, balance, isStopped = () => false) {
  if (isStopped() || sender.track?.readyState === 'ended') return { status: 'stopped' };
  const parameters = sender.getParameters();
  const encoding = parameters.encodings?.[0];
  if (!encoding) return { status: 'parameters-unavailable' };
  const externalCap = encoding.maxFramerate > 0 && encoding.maxFramerate < balance.fps
    ? encoding.maxFramerate : Infinity;
  const decision = balance.inspect(video, externalCap);
  const desired = Math.min(decision.fps, externalCap);
  // No pressure means no initial parameter write on these routes.
  const needsCap = encoding.maxFramerate > decision.fps
    || (!(encoding.maxFramerate > 0) && decision.fps < balance.targetFps);
  if (decision.fps === balance.fps && !needsCap) {
    balance.commit(decision);
    return { ...decision, status: 'unchanged' };
  }
  encoding.maxFramerate = desired;
  try {
    if (isStopped()) return { status: 'stopped' };
    await sender.setParameters(parameters);
    if (isStopped()) return { status: 'stopped' };
    balance.commit(decision);
    return { ...decision, status: 'applied' };
  } catch {
    balance.reject();
    return { ...decision, fps: balance.fps, status: 'parameters-rejected' };
  }
}
