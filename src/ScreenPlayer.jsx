import { AppWindow, Expand, LoaderCircle, Minimize, Radio, RefreshCw, Volume2, VolumeX } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { P2P_CONNECT_TIMEOUT_MS, MEDIA_FIRST_FRAME_TIMEOUT_MS, MEDIA_DISCONNECT_GRACE_MS,
  CAMPUS_LOCAL_TIMEOUT_MS, CAMPUS_ANSWER_TIMEOUT_MS, CAMPUS_TOTAL_TIMEOUT_MS, watchPlayableFrame } from './fallback-policy.js';
import { recordLifecycle } from './lifecycle-diagnostics.js';
import { createMediaRaceCoordinator } from './media-race-manager.js';
import { FULLSCREEN_ELEMENT, FULLSCREEN_VIDEO, pickFullscreenMode } from './fullscreen-policy.js';
import { campusStatsRoute } from './campus-session.js';
import { createVdoScreenViewer } from './transports/vdo-screen-viewer.js';
import { createRoomcastPeerConnection, mediaIceServers } from './ice-policy.js';
import { selectScreenPlayback } from './local-preview.js';
import { adaptivePlayoutTarget, MIN_PLAYOUT_BUFFER_MS } from './playout.js';
import { loadPreference, savePreference } from './preferences.js';
import { playSound } from './sounds.js';
import { openFloatingPlayer } from './floating-player.js';
import { recordP2pNetworkStats } from './p2p-video-policy.js';
import { playerInfo } from './player-info.js';
import { preferH264High } from './video-codec-policy.js';
import Avatar from './Avatar.jsx';

export const FULLSCREEN_UI_HIDE_DELAY = 2000;
const readPlaybackVolume = () => {
  const value = Number(loadPreference('playbackVolume', 0.5));
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5;
};

const emptyMetrics = {
  width: 0, height: 0, fps: 0, bitrate: 0, codec: '检测中',
  route: '连接中',
  lost: 0, decoder: '', encoder: ''
};

