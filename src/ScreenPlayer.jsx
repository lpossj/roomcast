import { AppWindow, Expand, LoaderCircle, Minimize, Radio, RefreshCw, Volume2, VolumeX } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { watchPlayableFrame } from './fallback-policy.js';
import { createScreenWatchSession } from './screen-watch-session.js';
import { FULLSCREEN_ELEMENT, FULLSCREEN_VIDEO, pickFullscreenMode } from './fullscreen-policy.js';
import { selectScreenPlayback } from './local-preview.js';
import { loadPreference, savePreference } from './preferences.js';
import { playSound } from './sounds.js';
import { openFloatingPlayer } from './floating-player.js';
import { playerInfo } from './player-info.js';
import Avatar from './Avatar.jsx';
import LaserIcon from './components/LaserIcon.jsx';
import LaserOverlay from './LaserOverlay.jsx';
import { bindLaserShortcut } from './laser-shortcut.js';

export const FULLSCREEN_UI_HIDE_DELAY = 2000;
const STALLED_MESSAGE = '共享画面暂未更新';
const readPlaybackVolume = () => {
  const value = Number(loadPreference('playbackVolume', 0.5));
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5;
};

const emptyMetrics = {
  width: 0, height: 0, fps: null, bitrate: 0, codec: '检测中',
  route: '连接中',
  lost: 0, decoder: '', encoder: ''
};

function presentStream(video, media, onPresented) {
  let frameCallback;
  if (video) {
    if (video.srcObject !== media) video.srcObject = media;
    video.play().catch(() => {});
    if (onPresented && video.requestVideoFrameCallback) {
      let firstMediaTime;
      const presented = (at, frame) => {
        if (video.srcObject !== media) return;
        const first = firstMediaTime === undefined;
        if (first || frame.mediaTime > firstMediaTime) {
          onPresented({ at, first, mediaTime: frame.mediaTime, presentedFrames: frame.presentedFrames });
          if (!first) return;
          firstMediaTime = frame.mediaTime;
        }
        frameCallback = video.requestVideoFrameCallback(presented);
      };
      frameCallback = video.requestVideoFrameCallback(presented);
    }
  }
  return () => {
    if (frameCallback !== undefined) video.cancelVideoFrameCallback(frameCallback);
    if (video?.srcObject === media) video.srcObject = null;
  };
}

function createFrameProbe(onFrame) {
  let video;
  let cancel;
  let closed = false;
  return {
    get element() { return video; },
    attach(media) {
      if (closed || video) return;
      video = document.createElement('video');
      video.playsInline = true;
      video.muted = true;
      cancel = watchPlayableFrame(video, onFrame, media);
      video.srcObject = media;
      video.play().catch(() => {});
    },
    close(selected = false) {
      if (closed) return;
      closed = true;
      cancel?.();
      if (video && !selected) {
        video.pause();
        video.srcObject = null;
      }
    },
  };
}

