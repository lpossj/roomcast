import {
  CAMPUS_ANSWER_TIMEOUT_MS, CAMPUS_LOCAL_TIMEOUT_MS, CAMPUS_TOTAL_TIMEOUT_MS,
  MEDIA_DISCONNECT_GRACE_MS, MEDIA_FIRST_FRAME_TIMEOUT_MS, P2P_CONNECT_TIMEOUT_MS,
} from './fallback-policy.js';
import { campusStatsRoute } from './campus-session.js';
import { observeEnhancedIceMedia } from './enhanced-ice.js';
import { createRoomcastPeerConnection, mediaIceServers } from './ice-policy.js';
import { recordLifecycle, recordReconnectPresentation } from './lifecycle-diagnostics.js';
import { createMediaRaceCoordinator } from './media-race-manager.js';
import { recordP2pNetworkStats } from './p2p-video-policy.js';
import { adaptivePlayoutTarget, MIN_PLAYOUT_BUFFER_MS } from './playout.js';
import { NativeScreenConnection } from './transports/native-screen-connection.js';
import { nativeAvailable } from './transports/native-endpoint.js';
import { createVdoScreenViewer } from './transports/vdo-screen-viewer.js';
import { screenReceiveCodecs } from './video-codec-policy.js';

const routeNames = { p2p: 'P2P', vdo: 'VDO', campus: 'EasyTier', native: '原生直连', turn: 'TURN' };
const stageNames = { local: '本机备用组件准备', answer: '共享者响应', ice: '媒体连接', frame: '首帧画面' };
const isDirectRoute = route => route === 'p2p' || route === 'vdo';

// One viewer watching one publication. Replacing its routes preserves the
// viewing registration and its recovery budget until the viewer leaves.
export function createScreenWatchSession({
  publisherId, startedAt, transport, iceServers, reportViewing, prepareNetwork,
  createFrameProbe, presentStream, onStatus, onMetrics,
}) {
  let closed = false;
  let generation = 0;
  let routes = null;
  let heartbeat;
  let preferredTried = false;
  let needsReconnect = false;
  const recovery = { iceRestartUsed: false, rebuildUsed: false };

  function stopRoutes(reason) {
    generation += 1;
    routes?.close(reason);
    routes = null;
  }

  function startRoutes(reason, failedRoute) {
    if (closed) return;
    stopRoutes(reason);
    onMetrics(null);
    if (!transport?.mediaP2P) {
      onStatus('failed', '当前房间没有可用的 WebRTC 屏幕传输。');
      return;
    }
    needsReconnect = false;
    onStatus('connecting');
    routes = createViewingRoutes({
      publisherId, startedAt, transport, iceServers, recovery, createFrameProbe, presentStream, onMetrics,
      manualReconnect: reason === 'manual-reconnect',
      onStatus(state, message) {
        needsReconnect = state === 'failed' || state === 'stalled';
        onStatus(state, message);
      },
      preferControlRoute: !preferredTried,
      markPreferred: () => { preferredTried = true; },
      retryDirect: () => startRoutes('control-route-failed'),
      tryOtherDirectRoute: failed => startRoutes('remaining-direct-route', failed),
      rebuild() {
        if (recovery.rebuildUsed) return false;
        recovery.rebuildUsed = true;
        recordLifecycle('playback-recovery', 'started');
        startRoutes('automatic-recovery');
        return true;
      },
    });
    routes.start(failedRoute);
  }

  function disconnected() {
    if (closed) return;
    stopRoutes('room-disconnected');
    needsReconnect = true;
    onStatus('failed', '房间连接已结束。');
  }

  function credentialChanged() {
    if (routes?.needsVdoCredentials()) startRoutes('credential-changed');
  }

  if (reportViewing) {
    void reportViewing(publisherId, 'view:start').catch(() => {});
    heartbeat = setInterval(() => {
      void reportViewing(publisherId, 'view:heartbeat').catch(() => {});
    }, 10_000);
  }
  transport?.on?.('disconnect', disconnected);
  transport?.on?.('room:credential', credentialChanged);
  startRoutes('entered');

  return {
    updateIceServers(next) {
      if (closed || iceServers === next) return;
      iceServers = next;
      startRoutes('ice-servers-changed');
    },
    async reconnect() {
      if (closed) return;
      stopRoutes('manual-reconnect');
      needsReconnect = false;
      onMetrics(null);
      onStatus('connecting');
      const previous = generation;
      try { await prepareNetwork?.(); } catch { /* Permission preparation is best effort. */ }
      if (closed || previous !== generation) return;
      recovery.iceRestartUsed = false;
      recovery.rebuildUsed = false;
      preferredTried = false;
      startRoutes('manual-reconnect');
    },
    async resume() {
      if (closed || !reportViewing) return;
      const previous = generation;
      try { await reportViewing(publisherId, 'view:start'); } catch { return; }
      if (!closed && previous === generation && needsReconnect) startRoutes('view-resumed');
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      transport?.off?.('disconnect', disconnected);
      transport?.off?.('room:credential', credentialChanged);
      stopRoutes('screen-player-disposed');
      if (reportViewing) void reportViewing(publisherId, 'view:stop').catch(() => {});
    },
  };
}

