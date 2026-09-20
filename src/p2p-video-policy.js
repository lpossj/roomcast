const numeric = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const counters = ['bytesSent', 'bytesReceived', 'packetsSent', 'packetsReceived', 'packetsLost',
  'nackCount', 'pliCount', 'firCount', 'retransmittedPacketsSent', 'retransmittedBytesSent',
  'retransmittedPacketsReceived', 'retransmittedBytesReceived', 'packetsDiscarded',
  'framesDropped', 'framesEncoded', 'framesDecoded', 'totalPacketSendDelay'];
const histories = new Map();
const states = new WeakMap();
let nextId = 1;

export function readP2pDiagnostics() {
  return structuredClone({ version: 1, connections: [...histories.values()] });
}

// Local, bounded, allowlisted diagnostics. No peer identities, SDP or ICE addresses.
if (typeof window !== 'undefined') window.roomcastP2pDiagnostics = readP2pDiagnostics;

export function recordP2pNetworkStats(pc, report, direction, policy = null) {
  let state = states.get(pc);
  if (!state) {
    state = { id: nextId++, previous: new Map() };
    states.set(pc, state);
  }
  const sample = { at: Date.now(), state: pc.connectionState, policy, streams: [] };
  const next = new Map();
  for (const stat of report.values()) {
    if (!['inbound-rtp', 'outbound-rtp'].includes(stat.type) || stat.isRemote) continue;
    const previous = state.previous.get(stat.id);
    const elapsed = previous ? stat.timestamp - previous.timestamp : 0;
    const fresh = elapsed > 0;
    const values = Object.fromEntries(counters.map(key => [key, numeric(stat[key])]));
    const delta = Object.fromEntries(counters.map(key => [key,
      fresh && values[key] !== null && previous[key] !== null && values[key] >= previous[key]
        ? values[key] - previous[key] : null,
    ]));
    const remote = report.get(stat.remoteId);
    const freshRemote = remote && numeric(remote.timestamp) !== null
      && remote.timestamp > (previous?.remoteTimestamp ?? -Infinity);
    const transport = report.get(stat.transportId);
    const pair = report.get(transport?.selectedCandidatePairId);
    let lossRate = null;
    if (stat.type === 'inbound-rtp' && delta.packetsReceived !== null && fresh
      && numeric(stat.packetsLost) !== null && previous.packetsLost !== null) {
      // Late recovery can lower cumulative loss; it is not new packet loss.
      const lost = Math.max(0, stat.packetsLost - previous.packetsLost);
      if (delta.packetsReceived + lost > 0) lossRate = lost / (delta.packetsReceived + lost);
    } else if (freshRemote && numeric(remote.fractionLost) !== null) {
      lossRate = Math.max(0, Math.min(1, remote.fractionLost));
    }
    const bytes = stat.type === 'outbound-rtp' ? delta.bytesSent : delta.bytesReceived;
    sample.streams.push({
      type: stat.type, kind: stat.kind || stat.mediaType,
      ...values, delta, lossRate, fresh,
      bitrate: bytes !== null && fresh ? bytes * 8000 / elapsed : null,
      ...Object.fromEntries(['frameWidth', 'frameHeight', 'framesPerSecond', 'targetBitrate', 'jitter']
        .map(key => [key, numeric(stat[key])])),
      qualityLimitationReason: stat.qualityLimitationReason ?? null,
      remotePacketsLost: numeric(remote?.packetsLost),
      remoteJitter: numeric(remote?.jitter),
      freshRemote: Boolean(freshRemote),
      rtt: numeric(pair?.currentRoundTripTime) ?? numeric(remote?.roundTripTime),
      availableOutgoingBitrate: numeric(pair?.availableOutgoingBitrate),
      packetSendDelayMs: delta.packetsSent > 0 && delta.totalPacketSendDelay !== null
        ? delta.totalPacketSendDelay * 1000 / delta.packetsSent : null,
    });
    next.set(stat.id, { ...values, timestamp: stat.timestamp, remoteTimestamp: remote?.timestamp });
  }
  state.previous = next;
  let history = histories.get(state.id);
  if (!history) history = { connection: state.id, direction, samples: [] };
  history.samples.push(sample);
  if (history.samples.length > 120) history.samples.shift();
  histories.delete(state.id);
  histories.set(state.id, history);
  if (histories.size > 20) histories.delete(histories.keys().next().value);
  return sample;
}

export function p2pResolutionScale(track, quality) {
  const source = track?.getSettings?.() || {};
  if (!(source.width > 0 && source.height > 0 && quality.width > 0 && quality.height > 0)) return 1;
  // Always derive from the source, never from a congestion-reduced encoded frame.
  return Math.max(1, source.width / quality.width, source.height / quality.height);
}


const STANDARD_VIDEO_RESOLUTIONS = Object.freeze([
  { width: 1920, height: 1080 },
  { width: 1280, height: 720 },
  { width: 854, height: 480 },
  { width: 640, height: 360 },
]);

function normalizedResolution(resolution, fallback) {
  const width = Math.round(Number(resolution?.width) || 0);
  const height = Math.round(Number(resolution?.height) || 0);
  return width >= 2 && height >= 2 ? { width, height } : fallback;
}