export default function ScreenPlayer({ laser, room, stream, iceServers, outputDeviceId, viewerMemberId, deafened, masterVolume = 1, initialSound = false, transport, reportViewing, initiallyEntered = false, onViewingChange }) {
  const videoRef = useRef(null);
  const videoHost = useRef(null);
  const containerRef = useRef(null);
  const streamViewRef = useRef(null);
  const [state, setState] = useState('idle');
  const [error, setError] = useState('');
  const [sound, setSound] = useState(initialSound);
  const [volume, setVolume] = useState(readPlaybackVolume);
  const [previewRetry, setPreviewRetry] = useState(0);
  const [playerGeneration, setPlayerGeneration] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const watchSession = useRef(null);
  const currentIceServers = useRef(iceServers);
  const uiTimer = useRef(null);
  const interaction = useRef({ inside: false, hover: false, pointer: false, focus: false });
  const wasFullscreen = useRef(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [laserEnabled, setLaserEnabled] = useState(false);
  const laserAvailable = Boolean(room?.features?.laser === 1 && room.laserEnabled !== false && room.members?.some(m => m.id === viewerMemberId && m.canLaser !== false));
  const playback = selectScreenPlayback({
    viewerMemberId,
    publisherMemberId: stream.memberId,
    localStream: transport?.screenStream,
  });
  const own = playback.isSelf;
  const localStream = own ? transport?.screenStream : null;

  // 是否真正进入这个共享
  const [entered, setEntered] = useState(() => initiallyEntered);
  const reconnect = () => {
    if (watchSession.current) {
      void watchSession.current.reconnect();
    } else if (own) setPreviewRetry(value => value + 1);
  };
  const [windowMode, setWindowMode] = useState('MAIN');
  const floating = windowMode !== 'MAIN';
  const floatingPlayer = useRef(null);
  const hasPlayback = state === 'live' || state === 'stalled';
  const floatingNotice = state === 'stalled' ? STALLED_MESSAGE : state === 'failed' ? error : '';
  useEffect(() => {
    floatingPlayer.current?.updatePlaybackNotice(floatingNotice);
  }, [floating, floatingNotice]);
  useEffect(() => {
    if (!laserAvailable || !entered || !hasPlayback) setLaserEnabled(false);
    floatingPlayer.current?.updateLaser?.({ active: laserEnabled, available: laserAvailable && entered && hasPlayback });
  }, [laserAvailable, entered, hasPlayback, laserEnabled, floating]);
  const clearLegacySize = () => {
    const node = streamViewRef.current;
    for (const key of ['width', 'height', 'left', 'top']) node?.style.removeProperty(key);
  };
  useLayoutEffect(() => {
    const element = document.createElement('video');
    element.playsInline = true;
    element.muted = true;
    videoHost.current.replaceChildren(element);
    videoRef.current = element;
    return () => { videoRef.current = null; };
  }, []);
  useLayoutEffect(() => {
    const video = videoRef.current;
    video.autoplay = hasPlayback;
    video.muted = !sound || deafened || own || !hasPlayback;
    floatingPlayer.current?.replaceSource(video);
  }, [playerGeneration, hasPlayback, sound, deafened, own]);
  useEffect(() => { const video = videoRef.current; if (video?.setSinkId) video.setSinkId(outputDeviceId || 'default').catch(() => { }); }, [outputDeviceId, playerGeneration]);
  useLayoutEffect(() => { if (videoRef.current) videoRef.current.volume = volume * masterVolume; }, [volume, masterVolume, playerGeneration]);
  useEffect(() => { savePreference('playbackVolume', volume); }, [volume]);
  useEffect(() => { clearLegacySize(); return () => { floatingPlayer.current?.close(); floatingPlayer.current = null; }; }, []);
  useEffect(() => { if (!entered) { floatingPlayer.current?.close(); floatingPlayer.current = null; } }, [entered]);
  useEffect(() => {
    floatingPlayer.current?.updateAudio?.({
      soundAvailable: !own && !deafened,
      soundEnabled: sound && !deafened && !own,
      volume,
    });
  }, [sound, volume, deafened, own]);
  const [metrics, setMetrics] = useState(emptyMetrics);
  useEffect(() => {
    currentIceServers.current = iceServers;
    watchSession.current?.updateIceServers(iceServers);
  }, [iceServers]);

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
  const canHideUi = () => !floating && entered && hasPlayback && !interaction.current.pointer && !interaction.current.hover && !interaction.current.focus;
  const armUiHide = () => {
    clearUiTimer(); setControlsVisible(true);
    if (!floating && entered && hasPlayback) uiTimer.current = setTimeout(() => { if (canHideUi()) setControlsVisible(false); }, FULLSCREEN_UI_HIDE_DELAY);
  };
  useEffect(() => {
    if (floating || !entered || !hasPlayback) { clearUiTimer(); setControlsVisible(true); return undefined; }
    armUiHide();
    return clearUiTimer;
  }, [floating, fullscreen, entered, hasPlayback]);

  useEffect(() => {
    const video = videoRef.current;
    if (!entered) {
      if (video) video.srcObject = null;
      setState('idle');
      setError('');
      setMetrics(emptyMetrics);
      return;
    }
    if (playback.mode === 'local-stream') {
      const local = localStream;
      let lastPreview;
      const update = () => {
        const now = performance.now();
        const quality = video?.getVideoPlaybackQuality?.();
        const frames = quality ? quality.totalVideoFrames - quality.droppedVideoFrames : null;
        const fps = frames != null && lastPreview?.frames != null && frames >= lastPreview.frames && now > lastPreview.at
          ? (frames - lastPreview.frames) * 1000 / (now - lastPreview.at) : null;
        lastPreview = { frames, at: now };
        setMetrics({ ...emptyMetrics, source: 'capture', width: video?.videoWidth, height: video?.videoHeight, fps });
      };
      setSound(false); setState('live'); setError('');
      const detach = presentStream(video, local);
      update();
      const statsTimer = setInterval(update, 2000);
      return () => { clearInterval(statsTimer); detach(); };
    }
    if (playback.mode === 'unavailable') {
      setSound(false); setState('failed'); setError('本机预览暂不可用；不会改用公网 P2P 或 TURN。'); setMetrics(emptyMetrics);
      return undefined;
    }
    if (!transport?.mediaP2P) setSound(false);
    const session = createScreenWatchSession({
      publisherId: stream.memberId,
      startedAt: stream.startedAt,
      transport,
      iceServers: currentIceServers.current,
      reportViewing,
      prepareNetwork: () => window.roomcast?.prepareNetwork?.(),
      createFrameProbe,
      presentStream(media, onPresented, prepared) {
        // Move the playing element, retaining the decoder, media clock and
        // frame counters from the selected connection.
        if (prepared && videoRef.current !== prepared) {
          prepared.volume = videoRef.current.volume;
          videoHost.current.replaceChildren(prepared);
          videoRef.current = prepared;
          setPlayerGeneration(value => value + 1);
        }
        return presentStream(videoRef.current, media, onPresented);
      },
      onStatus(next, message = '') {
        setState(next);
        setError(message);
      },
      onMetrics(value) {
        const video = videoRef.current;
        setMetrics(value ? {
          ...emptyMetrics, ...value,
          width: value.width || (video?.srcObject && video.videoWidth) || 0,
          height: value.height || (video?.srcObject && video.videoHeight) || 0,
        } : emptyMetrics);
      },
    });
    watchSession.current = session;
    const resume = () => {
      if (document.visibilityState !== 'visible') return;
      videoRef.current?.play().catch(() => {});
      void session.resume();
    };
    const resumeOnVisible = !window.roomcast?.desktop && !!reportViewing;
    if (resumeOnVisible) document.addEventListener('visibilitychange', resume);
    return () => {
      if (resumeOnVisible) document.removeEventListener('visibilitychange', resume);
      watchSession.current = null;
      session.close();
    };
  }, [entered, stream.memberId, stream.startedAt, viewerMemberId, transport, playback.mode, localStream, reportViewing, previewRetry]);

  const info = playerInfo(metrics);
  const statsLine = own ? `${info.resolution} · ${info.fps}` : `${info.resolution} · ${info.fps} · ${info.bitrate}`;
  const avatarColor = Number.isInteger(stream.avatarColor) && stream.avatarColor >= 0 && stream.avatarColor < 10 ? stream.avatarColor : 0;
  const floatingInfo = () => ({
    title: stream.name,
    avatarColor,
    viewers: stream.viewers || [],
    lines: own ? [`本机预览 · ${statsLine}`] : [statsLine, info.route],
  });
  useEffect(() => {
    if (floating) floatingPlayer.current?.updateInfo?.(floatingInfo());
  }, [floating, stream.name, stream.viewers, avatarColor, own, statsLine, info.route]);
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
        playbackNotice: floatingNotice,
        onReconnect: reconnect,
        soundAvailable: !own && !deafened,
        soundEnabled: sound && !deafened && !own,
        volume,
        info: floatingInfo(),
        laser: { controller: laser, stream, selfId: viewerMemberId, active: laserEnabled, available: laserAvailable, onActiveChange: setLaserEnabled },
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
    const overControls = Boolean(event.target.closest?.('.player-controls > div, .exit-view-button'));
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
  useEffect(() => {
    if (!laserAvailable || !entered || !hasPlayback || floating || !containerRef.current) return undefined;
    return bindLaserShortcut(containerRef.current, {
      canToggle: () => laser.allowed(),
      onToggle: () => { setLaserEnabled(value => !value); showUi(); },
    });
  }, [laser, laserAvailable, entered, hasPlayback, floating]);
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
        {own && entered && <span>本机预览</span>}
        <span>{statsLine}</span>
        {(!own || !entered) && <span>{entered ? info.route : '未加入'}</span>}
      </div>}

      <div className="player-stage">
        {room?.features?.laser === 1 && entered && hasPlayback && !floating && <LaserOverlay key={playerGeneration} laser={laser} stream={stream} selfId={viewerMemberId} videoRef={videoRef} active={laserEnabled && laserAvailable} onActiveChange={setLaserEnabled} />}
        <div className="player-video-surface" ref={videoHost} />

        {floating ? (entered && hasPlayback && <div className="floating-detached-placeholder" aria-hidden="true"><AppWindow size={28} /><strong>画面已移至小窗</strong><span>关闭小窗后自动返回这里</span></div>) : <>
          {!entered ? <div className="player-loading"><Radio size={28} /><strong>{own ? '你正在共享画面' : `${stream.name} 正在共享`}</strong><span>{own ? '点击加入窗口后才开启本地预览画面' : '点击加入窗口后才建立连接并播放画面'}</span><button className="button primary" onClick={() => { playSound('watch'); setEntered(true); onViewingChange?.(stream.memberId, true, stream.startedAt); }}>点击加入窗口</button></div> : !hasPlayback && <div className="player-loading"><LoaderCircle className="spin" size={28} /><strong>连接共享画面</strong><span>{error || '正在建立低延迟 P2P 画面…'}</span><button className="text-button" onClick={reconnect}><RefreshCw size={14} />重新连接</button></div>}
          {entered && state === 'stalled' && <div className="player-stall-notice">
            <span role="status">{STALLED_MESSAGE}</span>
            <button type="button" className="text-button" onClick={reconnect}><RefreshCw size={14} />重新连接</button>
          </div>}
          <div className="player-top" onPointerEnter={showUi} onPointerLeave={showUi}>
            {(stream.viewers || []).length > 0 &&
              <div className="viewer-avatars">
                {(stream.viewers || []).map(viewer =>
                  <Avatar
                    key={viewer.memberId}
                    member={viewer}
                    className="avatar viewer-avatar"
                    title={viewer.name}
                    aria-label={viewer.name}
                  />
                )}
              </div>
            }
          </div>
          <div className="player-controls"><div onPointerEnter={() => { interaction.current.hover = true; showUi(); }} onPointerLeave={() => { interaction.current.hover = false; armUiHide(); }} onPointerDown={controlPointerDown}>{laserAvailable && !floating && <button type="button" aria-pressed={laserEnabled} className={laserEnabled ? 'laser-active' : ''} data-tooltip={laserEnabled ? '退出激光笔 (N)' : '激光笔 (N)'} aria-label={laserEnabled ? '退出激光笔模式' : '激光笔'} aria-keyshortcuts="N" onClick={() => setLaserEnabled(x => !x)}><LaserIcon size={17}/></button>}{!own && <><button data-tooltip={sound ? '静音共享' : '播放共享声音'} aria-label={sound ? '关闭共享声音' : '播放共享声音'} onClick={() => { setSound(value => !value); videoRef.current?.play().catch(() => { }); }}>{sound && !deafened && volume > 0 ? <Volume2 size={18} /> : <VolumeX size={18} />}</button><label className="player-volume" title={`音量 ${Math.round(volume * 100)}%`}><input aria-label="共享音量" type="range" min="0" max="1" step="0.01" value={volume} onChange={event => { const next = Number(event.target.value); setVolume(next); if (next > 0) setSound(true); }} /><span>{Math.round(volume * 100)}%</span></label></>}{window.roomcast?.desktop && <button data-tooltip="独立小窗" aria-label="小窗模式" onClick={toggleWindowMode}><AppWindow size={18} /></button>}<button data-tooltip={fullscreen ? '退出全屏' : '全屏'} aria-label={fullscreen ? '退出全屏' : '全屏'} onClick={toggleFullscreen}>{fullscreen ? <Minimize size={18} /> : <Expand size={18} />}</button></div></div>
        </>}
      </div>
      {entered && <button type="button" className="button small exit-view-button" onPointerDown={controlPointerDown} onClick={() => {
        watchSession.current?.close();
        setEntered(false);
        onViewingChange?.(stream.memberId, false, stream.startedAt);
        if (document.fullscreenElement === containerRef.current) document.exitFullscreen().catch(() => { });
      }}>{own ? '退出预览' : '退出观看'}</button>}
    </div>
  </div>;
}
