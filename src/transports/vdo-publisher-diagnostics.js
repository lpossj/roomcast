// Read-only sender diagnostics. Never retain raw stats, ICE addresses, or invite data.
const SAMPLE_INTERVAL_MS = 2000;
const MAX_SAMPLES = 300;
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const pickNumbers = (value, keys) => Object.fromEntries(keys.map(key => [key, number(value?.[key])]));

function trackDetails(track) {
  let settings;
  try { settings = track.getSettings(); } catch { /* Track may have ended. */ }
  return {
    ...pickNumbers(settings, ['width', 'height', 'frameRate']),
    contentHint: track.contentHint || '',
    readyState: track.readyState,
  };
}

export function createVdoPublisherDiagnostics({
  getConnections,
  sourceStream,
  isolatedStream,
  schedule = setTimeout,
  cancel = clearTimeout,
  now = Date.now,
}) {
  const samples = [];
  const connections = new WeakMap();
  let nextConnectionId = 1;
  let timer = null;
  let started = false;
  let stopped = false;
  let collecting = null;

  const readConnection = async pc => {
    let previous = connections.get(pc);
    if (!previous) {
      previous = { id: nextConnectionId++, outbound: new Map() };
      connections.set(pc, previous);
    }
    const result = { connection: previous.id, state: pc.connectionState };
    try {
      const report = await pc.getStats();
      if (stopped) return null;
      result.senders = pc.getSenders().filter(sender => sender.track?.kind === 'video').map(sender => {
        let params;
        try { params = sender.getParameters(); } catch { /* Missing is not a default value. */ }
        return {
          track: trackDetails(sender.track),
          degradationPreference: params?.degradationPreference ?? null,
          encodings: Array.isArray(params?.encodings) ? params.encodings.map(encoding => ({
            ...pickNumbers(encoding, ['scaleResolutionDownBy', 'maxBitrate', 'maxFramerate']),
            active: typeof encoding.active === 'boolean' ? encoding.active : null,
          })) : null,
        };
      });
      const nextOutbound = new Map();
      result.outbound = [...report.values()].filter(stat =>
        stat.type === 'outbound-rtp' && (stat.kind || stat.mediaType) === 'video' && !stat.isRemote,
      ).map(stat => {
        const before = previous.outbound.get(stat.id);
        const elapsed = before ? stat.timestamp - before.timestamp : 0;
        const bytes = before ? stat.bytesSent - before.bytesSent : -1;
        const bitrate = elapsed > 0 && bytes >= 0 ? number(bytes * 8000 / elapsed) : null;
        nextOutbound.set(stat.id, { timestamp: stat.timestamp, bytesSent: stat.bytesSent });
        const transport = report.get(stat.transportId);
        const pair = report.get(transport?.selectedCandidatePairId);
        return {
          ...pickNumbers(stat, ['frameWidth', 'frameHeight', 'framesPerSecond', 'targetBitrate', 'bytesSent', 'framesEncoded', 'qualityLimitationResolutionChanges']),
          bitrate,
          qualityLimitationReason: stat.qualityLimitationReason ?? null,
          qualityLimitationDurations: pickNumbers(stat.qualityLimitationDurations, ['none', 'cpu', 'bandwidth', 'other']),
          availableOutgoingBitrate: number(pair?.availableOutgoingBitrate),
          currentRoundTripTime: number(pair?.currentRoundTripTime),
        };
      });
      previous.outbound = nextOutbound;
      result.status = 'ok';
    } catch {
      // A closing or unsupported connection must not affect publishing or other viewers.
      previous.outbound.clear();
      result.status = 'unavailable';
    }
    return result;
  };

  const sample = () => {
    if (stopped) return Promise.resolve();
    if (collecting) return collecting;
    collecting = (async () => {
      const entry = {
        at: now(),
        source: sourceStream.getVideoTracks().map(trackDetails),
        isolated: isolatedStream.getVideoTracks().map(trackDetails),
        connections: await Promise.all(getConnections().slice(0, 9).map(readConnection)),
      };
      if (stopped) return;
      samples.push(entry);
      if (samples.length > MAX_SAMPLES) samples.shift();
    })().catch(() => {
      // Diagnostics are optional and must never reject into the media lifecycle.
    }).finally(() => { collecting = null; });
    return collecting;
  };

  const tick = async () => {
    timer = null;
    await sample();
    if (!stopped) timer = schedule(tick, SAMPLE_INTERVAL_MS);
  };

  return {
    start() {
      if (started || stopped) return;
      started = true;
      void tick();
    },
    sample,
    snapshot: () => structuredClone({ version: 1, intervalMs: SAMPLE_INTERVAL_MS, stopped, samples }),
    stop() {
      stopped = true;
      if (timer !== null) cancel(timer);
      timer = null;
      sourceStream = isolatedStream = getConnections = null;
    },
  };
}
