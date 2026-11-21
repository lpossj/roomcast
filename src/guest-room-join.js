import { openNativeControl } from './transports/native-room-control.js';
import { nativeAvailable } from './transports/native-endpoint.js';
import { campusRequestProof, prepareCampusConnection } from './campus-session.js';
import { enableControlNatPrediction, markControlAuthenticated, markControlFailure } from './control-nat-prediction.js';
import { setEnhancedIceRemote } from './enhanced-ice.js';
import { createJoinTrace, recordFailure } from './lifecycle-diagnostics.js';
import { localNetworkCapabilities } from './network-capabilities.js';
import { createPeerAuthProof, PEER_AUTH_PROTOCOL, PEER_AUTH_TOTAL_TIMEOUT_MS, randomPeerAuthNonce, verifyPeerAuthProof } from './p2p-auth.js';
import { waitForRoomOperation, withTimeout } from './room-operation.js';

export const CONTROL_DISCONNECT_GRACE_MS = 8_000;
const signalingErrors = new Set(['peer-unavailable', 'network', 'server-error', 'socket-error', 'socket-closed']);
const connectionTimeout = '无法与房主建立 P2P 连接。';
const negotiationSteps = {
  createOffer: '发起连接', createAnswer: '回应连接', setLocalDescription: '准备连接',
  setRemoteDescription: '确认远端连接', addIceCandidate: '交换连接信息', prepareCampus: '准备备用连接',
};

async function registerGuest(room, purpose, trace, signal) {
  const initial = purpose === 'initial';
  const needsRecoveryPeer = purpose === 'recovery' && (!room.peer || room.peer.destroyed || room.peer.disconnected);
  if (!initial && !needsRecoveryPeer) {
    trace.mark('signaling', 'reused');
    return;
  }

  trace.mark('signaling', 'started');
  try {
    if (!initial) room.peer?.destroy();
    const peer = await room.openPeer(undefined, room.peerServer, {
      signal, timeout: initial ? 20_000 : 5_000,
    });
    signal.throwIfAborted();
    if (initial) peer.on('connection', connection => connection.close());
    trace.mark('signaling', 'registered');
  } catch (error) {
    trace.mark('signaling', signal.aborted ? 'cancelled' : 'failed', '', error.type || (error.roomcastTimeout ? 'deadline' : 'error'));
    throw error;
  }
}

// Reconnection keeps its original budget and membership ticket. A room reply is
// recorded only when it arrives on the wire, never when local cleanup settles an RPC.
export async function joinGuestRoom(room, purpose, credentials, recoveryDeadline) {
  room.assertOpen();
  room.guestJoinController.abort(new DOMException('操作已取消', 'AbortError'));
  room.guestJoinController = new AbortController();
  const { signal } = room.guestJoinController;
  const trace = createJoinTrace('guest', purpose);
  await registerGuest(room, purpose, trace, signal);
  signal.throwIfAborted();
  const timeout = purpose === 'recovery'
    ? Math.min(PEER_AUTH_TOTAL_TIMEOUT_MS, Math.max(1000, recoveryDeadline - performance.now()))
    : undefined;
  const remote = await room.connectRemote(timeout, trace, signal);
  const route = remote.roomcastNative ? 'native' : remote.peerConnection?.roomcastCampus ? 'campus' : 'ordinary';
  let received = false;
  try {
    signal.throwIfAborted();
    if (purpose !== 'recovery') room.connected = true;
    const result = await room.request('room:join', { roomId: room.roomId, ...credentials }, {
      signal,
      sent: () => trace.mark('admission', 'request-sent', route),
      reply: reply => {
        received = true;
        trace.mark('admission', 'reply-received', route, reply?.ok ? 'accepted' : 'rejected');
      },
    });
    signal.throwIfAborted();
    if (room.remote !== remote) throw new DOMException('操作已取消', 'AbortError');
    if (!result.ok) throw new Error(result.error || (purpose === 'recovery' ? '新房主尚未完成接任。' : ''));
    room.lastControlNative = remote.roomcastNative === true;
    room.id = result.selfId;
    room.room = result.room;
    watchAdmittedControl(room, remote, signal);
    return result;
  } catch (error) {
    if (!received) trace.mark('admission', signal.aborted || error.name === 'AbortError' ? 'cancelled' : 'failed',
      route, error.roomcastTimeout ? 'deadline' : 'no-wire-reply');
    if (purpose !== 'initial' || signal.aborted) remote.close();
    throw error;
  }
}

