import { NETWORK_FEATURES } from '../server/network-capabilities.mjs';
// Local, bounded metadata only. Do not accept error text, invites or peer identifiers.
const operations = new Set(['join', 'create', 'create-prepare', 'create-local', 'create-signal', 'leave', 'control', 'room-recovery', 'capture', 'playback',
  'playback-local', 'playback-answer', 'playback-ice', 'playback-frame', 'playback-recovery', 'playback-restart-answer', 'playback-native', 'playback-campus']);
const phases = new Set(['started', 'completed', 'cancelled', 'failed', 'rejected', 'skipped']);
const entries = [];
const failures = [];
const joinTimeline = [];
const reconnectPresentations = [];
const joinId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const joinStages = new Set(['signaling', 'control', 'authentication', 'fallback', 'admission']);
const joinEvents = new Set(['started', 'registered', 'reused', 'offer-received', 'channel-open',
  'challenge', 'challenge-repeated', 'proof-sent', 'verified', 'skipped', 'request-sent', 'request-received', 'reply-sent', 'reply-received',
  'failed', 'cancelled', 'rejected', 'retrying']);
const joinDetails = new Set(['accepted', 'rejected', 'deadline', 'closed', 'auth-started', 'recovery-budget',
  'no-campus-invite', 'unsupported', 'not-retryable', 'setup', 'superseded', 'no-wire-reply', 'error']);
const controlNatPredictions = new Map();
const failureOperations = new Set(['obs-start', 'obs-device', 'obs-camera', 'obs-track', 'obs-microphone',
  'createOffer', 'createAnswer', 'setLocalDescription', 'setRemoteDescription', 'addIceCandidate', 'prepareCampus', 'join-connection']);
const errorNames = new Set(['Error', 'TypeError', 'NotReadableError', 'AbortError', 'NotAllowedError', 'NotFoundError',
  'OverconstrainedError', 'InvalidStateError', 'OperationError', 'NotSupportedError', 'SecurityError', 'TimeoutError', 'SyntaxError', 'InvalidAccessError', 'RTCError']);
const peerErrorTypes = new Set(['webrtc', 'peer-unavailable', 'network', 'server-error', 'socket-error', 'socket-closed', 'negotiation-failed', 'disconnected']);
const signalingStates = new Set(['stable', 'have-local-offer', 'have-remote-offer', 'have-local-pranswer', 'have-remote-pranswer', 'closed']);
const iceStates = new Set(['new', 'checking', 'connected', 'completed', 'failed', 'disconnected', 'closed']);
const campusStages = new Set(['runtime-integrity', 'network-conflict', 'session-files', 'elevate', 'adapter-wait', 'local-adapter',
  'identity', 'integrity', 'compile', 'core-start', 'ready', 'running', 'cancelled', 'unknown']);
const campusCodes = new Set(['EACCES', 'EPERM', 'ENOENT', 'EADDRINUSE', 'EADDRNOTAVAIL', 'ETIMEDOUT', 'ERR_WORKER_PATH', 'ERR_MODULE_NOT_FOUND']);
let sequence = 0;

// A new guest UUID per join, shared only with its host. Old peers need no metadata.
export function createJoinTrace(role, purpose, remoteId) {
  const id = typeof remoteId === 'string' && joinId.test(remoteId) ? remoteId : crypto.randomUUID();
  const started = performance.now();
  const source = ['initial', 'recovery', 'migration'].includes(purpose) ? purpose : 'incoming';
  return {
    id,
    mark(stage, event, route = '', detail = '') {
      if (!joinStages.has(stage) || !joinEvents.has(event)) return;
      joinTimeline.push({ sequence: ++sequence, at: new Date().toISOString(), attemptId: id,
        role: role === 'host' ? 'host' : 'guest', purpose: source, stage, event,
        route: ['campus', 'ordinary', 'native'].includes(route) ? route : '',
        detail: joinDetails.has(detail) || peerErrorTypes.has(detail) ? detail : '',
        elapsedMs: Math.round(performance.now() - started) });
      if (joinTimeline.length > 200) joinTimeline.shift();
    },
  };
}