function buildP2pVideoTiers(quality, targetFps) {
  const base = normalizedResolution(quality, { width: 1920, height: 1080 });
  const resolutions = [base];
  for (const resolution of STANDARD_VIDEO_RESOLUTIONS) {
    if (resolution.width >= base.width && resolution.height >= base.height) continue;
    if (resolutions.some(item => item.width === resolution.width && item.height === resolution.height)) continue;
    resolutions.push({ ...resolution });
  }
  const reducedFps = Math.min(30, targetFps);
  const tiers = [];
  for (const resolution of resolutions) {
    tiers.push({ ...resolution, fps: targetFps });
    if (reducedFps < targetFps) tiers.push({ ...resolution, fps: reducedFps });
  }
  return tiers;
}

export function createP2pVideoPolicy({ pc, sender, quality, now = Date.now, schedule = setTimeout, cancel = clearTimeout }) {
  const targetFps = Math.max(1, Number(quality.fps) || 30);
  const tiers = buildP2pVideoTiers(quality, targetFps);
  const baseRate = Math.max(1, tiers[0].width * tiers[0].height * tiers[0].fps);
  const rateFor = tier => Math.max(1, tier.width * tier.height * tier.fps);
  const budgetFor = (index, observedBaseBitrate) => {
    const selected = Number(quality.bitrate) > 0 ? Number(quality.bitrate) * 1000 : observedBaseBitrate;
    if (!(selected > 0)) return 0;
    return selected * rateFor(tiers[index]) / baseRate;
  };
  let tierIndex = 0, bad = 0, good = 0, lastChange = -Infinity, fullRateBitrate = 0;
  let started = false, stopped = false, timer = null, inFlight = null;

  const poll = () => {
    if (stopped) return Promise.resolve();
    if (inFlight) return inFlight;
    inFlight = (async () => {
      if (pc.connectionState !== 'connected') { bad = good = 0; return; }
      const report = await pc.getStats();
      if (stopped || pc.connectionState !== 'connected' || sender.track?.readyState === 'ended') return;
      const currentTier = tiers[tierIndex];
      const sample = recordP2pNetworkStats(pc, report, 'publisher', {
        width: currentTier.width,
        height: currentTier.height,
        targetFps,
        appliedFps: currentTier.fps,
        tierIndex,
        tierCount: tiers.length,
      });
      const video = sample.streams.find(stat => stat.type === 'outbound-rtp' && stat.kind === 'video');
      const active = video?.fresh && video.delta.packetsSent > 0;
      if (active && video.qualityLimitationReason === 'none' && video.bitrate > 0) {
        // Keep an estimated full-quality bitrate even after a temporary tier drop,
        // so auto-bitrate sessions can recover instead of staying pinned low.
        const baseEquivalent = video.bitrate / (rateFor(currentTier) / baseRate);
        fullRateBitrate = Math.max(fullRateBitrate, baseEquivalent);
      }
      const budget = budgetFor(tierIndex, fullRateBitrate);
      const congested = active && (video.qualityLimitationReason === 'bandwidth'
        || (budget > 0 && video.availableOutgoingBitrate !== null && video.availableOutgoingBitrate < budget * 0.8)
        || (video.lossRate !== null && video.lossRate >= 0.05)
        || (video.packetSendDelayMs !== null && video.packetSendDelayMs >= 100));
      const nextIndex = Math.max(0, tierIndex - 1);
      const nextBudget = budgetFor(nextIndex, fullRateBitrate);
      const bitrateHealthy = nextBudget <= 0
        || (video.availableOutgoingBitrate !== null && video.availableOutgoingBitrate >= nextBudget);
      const healthy = active && !congested && video.qualityLimitationReason === 'none'
        && bitrateHealthy
        && (video.lossRate === null || video.lossRate < 0.02)
        && (video.rtt === null || video.rtt < 0.3)
        && (video.packetSendDelayMs === null || video.packetSendDelayMs < 30);
      bad = congested ? bad + 1 : 0;
      good = healthy ? good + 1 : 0;
      let desiredIndex = tierIndex;
      if (bad >= 2 && tierIndex < tiers.length - 1) desiredIndex = tierIndex + 1;
      else if (good >= 8 && tierIndex > 0 && now() - lastChange >= 10000) desiredIndex = tierIndex - 1;

      const parameters = sender.getParameters();
      const encoding = parameters.encodings?.[0];
      const finalize = status => {
        const applied = tiers[tierIndex];
        sample.policy = {
          ...sample.policy,
          width: applied.width,
          height: applied.height,
          targetFps,
          appliedFps: applied.fps,
          tierIndex,
          tierCount: tiers.length,
          scaleResolutionDownBy: p2pResolutionScale(sender.track, applied),
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
      const scale = p2pResolutionScale(sender.track, desiredTier);
      const changed = encoding.maxFramerate !== desiredTier.fps
        || encoding.scaleResolutionDownBy !== scale
        || parameters.degradationPreference !== 'maintain-resolution';
      if (!changed) {
        finalize('unchanged');
        return;
      }

      const previousTierIndex = tierIndex;
      tierIndex = desiredIndex;
      encoding.maxFramerate = desiredTier.fps;
      encoding.scaleResolutionDownBy = scale;
      delete encoding.scaleResolutionDownTo;
      parameters.degradationPreference = 'maintain-resolution';
      if (stopped) {
        tierIndex = previousTierIndex;
        return;
      }
      try {
        await sender.setParameters(parameters);
        if (stopped) {
          tierIndex = previousTierIndex;
          return;
        }
        if (previousTierIndex !== tierIndex) { lastChange = now(); bad = good = 0; }
        finalize('applied');
      } catch {
        tierIndex = previousTierIndex;
        bad = good = 0;
        finalize('parameters-rejected');
      }
    })().catch(() => { bad = good = 0; }).finally(() => { inFlight = null; });
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