import { buildP2pVideoTiers } from './video-quality-tiers.js';
import { createVideoFrameBalance, applyVideoFrameBalance } from './video-frame-balance.js';
import { hasSevereEncoderPressure } from './video-encoder-pressure.js';

import { recordP2pNetworkStats } from './p2p-diagnostics.js';
export { readP2pDiagnostics, recordP2pNetworkStats } from './p2p-diagnostics.js';
const numeric = value => typeof value === 'number' && Number.isFinite(value) ? value : null;

export function p2pResolutionScale(track, quality) {
  const source = track?.getSettings?.() || {};
  if (!(source.width > 0 && source.height > 0 && quality.width > 0 && quality.height > 0)) return 1;
  // Always derive from the source, never from a congestion-reduced encoded frame.
  return Math.max(1, source.width / quality.width, source.height / quality.height);
}


export function createP2pVideoPolicy({ pc, sender, quality, route = 'p2p', adapt = true, now = Date.now, schedule = setTimeout, cancel = clearTimeout }) {
  const targetFps = Math.max(1, Number(quality.fps) || 30);
  const frameBalance = createVideoFrameBalance(targetFps, now);
  const tiers = buildP2pVideoTiers(quality, targetFps);
  const baseRate = Math.max(1, tiers[0].width * tiers[0].height * tiers[0].fps);
  const rateFor = tier => Math.max(1, tier.width * tier.height * tier.fps);
  const budgetFor = (index, observedBaseBitrate) => {
    // A configured bitrate is a ceiling, not a minimum needed to recover.
    const ceiling = Number(quality.bitrate) > 0 ? Number(quality.bitrate) * 1000 : Infinity;
    const selected = observedBaseBitrate;
    if (!(selected > 0)) return 0;
    return Math.min(ceiling, selected * rateFor(tiers[index]) / baseRate);
  };
  let tierIndex = 0, bad = 0, queued = 0, good = 0, lastChange = -Infinity, fullRateBitrate = 0;
  let encoderBad = 0, encoderRecovery = false;
  const recentRtts = [];
  let recoveryInterval = 10000, promotedAt = -Infinity;
  let started = false, stopped = false, timer = null, inFlight = null;

  const poll = () => {
    if (stopped) return Promise.resolve();
    if (inFlight) return inFlight;
    inFlight = (async () => {
      if (pc.connectionState !== 'connected') { bad = queued = good = encoderBad = 0; frameBalance.reject(); return; }
      const report = await pc.getStats();
      if (stopped || pc.connectionState !== 'connected' || sender.track?.readyState === 'ended') return;
      const currentTier = tiers[tierIndex];
      const sample = recordP2pNetworkStats(pc, report, 'publisher', adapt ? {
        width: currentTier.width,
        height: currentTier.height,
        targetFps,
        appliedFps: currentTier.fps,
        tierIndex,
        tierCount: tiers.length,
      } : null, route);
      const video = sample.streams.find(stat => stat.type === 'outbound-rtp' && stat.kind === 'video');
      // TURN retains Chromium's network control; only encoder-load protection is shared.
      if (!adapt) {
        const balance = await applyVideoFrameBalance(sender, video, frameBalance, () => stopped);
        const parameters = sender.getParameters();
        sample.policy = { status: 'observe-only',
          frameBalance: balance,
          degradationPreference: parameters.degradationPreference ?? null,
          ...Object.fromEntries(['maxBitrate', 'maxFramerate', 'scaleResolutionDownBy']
            .map(key => [key, numeric(parameters.encodings?.[0]?.[key])])),
        };
        return;
      }
      const active = video?.fresh && video.delta.packetsSent > 0;
      if (active && video.qualityLimitationReason === 'none' && video.bitrate > 0) {
        // Smooth recent demand in both directions; a keyframe/motion peak must
        // not permanently raise the next tier's recovery budget.
        const baseEquivalent = video.bitrate / (rateFor(currentTier) / baseRate);
        fullRateBitrate = fullRateBitrate > 0
          ? fullRateBitrate * 0.8 + baseEquivalent * 0.2 : baseEquivalent;
      }
      if (active && video.rtt != null) {
        recentRtts.push(video.rtt);
        if (recentRtts.length > 30) recentRtts.shift();
      }
      const baselineRtt = recentRtts.length ? Math.min(...recentRtts) : null;
      const rttInflated = video?.rtt != null && baselineRtt !== null
        && video.rtt > baselineRtt + Math.max(0.05, baselineRtt * 0.25);
      const budget = budgetFor(tierIndex, fullRateBitrate);
      const bandwidthLimited = video?.qualityLimitationReason === 'bandwidth';
      const budgetLimited = budget > 0 && video?.availableOutgoingBitrate !== null
        && video?.availableOutgoingBitrate < budget * 0.8;
      // A high user ceiling or a motion-complexity spike is not itself network
      // congestion. Let Chromium handle transient encoder/BWE adjustments.
      const networkPressure = (video?.lossRate !== null && video?.lossRate >= 0.05)
        || (bandwidthLimited && budgetLimited && video?.rtt !== null && video?.rtt >= 0.3);
      const queuePressure = video?.packetSendDelayMs !== null && video?.packetSendDelayMs >= 100;
      // Motion/keyframe bursts can fill the local pacer while RTT/loss stay low.
      // Give queue-only pressure five samples to drain; retain fast protection
      // for confirmed network pressure or a queue already over one second.
      const severeQueue = video?.packetSendDelayMs !== null && video?.packetSendDelayMs >= 1000;
      const encoderPressure = active && hasSevereEncoderPressure(video, currentTier.fps);
      const congested = active && (networkPressure || queuePressure);
      const nextIndex = Math.max(0, tierIndex - 1);
      const nextBudget = budgetFor(nextIndex, fullRateBitrate);
      const bitrateHealthy = nextBudget <= 0
        || (video?.availableOutgoingBitrate != null && video.availableOutgoingBitrate >= nextBudget);
      const healthy = active && !congested && !encoderPressure && video.qualityLimitationReason === 'none'
        && (video.lossRate === null || video.lossRate < 0.02)
        && !rttInflated
        && video.packetSendDelayMs !== null && video.packetSendDelayMs < 30
        // Missing metrics alone are not evidence of recovery.
        && ((video.freshRemote && video.lossRate !== null) || (video.rtt !== null && recentRtts.length >= 8));
      bad = active && (networkPressure || severeQueue) ? bad + 1 : 0;
      queued = active && queuePressure ? queued + 1 : 0;
      good = healthy ? good + 1 : 0;
      encoderBad = encoderPressure ? encoderBad + 1 : 0;
      // Low demand or missing BWE can prevent an estimate from reaching the
      // next tier. After a longer healthy window allow one reversible step.
      const probeRecovery = good >= 20 && now() - lastChange >= Math.max(30000, recoveryInterval);
      const canRecover = good >= 8 && now() - lastChange >= recoveryInterval
        && (bitrateHealthy || probeRecovery);
      let desiredIndex = tierIndex;
      if ((bad >= 2 || queued >= 5) && tierIndex < tiers.length - 1) desiredIndex = tierIndex + 1;
      else if (canRecover && tierIndex > 0) desiredIndex = tierIndex - 1;
      if (encoderBad >= 3 && now() - lastChange >= 3000) {
        // Skip the same-resolution FPS tier: a 1 FPS CPU collapse needs less
        // pixel work, even when packet loss and RTT are healthy.
        const lowerResolution = tiers.findIndex((tier, index) => index > tierIndex
          && (tier.width < currentTier.width || tier.height < currentTier.height));
        if (lowerResolution >= 0) desiredIndex = Math.max(desiredIndex, lowerResolution);
        encoderRecovery = true;
      } else if (canRecover) {
        encoderRecovery = false;
      }

      const parameters = sender.getParameters();
      const encoding = parameters.encodings?.[0];
      const balance = frameBalance.inspect(video, tiers[desiredIndex].fps);
      const finalize = status => {
        const applied = tiers[tierIndex];
        sample.policy = {
          ...sample.policy,
          width: applied.width,
          height: applied.height,
          targetFps,
          appliedFps: Math.min(applied.fps, frameBalance.fps),
          balancedFps: frameBalance.fps,
          encoderPressure: balance.overloaded,
          severeEncoderPressure: encoderPressure,
          encoderRecovery,
          tierIndex,
          tierCount: tiers.length,
          scaleResolutionDownBy: p2pResolutionScale(sender.track, applied),
          maxBitrate: encoding?.maxBitrate ?? null,
          maxFramerate: encoding?.maxFramerate ?? null,
          badSamples: bad,
          queueSamples: queued,
          healthySamples: good,
          baselineRtt,
          rttInflated,
          recoveryBudget: nextBudget,
          recoveryInterval,
          probeRecovery,
          bandwidthLimited,
          budgetLimited,
          networkPressure,
          queuePressure,
          resolutionMatches: video?.frameWidth > 0 && video?.frameHeight > 0
            ? video.frameWidth === applied.width && video.frameHeight === applied.height : null,
          status,
        };
      };
      if (!encoding) {
        finalize('parameters-unavailable');
        return;
      }

      const desiredTier = tiers[desiredIndex];
      const desiredFps = Math.min(desiredTier.fps, balance.fps);
      const scale = p2pResolutionScale(sender.track, desiredTier);
      const degradation = encoderRecovery || quality.performanceMode === 'smooth' ? 'maintain-framerate' : 'maintain-resolution';
      const changed = encoding.maxFramerate !== desiredFps
        || encoding.scaleResolutionDownBy !== scale
        || parameters.degradationPreference !== degradation;
      const commitDecision = () => {
        if (tierIndex !== desiredIndex) {
          const changedAt = now();
          if (desiredIndex < tierIndex) promotedAt = changedAt;
          else if (changedAt - promotedAt <= 20000) {
            recoveryInterval = Math.min(60000, recoveryInterval * 2);
            promotedAt = -Infinity;
          } else recoveryInterval = 10000;
          tierIndex = desiredIndex;
          lastChange = changedAt;
          bad = queued = good = encoderBad = 0;
        }
        frameBalance.commit(balance);
      };
      if (!changed) {
        // The CPU FPS cap can make adjacent network tiers encode identically.
        // Still advance the logical tier, or resolution changes get stuck here.
        commitDecision();
        finalize('unchanged');
        return;
      }

      encoding.maxFramerate = desiredFps;
      encoding.scaleResolutionDownBy = scale;
      delete encoding.scaleResolutionDownTo;
      parameters.degradationPreference = degradation;
      if (stopped) return;
      try {
        await sender.setParameters(parameters);
        if (stopped) return;
        commitDecision();
        finalize('applied');
      } catch {
        frameBalance.reject();
        bad = queued = good = encoderBad = 0;
        finalize('parameters-rejected');
      }
    })().catch(() => { bad = queued = good = encoderBad = 0; frameBalance.reject(); }).finally(() => { inFlight = null; });
    return inFlight;
  };
  const tick = async () => {
    timer = null;
    await poll();
    if (!stopped) timer = schedule(tick, 1000);
  };
  return {
    poll,
    start() { if (started || stopped) return; started = true; void tick(); },
    stop() { stopped = true; if (timer !== null) cancel(timer); timer = null; },
  };
}