// Experimental control ICE evidence: counters/state only, never SDP or IPs.
export function recordEnhancedIce(id, value) {
  if (!/^[a-f0-9-]{36}$/.test(id)) return;
  const counts = Object.fromEntries(['generation', 'ordinary', 'observed', 'generated', 'dispatched', 'dispatchRejected',
    'accepted', 'rejected', 'predictedAccepted', 'predictedRejected', 'configuredSources', 'validSources',
    'validObservations', 'sourceMissing', 'sourceRejected', 'duplicates']
    .map(key => [key, Number.isSafeInteger(value[key]) ? Math.max(0, value[key]) : 0]));
  const choose = (key, allowed) => allowed.includes(value[key]) ? value[key] : '';
  controlNatPredictions.set(id, { connectionId: id, at: new Date().toISOString(), ...counts,
    ...(value.scope === 'room-control' && typeof value.joinAttemptId === 'string' && joinId.test(value.joinAttemptId)
      ? { joinAttemptId: value.joinAttemptId } : {}),
    role: choose('role', ['host', 'guest', 'publisher', 'viewer', 'unknown']),
    scope: choose('scope', ['room-control', 'screen-media']),
    platform: typeof window !== 'undefined' && window.roomcast?.desktop ? 'electron' : 'browser',
    capabilities: { enhancedIce: true, natPrediction: true, nativeUdpMux: false,
      nativeSocketPreparation: false, browserWebRtc: true },
    networkProtocol: value.network?.version === 1 ? 1 : 0,
    peerLegacy: value.network?.legacy !== false,
    commonCapabilities: Object.fromEntries(NETWORK_FEATURES.map(key => [key, value.network?.features?.[key] === true])),
    ...Object.fromEntries(['baseRedacted', 'channelOpen', 'authenticated'].map(key => [key, value[key] === true])),
    state: iceStates.has(value.state) ? value.state : '',
    gatheringState: choose('gatheringState', ['new', 'gathering', 'complete']),
    connectionState: choose('connectionState', ['new', 'connecting', 'connected', 'disconnected', 'failed', 'closed']),
    dtlsState: choose('dtlsState', ['new', 'connecting', 'connected', 'closed', 'failed']),
    outcome: choose('outcome', ['authenticated', 'failed', 'cancelled']),
    failureStage: choose('failureStage', ['ice-gathering', 'ice-checking', 'dtls', 'data-channel', 'authentication', 'established', 'media-track', 'first-frame', 'media-receiving']),
    mediaStage: choose('mediaStage', ['track', 'first-frame', 'receiving']),
    predictionStatus: choose('predictionStatus', ['survey-unavailable', 'generated', 'non-sequential', 'source-unavailable', 'insufficient-observations']),
    selectedLocalSource: choose('selectedLocalSource', ['ordinary', 'predicted', 'unknown']),
    selectedRemoteSource: choose('selectedRemoteSource', ['ordinary', 'predicted', 'unknown']),
    protocol: choose('protocol', ['udp', 'tcp']),
    relay: typeof value.relay === 'boolean' ? value.relay : null,
    ...Object.fromEntries(['rttMs', 'bytesSent', 'bytesReceived', 'iceConnectedMs', 'channelOpenMs', 'authenticatedMs', 'elapsedMs',
      'trackEstablishedMs', 'firstFrameMs', 'mediaBytesReceived', 'framesDecoded', 'width', 'height', 'fps']
      .map(key => [key, typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0 ? value[key] : null])),
    selectedPredicted: typeof value.selectedPredicted === 'boolean' ? value.selectedPredicted : null });
  if (controlNatPredictions.size > 30) controlNatPredictions.delete(controlNatPredictions.keys().next().value);
}