// Each race owns its connections, timers and pending answers. Async completions
// keep their original attempt even after the session starts another race.
function createViewingRoutes({
  publisherId, startedAt, transport, iceServers, recovery, createFrameProbe, presentStream, onStatus, onMetrics,
  rebuild, tryOtherDirectRoute, preferControlRoute, markPreferred, retryDirect, manualReconnect,
}) {
  const attempts = new Map();
  let closed = false;
  let active = null;
  let detachStream = null;
  let statsTimer;
  let preferredTimer;
  let preferredRoute;
  let controlRecheckDue = false;
  let lastSample = null;
  let lastNetworkSample = null;
  let bufferTargetMs = MIN_PLAYOUT_BUFFER_MS;

  const isAttemptOpen = attempt => !closed && !attempt.closed;

  function clearPlayback() {
    clearInterval(statsTimer);
    lastSample = null;
    lastNetworkSample = null;
    active = null;
    detachStream?.();
    detachStream = null;
  }

  function applyReceiverLatency(attempt) {
    // The native receiver reports the local Chromium/Go leg. Its jitter and
    // loss cannot set the network playout budget for the synchronized A/V pair.
    if (attempt.route === 'native') return;
    for (const receiver of attempt.receivers) {
      try {
        if ('jitterBufferTarget' in receiver) receiver.jitterBufferTarget = Math.round(bufferTargetMs);
        else if ('playoutDelayHint' in receiver) receiver.playoutDelayHint = bufferTargetMs / 1000;
      } catch {}
    }
  }

  function watchFrameProgress(attempt) {
    let progress = null;
    let lastTimestamp = -Infinity;
    let evidence = null;
    let probing = false;
    let nextProbeAt = 0;
    let stalled = false;

    function indicateStall() {
      if (stalled || !isAttemptOpen(attempt) || active !== attempt || attempt.observeFrames !== observe || attempt.restarting
        || attempt.pc?.connectionState !== 'connected') return;
      stalled = true;
      onStatus('stalled');
    }

    function observe(video, report) {
      const now = performance.now();
      const frames = video?.framesDecoded ?? video?.framesRendered;
      if (Number.isFinite(frames)) {
        if (video.id === progress?.id && video.timestamp < lastTimestamp) return;
        lastTimestamp = video.timestamp;
        if (!progress || video.id !== progress.id || frames !== progress.frames) {
          const advanced = video.id === progress?.id ? frames > progress.frames : frames > 0;
          progress = { id: video.id, frames, at: now, statsAt: video.timestamp };
          evidence = null;
          nextProbeAt = 0;
          if (stalled && advanced) {
            stalled = false;
            onStatus('live');
          }
          return;
        }
      }
      if (!progress?.frames || stalled || now - progress.at < MEDIA_DISCONNECT_GRACE_MS
        || attempt.restarting || attempt.pc?.connectionState !== 'connected') return;

      // Compare measurements taken *during* the quiet interval. A static
      // screen and a lost stream can both have zero decoded frames and bytes.
      const remote = video?.remoteId && report.get(video.remoteId);
      const sent = remote?.type === 'remote-outbound-rtp' && remote.timestamp >= progress.statsAt + MEDIA_DISCONNECT_GRACE_MS
        ? remote.bytesSent : undefined;
      const received = video?.framesReceived;
      if ((Number.isFinite(evidence?.received) && received > evidence.received)
        || (Number.isFinite(evidence?.sent) && remote?.id === evidence.remoteId && sent > evidence.sent)) {
        indicateStall();
        return;
      }
      evidence = { received, sent, remoteId: remote?.id };

      if (!attempt.resource || !transport.checkScreenFrames || probing || now < nextProbeAt) return;
      const checked = progress;
      nextProbeAt = now + MEDIA_DISCONNECT_GRACE_MS;
      probing = true;
      void transport.checkScreenFrames(publisherId, attempt.resource, attempt.controller.signal)
        .then(expected => {
          if (checked !== progress || !isAttemptOpen(attempt) || active !== attempt) return;
          if (expected) indicateStall();
          else if (expected == null) nextProbeAt = performance.now() + 60_000;
        }).finally(() => { probing = false; });
    }
    return observe;
  }

  async function readStats(attempt) {
    const pc = attempt.pc;
    if (!isAttemptOpen(attempt) || active !== attempt || !pc || pc.connectionState === 'closed') return;
    const afterRestartAnswer = attempt.restartNegotiated;
    const requestedAt = performance.now();
    const report = await pc.getStats();
    if (!isAttemptOpen(attempt) || active !== attempt) return;
    const sample = recordP2pNetworkStats(pc, report, 'viewer', null, attempt.route);
    const player = attempt.probe.element;
    if (player?.srcObject === attempt.media) {
      const quality = player.getVideoPlaybackQuality?.();
      sample.presentation = { mediaTime: player.currentTime, totalVideoFrames: quality?.totalVideoFrames ?? null,
        droppedVideoFrames: quality?.droppedVideoFrames ?? null, statsWaitMs: Math.round(performance.now() - requestedAt) };
    }
    observeEnhancedIceMedia(pc, report);

    let video, audio;
    report.forEach(item => {
      if (item.type !== 'inbound-rtp' || item.isRemote) return;
      if (item.kind === 'video') video = item;
      if (item.kind === 'audio') audio = item;
    });
    attempt.observeFrames(video, report);
    if (!video) return;
    if (afterRestartAnswer && attempt.restartNegotiated) {
      const baseline = attempt.restartSample;
      if (!baseline || baseline.id !== video.id) attempt.restartSample = video;
      else if (pc.connectionState === 'connected' && video.timestamp > baseline.timestamp && video.framesDecoded > baseline.framesDecoded
        && video.bytesReceived > baseline.bytesReceived) attempt.finishRestart?.(true);
    }

    const now = video.timestamp || performance.now();
    const previous = lastSample?.id === video.id && now > lastSample.at ? lastSample : null;
    const bitrate = previous ? Math.max(0, (video.bytesReceived - previous.bytes) * 8 / (now - previous.at)) : 0;
    lastSample = { id: video.id, at: now, bytes: video.bytesReceived || 0,
      framesDecoded: video.framesDecoded, totalDecodeTime: video.totalDecodeTime };
    const received = Number(video.packetsReceived || 0) + Number(audio?.packetsReceived || 0);
    const lost = Number(video.packetsLost || 0) + Number(audio?.packetsLost || 0);
    const receivedDelta = Math.max(0, received - (lastNetworkSample?.received ?? received));
    const lostDelta = Math.max(0, lost - (lastNetworkSample?.lost ?? lost));
    lastNetworkSample = { received, lost };
    const decodedFrames = video.framesDecoded - previous?.framesDecoded;
    const decodeTime = video.totalDecodeTime - previous?.totalDecodeTime;
    bufferTargetMs = adaptivePlayoutTarget(bufferTargetMs, {
      jitterMs: Math.max(Number(video.jitter || 0), Number(audio?.jitter || 0)) * 1000,
      decodeMs: decodedFrames > 0 && Number.isFinite(decodeTime) && decodeTime >= 0 ? decodeTime * 1000 / decodedFrames : 0,
      lossRate: lostDelta / Math.max(1, receivedDelta + lostDelta),
    });
    applyReceiverLatency(attempt);
    onMetrics({
      width: video.frameWidth || 0, height: video.frameHeight || 0,
      fps: video.framesPerSecond ?? (decodedFrames >= 0 ? decodedFrames * 1000 / (now - previous.at) : null),
      bitrate, lost: video.packetsLost || 0,
      codec: report.get(video.codecId)?.mimeType?.split('/')[1] || '检测中',
      route: campusStatsRoute(report, routeNames[attempt.route]), decoder: video.decoderImplementation || '',
    });
  }

  function finishStage(attempt, outcome) {
    if (!attempt.stage) return;
    recordLifecycle(`playback-${attempt.stage}`, outcome, performance.now() - attempt.stageStarted);
    attempt.stage = null;
    clearTimeout(attempt.deadlineTimer);
    clearTimeout(attempt.keyFrameTimer);
  }

  async function requestFirstKeyFrame(attempt) {
    if (!isAttemptOpen(attempt) || active || !attempt.resource || attempt.stage !== 'frame') return;
    const report = await attempt.pc.getStats();
    if (!isAttemptOpen(attempt) || active || attempt.stage !== 'frame') return;
    const waiting = [...report.values()].some(stat => stat.type === 'inbound-rtp' && stat.kind === 'video'
      && stat.bytesReceived > 0 && stat.framesDecoded === 0);
    if (waiting) await transport.checkScreenFrames?.(publisherId, attempt.resource, attempt.controller.signal, true);
  }

  function beginStage(attempt, requested) {
    if (!isAttemptOpen(attempt) || active === attempt) return;
    const stage = requested === 'ice' && attempt.pc?.connectionState === 'connected' ? 'frame' : requested;
    if (attempt.stage === stage || (attempt.stage === 'frame' && stage === 'ice')) return;
    finishStage(attempt, 'completed');
    attempt.stage = stage;
    attempt.stageStarted = performance.now();
    recordLifecycle(`playback-${stage}`, 'started');
    let duration = P2P_CONNECT_TIMEOUT_MS;
    if (stage === 'local') duration = CAMPUS_LOCAL_TIMEOUT_MS;
    if (stage === 'answer' && attempt.route === 'campus') duration = CAMPUS_ANSWER_TIMEOUT_MS;
    if (stage === 'frame') {
      duration = MEDIA_FIRST_FRAME_TIMEOUT_MS;
      if (attempt.route !== 'vdo') {
        attempt.keyFrameTimer = setTimeout(() => { void requestFirstKeyFrame(attempt).catch(() => {}); }, 1500);
      }
    }
    attempt.deadlineTimer = setTimeout(() => failAttempt(attempt, new Error(`${stageNames[stage]}超时。`)), duration);
  }

  function activateAttempt(attempt) {
    if (!isAttemptOpen(attempt) || !attempt.media.getVideoTracks().length) return;
    clearPlayback();
    active = attempt;
    finishStage(attempt, 'completed');
    clearTimeout(attempt.totalTimer);
    const receiver = attempt.receivers.find(item => item.track === attempt.media.getVideoTracks()[0]);
    const onPresented = manualReconnect && receiver?.getStats ? async frame => {
      try {
        const report = await receiver.getStats();
        if (!isAttemptOpen(attempt) || active !== attempt) return;
        const video = [...report.values()].find(stat => stat.type === 'inbound-rtp' && stat.kind === 'video');
        recordReconnectPresentation(race.generation, attempt.route, frame, video);
      } catch { /* Presentation continues when receiver statistics are unavailable. */ }
    } : undefined;
    detachStream = presentStream(attempt.media, onPresented, attempt.probe.element);
    attempt.probe.close(true);
    if (attempt.route === 'native') recordLifecycle('playback-native', 'completed');
    const settings = attempt.media.getVideoTracks()[0].getSettings?.();
    onMetrics({ width: settings?.width || 0, height: settings?.height || 0,
      route: attempt.route === 'campus' ? '路线检测中' : routeNames[attempt.route] });
    onStatus('live');
    attempt.observeFrames = watchFrameProgress(attempt);
    let sampling = false;
    attempt.sample = async () => {
      if (sampling) return;
      sampling = true;
      try { await readStats(attempt); } catch {} finally { sampling = false; }
    };
    void attempt.sample();
    statsTimer = setInterval(attempt.sample, 1000);
  }

  function closeAttempt(attempt, reason) {
    if (!attempt || attempt.closed) return;
    attempt.closed = true;
    clearTimeout(attempt.restartTimer);
    attempt.finishRestart?.(false);
    finishStage(attempt, 'cancelled');
    clearTimeout(attempt.totalTimer);
    clearTimeout(attempt.disconnectTimer);
    attempt.controller.abort(reason);
    attempt.probe?.close();
    if (attempt.viewer) {
      attempt.detachViewer?.();
      void attempt.viewer.close().catch(() => {});
    } else if (attempt.pc) {
      attempt.pc.ontrack = null;
      attempt.pc.onicecandidate = null;
      attempt.pc.onconnectionstatechange = null;
      if (attempt.route === 'p2p') attempt.pc.oniceconnectionstatechange = null;
      try { attempt.pc.close(); } catch {}
    }
    if (attempt.resource) void transport.closeScreen(publisherId, attempt.resource).catch(() => {});
  }

  async function restartIce(attempt, failure) {
    recovery.iceRestartUsed = true;
    attempt.restarting = true;
    recordLifecycle('playback-recovery', 'started');
    const restored = new Promise(resolve => {
      attempt.finishRestart = resolve;
      attempt.restartTimer = setTimeout(() => {
        attempt.controller.abort('restart-timeout');
        resolve(false);
      }, 12_000);
    });
    let recovered = false;
    try {
      recordLifecycle('playback-restart-answer', 'started');
      await transport.restartScreen(publisherId, attempt.pc, { signal: attempt.controller.signal });
      if (!isAttemptOpen(attempt)) return;
      recordLifecycle('playback-restart-answer', 'completed');
      attempt.restartNegotiated = true;
      void attempt.sample?.();
      recovered = await restored;
    } catch {
      recordLifecycle('playback-restart-answer', isAttemptOpen(attempt) ? 'failed' : 'cancelled');
      recovered = false;
    } finally {
      clearTimeout(attempt.restartTimer);
      attempt.restarting = false;
      attempt.restartNegotiated = false;
      attempt.restartSample = null;
      attempt.finishRestart = null;
    }
    if (!isAttemptOpen(attempt)) return;
    recordLifecycle('playback-recovery', recovered ? 'completed' : 'failed');
    if (!recovered) failAttempt(attempt, failure);
  }

  function startTurn() {
    const servers = transport.getTurnMediaIceServers?.() || [];
    if (servers.length) {
      onMetrics({ route: 'TURN连接中' });
      onStatus('connecting', preferredRoute === 'turn'
        ? '直连尚未出画，正在尝试 TURN 媒体连接…'
        : 'P2P 与 VDO 直连均不可用，正在尝试 TURN 中继…');
      startRoute('turn', servers);
    } else {
      onMetrics(null);
      onStatus('failed', 'P2P 与 VDO 直连均未建立可播放画面；TURN 未启用或不可用。');
    }
  }

  function currentPublication() {
    return transport.room?.streams?.find(stream => stream.memberId === publisherId && stream.startedAt === startedAt);
  }

  function startFallback(message) {
    const publication = currentPublication();
    if (!publication) return;
    if (publication.nativeCapable && nativeAvailable() && !attempts.has('native')) {
      onStatus('connecting', '正在尝试桌面原生直连…');
      recordLifecycle('playback-native', 'started');
      startRoute('native', []);
      return;
    }
    if (transport.canUseCampus?.()) {
      // Older hosts and publishers can omit this field.
      if (publication.campusCapable !== false) {
        onStatus('connecting', message);
        startRoute('campus', []);
        return;
      }
      recordLifecycle('playback-campus', 'skipped');
    }
    startTurn();
  }

  function failAttempt(attempt, failure) {
    if (!isAttemptOpen(attempt)) return;
    if (attempt.restarting) {
      // A new failure after the restart answer belongs to the recovered
      // transport, even if the next decoded-frame sample has not arrived.
      if (attempt.restartNegotiated) attempt.finishRestart?.(false);
      return;
    }
    const { route } = attempt;
    if (route === 'p2p' && active === attempt && !recovery.iceRestartUsed && attempt.pc.connectionState !== 'closed') {
      // Decoding can start while openScreen still owns the initial answer and
      // is draining trickled candidates. Serialize recovery behind that work.
      if (attempt.opening) {
        attempt.pendingFailure = failure;
        return;
      }
      if (transport.canRestartScreen?.(publisherId, attempt.pc)) {
        void restartIce(attempt, failure);
        return;
      }
    }
    finishStage(attempt, 'failed');
    if (!isDirectRoute(route)) {
      closeAttempt(attempt, 'turn-failed');
      if (active === attempt) clearPlayback();
      if (route === 'native') recordLifecycle('playback-native', 'failed');
      if (route === preferredRoute) retryDirect();
      else if (route === 'native') {
        startFallback('原生连接已结束，正在尝试备用路线…');
      } else if (route === 'campus') startTurn();
      else {
        onMetrics(null);
        onStatus('failed', failure?.message || 'TURN 中继未建立可播放画面。');
      }
      return;
    }

    const error = failure instanceof Error ? failure : new Error(String(failure || `${routeNames[route]} 连接失败。`));
    const result = race.markFailed(route, error);
    if (closed) return; // A failed winner may already have started a fresh race.
    closeAttempt(attempt, 'candidate-failed');
    if (result.state === 'racing' && !result.selectedRoute) {
      if (active === attempt) clearPlayback();
      onStatus('connecting', `${routeNames[route]} 路线中断，正在等待另一条直连路线…`);
    }
  }

  function connectionState(attempt) {
    const state = attempt.pc?.connectionState;
    if (attempt.route !== 'p2p' || state === 'closed' || state === 'failed') return state;
    const ice = attempt.pc?.iceConnectionState;
    return ice === 'failed' || ice === 'disconnected' ? ice : state;
  }

  function connectionChanged(attempt) {
    if (!isAttemptOpen(attempt)) return;
    const state = connectionState(attempt);
    if (state !== 'disconnected') {
      clearTimeout(attempt.disconnectTimer);
      attempt.disconnectTimer = null;
    }
    if (state === 'closed' || state === 'failed') {
      const message = attempt.route === 'p2p' ? 'P2P 屏幕连接失败。' : `${routeNames[attempt.route]} 媒体连接失败。`;
      failAttempt(attempt, new Error(message));
    } else if (state === 'connected') {
      beginStage(attempt, 'frame');
      attachConnectedStream(attempt);
    }
    else if (state === 'disconnected' && !attempt.disconnectTimer) {
      attempt.disconnectTimer = setTimeout(() => {
        attempt.disconnectTimer = null;
        if (connectionState(attempt) === 'disconnected') failAttempt(attempt, new Error('媒体连接持续中断。'));
      }, MEDIA_DISCONNECT_GRACE_MS);
    }
  }

  function receiveTrack(attempt, track) {
    if (!isAttemptOpen(attempt) || !track) return;
    if (track.kind === 'audio') {
      attempt.audioTrack = track;
      if (track.muted) {
        // A receive transceiver can exist with no audio source. Let video
        // start, then join the same playing stream when audio becomes live.
        track.addEventListener('unmute', () => {
          if (attempt.audioTrack === track) receiveTrack(attempt, track);
        }, { once: true, signal: attempt.controller.signal });
        return;
      }
    }
    if (attempt.route === 'vdo') {
      for (const old of attempt.media.getTracks()) {
        if (old.kind === track.kind && old.id !== track.id) attempt.media.removeTrack(old);
      }
    }
    if (!attempt.media.getTracks().some(existing => existing.id === track.id)) attempt.media.addTrack(track);
    attachConnectedStream(attempt);
  }

  function attachConnectedStream(attempt) {
    if (!isAttemptOpen(attempt) || !attempt.pc || connectionState(attempt) !== 'connected') return;
    if (attempt.route !== 'vdo' && !attempt.resource) return;
    if (!attempt.media.getVideoTracks().length) return;
    attempt.probe.attach(attempt.media);
    if (attempt.hasImage) confirmPlayable(attempt);
  }

  function confirmPlayable(attempt) {
    if (!isAttemptOpen(attempt) || attempt.playable || connectionState(attempt) !== 'connected') return;
    const track = attempt.media.getVideoTracks()[0];
    if (!track || track.readyState === 'ended') return;
    attempt.playable = true;
    if (isDirectRoute(attempt.route)) race.markPlayable(attempt.route, attempt);
    else activateAttempt(attempt);
  }

  async function connectPeer(attempt, servers) {
    const { route, controller: { signal } } = attempt;
    const options = { iceServers: servers, targetLatency: 'lowest' };
    if (route !== 'p2p') options.iceTransportPolicy = 'relay';
    const pc = route === 'native' || (route === 'p2p' && window.roomcast?.physicalDirect)
      ? new NativeScreenConnection(true) : createRoomcastPeerConnection(options);
    attempt.pc = pc;
    const video = pc.addTransceiver('video', { direction: 'recvonly' });
    const audio = pc.addTransceiver('audio', { direction: 'recvonly' });
    attempt.receivers = [video.receiver, audio.receiver];
    applyReceiverLatency(attempt);
    try {
      const codecs = RTCRtpReceiver.getCapabilities('video')?.codecs || [];
      if (codecs.length) video.setCodecPreferences(await screenReceiveCodecs(codecs, currentPublication()?.settings));
    } catch {}
    if (!isAttemptOpen(attempt)) return;
    pc.ontrack = event => receiveTrack(attempt, event.track);
    pc.onconnectionstatechange = () => connectionChanged(attempt);
    if (route === 'p2p') pc.oniceconnectionstatechange = pc.onconnectionstatechange;
    attempt.opening = true;
    let answer;
    try {
      answer = await transport.openScreen(publisherId, pc, {
        route, signal, onStage: stage => beginStage(attempt, stage),
        onSession: (session, publisherRelayed) => {
          attempt.resource = session;
          attempt.publisherRelayed = publisherRelayed;
          attachConnectedStream(attempt);
        },
      });
    } finally {
      attempt.opening = false;
    }
    if (!isAttemptOpen(attempt) || signal.aborted) {
      if (answer?.session && attempt.resource !== answer.session) void transport.closeScreen(publisherId, answer.session).catch(() => {});
      return;
    }
    attempt.resource = answer.session;
    attachConnectedStream(attempt);
    if (route === 'p2p' && controlRecheckDue && preferControlRoute && !active && transport.guestCoordinator?.(publisherId)) {
      void tryControlRoute(true);
    }
    if (attempt.pendingFailure) {
      const failure = attempt.pendingFailure;
      attempt.pendingFailure = null;
      failAttempt(attempt, failure);
    }
  }

  async function connectVdo(attempt) {
    if (window.roomcast?.physicalDirect) throw new Error('当前使用物理网卡直连。');
    const signal = attempt.controller.signal;
    const descriptor = await transport.requestVdoScreen(publisherId, { signal });
    if (!isAttemptOpen(attempt)) return;
    const viewer = createVdoScreenViewer(descriptor, { label: 'Roomcast' });
    attempt.viewer = viewer;
    const onTrack = event => receiveTrack(attempt, event.detail?.track);
    const onFailure = event => failAttempt(attempt, new Error(event.detail?.reason || 'VDO 备用连接失败。'));
    const onConnection = () => connectionChanged(attempt);
    viewer.addEventListener('track', onTrack);
    viewer.addEventListener('connectionfailed', onFailure);
    attempt.detachViewer = () => {
      viewer.removeEventListener('track', onTrack);
      viewer.removeEventListener('connectionfailed', onFailure);
      attempt.pc?.removeEventListener('connectionstatechange', onConnection);
    };
    const pc = await viewer.start({ signal });
    if (!isAttemptOpen(attempt)) {
      await viewer.close().catch(() => {});
      return;
    }
    attempt.pc = pc;
    attempt.receivers = pc.getReceivers?.() || [];
    applyReceiverLatency(attempt);
    pc.addEventListener('connectionstatechange', onConnection);
    onConnection();
  }

  function startRoute(route, servers) {
    if (closed || attempts.has(route)) return;
    const attempt = { route, controller: new AbortController(), receivers: [], closed: false };
    attempts.set(route, attempt);
    try {
      attempt.media = new MediaStream();
      attempt.probe = createFrameProbe(() => {
        attempt.hasImage = true;
        confirmPlayable(attempt);
      });
      if (!isDirectRoute(route)) {
        attempt.totalTimer = setTimeout(() => failAttempt(attempt, new Error(`${routeNames[route]} 连接超时。`)),
          route === 'campus' ? CAMPUS_TOTAL_TIMEOUT_MS : P2P_CONNECT_TIMEOUT_MS);
      }
      const connecting = route === 'vdo' ? connectVdo(attempt) : connectPeer(attempt, servers);
      void connecting.catch(error => {
        if (!attempt.controller.signal.aborted) failAttempt(attempt, error);
      });
    } catch (error) { failAttempt(attempt, error); }
  }

  const race = createMediaRaceCoordinator({
    timeoutMs: P2P_CONNECT_TIMEOUT_MS,
    startVdo: () => startRoute('vdo'),
    onSelected: ({ payload }) => activateAttempt(payload),
    cleanup: (route, reason) => closeAttempt(attempts.get(route), reason),
    onExhausted() {
      if (closed) return;
      clearPlayback();
      startFallback('普通直连未建立画面，正在尝试 EasyTier…');
    },
    onWinnerFailed({ route, routes }) {
      if (closed || rebuild()) return;
      clearPlayback();
      const publication = currentPublication();
      if (!publication) return;
      const desktopFallback = transport.canUseCampus?.() || nativeAvailable();
      const other = route === 'p2p' ? 'vdo' : 'p2p';
      // A stable winner can retire a healthy competitor. Older publications
      // keep their existing fallback order on desktop-capable viewers.
      if (routes[other].failedAt === null && (!desktopFallback || typeof publication.campusCapable === 'boolean')) {
        tryOtherDirectRoute(route);
        return;
      }
      if (desktopFallback && !attempts.has('campus') && !attempts.has('native')) {
        closeAttempt(attempts.get('p2p'), 'direct-lost');
        closeAttempt(attempts.get('vdo'), 'direct-lost');
        startFallback('普通直连已中断，正在尝试 EasyTier…');
      } else onStatus('failed', `${routeNames[route]} 媒体连接已中断，请重新连接。`);
    },
  });

  async function tryControlRoute(lastCheck) {
    if (closed || active || race.state !== 'racing') return;
    if (!lastCheck) preferredTimer = setTimeout(() => { void tryControlRoute(true); }, 2500);
    else controlRecheckDue = true;
    const control = transport.memberControl?.(publisherId);
    const publication = transport.room?.streams?.find(stream => stream.memberId === publisherId && stream.startedAt === startedAt);
    if (!publication) return;

    let route;
    if (control?.open) {
      if (control.roomcastNative && publication.nativeCapable && nativeAvailable()) route = 'native';
      else if (transport.getTurnMediaIceServers?.().length
        && await transport.controlUsesTurnRelay(publisherId).catch(() => false)) route = 'turn';
      if (!control.open || transport.memberControl(publisherId) !== control) return;
    } else {
      // Guests signal through the owner. Require a direct media answer from
      // this publisher before using either control hop as a scheduling hint.
      const owner = transport.guestCoordinator?.(publisherId);
      const direct = attempts.get('p2p');
      if (!owner || !direct?.resource || direct.closed || !transport.getTurnMediaIceServers?.().length) return;
      if (!direct.publisherRelayed && !(await transport.controlUsesTurnRelay(owner.id).catch(() => false))) return;
      if (transport.guestCoordinator(publisherId)?.id !== owner.id || direct.closed
        || !['new', 'checking'].includes(direct.pc?.iceConnectionState)) return;
      route = 'turn';
    }
    if (closed || active || race.state !== 'racing'
      || !transport.room?.streams?.some(stream => stream.memberId === publisherId && stream.startedAt === startedAt)) return;
    const receiving = [...attempts.values()].some(attempt => !attempt.closed
      && (attempt.pc?.connectionState === 'connected' || attempt.media?.getVideoTracks().some(track => !track.muted)));
    if (receiving) return;
    if (!route || (route === 'turn' && !transport.getTurnMediaIceServers().length)) return;
    clearTimeout(preferredTimer);
    preferredRoute = route;
    markPreferred();
    race.close('authenticated-control-route');
    if (route === 'native') {
      recordLifecycle('playback-native', 'started');
      onStatus('connecting', '正在通过原生直连连接共享者…');
      startRoute(route, []);
    } else startTurn();
  }

  return {
    start(failedRoute) {
      race.start();
      if (failedRoute) race.markFailed(failedRoute);
      if (failedRoute !== 'p2p') startRoute('p2p', mediaIceServers(iceServers));
      if (preferControlRoute && !failedRoute) {
        preferredTimer = setTimeout(() => { void tryControlRoute(false); }, 1500);
      }
    },
    needsVdoCredentials() {
      // A closed VDO attempt can still need the replacement credential.
      return !closed && !attempts.has('native') && !attempts.has('campus') && !attempts.has('turn') && active?.route !== 'p2p' && attempts.has('vdo');
    },
    close(reason) {
      if (closed) return;
      closed = true;
      clearTimeout(preferredTimer);
      race.close(reason);
      clearPlayback();
      for (const attempt of attempts.values()) closeAttempt(attempt, reason);
    },
  };
}
