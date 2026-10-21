import { hasSevereEncoderPressure, hasSustainedEncoderCost } from './video-encoder-pressure.js';
import { buildVideoResolutionTiers, p2pResolutionScale } from './video-quality-tiers.js';

// Chromium owns ordinary CPU, quality and network adaptation. This guard only
// rescues a clarity stream that has collapsed despite its FPS adaptation. It
// never interprets pacer bursts, QP, packet loss or low demand as CPU pressure.
export function createVideoEncoderGuard(quality, now = Date.now) {
  const targetFps = Math.max(1, Number(quality.fps) || 30);
  const tiers = buildVideoResolutionTiers(quality);
  let index = 0, bad = 0, good = 0, lastChange = -Infinity;
  return {
    resetSamples() { bad = good = 0; },
    async apply(sender, video, isStopped = () => false) {
      if (isStopped() || sender.track?.readyState === 'ended') return { status: 'stopped' };
      const parameters = sender.getParameters();
      const encoding = parameters.encodings?.[0];
      if (!encoding) return { status: 'parameters-unavailable' };
      const degradation = quality.performanceMode === 'smooth' ? 'maintain-framerate' : 'maintain-resolution';
      // VDO's existing delta sampler exposes elapsed time instead of `fresh`.
      const sample = { ...video, fresh: video?.fresh ?? (video?.sampleIntervalMs > 0) };
      // In maintain-framerate mode the browser already owns resolution changes.
      // A CPU reason alone may persist while a static source supplies few frames.
      const overloaded = degradation === 'maintain-resolution'
        && hasSevereEncoderPressure(sample, targetFps)
        && hasSustainedEncoderCost(sample, targetFps);
      const healthy = sample.fresh && video.delta?.framesEncoded > 0
        && video.qualityLimitationReason === 'none'
        && typeof video.encodeTimeMs === 'number' && Number.isFinite(video.encodeTimeMs)
        && video.encodeTimeMs >= 0 && video.encodeTimeMs <= 450 / targetFps;
      bad = overloaded ? bad + 1 : 0;
      good = healthy ? good + 1 : 0;
      let desiredIndex = index;
      if (bad >= 3 && now() - lastChange >= 3000 && index < tiers.length - 1) desiredIndex++;
      else if (index > 0 && good >= 8 && now() - lastChange >= 10000) desiredIndex--;

      const decision = { owner: 'chromium', emergencyEncoderPressure: overloaded,
        tierIndex: index, tierCount: tiers.length, targetFps,
        appliedFps: encoding.maxFramerate > 0 ? Math.min(targetFps, encoding.maxFramerate) : targetFps,
        width: tiers[index].width, height: tiers[index].height,
        badSamples: bad, healthySamples: good };
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
          bad = good = 0;
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
          bad = good = 0;
        }
        return { ...decision, tierIndex: index, width: tiers[index].width,
          height: tiers[index].height, status: tierChanged ? 'encoder-rescue' : 'preference-applied' };
      } catch {
        bad = good = 0;
        return { ...decision, status: 'parameters-rejected' };
      }
    },
  };
}
