// Bounded srflx prediction adapted from Piik (MIT), commit 03b1d73ddf6e965ace34bf1e8b91d1db84529fe9.
// Copyright (c) 2026 TNTcraft and Piik contributors. See electron/PIIK-NAT-LICENSE.txt.
// This module only proposes extra candidates; the caller forwards ordinary ICE immediately.

export const MAX_NAT_PREDICTION_CANDIDATES = 8;

export function isPredictedCandidate(value) {
  const candidate = typeof value === 'string' ? value : value?.candidate;
  return /^candidate:rcnp[pm][1-4]\s/i.test(candidate?.trim() || '');
}

function normalizeStunUrl(value) {
  if (typeof value !== 'string' || !/^stun:/i.test(value)) return null;
  const authority = value.slice(5);
  try {
    const parsed = new URL(`http://${authority}`);
    if (!parsed.hostname || parsed.username || parsed.password
      || parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
    // URL removes an explicit :80; preserve it rather than treating it as 3478.
    const explicitPort = /:(\d+)$/.exec(authority)?.[1];
    const port = explicitPort === undefined ? 3478 : Number(explicitPort);
    if (port < 1 || port > 65535) return null;
    return `stun:${parsed.hostname.toLowerCase()}:${port}`;
  } catch { return null; }
}

function fieldsOf(candidate) {
  return typeof candidate?.candidate === 'string' ? candidate.candidate.trim().split(/\s+/) : [];
}

function extension(fields, name) {
  const index = fields.findIndex(field => field.toLowerCase() === name);
  return index < 0 ? '' : fields[index + 1] || '';
}

function observationOf(candidate, fields, fragment) {
  if (fields.length < 8 || !/^candidate:/i.test(fields[0])
    || fields[2].toLowerCase() !== 'udp' || extension(fields, 'typ').toLowerCase() !== 'srflx') return null;
  const port = Number(fields[5]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  // Hidden raddr/rport retain Piik's bounded browser hypothesis. Distinct known
  // bases, components, public addresses and media sections never share evidence.
  const key = JSON.stringify([
    fragment, candidate.sdpMid ?? null, candidate.sdpMLineIndex ?? null,
    fields[1], extension(fields, 'raddr'), extension(fields, 'rport'), fields[4],
  ]);
  return {
    key, port, fields,
    candidate: {
      candidate: candidate.candidate,
      sdpMid: candidate.sdpMid ?? null,
      sdpMLineIndex: candidate.sdpMLineIndex ?? null,
      usernameFragment: candidate.usernameFragment ?? (fragment || null),
    },
  };
}

function predictionsFor(observations) {
  if (observations.length !== 3) return [];
  const sorted = [...observations].sort((left, right) => left.port - right.port);
  const step = sorted[1].port - sorted[0].port;
  if (step <= 0 || sorted[2].port - sorted[1].port !== step) return [];
  const result = [];
  for (const [anchor, direction] of [[sorted[2], 1], [sorted[0], -1]]) {
    for (let index = 1; index <= 4; index++) {
      const port = anchor.port + direction * step * index;
      if (port < 1 || port > 65535) continue;
      const fields = [...anchor.fields];
      fields[0] = `candidate:rcnp${direction > 0 ? 'p' : 'm'}${index}`;
      fields[5] = String(port);
      result.push({ ...anchor.candidate, candidate: fields.join(' ') });
    }
  }
  return result;
}

export function createNatPrediction({ iceServers = [] } = {}) {
  // Roomcast supplies its existing three STUN services. TURN entries are ignored
  // and their credentials/configuration are never copied or modified here.
  const urls = new Set(iceServers.flatMap(server => {
    const entries = Array.isArray(server?.urls) ? server.urls : [server?.urls];
    return entries.map(normalizeStunUrl).filter(Boolean);
  }));
  const groups = new Map();
  const retiredFragments = new Set();
  const sourcesSeen = new Set();
  let validObservations = 0;
  let sourceMissing = 0;
  let sourceRejected = 0;
  let duplicates = 0;
  let sequenceMismatch = false;
  let currentFragment = '';
  let emitted = false;
  let epoch = 0;

  return {
    // A queued event may be dispatched only while this token is still current.
    get epoch() { return epoch; },
    snapshot() {
      return { configuredSources: urls.size, validSources: sourcesSeen.size,
        validObservations, sourceMissing, sourceRejected, duplicates,
        predictionStatus: urls.size !== 3 ? 'survey-unavailable' : emitted ? 'generated'
          : sequenceMismatch ? 'non-sequential' : sourceMissing && !validObservations
            ? 'source-unavailable' : 'insufficient-observations' };
    },
    reset() {
      groups.clear();
      retiredFragments.clear();
      sourcesSeen.clear();
      validObservations = sourceMissing = sourceRejected = duplicates = 0;
      sequenceMismatch = false;
      currentFragment = '';
      emitted = false;
      epoch++;
    },
    observe(candidate) {
      if (!candidate?.candidate || isPredictedCandidate(candidate) || urls.size !== 3) return [];
      const fields = fieldsOf(candidate);
      const fragment = candidate.usernameFragment || extension(fields, 'ufrag');
      if (fragment && retiredFragments.has(fragment)) return [];
      if (fragment && currentFragment && fragment !== currentFragment) {
        retiredFragments.add(currentFragment);
        groups.clear();
        sourcesSeen.clear();
        validObservations = sourceMissing = sourceRejected = duplicates = 0;
        sequenceMismatch = false;
        emitted = false;
        epoch++;
      }
      if (fragment) currentFragment = fragment;
      if (emitted) return [];
      const observation = observationOf(candidate, fields, fragment);
      if (!observation) return [];
      // Read url before toJSON(): browser candidate init deliberately omits it.
      const url = normalizeStunUrl(candidate.url);
      if (!url) { sourceMissing++; return []; }
      if (!urls.has(url)) { sourceRejected++; return []; }
      const sources = groups.get(observation.key) || new Map();
      if (sources.has(url)) { duplicates++; return []; }
      // Observations stay bounded even when an interface emits many bases.
      if (!groups.has(observation.key) && groups.size >= 32) return [];
      sources.set(url, observation);
      sourcesSeen.add(url);
      validObservations++;
      groups.set(observation.key, sources);
      const predictions = predictionsFor([...sources.values()]);
      if (sources.size === 3 && !predictions.length) sequenceMismatch = true;
      if (predictions.length) {
        emitted = true;
        groups.clear();
      }
      return predictions;
    },
  };
}