export default function ScreenPlayer({ stream, iceServers, outputDeviceId, viewerMemberId, deafened, masterVolume = 1, initialSound = false, transport, reportViewing, initiallyEntered = false, onViewingChange }) {
  const videoRef = useRef(null);
  const containerRef = useRef(null);
  const streamViewRef = useRef(null);
  const [state, setState] = useState('idle');
  const [error, setError] = useState('');
  const [sound, setSound] = useState(initialSound);
  const [volume, setVolume] = useState(readPlaybackVolume);
  const [retry, setRetry] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const viewingReported = useRef(false);
  const viewingAuthorization = useRef(Promise.resolve());
  const playbackGeneration = useRef(0);
  const automaticRecoveryUsed = useRef(false);
  const uiTimer = useRef(null);
  const interaction = useRef({ inside: false, hover: false, pointer: false, focus: false });
  const wasFullscreen = useRef(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const playback = selectScreenPlayback({
    viewerMemberId,
    publisherMemberId: stream.memberId,
    localStream: transport?.screenStream,
  });
  const own = playback.isSelf;

  // 是否真正进入这个共享
  const [entered, setEntered] = useState(() => initiallyEntered);
  useEffect(() => { automaticRecoveryUsed.current = false; }, [entered, stream.memberId, transport]);
  const [windowMode, setWindowMode] = useState('MAIN');
  const floating = windowMode !== 'MAIN';
  const floatingPlayer = useRef(null);
  const clearLegacySize = () => {
    const node = streamViewRef.current;
    for (const key of ['width', 'height', 'left', 'top']) node?.style.removeProperty(key);
  };
  useEffect(() => { const video = videoRef.current; if (video?.setSinkId) video.setSinkId(outputDeviceId || 'default').catch(() => { }); }, [outputDeviceId]);
  useEffect(() => { if (videoRef.current) videoRef.current.volume = volume * masterVolume; savePreference('playbackVolume', volume); }, [volume, masterVolume]);
  useEffect(() => { clearLegacySize(); return () => { floatingPlayer.current?.close(); floatingPlayer.current = null; }; }, []);
  useEffect(() => { if (!entered) { floatingPlayer.current?.close(); floatingPlayer.current = null; } }, [entered]);
  useEffect(() => {
    if (window.roomcast?.desktop || !entered || own || !reportViewing) return undefined;
    const resume = () => {
      if (document.visibilityState !== 'visible') return;
      videoRef.current?.play().catch(() => { });
      void reportViewing(stream.memberId, 'view:start').then(() => setRetry(value => value + 1)).catch(() => { });
    };
    document.addEventListener('visibilitychange', resume);
    return () => document.removeEventListener('visibilitychange', resume);
  }, [entered, own, reportViewing, stream.memberId]);
  useEffect(() => {
    floatingPlayer.current?.updateAudio?.({
      soundAvailable: !own && !deafened,
      soundEnabled: sound && !deafened && !own,
      volume,
    });
  }, [sound, volume, deafened, own]);
  const [metrics, setMetrics] = useState(emptyMetrics);
  useEffect(() => {
    // Register viewing intent while this viewer is actively watching the share.
    if (own || !reportViewing || !entered) {
      if (viewingReported.current) { viewingReported.current = false; reportViewing(stream.memberId, 'view:stop').catch(() => { }); }
      return undefined;
    }
    if (!viewingReported.current) {
      viewingReported.current = true;
      viewingAuthorization.current = reportViewing(stream.memberId, 'view:start').catch(error => ({ ok: false, error: error.message }));
    }
    const heartbeat = setInterval(() => reportViewing(stream.memberId, 'view:heartbeat').catch(() => { }), 10_000);
    return () => { clearInterval(heartbeat); if (viewingReported.current) { viewingReported.current = false; reportViewing(stream.memberId, 'view:stop').catch(() => { }); } };
  }, [entered, own, reportViewing, stream.memberId]);

  useEffect(() => {
    const changed = () => {
      const next = document.fullscreenElement === containerRef.current;
      clearUiTimer();
      interaction.current.pointer = false;
      setFullscreen(next);
      setControlsVisible(true);
      if (!next && wasFullscreen.current) window.roomcast?.finishFullscreen?.().catch(() => { });
      wasFullscreen.current = next;
    };
    document.addEventListener('fullscreenchange', changed);
    return () => document.removeEventListener('fullscreenchange', changed);
  }, []);

  const clearUiTimer = () => { clearTimeout(uiTimer.current); uiTimer.current = null; };
  const canHideUi = () => !floating && entered && state === 'live' && !interaction.current.pointer && !interaction.current.hover && !interaction.current.focus;
  const armUiHide = () => {
    clearUiTimer(); setControlsVisible(true);
    if (!floating && entered && state === 'live') uiTimer.current = setTimeout(() => { if (canHideUi()) setControlsVisible(false); }, FULLSCREEN_UI_HIDE_DELAY);
  };
  useEffect(() => {
    if (floating || !entered || state !== 'live') { clearUiTimer(); setControlsVisible(true); return undefined; }
    armUiHide();
    return clearUiTimer;
  }, [floating, fullscreen, entered, state]);

  useEffect(() => {
    const generation = ++playbackGeneration.current;
    if (!entered) { setState('idle'); setError(''); setMetrics(emptyMetrics); return; }
    if (playback.mode === 'local-stream') {
      const local = transport.screenStream;
      let lastSample;
      const update = async () => {
        const track = local.getVideoTracks()[0];
        const value = track?.getSettings?.() || {};
        let bytes = 0, outbound, codec;
        const routes = new Set();
        const sessions = [...(transport.screenSessions?.values?.() || [])];
        for (const { pc } of sessions) {
          const report = await pc.getStats().catch(() => null);
          if (report) routes.add(campusStatsRoute(report));
          report?.forEach(item => {
            if (item.type === 'outbound-rtp' && item.kind === 'video') { bytes += item.bytesSent || 0; if (!outbound) { outbound = item; codec = report.get(item.codecId); } }
          });
        }
        if (playbackGeneration.current !== generation) return;
        const now = performance.now();
        const bitrate = lastSample && now > lastSample.at ? Math.max(0, (bytes - lastSample.bytes) * 8 / (now - lastSample.at)) : 0;
        lastSample = { at: now, bytes };
        // Without a viewer there is no outbound-rtp report, so the numbers fall back to the
        // capture settings. `source` keeps those two meanings from being confused.
        setMetrics({ ...emptyMetrics, source: outbound ? 'outbound' : 'capture', viewers: sessions.length, width: outbound?.frameWidth || videoRef.current?.videoWidth || value.width || 0, height: outbound?.frameHeight || videoRef.current?.videoHeight || value.height || 0, fps: outbound?.framesPerSecond || value.frameRate || 0, bitrate, codec: codec?.mimeType?.split('/')[1] || 'H.264 优先', route: [...routes].join(' / ') || '本机预览', encoder: outbound?.encoderImplementation || '' });
      };
      setSound(false); setState('live'); setError('');
      if (videoRef.current) { videoRef.current.srcObject = local; videoRef.current.play().catch(() => { }); }
      update().catch(() => { }); const statsTimer = setInterval(() => update().catch(() => { }), 1000);
      return () => { playbackGeneration.current += 1; clearInterval(statsTimer); if (videoRef.current?.srcObject === local) videoRef.current.srcObject = null; };
    }
    if (playback.mode === 'unavailable') {
      setSound(false); setState('failed'); setError('本机预览暂不可用；不会改用公网 P2P 或 TURN。'); setMetrics(emptyMetrics);
      return undefined;
    }
    if (!transport?.mediaP2P) {
      setSound(false); setState('failed'); setError('当前房间没有可用的 WebRTC 屏幕传输。'); setMetrics(emptyMetrics);
      return undefined;
    }
    let disposed = false;
    let statsTimer = null;
    let lastSample = null;
    let lastNetworkSample = null;
    let bufferTargetMs = MIN_PLAYOUT_BUFFER_MS;
    let activeAttempt = null;
    let activeRoute = null;

    const attempts = new Map();
    const isCurrent = value => !disposed && playbackGeneration.current === value;

    // Reconnecting replaces the transport, not the viewer's sound preference.
    setState('connecting');
    setError('');
    setMetrics(emptyMetrics);

    const routeText = route => (
      route === 'campus'
        ? 'EasyTier'
        : route === 'vdo'
        ? 'VDO'
        : route === 'turn'
          ? 'TURN'
          : 'P2P'
    );

    const clearStats = () => {
      clearInterval(statsTimer);
      statsTimer = null;
      lastSample = null;
      lastNetworkSample = null;
    };

    const applyReceiverLatency = receivers => {
      for (const receiver of receivers || []) {
        try {
          if ('jitterBufferTarget' in receiver) {
            receiver.jitterBufferTarget = Math.round(bufferTargetMs);
          }
        } catch { }

        try {
          if ('playoutDelayHint' in receiver) {
            receiver.playoutDelayHint = bufferTargetMs / 1000;
          }
        } catch { }
      }
    };

    const readStats = async attempt => {
      const current = attempt?.pc;

      if (
        !isCurrent(generation)
        || !attempt
        || attempt.closed
        || activeAttempt !== attempt
        || !current
        || current.connectionState === 'closed'
      ) {
        return;
      }

      const report = await current.getStats();

      if (
        !isCurrent(generation)
        || activeAttempt !== attempt
        || attempt.closed
      ) {
        return;
      }

      let inbound;
      recordP2pNetworkStats(current, report, 'viewer', null, attempt.route);
      let audioInbound;
      let codec;

      report.forEach(item => {
        if (
          item.type === 'inbound-rtp'
          && item.kind === 'video'
          && !item.isRemote
        ) {
          inbound = item;
        }

        if (
          item.type === 'inbound-rtp'
          && item.kind === 'audio'
          && !item.isRemote
        ) {
          audioInbound = item;
        }
      });

      if (!inbound) return;

      codec = report.get(inbound.codecId);

      const now =
        inbound.timestamp
        || performance.now();

      const previousSample = lastSample?.id === inbound.id && now > lastSample.at
        ? lastSample : null;

      const bitrate =
        previousSample
          ? Math.max(
            0,
            (
              inbound.bytesReceived
              - previousSample.bytes
            ) * 8 / (
              now - previousSample.at
            ),
          )
          : 0;

      lastSample = {
        id: inbound.id,
        at: now,
        framesDecoded: inbound.framesDecoded,
        totalDecodeTime: inbound.totalDecodeTime,
        bytes:
          inbound.bytesReceived
          || 0,
      };

      const networkSample = {
        received:
          Number(
            inbound.packetsReceived
            || 0,
          )
          + Number(
            audioInbound
              ?.packetsReceived
            || 0,
          ),

        lost:
          Number(
            inbound.packetsLost
            || 0,
          )
          + Number(
            audioInbound
              ?.packetsLost
            || 0,
          ),
      };

      const receivedDelta =
        Math.max(
          0,
          networkSample.received
          - Number(
            lastNetworkSample
              ?.received
            ?? networkSample.received,
          ),
        );

      const lostDelta =
        Math.max(
          0,
          networkSample.lost
          - Number(
            lastNetworkSample
              ?.lost
            ?? networkSample.lost,
          ),
        );

      const lossRate =
        lostDelta
        / Math.max(
          1,
          receivedDelta
          + lostDelta,
        );

      lastNetworkSample =
        networkSample;

      const jitterMs =
        Math.max(
          Number(
            inbound.jitter
            || 0,
          ),
          Number(
            audioInbound
              ?.jitter
            || 0,
          ),
        ) * 1000;

      // Use recent decode cost: a session-wide average retains old stalls and
      // hides new decoder pressure. Ignore absent/reset counters or no new frames.
      const decodedFrames = inbound.framesDecoded - previousSample?.framesDecoded;
      const decodeTime = inbound.totalDecodeTime - previousSample?.totalDecodeTime;
      const decodeMs = decodedFrames > 0 && Number.isFinite(decodeTime) && decodeTime >= 0
        ? decodeTime * 1000 / decodedFrames : 0;

      bufferTargetMs =
        adaptivePlayoutTarget(
          bufferTargetMs,
          {
            jitterMs,
            decodeMs,
            lossRate,
          },
        );

      applyReceiverLatency(
        attempt.receivers,
      );

      setMetrics({
        width:
          inbound.frameWidth
          || videoRef.current
            ?.videoWidth
          || 0,

        height:
          inbound.frameHeight
          || videoRef.current
            ?.videoHeight
          || 0,

        fps:
          inbound.framesPerSecond
          || 0,

        bitrate,

        codec:
          codec?.mimeType
            ?.split('/')[1]
          || '检测中',

        route:
          campusStatsRoute(report, routeText(attempt.route)),

        lost:
          inbound.packetsLost
          || 0,

        decoder:
          inbound
            .decoderImplementation
          || '',
      });
    };

    const startStats = attempt => {
      clearStats();
      readStats(attempt)
        .catch(() => { });

      statsTimer =
        setInterval(
          () => readStats(attempt)
            .catch(() => { }),
          1000,
        );
    };

    const finishStage = (attempt, phase) => {
      if (!attempt?.stage) return;
      recordLifecycle(`playback-${attempt.stage}`, phase, performance.now() - attempt.stageStarted);
      attempt.stage = null;
      clearTimeout(attempt.deadlineTimer);
      attempt.deadlineTimer = null;
    };

    const beginStage = (attempt, requestedStage) => {
      if (!isCurrent(generation) || attempt.closed || activeAttempt === attempt) return;
      const stage = requestedStage === 'ice' && attempt.pc?.connectionState === 'connected' ? 'frame' : requestedStage;
      if (attempt.stage === stage || (attempt.stage === 'frame' && stage === 'ice')) return;
      finishStage(attempt, 'completed');
      attempt.stage = stage;
      attempt.stageStarted = performance.now();
      recordLifecycle(`playback-${stage}`, 'started');
      const duration = stage === 'local' ? CAMPUS_LOCAL_TIMEOUT_MS
        : stage === 'answer' ? (attempt.route === 'campus' ? CAMPUS_ANSWER_TIMEOUT_MS : P2P_CONNECT_TIMEOUT_MS)
          : stage === 'frame' ? MEDIA_FIRST_FRAME_TIMEOUT_MS : P2P_CONNECT_TIMEOUT_MS;
      attempt.deadlineTimer = setTimeout(() => {
        if (!isCurrent(generation) || attempt.closed) return;
        const label = { local: '本机备用组件准备', answer: '共享者响应', ice: '媒体连接', frame: '首帧画面' }[stage];
        const failure = new Error(`${label}超时。`);
        if (attempt.route === 'p2p' || attempt.route === 'vdo') markFailed(attempt.route, failure);
        else markTurnFailed(failure, attempt.route);
      }, duration);
    };

    const observeConnection = attempt => {
      if (!isCurrent(generation) || attempt.closed) return;
      const connectionState = attempt.pc?.connectionState;
      if (connectionState !== 'disconnected') {
        clearTimeout(attempt.disconnectTimer);
        attempt.disconnectTimer = null;
      }
      if (connectionState === 'connected') beginStage(attempt, 'frame');
      if (connectionState === 'disconnected' && !attempt.disconnectTimer) {
        attempt.disconnectTimer = setTimeout(() => {
          attempt.disconnectTimer = null;
          if (!isCurrent(generation) || attempt.closed || attempt.pc?.connectionState !== 'disconnected') return;
          const failure = new Error('媒体连接持续中断。');
          if (attempt.route === 'p2p' || attempt.route === 'vdo') markFailed(attempt.route, failure);
          else markTurnFailed(failure, attempt.route);
        }, MEDIA_DISCONNECT_GRACE_MS);
      }
    };

    const activateAttempt = (
      route,
      attempt,
    ) => {
      if (
        !isCurrent(generation)
        || !attempt
        || attempt.closed
        || !attempt.media
          ?.getVideoTracks()
          ?.length
      ) {
        return false;
      }

      activeAttempt =
        attempt;

      activeRoute =
        route;

      finishStage(attempt, 'completed');
      clearTimeout(attempt.totalTimer);
      attempt.totalTimer = null;

      attempt.candidate.pause();
      attempt.candidate.srcObject =
        null;

      attempt.cancelFrame?.();
      attempt.cancelFrame = null;

      clearTimeout(
        attempt.deadlineTimer,
      );
      attempt.deadlineTimer = null;

      if (
        videoRef.current
      ) {
        videoRef.current.srcObject =
          attempt.media;

        videoRef.current
          .play()
          .catch(() => { });
      }

      setMetrics({
        ...emptyMetrics,
        width:
          attempt.media
            .getVideoTracks()[0]
            ?.getSettings?.()
            ?.width
          || 0,

        height:
          attempt.media
            .getVideoTracks()[0]
            ?.getSettings?.()
            ?.height
          || 0,

        route:
          route === 'campus' ? '路线检测中' : routeText(route),
      });

      setState('live');
      setError('');
      startStats(attempt);

      return true;
    };

    const makeAttempt = route => {
      const candidate =
        document.createElement(
          'video',
        );

      candidate.muted = true;
      candidate.playsInline = true;

      const attempt = {
        route,
        candidate,
        media:
          new MediaStream(),
        controller:
          new AbortController(),
        pc: null,
        resource: null,
        viewer: null,
        receivers: [],
        cancelFrame: null,
        deadlineTimer: null,
        totalTimer: null,
        disconnectTimer: null,
        stage: null,
        stageStarted: 0,
        connectionListener: null,
        closed: false,
      };

      attempts.set(
        route,
        attempt,
      );

      return attempt;
    };

    const closeAttempt = (
      route,
      reason = 'closed',
    ) => {
      const attempt =
        attempts.get(route);

      if (
        !attempt
        || attempt.closed
      ) {
        return;
      }

      attempt.closed = true;
      finishStage(attempt, 'cancelled');
      clearTimeout(attempt.totalTimer);
      clearTimeout(attempt.disconnectTimer);
      attempt.controller.abort(
        reason,
      );

      attempt.cancelFrame?.();
      attempt.cancelFrame = null;

      clearTimeout(
        attempt.deadlineTimer,
      );
      attempt.deadlineTimer = null;

      attempt.candidate.pause();
      attempt.candidate.srcObject =
        null;

      if (
        attempt.connectionListener
        && attempt.pc
      ) {
        attempt.pc
          .removeEventListener?.(
            'connectionstatechange',
            attempt.connectionListener,
          );
      }

      if (
        [
          'p2p',
          'turn',
          'campus',
        ].includes(route)
        && attempt.pc
      ) {
        attempt.pc.ontrack = null;
        attempt.pc
          .onconnectionstatechange =
          null;

        try {
          attempt.pc.close();
        } catch { }
      }

      if (
        [
          'p2p',
          'turn',
          'campus',
        ].includes(route)
        && attempt.resource
      ) {
        const resource =
          attempt.resource;

        attempt.resource = null;

        transport.closeScreen(
          stream.memberId,
          resource,
        ).catch(() => { });
      }

      if (
        route === 'vdo'
        && attempt.viewer
      ) {
        attempt.viewerCleanup?.();
        attempt.viewerCleanup = null;

        void attempt.viewer
          .close()
          .catch(() => { });

        attempt.viewer = null;
      }

      if (
        videoRef.current
          ?.srcObject
        === attempt.media
        && activeAttempt
          !== attempt
      ) {
        videoRef.current.srcObject =
          null;
      }
    };

    const closeAllAttempts = (
      reason = 'closed',
    ) => {
      clearStats();

      const visible =
        videoRef.current;

      if (
        visible
        && [
          ...attempts.values(),
        ].some(
          attempt => (
            visible.srcObject
            === attempt.media
          ),
        )
      ) {
        visible.srcObject =
          null;
      }

      activeAttempt = null;
      activeRoute = null;

      closeAttempt(
        'p2p',
        reason,
      );

      closeAttempt(
        'vdo',
        reason,
      );

      closeAttempt(
        'turn',
        reason,
      );
      closeAttempt('campus', reason);
    };

    let turnStarted = false;
    let campusStarted = false;

    const markTurnFailed = (
      failure,
      route = 'turn',
    ) => {
      const attempt =
        attempts.get(route);

      if (
        !isCurrent(generation)
        || !attempt
        || attempt.closed
      ) {
        return;
      }

      finishStage(attempt, 'failed');
      closeAttempt(route, 'turn-failed');

      if (
        activeRoute === route
      ) {
        activeAttempt = null;
        activeRoute = null;
        clearStats();

        if (
          videoRef.current
        ) {
          videoRef.current.srcObject =
            null;
        }
      }

      if (route === 'campus') { startTurnFallback(); return; }

      setMetrics(
        emptyMetrics,
      );

      setState('failed');
      setError(
        failure?.message
        || 'TURN 中继未建立可播放画面。',
      );
    };

    const startTurnFallback = () => {
      if (!isCurrent(generation)) return;
      const turnServers =
        transport
          .getTurnMediaIceServers
          ?.()
        || [];

      if (
        turnServers.length
      ) {
        setMetrics({
          ...emptyMetrics,
          route:
            'TURN连接中',
        });

        setState('connecting');
        setError(
          'P2P 与 VDO 直连均不可用，正在尝试 TURN 中继…',
        );

        void connectTurn(
          turnServers,
        );

        return;
      }

      setMetrics(
        emptyMetrics,
      );

      setState('failed');
      setError(
        'P2P 与 VDO 直连均未建立可播放画面；TURN 未启用或不可用。',
      );
    };

    let race;

    const markFailed = (
      route,
      failure,
    ) => {
      const attempt =
        attempts.get(route);

      if (
        !isCurrent(generation)
        || !attempt
        || attempt.closed
      ) {
        return;
      }

      const message =
        failure?.message
        || String(failure || '');

      finishStage(attempt, 'failed');
      const result =
        race.markFailed(
          route,
          failure
            instanceof Error
            ? failure
            : new Error(
              message
              || `${routeText(route)} 连接失败。`,
            ),
        );

      closeAttempt(
        route,
        'candidate-failed',
      );

      if (
        result.state === 'racing'
        && !result.selectedRoute
      ) {
        if (
          activeRoute === route
        ) {
          activeAttempt = null;
          activeRoute = null;
          clearStats();

          if (
            videoRef.current
          ) {
            videoRef.current.srcObject =
              null;
          }
        }

        setState('connecting');
        setError(
          `${routeText(route)} 路线中断，正在等待另一条直连路线…`,
        );
      }
    };

    race =
      createMediaRaceCoordinator({
        timeoutMs:
          P2P_CONNECT_TIMEOUT_MS,

        startVdo: () => {
          if (!isCurrent(generation)) return;
          return connectVdo().catch(failure => markFailed('vdo', failure));
        },

        onSelected:
          snapshot => {
            if (
              !isCurrent(generation)
            ) {
              return;
            }

            activateAttempt(
              snapshot.route,
              snapshot.payload,
            );
          },

        onStable:
          snapshot => {
            if (
              !isCurrent(generation)
              || activeRoute
              !== snapshot.route
            ) {
              return;
            }

            // The manager has already closed the loser through cleanup().
            // Keep the selected route as the only active media path.
          },

        onExhausted:
          () => {
            if (
              !isCurrent(generation)
            ) {
              return;
            }

            activeAttempt = null;
            activeRoute = null;
            clearStats();

            if (
              videoRef.current
            ) {
              videoRef.current.srcObject =
                null;
            }

            if (transport.canUseCampus?.()) {
              setState('connecting');
              setError('普通直连未建立画面，正在尝试 EasyTier…');
              void connectTurn([], 'campus');
            } else startTurnFallback();
          },

        onWinnerFailed:
          snapshot => {
            if (
              !isCurrent(generation)
            ) {
              return;
            }

            const route =
              snapshot.route
              || activeRoute;

            if (!automaticRecoveryUsed.current) {
              automaticRecoveryUsed.current = true;
              recordLifecycle('playback-recovery', 'started');
              closeAllAttempts('automatic-recovery');
              setRetry(value => value + 1);
              return;
            }

            activeAttempt = null;
            activeRoute = null;
            clearStats();

            if (
              videoRef.current
            ) {
              videoRef.current.srcObject =
                null;
            }

            if (transport.canUseCampus?.() && !campusStarted) {
              closeAttempt('p2p', 'direct-lost');
              closeAttempt('vdo', 'direct-lost');
              setState('connecting');
              setError('普通直连已中断，正在尝试 EasyTier…');
              void connectTurn([], 'campus');
              return;
            }
            setState('failed');
            setError(
              `${routeText(route)} 媒体连接已中断，请重新连接。`,
            );
          },

        cleanup:
          (
            route,
            reason,
          ) => {
            closeAttempt(
              route,
              reason,
            );
          },
      });

    const armPlayableProbe =
      attempt => {
        attempt.cancelFrame =
          watchPlayableFrame(
            attempt.candidate,
            () => {
              if (
                !isCurrent(generation)
                || attempt.closed
              ) {
                return;
              }

              race.markPlayable(
                attempt.route,
                attempt,
              );
            },
          );
      };

    const connectP2P =
      async () => {
        const attempt =
          makeAttempt('p2p');

        const signal =
          attempt.controller.signal;

        armPlayableProbe(
          attempt,
        );

        const pc =
          createRoomcastPeerConnection({
            iceServers:
              mediaIceServers(
                iceServers,
              ),

            targetLatency:
              'lowest',
          });

        attempt.pc = pc;

        const video =
          pc.addTransceiver(
            'video',
            {
              direction:
                'recvonly',
            },
          );

        const audio =
          pc.addTransceiver(
            'audio',
            {
              direction:
                'recvonly',
            },
          );

        attempt.receivers = [
          video.receiver,
          audio.receiver,
        ];

        applyReceiverLatency(
          attempt.receivers,
        );

        try {
          const codecs =
            RTCRtpReceiver
              .getCapabilities(
                'video',
              )
              ?.codecs
            || [];

          if (codecs.length) {
            video.setCodecPreferences(preferH264High(codecs));
          }
        } catch { }

        pc.ontrack =
          event => {
            if (
              !isCurrent(generation)
              || attempt.closed
              || attempt.pc
              !== pc
            ) {
              return;
            }

            if (
              !attempt.media
                .getTracks()
                .some(
                  track => (
                    track.id
                    === event.track.id
                  ),
                )
            ) {
              attempt.media
                .addTrack(
                  event.track,
                );
            }

            if (
              attempt.candidate
                .srcObject
              !== attempt.media
            ) {
              attempt.candidate
                .srcObject =
                attempt.media;

              attempt.candidate
                .play()
                .catch(() => { });
            }
          };

        pc.onconnectionstatechange =
          () => {
            if (
              !isCurrent(generation)
              || attempt.closed
              || attempt.pc
              !== pc
            ) {
              return;
            }

            if (
              [
                'failed',
                'closed',
              ].includes(
                pc.connectionState,
              )
            ) {
              markFailed(
                'p2p',
                new Error(
                  'P2P 屏幕连接失败。',
                ),
              );
            }
            observeConnection(attempt);
          };

        try {
          const answer =
            await transport
              .openScreen(
                stream.memberId,
                pc,
                {
                  signal,
                  onStage: stage => beginStage(attempt, stage),
                },
              );

          if (
            !isCurrent(generation)
            || signal.aborted
            || attempt.closed
            || attempt.pc
              !== pc
          ) {
            if (
              answer?.session
            ) {
              transport.closeScreen(
                stream.memberId,
                answer.session,
              ).catch(() => { });
            }

            return;
          }

          attempt.resource =
            answer.session;
        } catch (failure) {
          if (
            !isCurrent(generation)
            || signal.aborted
            || attempt.closed
          ) {
            return;
          }

          markFailed(
            'p2p',
            failure,
          );
        }
      };

    const connectVdo =
      async () => {
        const attempt =
          makeAttempt('vdo');

        const signal =
          attempt.controller.signal;

        armPlayableProbe(
          attempt,
        );

        try {
          const descriptor =
            await transport
              .requestVdoScreen(
                stream.memberId,
                {
                  signal,
                },
              );

          if (
            !isCurrent(generation)
            || signal.aborted
            || attempt.closed
          ) {
            return;
          }

          const viewer =
            createVdoScreenViewer(
              descriptor,
              {
                label:
                  'Roomcast',
              },
            );

          attempt.viewer =
            viewer;

          const onTrack =
            event => {
              if (
                !isCurrent(generation)
                || attempt.closed
                || attempt.viewer
                !== viewer
              ) {
                return;
              }

              const track =
                event?.detail
                  ?.track;

              if (!track) return;

              for (
                const current
                of attempt.media
                  .getTracks()
              ) {
                if (
                  current.kind
                  === track.kind
                  && current.id
                  !== track.id
                ) {
                  attempt.media
                    .removeTrack(
                      current,
                    );
                }
              }

              if (
                !attempt.media
                  .getTracks()
                  .some(
                    current => (
                      current.id
                      === track.id
                    ),
                  )
              ) {
                attempt.media
                  .addTrack(
                    track,
                  );
              }

              if (
                attempt.candidate
                  .srcObject
                !== attempt.media
              ) {
                attempt.candidate
                  .srcObject =
                  attempt.media;

                attempt.candidate
                  .play()
                  .catch(() => { });
              }
            };

          const onConnectionFailed =
            event => {
              if (
                attempt.closed
              ) {
                return;
              }

              markFailed(
                'vdo',
                new Error(
                  event?.detail
                    ?.reason
                  || 'VDO 备用连接失败。',
                ),
              );
            };

          viewer.addEventListener(
            'track',
            onTrack,
          );

          viewer.addEventListener(
            'connectionfailed',
            onConnectionFailed,
          );

          attempt.viewerCleanup =
            () => {
              viewer.removeEventListener(
                'track',
                onTrack,
              );

              viewer.removeEventListener(
                'connectionfailed',
                onConnectionFailed,
              );
            };

          const pc =
            await viewer.start({
              signal,
            });

          if (
            !isCurrent(generation)
            || signal.aborted
            || attempt.closed
            || attempt.viewer
              !== viewer
          ) {
            await viewer
              .close()
              .catch(() => { });

            return;
          }

          attempt.pc = pc;

          attempt.receivers =
            pc?.getReceivers?.()
            || [];

          applyReceiverLatency(
            attempt.receivers,
          );

          const stateChanged =
            () => {
              if (
                !isCurrent(generation)
                || attempt.closed
                || attempt.pc
                !== pc
              ) {
                return;
              }

              if (
                [
                  'failed',
                  'closed',
                ].includes(
                  pc.connectionState,
                )
              ) {
                markFailed(
                  'vdo',
                  new Error(
                    'VDO 媒体连接失败。',
                  ),
                );
              }
              observeConnection(attempt);
            };

          attempt.connectionListener =
            stateChanged;

          pc?.addEventListener?.(
            'connectionstatechange',
            stateChanged,
          );

          stateChanged();
        } catch (failure) {
          if (
            !isCurrent(generation)
            || signal.aborted
            || attempt.closed
          ) {
            return;
          }

          markFailed(
            'vdo',
            failure,
          );
        }
      };

    const connectTurn =
      async (turnServers, route = 'turn') => {
        if (
          (route === 'campus' ? campusStarted : turnStarted)
          || !isCurrent(generation)
        ) {
          return;
        }

        if (route === 'campus') campusStarted = true; else turnStarted = true;

        const attempt =
          makeAttempt(route);

        const signal =
          attempt.controller.signal;

        attempt.cancelFrame =
          watchPlayableFrame(
            attempt.candidate,
            () => {
              if (
                !isCurrent(generation)
                || attempt.closed
              ) {
                return;
              }

              activateAttempt(
                route,
                attempt,
              );
            },
          );

        attempt.totalTimer =
          setTimeout(
            () => {
              markTurnFailed(
                new Error(
                  `${routeText(route)} 连接超时。`,
                ),
                route,
              );
            },
            route === 'campus' ? CAMPUS_TOTAL_TIMEOUT_MS : P2P_CONNECT_TIMEOUT_MS,
          );

        const pc =
          createRoomcastPeerConnection({
            iceServers:
              turnServers,

            iceTransportPolicy:
              'relay',

            targetLatency:
              'lowest',
          });

        attempt.pc = pc;

        const video =
          pc.addTransceiver(
            'video',
            {
              direction:
                'recvonly',
            },
          );

        const audio =
          pc.addTransceiver(
            'audio',
            {
              direction:
                'recvonly',
            },
          );

        attempt.receivers = [
          video.receiver,
          audio.receiver,
        ];

        applyReceiverLatency(
          attempt.receivers,
        );

        try {
          const codecs =
            RTCRtpReceiver
              .getCapabilities(
                'video',
              )
              ?.codecs
            || [];

          if (codecs.length) {
            video.setCodecPreferences(preferH264High(codecs));
          }
        } catch { }

        pc.ontrack =
          event => {
            if (
              !isCurrent(generation)
              || attempt.closed
              || attempt.pc
              !== pc
            ) {
              return;
            }

            if (
              !attempt.media
                .getTracks()
                .some(
                  track => (
                    track.id
                    === event.track.id
                  ),
                )
            ) {
              attempt.media
                .addTrack(
                  event.track,
                );
            }

            if (
              attempt.candidate
                .srcObject
              !== attempt.media
            ) {
              attempt.candidate
                .srcObject =
                attempt.media;

              attempt.candidate
                .play()
                .catch(() => { });
            }
          };

        pc.onconnectionstatechange =
          () => {
            if (
              !isCurrent(generation)
              || attempt.closed
              || attempt.pc
              !== pc
            ) {
              return;
            }

            if (
              [
                'failed',
                'closed',
              ].includes(
                pc.connectionState,
              )
            ) {
              markTurnFailed(
                new Error(
                  `${routeText(route)} 媒体连接失败。`,
                ),
                route,
              );
            }
            observeConnection(attempt);
          };

        try {
          const answer =
            await transport
              .openScreen(
                stream.memberId,
                pc,
                {
                  signal,
                  route,
                  onStage: stage => beginStage(attempt, stage),
                },
              );

          if (
            !isCurrent(generation)
            || signal.aborted
            || attempt.closed
            || attempt.pc
              !== pc
          ) {
            if (
              answer?.session
            ) {
              transport.closeScreen(
                stream.memberId,
                answer.session,
              ).catch(() => { });
            }

            return;
          }

          attempt.resource =
            answer.session;
        } catch (failure) {
          if (
            !isCurrent(generation)
            || signal.aborted
            || attempt.closed
          ) {
            return;
          }

          markTurnFailed(
            failure,
            route,
          );
        }
      };

    // P2P starts immediately; the coordinator starts VDO after 3s or P2P failure.
    // TURN remains gated on exhaustion of both direct routes.
    race.start();
    void connectP2P().catch(failure => markFailed('p2p', failure));

    const disconnected = () => {
      if (
        !isCurrent(generation)
      ) {
        return;
      }

      disposed = true;
      playbackGeneration.current += 1;

      race.close(
        'room-disconnected',
      );

      closeAllAttempts(
        'room-disconnected',
      );

      setState('failed');
      setError(
        '房间连接已结束。',
      );
    };

    const credentialChanged = () => {
      // Native P2P and the EasyTier/TURN fallback keep their current connection. Only a
      // VDO viewer (including a pending contender) needs fresh credentials.
      // The old VDO connection may fail before the control-channel update
      // arrives. Its closed attempt must still be eligible for recovery.
      if (isCurrent(generation) && !campusStarted && !turnStarted && activeRoute !== 'p2p'
        && attempts.has('vdo')) setRetry(value => value + 1);
    };
    transport.on?.('room:credential', credentialChanged);
    transport.on?.(
      'disconnect',
      disconnected,
    );

    return () => {
      disposed = true;
      playbackGeneration.current += 1;

      transport.off?.(
        'disconnect',
        disconnected,
      );
      transport.off?.('room:credential', credentialChanged);

      race.close(
        'screen-player-disposed',
      );

      closeAllAttempts(
        'screen-player-disposed',
      );
    };
  }, [entered, stream.memberId, iceServers, retry, transport, playback.mode, own]);

  const info = playerInfo(metrics);
  const avatarColor = Number.isInteger(stream.avatarColor) && stream.avatarColor >= 0 && stream.avatarColor < 10 ? stream.avatarColor : 0;
  const floatingInfo = () => ({
    title: stream.name,
    avatarColor,
    viewers: stream.viewers || [],
    lines: [
      `${info.resolution} · ${info.fps} · ${info.bitrate}`,
      info.route,
    ],
  });
  useEffect(() => {
    if (floating) floatingPlayer.current?.updateInfo?.(floatingInfo());
  }, [floating, stream.name, stream.viewers, avatarColor, info.resolution, info.fps, info.bitrate, info.route]);
  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) { await document.exitFullscreen(); return; }
      floatingPlayer.current?.close();
      clearUiTimer();
      setControlsVisible(true);
      const container = containerRef.current;
      const video = videoRef.current;
      const mode = pickFullscreenMode({
        elementFullscreen: typeof container?.requestFullscreen === 'function',
        videoFullscreen: typeof video?.webkitEnterFullscreen === 'function',
      });
      if (mode === FULLSCREEN_ELEMENT) {
        await window.roomcast?.prepareFullscreen?.();
        await container.requestFullscreen();
        return;
      }
      // iPhone Safari implements no element fullscreen API; the native video player is the
      // only route, and it reports through webkit events instead of fullscreenchange.
      if (mode === FULLSCREEN_VIDEO) {
        const left = () => { video.removeEventListener('webkitendfullscreen', left); setFullscreen(false); setControlsVisible(true); };
        video.addEventListener('webkitbeginfullscreen', () => { setFullscreen(true); setControlsVisible(true); }, { once: true });
        video.addEventListener('webkitendfullscreen', left);
        video.webkitEnterFullscreen();
        return;
      }
      throw new Error('当前浏览器不支持全屏播放。');
    } catch (failure) { setError(`无法切换全屏：${failure.message}`); }
  };
  const toggleWindowMode = async () => {
    if (floatingPlayer.current) { floatingPlayer.current.close(); return; }
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      clearLegacySize();
      floatingPlayer.current = openFloatingPlayer(videoRef.current, {
        title: stream.name,
        soundAvailable: !own && !deafened,
        soundEnabled: sound && !deafened && !own,
        volume,
        info: floatingInfo(),
        onState: mode => { setWindowMode(mode); if (mode === 'MAIN') { floatingPlayer.current = null; clearLegacySize(); } },
        onSound: enabled => {
          if (own || deafened) return;
          setSound(enabled);
          if (enabled) videoRef.current?.play().catch(() => { });
        },
        onVolume: value => {
          setVolume(value);
          if (value > 0 && !own && !deafened) setSound(true);
        },
      });
    } catch (failure) { setError(`无法打开桌面浮窗：${failure.message}`); }
  };
  const showUi = () => {
    armUiHide();
  };
  const pointerEntered = event => {
    interaction.current.inside = true;
    const overControls = Boolean(event.target.closest?.('.player-controls, .exit-view-button'));
    interaction.current.hover = overControls;
    showUi();
  };
  const pointerLeft = event => {
    if (event.relatedTarget?.nodeType && containerRef.current?.contains(event.relatedTarget)) return;
    interaction.current.inside = false;
    interaction.current.hover = false;
    armUiHide();
  };
  const controlPointerDown = () => {
    interaction.current.pointer = true; clearUiTimer(); setControlsVisible(true);
    const released = () => { interaction.current.pointer = false; document.removeEventListener('pointerup', released); armUiHide(); };
    document.addEventListener('pointerup', released);
  };
  return <div ref={streamViewRef} className="stream-view" data-window-mode={windowMode}>
    <div
      className={`screen-player ${entered ? '' : 'awaiting-entry'} ${controlsVisible ? 'controls-visible' : 'controls-hidden'} ${floating ? 'detached-source' : ''}`}
      ref={containerRef}
      onPointerEnter={pointerEntered}
      onPointerMove={pointerEntered}
      onPointerLeave={pointerLeft}
      onFocusCapture={event => { interaction.current.focus = event.target.matches?.(':focus-visible') === true; showUi(); }}
      onBlurCapture={() => requestAnimationFrame(() => { interaction.current.focus = Boolean(containerRef.current?.contains(document.activeElement) && document.activeElement?.matches?.(':focus-visible')); showUi(); })}
    >
      {!floating && <div className={`stream-parameter-bar player-info-overlay avatar-color-${avatarColor}`}>
        <strong title={stream.name}>{stream.name}</strong>
        <span>{info.resolution} · {info.fps} · {info.bitrate}</span>
        <span>{info.route}</span>
      </div>}

      <div className="player-stage">
        <video ref={videoRef} autoPlay={state === 'live'} playsInline muted={!sound || deafened || own || state !== 'live'} />

        {floating ? (entered && state === 'live' && <div className="floating-detached-placeholder" aria-hidden="true"><AppWindow size={28} /><strong>画面已移至小窗</strong><span>关闭小窗后自动返回这里</span></div>) : <>
          {!entered ? <div className="player-loading"><Radio size={28} /><strong>{stream.name} 正在共享</strong><span>进入后才连接并播放画面</span><button className="button primary" onClick={() => { playSound('watch'); setEntered(true); onViewingChange?.(stream.memberId, true); }}>点击进入共享</button></div> : state !== 'live' && <div className="player-loading"><LoaderCircle className="spin" size={28} /><strong>连接共享画面</strong><span>{error || '正在建立低延迟 P2P 画面…'}</span><button className="text-button" onClick={() => setRetry(value => value + 1)}><RefreshCw size={14} />重新连接</button></div>}
          <div className="player-top" onPointerEnter={showUi} onPointerLeave={showUi}>
            {(stream.viewers || []).length > 0 &&
              <div className="viewer-avatars">
                {(stream.viewers || []).map(viewer =>
                  <Avatar
                    key={viewer.memberId}
                    member={viewer}
                    className="viewer-avatar"
                    title={viewer.name}
                    aria-label={viewer.name}
                  />
                )}
              </div>
            }
          </div>
          {entered && <button className="button small exit-view-button" onPointerDown={controlPointerDown} onClick={() => {
            setEntered(false);
            onViewingChange?.(stream.memberId, false);
            if (document.fullscreenElement === containerRef.current) document.exitFullscreen().catch(() => { });
          }}>退出观看</button>}
          <div className="player-controls" onPointerEnter={() => { interaction.current.hover = true; showUi(); }} onPointerLeave={() => { interaction.current.hover = false; armUiHide(); }} onPointerDown={controlPointerDown}><div>{!own && <><button aria-label={sound ? '关闭共享声音' : '播放共享声音'} title={sound ? '关闭共享声音' : '播放共享声音'} onClick={() => { setSound(value => !value); videoRef.current?.play().catch(() => { }); }}>{sound && !deafened && volume > 0 ? <Volume2 size={18} /> : <VolumeX size={18} />}</button><label className="player-volume" title={`音量 ${Math.round(volume * 100)}%`}><input aria-label="共享音量" type="range" min="0" max="1" step="0.01" value={volume} onChange={event => { const next = Number(event.target.value); setVolume(next); if (next > 0) setSound(true); }} /><span>{Math.round(volume * 100)}%</span></label></>}{window.roomcast?.desktop && <button title="窗口模式" aria-label="窗口模式" onClick={toggleWindowMode}><AppWindow size={18} /></button>}<button title={fullscreen ? '退出全屏' : '全屏'} aria-label={fullscreen ? '退出全屏' : '全屏'} onClick={toggleFullscreen}>{fullscreen ? <Minimize size={18} /> : <Expand size={18} />}</button></div></div>
        </>}
      </div>
    </div>
  </div>;
}
