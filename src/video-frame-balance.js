import { hasSevereEncoderPressure, hasSustainedEncoderCost } from './video-encoder-pressure.js';
import { buildVideoResolutionTiers, p2pResolutionScale } from './video-quality-tiers.js';

// A high-detail still can be sent at full size. When it starts moving, use
// the cost of the actual encoded frames on this viewer's connection.
function motionSample(video, targetFps) {
  const ms = video?.sampleIntervalMs;
  if (!(ms >= 200 && ms <= 2500 && video.source?.deltaFrames != null
    && video.delta?.framesEncoded != null && video.targetBitrate > 0 && video.bitrate != null)) return {};
  const sourceFps = Math.min(targetFps, video.source.deltaFrames * 1000 / ms);
  const encodedFps = video.delta.framesEncoded * 1000 / ms;
  const load = video.bitrate / video.targetBitrate;
  const delivered = sourceFps > 0 ? encodedFps / sourceFps : 1;
  return {
    fit: sourceFps >= Math.min(12, targetFps * 0.75) && encodedFps > 0 && delivered < 0.78 && load >= 0.45
      ? Math.sqrt(delivered / Math.max(1, load)) : null,
    spareMs: load < 0.18 && delivered >= 0.82 && !(video.lossRate > 0.03) ? ms : 0,
  };
}

export function createVideoEncoderGuard(quality, now = Date.now) {
  const targetFps = Math.max(1, Number(quality.fps) || 30);
  const tiers = buildVideoResolutionTiers(quality);
  let index = 0, bad = 0, good = 0, quietMs = 0, lastChange = -Infinity;
  const motion = quality.performanceMode === 'smooth';
  const resetSamples = () => { bad = good = quietMs = 0; };
  return {
    resetSamples,
    async apply(sender, video, isStopped = () => false) {
      if (isStopped() || sender.track?.readyState === 'ended') return { status: 'stopped' };
      const parameters = sender.getParameters();
      const encoding = parameters.encodings?.[0];
      if (!encoding) return { status: 'parameters-unavailable' };
      const degradation = motion ? 'maintain-framerate' : 'maintain-resolution';
      // VDO's existing delta sampler exposes elapsed time instead of `fresh`.
      const sample = { ...video, fresh: video?.fresh ?? (video?.sampleIntervalMs > 0) };
      const cost = motion ? motionSample(sample, targetFps) : {};
      const overloaded = motion ? cost.fit != null
        : hasSevereEncoderPressure(sample, targetFps) && hasSustainedEncoderCost(sample, targetFps);
      const healthy = sample.fresh && video.delta?.framesEncoded > 0
        && video.qualityLimitationReason === 'none'
        && typeof video.encodeTimeMs === 'number' && Number.isFinite(video.encodeTimeMs)
        && video.encodeTimeMs >= 0 && video.encodeTimeMs <= 450 / targetFps;
      bad = overloaded ? bad + 1 : 0;
      good = healthy ? good + 1 : 0;
      quietMs = cost.spareMs ? quietMs + cost.spareMs : 0;
      let desiredIndex = index;
      if (motion && bad >= 2 && now() - lastChange >= 1000 && video.frameWidth > 0 && video.frameHeight > 0) {
        const source = sender.track.getSettings();
        const currentScale = Math.max(source.width / video.frameWidth, source.height / video.frameHeight);
        const fit = tiers.findIndex(tier => p2pResolutionScale(sender.track, tier) >= currentScale / (cost.fit * 1.18));
        desiredIndex = Math.max(index, Math.min(index + 2, fit < 0 ? tiers.length - 1 : fit));
      } else if (motion && index > 0 && quietMs >= 2500) desiredIndex = 0;
      else if (!motion && bad >= 3 && now() - lastChange >= 3000 && index < tiers.length - 1) desiredIndex++;
      else if (!motion && index > 0 && good >= 8 && now() - lastChange >= 10000) desiredIndex--;

      const decision = { owner: 'chromium', emergencyEncoderPressure: overloaded,
        tierIndex: index, tierCount: tiers.length, targetFps,
        appliedFps: encoding.maxFramerate > 0 ? Math.min(targetFps, encoding.maxFramerate) : targetFps,
        width: tiers[index].width, height: tiers[index].height,
        badSamples: bad, healthySamples: good, quietMs };
      const preferenceChanged = parameters.degradationPreference !== degradation;
      const tierChanged = desiredIndex !== index;
      if (!tierChanged && !preferenceChanged) return { ...decision, status: 'observe-only' };

      // Only this guard's emergency transition changes the user resolution cap.
      // Leave SDK/user FPS and bitrate caps intact; no second FPS controller.
      if (tierChanged) {
        const source = sender.track?.getSettings?.() || {};
        if (!(source.width > 0 && source.height > 0)) return { ...decision, status: 'source-size-unavailable' };
        // Respect a separate SDK/user cap. Only recover a cap that still matches
        // our previous tier, never raise one another owner has changed.
        const currentScale = encoding.scaleResolutionDownBy || 1;
        if (encoding.scaleResolutionDownTo != null
          || Math.abs(currentScale - p2pResolutionScale(sender.track, tiers[index])) > 0.001) {
          resetSamples();
          return { ...decision, status: 'external-resolution-cap' };
        }
        encoding.scaleResolutionDownBy = p2pResolutionScale(sender.track, tiers[desiredIndex]);
        delete encoding.scaleResolutionDownTo;
      }
      parameters.degradationPreference = degradation;
      try {
        if (isStopped()) return { ...decision, status: 'stopped' };
        await sender.setParameters(parameters);
        if (isStopped()) return { ...decision, status: 'stopped' };
        if (tierChanged) {
          index = desiredIndex;
          lastChange = now();
          resetSamples();
        }
        return { ...decision, tierIndex: index, width: tiers[index].width,
          height: tiers[index].height, status: tierChanged ? 'encoder-rescue' : 'preference-applied' };
      } catch {
        resetSamples();
        return { ...decision, status: 'parameters-rejected' };
      }
    },
  };
}