// Leave an ordinary connection in progress when a desktop peer can also use
// native ICE. Only the first open channel may exchange proofs and join.
async function connectDesktopControl(room, trace, signal, recoveryDeadline) {
  const controllers = { ordinary: new AbortController(), native: new AbortController() };
  let selected;
  let releaseNative;
  const headStart = new Promise(resolve => { releaseNative = resolve; });
  const headStartMs = recoveryDeadline === undefined ? 1500 : Math.min(1500, (recoveryDeadline - performance.now()) / 2);
  const timer = setTimeout(releaseNative, headStartMs);

  async function attempt(route, other) {
    const attemptSignal = AbortSignal.any([signal, controllers[route].signal]);
    if (route === 'native') {
      await waitForRoomOperation(headStart, attemptSignal);
      attemptSignal.throwIfAborted();
      trace.mark('fallback', 'started', route);
    }
    const remaining = recoveryDeadline === undefined ? undefined : Math.ceil(recoveryDeadline - performance.now());
    if (remaining !== undefined && remaining <= 0) {
      throw Object.assign(new Error(connectionTimeout), { roomcastTimeout: true, campusSkipReason: 'recovery-budget' });
    }
    return connectAttempt(room, route, remaining, trace, attemptSignal, remote => {
      if (attemptSignal.aborted) return false;
      if (!selected) {
        selected = route;
        room.remote = remote;
        controllers[other].abort();
      }
      return selected === route;
    });
  }

  const ordinary = attempt('ordinary', 'native').catch(error => {
    if (!selected && !error.nativeRetryable) controllers.native.abort();
    releaseNative();
    throw error;
  });
  try {
    return await Promise.any([ordinary, attempt('native', 'ordinary')]);
  } catch (errors) {
    signal.throwIfAborted();
    const [ordinaryError, nativeError] = errors.errors;
    if (recoveryDeadline !== undefined && selected === 'ordinary' && ordinaryError.closedBeforeProof
      && ordinaryError.campusSkipReason !== 'auth-started') {
      // Opening the ordinary channel cancelled its competitor. If it closed
      // before the challenge, the remaining time still belongs to this join.
      const remaining = Math.ceil(recoveryDeadline - performance.now());
      if (remaining > 0) {
        trace.mark('fallback', 'started', 'native');
        return await connectAttempt(room, 'native', remaining, trace, signal);
      }
    }
    throw selected === 'ordinary' || (!selected && !ordinaryError.nativeRetryable) ? ordinaryError : nativeError;
  } finally {
    clearTimeout(timer);
    releaseNative();
  }
}

export async function connectGuestControl(room, timeout, trace = createJoinTrace('guest', 'initial'), signal = room.guestJoinController.signal) {
  const deadline = performance.now() + (timeout ?? PEER_AUTH_TOTAL_TIMEOUT_MS);
  try {
    if (room.nativeHost && nativeAvailable()) {
      if (!timeout || !room.lastControlNative) {
        return await connectDesktopControl(room, trace, signal, timeout ? deadline : undefined);
      }
      try { return await connectAttempt(room, 'native', Math.ceil(timeout / 2), trace, signal); }
      catch (error) {
        if (signal.aborted || error.campusSkipReason === 'auth-started' || signalingErrors.has(error.type)) throw error;
        timeout = Math.ceil(deadline - performance.now());
        if (timeout <= 0) throw error;
      }
    }
    return await connectAttempt(room, 'ordinary', timeout, trace, signal);
  } catch (firstError) {
    let error = firstError;
    const remaining = Math.ceil(deadline - performance.now());
    if (!timeout && !signal.aborted && firstError.closedBeforeProof && remaining > 0) {
      const route = firstError.closedBeforeProof;
      trace.mark('control', 'retrying', route, 'closed');
      try { return await connectAttempt(room, route, undefined, trace, signal, undefined, remaining); }
      catch (retryError) { error = retryError; }
    }
    let skip = '';
    if (signal.aborted) skip = room.closed ? 'closed' : 'superseded';
    else if (!room.campusSecret) skip = 'no-campus-invite';
    else if (!window.roomcast?.startCampusNetwork) skip = 'unsupported';
    else if (!error.campusRetryable) skip = error.campusSkipReason || 'not-retryable';
    else if (timeout && remaining <= 0) skip = 'recovery-budget';
    if (skip) {
      trace.mark('fallback', 'skipped', 'campus', skip);
      signal.throwIfAborted();
      throw error;
    }
    trace.mark('fallback', 'started', 'campus');
    return connectAttempt(room, 'campus', timeout ? remaining : undefined, trace, signal);
  }
}

function isInviteChallenge(data) {
  return data.authChallenge?.protocol === PEER_AUTH_PROTOCOL && data.authChallenge.mode === 'invite';
}

