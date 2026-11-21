import { createNatPrediction, isPredictedCandidate } from './nat-prediction.js';
import { recordEnhancedIce } from './lifecycle-diagnostics.js';
import { negotiateNetwork } from './network-capabilities.js';

const attached = new WeakMap();
const live = new Set();
const numeric = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
export function markControlAuthenticated(pc) { attached.get(pc)?.authenticated(); }
export function markControlFailure(pc, reason = 'failed') { attached.get(pc)?.failed(reason); }
export function setEnhancedIceRemote(pc, value) { attached.get(pc)?.remote(value); }
export function observeEnhancedIceMedia(pc, report) { attached.get(pc)?.media(report); }
export async function refreshEnhancedIceDiagnostics() {
  // Export on demand; no new background polling or retry owner.
  await Promise.allSettled([...live].map(entry => entry.sample()));
}

// Attach before PeerJS's async SDP operations. Ordinary events are not intercepted.
export function enableEnhancedIce(pc, { role = 'unknown', channel = null, scope = 'room-control', joinAttemptId } = {}) {
  if (!pc || attached.has(pc) || pc.roomcastCampus || pc.signalingState === 'closed') return false;
  const config = pc.getConfiguration();
  if (config.iceTransportPolicy === 'relay') return false;
  let predictor = createNatPrediction({ iceServers: config.iceServers });
  let sampleSequence = 0;
  let closed = false;
  let finalObservation;
  let lastMedia = null;
  let waitingForLocalDescription = false;
  const started = performance.now();
  const id = crypto.randomUUID();
  const channels = new Set();
  const summary = { role, scope, joinAttemptId, network: negotiateNetwork(null), generation: 0, ordinary: 0, observed: 0, generated: 0,
    dispatched: 0, dispatchRejected: 0, accepted: 0, rejected: 0,
    predictedAccepted: 0, predictedRejected: 0, baseRedacted: false,
    state: pc.iceConnectionState, gatheringState: pc.iceGatheringState,
    connectionState: pc.connectionState, dtlsState: '', channelOpen: false,
    authenticated: false, failureStage: '', outcome: '', selectedPredicted: null,
    selectedLocalSource: 'unknown', selectedRemoteSource: 'unknown', protocol: '', relay: null,
    rttMs: null, bytesSent: null, bytesReceived: null, iceConnectedMs: null,
    channelOpenMs: null, authenticatedMs: null, elapsedMs: 0,
    mediaStage: '', trackEstablishedMs: null, firstFrameMs: null, mediaBytesReceived: null,
    framesDecoded: null, width: null, height: null, fps: null };
  const active = () => !closed && !pc.roomcastCampus && pc.signalingState !== 'closed'
    && pc.getConfiguration().iceTransportPolicy !== 'relay';
  const record = () => {
    summary.elapsedMs = Math.round(performance.now() - started);
    recordEnhancedIce(id, { ...summary, ...(finalObservation || predictor.snapshot()) });
  };
  const stage = () => scope === 'screen-media' && ['connected', 'completed'].includes(summary.state)
    ? summary.dtlsState !== 'connected' ? 'dtls' : summary.firstFrameMs !== null ? 'media-receiving'
      : summary.trackEstablishedMs !== null ? 'first-frame' : 'media-track'
    : summary.authenticated ? 'established' : summary.channelOpen ? 'authentication'
    : summary.dtlsState === 'connected' ? 'data-channel'
      : ['connected', 'completed'].includes(summary.state) ? 'dtls'
        : summary.state === 'checking' ? 'ice-checking' : 'ice-gathering';
  const entry = {
    remote(value) { if (active()) { summary.network = negotiateNetwork(value); record(); } },
    media(report) { if (active()) { readMedia(report); record(); } },
    authenticated() {
      if (!active()) return;
      summary.authenticated = true;
      summary.authenticatedMs ??= Math.round(performance.now() - started);
      summary.outcome = 'authenticated';
      record();
      void sample();
    },
    failed(reason) {
      if (!active()) return;
      summary.outcome = reason === 'cancelled' ? 'cancelled' : 'failed';
      if (reason !== 'cancelled') summary.failureStage ||= stage();
      record();
    },
    sample,
  };
  attached.set(pc, entry);
  live.add(entry);
  record();

  function reset() {
    predictor.reset();
    sampleSequence++;
    summary.selectedPredicted = null;
    summary.selectedLocalSource = summary.selectedRemoteSource = 'unknown';
    summary.protocol = '';
    summary.relay = summary.rttMs = summary.bytesSent = summary.bytesReceived = null;
    record();
  }
  const restartIce = pc.restartIce;
  pc.restartIce = function (...args) { reset(); waitingForLocalDescription = true; return restartIce.apply(this, args); };
  const setLocalDescription = pc.setLocalDescription;
  pc.setLocalDescription = async function (...args) {
    const result = await setLocalDescription.apply(this, args);
    waitingForLocalDescription = false;
    return result;
  };
  const setConfiguration = pc.setConfiguration;
  pc.setConfiguration = function (...args) {
    const result = setConfiguration.apply(this, args);
    reset();
    predictor = createNatPrediction({ iceServers: pc.getConfiguration().iceServers });
    record();
    return result;
  };
  const close = pc.close;
  pc.close = function (...args) {
    if (!closed) {
      // PeerJS may close inside its earlier ICE listener before ours runs.
      summary.state = pc.iceConnectionState;
      summary.connectionState = pc.connectionState;
      summary.dtlsState = pc.sctp?.transport?.state || summary.dtlsState;
      if (summary.state === 'failed' || summary.connectionState === 'failed') entry.failed();
      closed = true;
      sampleSequence++;
      finalObservation = predictor.snapshot();
      predictor.reset();
      live.delete(entry);
      pc.removeEventListener('icegatheringstatechange', onGathering);
      pc.removeEventListener('icecandidate', onCandidate);
      pc.removeEventListener('iceconnectionstatechange', onState);
      pc.removeEventListener('connectionstatechange', onState);
      pc.removeEventListener('datachannel', onDataChannel);
      pc.removeEventListener('track', onTrack);
      for (const value of channels) value.removeEventListener('open', onChannelOpen);
      channels.clear();
      delete pc.roomcastIceCandidateResult;
    }
    const result = close.apply(this, args);
    // Preserve the final selected-pair evidence after a failed/recovered attempt.
    summary.state = summary.connectionState = 'closed';
    record();
    return result;
  };
  // Count the native result only, not queued or cancelled candidates.
  pc.roomcastIceCandidateResult = (candidate, accepted) => {
    if (!active() || !candidate?.candidate) return;
    const fragment = candidate.usernameFragment || /\bufrag\s+(\S+)/.exec(candidate.candidate)?.[1];
    if (fragment && !pc.remoteDescription?.sdp?.split(/\r?\n/).includes('a=ice-ufrag:' + fragment)) return;
    summary[accepted ? 'accepted' : 'rejected']++;
    if (isPredictedCandidate(candidate)) summary[accepted ? 'predictedAccepted' : 'predictedRejected']++;
    record();
  };

  function onGathering() {
    if (pc.iceGatheringState === 'gathering') { reset(); summary.generation++; }
    summary.gatheringState = pc.iceGatheringState;
    record();
  }
  function onCandidate(event) {
    const candidate = event.candidate;
    if (!active() || !candidate?.candidate || isPredictedCandidate(candidate)) return;
    summary.ordinary++;
    const fields = candidate.candidate.trim().split(/\s+/);
    if (fields[2]?.toLowerCase() === 'udp' && fields[fields.indexOf('typ') + 1] === 'srflx') summary.observed++;
    const fragment = candidate.usernameFragment || /\bufrag\s+(\S+)/.exec(candidate.candidate)?.[1];
    if (waitingForLocalDescription || (fragment && pc.localDescription?.sdp
      && !pc.localDescription.sdp.split(/\r?\n/).includes('a=ice-ufrag:' + fragment))) { record(); return; }
    const previousEpoch = predictor.epoch;
    const predictions = predictor.observe(candidate);
    if (previousEpoch !== predictor.epoch) { sampleSequence++; summary.selectedPredicted = null; }
    if (!predictions.length) { record(); return; }
    summary.generated += predictions.length;
    const relatedAddress = fields[fields.indexOf('raddr') + 1];
    const relatedPort = fields[fields.indexOf('rport') + 1];
    summary.baseRedacted = !fields.includes('raddr') || !fields.includes('rport')
      || ['0.0.0.0', '::'].includes(relatedAddress) || relatedPort === '0';
    const epoch = predictor.epoch;
    const batchPredictor = predictor;
    record();
    queueMicrotask(() => {
      if (!active() || batchPredictor !== predictor || epoch !== predictor.epoch) return;
      for (const init of predictions) {
        if (!active() || batchPredictor !== predictor || epoch !== predictor.epoch) break;
        try {
          pc.dispatchEvent(new RTCPeerConnectionIceEvent('icecandidate', { candidate: new RTCIceCandidate(init) }));
          summary.dispatched++;
        } catch { summary.dispatchRejected++; }
      }
      record();
    });
  }
  async function sample() {
    if (!active()) return;
    const epoch = predictor.epoch;
    const batchPredictor = predictor;
    const sequence = ++sampleSequence;
    try {
      const report = await pc.getStats();
      if (!active() || batchPredictor !== predictor || epoch !== predictor.epoch || sequence !== sampleSequence) return;
      const values = [...report.values()];
      const transport = values.find(value => value.type === 'transport' && value.selectedCandidatePairId);
      const pair = transport ? report.get(transport.selectedCandidatePairId)
        : values.find(value => value.type === 'candidate-pair' && value.nominated && value.state === 'succeeded');
      const local = pair && report.get(pair.localCandidateId);
      const remote = pair && report.get(pair.remoteCandidateId);
      const source = candidate => !candidate?.foundation ? 'unknown'
        : /^rcnp[pm][1-4](?:b\d+)?$/.test(candidate.foundation) ? 'predicted' : 'ordinary';
      summary.selectedLocalSource = source(local);
      summary.selectedRemoteSource = source(remote);
      summary.selectedPredicted = summary.selectedRemoteSource === 'unknown' ? null : summary.selectedRemoteSource === 'predicted';
      summary.protocol = local?.protocol || remote?.protocol || '';
      summary.relay = pair && local?.candidateType && remote?.candidateType
        ? local.candidateType === 'relay' || remote.candidateType === 'relay' : null;
      summary.rttMs = numeric(pair?.currentRoundTripTime) === null ? null : pair.currentRoundTripTime * 1000;
      summary.bytesSent = numeric(pair?.bytesSent);
      summary.bytesReceived = numeric(pair?.bytesReceived);
      summary.dtlsState = transport?.dtlsState || pc.sctp?.transport?.state || '';
      readMedia(report);
      record();
    } catch { /* Stats unavailability never changes transport state. */ }
  }
  function onState() {
    summary.state = pc.iceConnectionState;
    summary.connectionState = pc.connectionState;
    summary.dtlsState = pc.sctp?.transport?.state || summary.dtlsState;
    if (['connected', 'completed'].includes(summary.state)) summary.iceConnectedMs ??= Math.round(performance.now() - started);
    if (summary.state === 'failed' || summary.connectionState === 'failed') entry.failed();
    record();
    void sample();
  }
  function readMedia(report) {
    if (scope !== 'screen-media') return;
    const video = [...report.values()].find(item => item.type === 'inbound-rtp' && (item.kind || item.mediaType) === 'video');
    if (!video || (lastMedia && video.timestamp <= lastMedia.timestamp)) return;
    summary.framesDecoded = numeric(video.framesDecoded);
    summary.mediaBytesReceived = numeric(video.bytesReceived);
    summary.width = numeric(video.frameWidth);
    summary.height = numeric(video.frameHeight);
    summary.fps = numeric(video.framesPerSecond);
    if (video.framesDecoded > 0) {
      summary.firstFrameMs ??= Math.round(performance.now() - started);
      summary.mediaStage = lastMedia && video.framesDecoded > lastMedia.framesDecoded && video.bytesReceived > lastMedia.bytesReceived
        ? 'receiving' : 'first-frame';
    }
    lastMedia = { timestamp: video.timestamp, framesDecoded: video.framesDecoded, bytesReceived: video.bytesReceived };
  }
  function onTrack() {
    summary.trackEstablishedMs ??= Math.round(performance.now() - started);
    summary.mediaStage ||= 'track';
    record();
  }
  function onChannelOpen() {
    summary.channelOpen = true;
    summary.channelOpenMs ??= Math.round(performance.now() - started);
    record();
    void sample();
  }
  function watchChannel(value) {
    if (!value || channels.has(value)) return;
    channels.add(value);
    value.addEventListener('open', onChannelOpen);
    if (value.readyState === 'open') onChannelOpen();
  }
  function onDataChannel(event) { watchChannel(event.channel); }
  watchChannel(channel);
  pc.addEventListener('datachannel', onDataChannel);
  pc.addEventListener('track', onTrack);
  pc.addEventListener('icegatheringstatechange', onGathering);
  pc.addEventListener('icecandidate', onCandidate);
  pc.addEventListener('iceconnectionstatechange', onState);
  pc.addEventListener('connectionstatechange', onState);
  return true;
}