export function recordFailure(operation, error, { pc, attempt = 0, campus } = {}) {
  if (!failureOperations.has(operation)) return;
  const name = error?.roomcastErrorName || error?.name;
  const campusFailure = error?.campusFailure || error?.cause?.campusFailure;
  failures.push({ sequence: ++sequence, at: new Date().toISOString(), operation,
    name: errorNames.has(name) ? name : 'UnknownError',
    type: peerErrorTypes.has(error?.type) ? error.type : '',
    attempt: Number.isInteger(attempt) && attempt >= 0 && attempt <= 3 ? attempt : 0,
    route: typeof campus === 'boolean' ? campus ? 'campus' : 'ordinary' : pc ? pc.roomcastCampus ? 'campus' : 'ordinary' : '',
    signalingState: signalingStates.has(pc?.signalingState) ? pc.signalingState : '',
    iceConnectionState: iceStates.has(pc?.iceConnectionState) ? pc.iceConnectionState : '',
    remoteDescription: pc ? Boolean(pc.remoteDescription) : null,
    ...(campusStages.has(campusFailure?.stage) ? { campusStage: campusFailure.stage,
      campusCode: campusCodes.has(campusFailure.code) || /^-?\d{1,10}$/.test(campusFailure.code || '') ? campusFailure.code : '' } : {}) });
  if (failures.length > 100) failures.shift();
}

export function recordLifecycle(operation, phase, elapsedMs = 0) {
  if (!operations.has(operation) || !phases.has(phase)) return;
  entries.push({ sequence: ++sequence, at: new Date().toISOString(), operation, phase,
    elapsedMs: Number.isFinite(elapsedMs) ? Math.round(Math.max(0, Math.min(elapsedMs, 86_400_000))) : 0 });
  if (entries.length > 200) entries.shift();
}

export function recordReconnectPresentation(generation, route, frame, inbound) {
  reconnectPresentations.push({ generation, route, first: frame.first, presentedAt: performance.timeOrigin + frame.at,
    mediaTime: frame.mediaTime, presentedFrames: frame.presentedFrames,
    receiverStatsAt: inbound?.timestamp ?? null, framesDecoded: inbound?.framesDecoded ?? null });
  if (reconnectPresentations.length > 32) reconnectPresentations.shift();
}

const nativeTransports = new Map();
export function recordNativeTransport(id, role, message) {
  const entry = nativeTransports.get(id) || { id, role };
  entry.at = new Date().toISOString();
  if (['prepared','open','local-answer','closed','error'].includes(message.event)) entry[message.event] = true;
  if (['new','connecting','connected','disconnected','failed','closed'].includes(message.state)) entry.state = message.state;
  if (message.event === 'stats') {
    for (const key of ['ordinary','observations','predicted','accepted','rejected','rttMs','mediaBytesSent','mediaBytesReceived']) {
      if (Number.isFinite(message[key]) && message[key] >= 0) entry[key] = message[key];
    }
    if (message.protocol === 'udp' || message.protocol === 'tcp') entry.protocol = message.protocol;
    if (typeof message.relay === 'boolean') entry.relay = message.relay;
  }
  nativeTransports.set(id, entry);
  if (nativeTransports.size > 32) nativeTransports.delete(nativeTransports.keys().next().value);
}

export function getLifecycleDiagnostics(version = '') {
  return { schema: 3, revision: 'step4-acceptance-fixes-20261120', playbackRevision: 'step4-playback-20261121',
    version: /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version) ? version : '',
    exportedAt: new Date().toISOString(), entries: entries.map(entry => ({ ...entry })),
    nativeTransports: [...nativeTransports.values()].map(item => ({ ...item })),
    joinTimeline: joinTimeline.map(entry => ({ ...entry })),
    reconnectPresentations: reconnectPresentations.map(entry => ({ ...entry })),
    controlNatPredictions: [...controlNatPredictions.values()].filter(entry => entry.scope === 'room-control').map(entry => ({ ...entry })),
    enhancedIceConnections: [...controlNatPredictions.values()].map(entry => ({ ...entry })),
    failures: failures.map(entry => ({ ...entry })) };
}