function watchAdmittedControl(room, remote, signal) {
  const pc = remote.peerConnection;
  if (!pc) return;
  let lastReachable = null;
  let timer = null;
  let probe = null;

  function reset() {
    clearTimeout(timer);
    timer = null;
    lastReachable = null;
    probe?.abort();
    probe = null;
  }

  function stop() {
    reset();
    pc.removeEventListener('iceconnectionstatechange', inspect);
    pc.removeEventListener('connectionstatechange', inspect);
    remote.off('close', stop);
    signal.removeEventListener('abort', stop);
  }

  function tick() {
    timer = null;
    inspect();
  }

  function inspect() {
    if (signal.aborted || room.closed || room.isHost || room.remote !== remote) return stop();
    if (room.pendingMigrationCommit || room.migrating) return reset();
    const states = [pc.iceConnectionState, pc.connectionState];
    const failed = states.includes('failed') || states.includes('closed');
    if (!failed && !states.includes('disconnected')) return reset();
    const now = performance.now();
    lastReachable ??= now;
    const remaining = lastReachable + CONTROL_DISCONNECT_GRACE_MS - now;
    if (failed || remaining <= 0) {
      stop();
      room.handleGuestClose(remote, { transportLoss: true });
      return;
    }
    if (timer !== null) return;
    if (!probe) {
      const attempt = new AbortController();
      probe = attempt;
      void room.request('room:ping', {}, {
        signal: attempt.signal,
        // Only a reply on this admitted channel renews the grace period.
        reply: result => {
          if (!attempt.signal.aborted && typeof result?.ok === 'boolean') lastReachable = performance.now();
        },
      }).catch(() => {}).finally(() => {
        if (probe === attempt) probe = null;
      });
    }
    timer = setTimeout(tick, Math.min(remaining, CONTROL_DISCONNECT_GRACE_MS / 2));
  }

  pc.addEventListener('iceconnectionstatechange', inspect);
  pc.addEventListener('connectionstatechange', inspect);
  remote.on('close', stop);
  signal.addEventListener('abort', stop, { once: true });
  // A recovery join installs the observers before its caller completes the handover.
  if (room.migrating) timer = setTimeout(tick, 0);
  else inspect();
}

// The established connection retains no listeners or nonce from the handshake.
function bindAuthenticatedRoom(room, remote, signal) {
  remote.on('data', data => {
    if (signal.aborted || room.remote !== remote || !data || typeof data !== 'object') return;
    if (isInviteChallenge(data)) { remote.close(); return; }
    if (data.authenticated !== true) room.handleGuestData(remote, data);
  });
  remote.on('close', () => { if (!signal.aborted) room.handleGuestClose(remote); });
}

