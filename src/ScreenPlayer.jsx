import { AppWindow, Expand, LoaderCircle, Minimize, Radio, RefreshCw, Volume2, VolumeX } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { P2P_CONNECT_TIMEOUT_MS, watchPlayableFrame } from './fallback-policy.js';
import { createMediaRaceCoordinator } from './media-race-manager.js';
import { createVdoScreenViewer } from './transports/vdo-screen-viewer.js';
import { createRoomcastPeerConnection, mediaIceServers } from './ice-policy.js';
import { selectScreenPlayback } from './local-preview.js';
import { adaptivePlayoutTarget, MIN_PLAYOUT_BUFFER_MS } from './playout.js';
import { loadPreference, savePreference } from './preferences.js';
import { playSound } from './sounds.js';
import { openFloatingPlayer } from './floating-player.js';
import { recordP2pNetworkStats } from './p2p-video-policy.js';

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

export default function ScreenPlayer({ stream, iceServers, outputDeviceId, viewerMemberId, deafened, transport, reportViewing, initiallyEntered = false, onViewingChange }) {
  const videoRef = useRef(null);
  const containerRef = useRef(null);
  const streamViewRef = useRef(null);
  const [state, setState] = useState('idle');
  const [error, setError] = useState('');
  const [sound, setSound] = useState(false);
  const [volume, setVolume] = useState(readPlaybackVolume);
  const [retry, setRetry] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const viewingReported = useRef(false);
  const viewingAuthorization = useRef(Promise.resolve());
  const playbackGeneration = useRef(0);
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
  const [windowMode, setWindowMode] = useState('MAIN');
  const floating = windowMode !== 'MAIN';
  const floatingPlayer = useRef(null);
  const clearLegacySize = () => {
    const node = streamViewRef.current;
    for (const key of ['width', 'height', 'left', 'top']) node?.style.removeProperty(key);
  };
  useEffect(() => { const video = videoRef.current; if (video?.setSinkId) video.setSinkId(outputDeviceId || 'default').catch(() => { }); }, [outputDeviceId]);
  useEffect(() => { if (videoRef.current) videoRef.current.volume = volume; savePreference('playbackVolume', volume); }, [volume]);
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
  const canHideUi = () => !floating && entered && state === 'live' && !interaction.current.pointer;
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
        const sessions = [...(transport.screenSessions?.values?.() || [])];
        for (const { pc } of sessions) {
          const report = await pc.getStats().catch(() => null);
          report?.forEach(item => {
            if (item.type === 'outbound-rtp' && item.kind === 'video') { bytes += item.bytesSent || 0; if (!outbound) { outbound = item; codec = report.get(item.codecId); } }
          });
        }
        if (playbackGeneration.current !== generation) return;
        const now = performance.now();
        const bitrate = lastSample && now > lastSample.at ? Math.max(0, (bytes - lastSample.bytes) * 8 / (now - lastSample.at)) : 0;
        lastSample = { at: now, bytes };
        setMetrics({ ...emptyMetrics, width: outbound?.frameWidth || videoRef.current?.videoWidth || value.width || 0, height: outbound?.frameHeight || videoRef.current?.videoHeight || value.height || 0, fps: outbound?.framesPerSecond || value.frameRate || 0, bitrate, codec: codec?.mimeType?.split('/')[1] || 'H.264 优先', route: 'P2P直连', encoder: outbound?.encoderImplementation || '' });
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

    setSound(false);
    setState('connecting');
    setError('');
    setMetrics(emptyMetrics);

    const routeText = route => (
      route === 'vdo'
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
      if (attempt.route === 'p2p') recordP2pNetworkStats(current, report, 'viewer');
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

      const bitrate =
        lastSample
        && now > lastSample.at
          ? Math.max(
            0,
            (
              inbound.bytesReceived
              - lastSample.bytes
            ) * 8 / (
              now - lastSample.at
            ),
          )
          : 0;

      lastSample = {
        at: now,
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

      const decodeMs =
        inbound.framesDecoded
          ? (
            Number(
              inbound.totalDecodeTime
              || 0,
            )
            * 1000
            / Number(
              inbound.framesDecoded,
            )
          )
          : 0;

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
          routeText(
            attempt.route,
          ),

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
          routeText(route),
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
    };

    let turnStarted = false;

    const markTurnFailed = (
      failure,
    ) => {
      const attempt =
        attempts.get('turn');

      if (
        !isCurrent(generation)
        || !attempt
        || attempt.closed
      ) {
        return;
      }

      closeAttempt(
        'turn',
        'turn-failed',
      );

      if (
        activeRoute === 'turn'
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

      setMetrics(
        emptyMetrics,
      );

      setState('failed');
      setError(
        failure?.message
        || 'TURN 中继未建立可播放画面。',
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

            activeAttempt = null;
            activeRoute = null;
            clearStats();

            if (
              videoRef.current
            ) {
              videoRef.current.srcObject =
                null;
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

          const h264 =
            codecs.filter(
              codec => (
                codec.mimeType
                  .toLowerCase()
                === 'video/h264'
              ),
            );

          if (h264.length) {
            video.setCodecPreferences([
              ...h264,
              ...codecs.filter(
                codec => (
                  !h264.includes(
                    codec,
                  )
                ),
              ),
            ]);
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
          };

        try {
          const answer =
            await transport
              .openScreen(
                stream.memberId,
                pc,
                {
                  signal,
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
      async turnServers => {
        if (
          turnStarted
          || !isCurrent(generation)
        ) {
          return;
        }

        turnStarted = true;

        const attempt =
          makeAttempt('turn');

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
                'turn',
                attempt,
              );
            },
          );

        attempt.deadlineTimer =
          setTimeout(
            () => {
              markTurnFailed(
                new Error(
                  'TURN 中继连接超时。',
                ),
              );
            },
            P2P_CONNECT_TIMEOUT_MS,
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

          const h264 =
            codecs.filter(
              codec => (
                codec.mimeType
                  .toLowerCase()
                === 'video/h264'
              ),
            );

          if (h264.length) {
            video.setCodecPreferences([
              ...h264,
              ...codecs.filter(
                codec => (
                  !h264.includes(
                    codec,
                  )
                ),
              ),
            ]);
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
                  'TURN 中继媒体连接失败。',
                ),
              );
            }
          };

        try {
          const answer =
            await transport
              .openScreen(
                stream.memberId,
                pc,
                {
                  signal,
                  route: 'turn',
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

      race.close(
        'screen-player-disposed',
      );

      closeAllAttempts(
        'screen-player-disposed',
      );
    };
  }, [entered, stream.memberId, iceServers, retry, transport, playback.mode, own]);

  const requested = stream.settings || {};
  const avatarColor = Number.isInteger(stream.avatarColor) && stream.avatarColor >= 0 && stream.avatarColor < 10 ? stream.avatarColor : 0;
  const floatingInfo = () => ({
    title: stream.name,
    avatarColor,
    lines: [
      `${metrics.width && metrics.height ? `${metrics.width}×${metrics.height}` : '检测中'} · ${metrics.fps ? `${Math.round(metrics.fps)} FPS` : '— FPS'} · ${metrics.bitrate ? `${metrics.bitrate.toFixed(0)} Kbps` : '测量中'}`,
      `媒体连接：${metrics.route}`,
      `目标 ${requested.width || '—'}×${requested.height || '—'} / ${requested.fps || '—'} FPS / ${requested.bitrate || '自动'} Kbps`,
      own ? metrics.encoder || '等待编码器' : `累计丢包 ${metrics.lost} · ${metrics.decoder || '检测解码器'}`,
    ],
  });
  useEffect(() => {
    if (floating) floatingPlayer.current?.updateInfo?.(floatingInfo());
  }, [floating, stream.name, avatarColor, metrics.width, metrics.height, metrics.fps, metrics.bitrate, metrics.route, metrics.lost, metrics.decoder, metrics.encoder, requested.width, requested.height, requested.fps, requested.bitrate, requested.performanceMode, own]);
  const toggleFullscreen = async () => {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else { floatingPlayer.current?.close(); clearUiTimer(); setControlsVisible(true); await window.roomcast?.prepareFullscreen?.(); await containerRef.current?.requestFullscreen(); } }
    catch (failure) { setError(`无法切换全屏：${failure.message}`); }
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
    const overControls = Boolean(event.target.closest?.('.player-controls, .player-top'));
    interaction.current.hover = overControls;
    showUi();
  };
  const pointerLeft = event => {
    if (event.relatedTarget && containerRef.current?.contains(event.relatedTarget)) return;
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
      onFocusCapture={() => { interaction.current.focus = true; showUi(); }}
      onBlurCapture={() => requestAnimationFrame(() => { interaction.current.focus = Boolean(containerRef.current?.contains(document.activeElement)); showUi(); })}
    >
      {!floating && <div className={`stream-parameter-bar player-info-overlay avatar-color-${avatarColor}`}>
        <strong>{stream.name}</strong>
        <span>{metrics.width && metrics.height ? `${metrics.width}×${metrics.height}` : '检测中'} · {metrics.fps ? `${Math.round(metrics.fps)} FPS` : '— FPS'} · {metrics.bitrate ? `${metrics.bitrate.toFixed(0)} Kbps` : '测量中'}</span>
        <span>媒体连接：{metrics.route}</span>
        <span>目标 {requested.width || '—'}×{requested.height || '—'} / {requested.fps || '—'} FPS / {requested.bitrate || '自动'} Kbps</span>
        <span>{own ? metrics.encoder || '等待编码器' : `累计丢包 ${metrics.lost} · ${metrics.decoder || '检测解码器'}`}</span>
      </div>}

      <div className="player-stage">
        <video ref={videoRef} autoPlay={state === 'live'} playsInline muted={!sound || deafened || own || state !== 'live'} />

        {floating ? (entered && state === 'live' && <div className="floating-detached-placeholder" aria-hidden="true"><AppWindow size={28} /><strong>画面已移至小窗</strong><span>关闭小窗后自动返回这里</span></div>) : <>
          {!entered ? <div className="player-loading"><Radio size={28} /><strong>{stream.name} 正在共享</strong><span>进入后才连接并播放画面</span><button className="button primary" onClick={() => { playSound('watch'); setEntered(true); onViewingChange?.(stream.memberId, true); }}>点击进入共享</button></div> : state !== 'live' && <div className="player-loading"><LoaderCircle className="spin" size={28} /><strong>连接共享画面</strong><span>{error || '正在建立低延迟 P2P 画面…'}</span><button className="text-button" onClick={() => setRetry(value => value + 1)}><RefreshCw size={14} />重新连接</button></div>}
          <div className="player-top" onPointerEnter={() => { interaction.current.hover = true; showUi(); }} onPointerLeave={() => { interaction.current.hover = false; armUiHide(); }} onPointerDown={controlPointerDown}>
            {(stream.viewers || []).length > 0 &&
              <div className="viewer-avatars">
                {(stream.viewers || []).map(viewer =>
                  <span
                    key={viewer.memberId}
                    className={`viewer-avatar avatar-color-${Number.isInteger(viewer.avatarColor) ? viewer.avatarColor : 0}`}
                    title={viewer.name}
                    aria-label={viewer.name}
                  >
                    {[...String(viewer.name || '访').trim()][0]?.toUpperCase() || '访'}
                  </span>
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
