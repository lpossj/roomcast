// Local, bounded metadata only. Do not accept error text, invites or peer identifiers.
const operations = new Set(['join', 'create', 'create-prepare', 'create-local', 'create-signal', 'leave', 'control', 'capture', 'playback',
  'playback-local', 'playback-answer', 'playback-ice', 'playback-frame', 'playback-recovery']);
const phases = new Set(['started', 'completed', 'cancelled', 'failed', 'rejected']);
const entries = [];
const failures = [];
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

export function getLifecycleDiagnostics(version = '') {
  return { schema: 2, revision: 'direct-quality-20261016', version: /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version) ? version : '',
    exportedAt: new Date().toISOString(), entries: entries.map(entry => ({ ...entry })),
    failures: failures.map(entry => ({ ...entry })) };
}