async function connectAttempt(room, route, timeout, trace, signal, claim, handshakeBudget = timeout) {
  const campus = route === 'campus';
  const peer = room.peer;
  let remote;
  trace.mark('control', 'started', route);
  try {
    const campusRequest = campus ? await waitForRoomOperation(campusRequestProof(room), signal) : undefined;
    signal.throwIfAborted();
    const metadata = { protocol: PEER_AUTH_PROTOCOL, authMode: 'invite', repeatChallenge: true, joinAttemptId: trace.id,
      networkCapabilities: localNetworkCapabilities(), ...(campusRequest ? { campusRequest } : {}) };
    remote = route === 'native' ? openNativeControl(room, metadata) :
      peer.connect('roomcast-v1-' + room.roomId, { reliable: true, serialization: 'binary', metadata });
    if (!claim) room.remote = remote;
    if (campus) void prepareCampusConnection(room, remote.peerConnection);
    else if (route === 'ordinary') enableControlNatPrediction(remote.peerConnection, { role: 'guest', channel: remote.dataChannel, joinAttemptId: trace.id });
  } catch (error) {
    trace.mark('control', signal.aborted ? 'cancelled' : 'failed', route, error.type || 'setup');
    if (remote) {
      if (room.remote === remote) room.remote = null;
      remote.close();
    }
    throw error;
  }

  let resolveAuth, rejectAuth;
  const hostReady = new Promise((resolve, reject) => { resolveAuth = resolve; rejectAuth = reject; });
  let challenge = null;
  let pendingProof;
  let proofSent = false;
  let responseSeen = false;
  let authenticated = false;
  let awaitingAuthentication = false;
  let waiting = true;
  const clientNonce = randomPeerAuthNonce();
  const current = () => !signal.aborted && room.remote === remote;
  const failed = cause => {
    if (!waiting) return;
    waiting = false;
    recordFailure('join-connection', cause, { pc: remote.peerConnection, campus });
    const step = negotiationSteps[cause?.roomcastOperation];
    const error = new Error(cause?.type === 'webrtc'
      ? '房间连接协商失败' + (step ? '（' + step + '）' : '') + '，请重新加入。'
      : cause?.message || cause?.type || '房间连接已关闭', { cause });
    if (cause?.type) error.type = cause.type;
    if (cause?.closedBeforeProof) error.closedBeforeProof = route;
    rejectAuth(error);
  };
  const ended = () => {
    const cause = new Error('房间连接已关闭');
    cause.closedBeforeProof = !proofSent && !responseSeen && !campus;
    failed(cause);
  };
  const peerFailed = error => {
    const pc = error?.roomcastPeerConnection;
    if (error?.type === 'webrtc' && pc) {
      if (pc !== remote.peerConnection || (pc.signalingState === 'closed' && error.roomcastOperation !== 'prepareCampus')) return;
      // One rejected candidate is not a definitive ICE failure.
      if (error.roomcastOperation === 'addIceCandidate') return;
    }
    failed(error);
  };
  const invalid = message => { failed(new Error(message)); remote.close(); };
  const sendProof = () => {
    if (!pendingProof || !waiting || !current() || !remote.open) return;
    const proof = pendingProof;
    pendingProof = null;
    try {
      remote.send({ authProof: proof, authNonce: clientNonce });
        proofSent = true;
      trace.mark('authentication', 'proof-sent', route);
    } catch (error) { failed(error); }
  };
  const receive = data => {
    if (!waiting || signal.aborted || !data || typeof data !== 'object') return;
    if (claim && !claim(remote)) return;
    if (!current()) return;
    if (isInviteChallenge(data)) {
      awaitingAuthentication = true;
      if (data.authChallenge.roomId !== room.roomId) { invalid('P2P 鉴权挑战无效。'); return; }
      if (challenge) {
        if (challenge.nonce !== data.authChallenge.nonce) invalid('P2P 鉴权挑战无效。');
        return;
      }
      challenge = { protocol: PEER_AUTH_PROTOCOL, roomId: room.roomId, mode: 'invite', nonce: data.authChallenge.nonce };
      trace.mark('authentication', 'challenge', route);
      void createPeerAuthProof(room.inviteSecret, challenge).then(proof => {
        pendingProof = proof;
        sendProof();
      }).catch(failed);
    }
    if (data.authenticated === true) {
      awaitingAuthentication = true;
      if (responseSeen) return;
      if (!challenge) { invalid('P2P 鉴权状态无效。'); return; }
      responseSeen = true;
      void verifyPeerAuthProof(room.inviteSecret, { ...challenge, role: 'host', clientNonce }, data.hostProof).then(valid => {
        if (!waiting || !current() || !remote.open) return;
        if (!valid) { invalid('P2P 房主鉴权失败。'); return; }
        room.nativeHost = data.networkCapabilities?.features?.nativeUdpMux === true;
        setEnhancedIceRemote(remote.peerConnection, data.networkCapabilities);
        markControlAuthenticated(remote.peerConnection);
        remote.off('data', receive);
        bindAuthenticatedRoom(room, remote, signal);
        authenticated = true;
        waiting = false;
        trace.mark('authentication', 'verified', route);
        resolveAuth();
      }).catch(failed);
      return;
    }
  };
  const opened = () => {
    if (claim && !claim(remote)) return;
    if (!current()) return;
    awaitingAuthentication = true;
    trace.mark('control', 'channel-open', route);
    sendProof();
  };
  peer.on('error', peerFailed);
  remote.on('error', failed);
  remote.once('close', ended);
  remote.on('data', receive);
  if (remote.open) opened();
  else remote.once('open', opened);

  try {
    await withTimeout(hostReady, handshakeBudget || (campus ? 220_000 : PEER_AUTH_TOTAL_TIMEOUT_MS), connectionTimeout, signal);
    signal.throwIfAborted();
    return remote;
  } catch (error) {
    waiting = false;
    const type = error.type || error.message;
    let skip = '';
    if (signal.aborted) skip = room.closed ? 'closed' : 'superseded';
    else if (challenge || authenticated) skip = 'auth-started';
    else if (signalingErrors.has(type)) skip = type;
    error.nativeRetryable = !skip && !awaitingAuthentication;
    // EasyTier has a separate preparation cost during room recovery.
    if (!skip && timeout && error.type !== 'webrtc') skip = 'recovery-budget';
    error.campusRetryable = !skip;
    error.campusSkipReason = skip;
    const stage = awaitingAuthentication ? 'authentication' : signalingErrors.has(type) ? 'signaling' : 'control';
    trace.mark(stage, signal.aborted ? 'cancelled' : 'failed', route,
      error.roomcastTimeout ? 'deadline' : error.type || 'error');
    markControlFailure(remote.peerConnection, signal.aborted ? 'cancelled' : 'failed');
    if (!room.connected && room.remote === remote) room.remote = null;
    remote.close();
    throw error;
  } finally {
    peer.off('error', peerFailed);
    remote.off('data', receive);
    remote.off('error', failed);
    remote.off('close', ended);
    remote.off('open', opened);
  }
}
