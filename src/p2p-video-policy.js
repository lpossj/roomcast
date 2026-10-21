import { createVideoEncoderGuard } from './video-frame-balance.js';
import { recordP2pNetworkStats } from './p2p-diagnostics.js';

export { p2pResolutionScale } from './video-quality-tiers.js';
export { readP2pDiagnostics, recordP2pNetworkStats } from './p2p-diagnostics.js';
const numeric = value => typeof value === 'number' && Number.isFinite(value) ? value : null;

export function createP2pVideoPolicy({ pc, sender, quality, route = 'p2p', now = Date.now, schedule = setTimeout, cancel = clearTimeout }) {
  const guard = createVideoEncoderGuard(quality, now);
  let started = false, stopped = false, timer = null, inFlight = null;

  const poll = () => {
    if (stopped) return Promise.resolve();
    if (inFlight) return inFlight;
    inFlight = (async () => {
      if (pc.connectionState !== 'connected') { guard.resetSamples(); return; }
      const report = await pc.getStats();
      if (stopped || pc.connectionState !== 'connected' || sender.track?.readyState === 'ended') return;
      const sample = recordP2pNetworkStats(pc, report, 'publisher', null, route);
      const video = sample.streams.find(stat => stat.type === 'outbound-rtp' && stat.kind === 'video');
      // BWE, loss recovery, pacing and ordinary resource adaptation already
      // belong to libwebrtc. A local pacer queue after idle/motion is not an
      // independent reason to clamp resolution for another 10-60 seconds.
      const decision = await guard.apply(sender, video, () => stopped);
      const parameters = sender.getParameters();
      sample.policy = {
        ...decision,
        degradationPreference: parameters.degradationPreference ?? null,
        ...Object.fromEntries(['maxBitrate', 'maxFramerate', 'scaleResolutionDownBy']
          .map(key => [key, numeric(parameters.encodings?.[0]?.[key])])),
      };
    })().catch(() => { guard.resetSamples(); }).finally(() => { inFlight = null; });
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
