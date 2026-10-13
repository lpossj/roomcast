import { campusStatsRoute } from './campus-session.js';
const numeric = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const counters = ['bytesSent', 'bytesReceived', 'packetsSent', 'packetsReceived', 'packetsLost',
  'nackCount', 'pliCount', 'firCount', 'retransmittedPacketsSent', 'retransmittedBytesSent',
  'retransmittedPacketsReceived', 'retransmittedBytesReceived', 'packetsDiscarded',
  'framesDropped', 'framesEncoded', 'framesDecoded', 'keyFramesEncoded', 'keyFramesDecoded',
  'totalPacketSendDelay', 'qpSum', 'totalEncodeTime'];
const histories = new Map();
const states = new WeakMap();
let nextId = 1;

export function readP2pDiagnostics() {
  return structuredClone({ version: 1, connections: [...histories.values()] });
}

// Local, bounded, allowlisted diagnostics. No peer identities, SDP or ICE addresses.
if (typeof window !== 'undefined') window.roomcastP2pDiagnostics = readP2pDiagnostics;

export function recordP2pNetworkStats(pc, report, direction, policy = null, route = 'p2p') {
  let state = states.get(pc);
  if (!state) {
    state = { id: nextId++, previous: new Map() };
    states.set(pc, state);
  }
  const transportRoute = campusStatsRoute(report);
  const sample = { at: Date.now(), state: pc.connectionState, policy, transportRoute, easytierUnderlay: transportRoute === 'EasyTier虚拟网' ? 'unknown' : null, streams: [] };
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
      averageQp: delta.framesEncoded > 0 && delta.qpSum !== null ? delta.qpSum / delta.framesEncoded : null,
      encodeTimeMs: delta.framesEncoded > 0 && delta.totalEncodeTime !== null ? delta.totalEncodeTime * 1000 / delta.framesEncoded : null,
      codec: report.get(stat.codecId)?.mimeType ?? null,
      encoderImplementation: typeof stat.encoderImplementation === 'string' ? stat.encoderImplementation.slice(0, 128) : null,
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
  if (!history) history = { connection: state.id, direction, route, samples: [] };
  history.samples.push(sample);
  if (history.samples.length > 120) history.samples.shift();
  histories.delete(state.id);
  histories.set(state.id, history);
  if (histories.size > 20) histories.delete(histories.keys().next().value);
  return sample;
}

