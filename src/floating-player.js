const AVATAR_PALETTE = [
  ['#394631', '#c5d4a7'],
  ['#383551', '#c6bbea'],
  ['#2b454e', '#a3d2df'],
  ['#533b38', '#e7b5ac'],
  ['#29463d', '#abe4c9'],
  ['#4a3427', '#f2c29c'],
  ['#263f57', '#a9d5f5'],
  ['#4d2945', '#efb4df'],
  ['#4b4826', '#e9e09c'],
  ['#263f3f', '#a8e2df'],
];

const normalizeAvatarColor = value => Number.isInteger(value) && value >= 0 && value < AVATAR_PALETTE.length ? value : 0;

// The transport and source element stay in the main renderer. The floating
// BrowserWindow only mirrors video tracks, so opening/closing it never rebuilds
// WebRTC or takes ownership of the original media tracks.
export function openFloatingPlayer(source, {
  title,
  onState,
  onVolume,
  onSound,
  soundAvailable,
  soundEnabled,
  volume: initialVolume,
  info,
} = {}) {
  const bridge = window.roomcast;
  const id = bridge?.prepareFloatingWindow?.();
  if (!id) throw new Error('无法创建桌面共享浮窗。');

  const popup = window.open('about:blank', id, 'width=760,height=480');
  if (!popup) throw new Error('桌面共享浮窗被阻止。');

  let disposed = false;
  let captured = null;
  let observedStream = null;
  const observedTracks = new Set();
  let unsubscribe;
  let fullscreen = false;
  let alwaysOnTop = false;
  let uiTimer = null;

  const doc = popup.document;
  doc.title = `${title || '共享画面'} — Roomcast`;

  const style = doc.createElement('style');
  style.textContent = `
    :root {
      font-family: Inter, "Segoe UI", "Microsoft YaHei", sans-serif;
      color: #e8ecef;
      background: #06090c;
      --muted: #86919c;
      --green: #78ddbd;
      --border: #ffffff0c;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #06090c; }
    body { position: relative; display: flex; flex-direction: column; user-select: none; }
    .floating-info-card {
      position: relative;
      z-index: 6;
      flex: 0 0 auto;
      width: 100%;
      max-width: none;
      min-height: 0;
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 7px 14px;
      padding: 7px 10px;
      border: 0;
      border-bottom: 1px solid #ffffff18;
      border-radius: 0;
      overflow: hidden;
      box-shadow: none;
      font-size: 9px;
      line-height: 1.35;
      transition: opacity .16s ease;
      -webkit-app-region: drag;
    }
    .floating-info-card strong { font-size: 11px; font-weight: 700; color: inherit; }
    .floating-info-card span { color: inherit; opacity: .84; padding-left: 10px; border-left: 1px solid #ffffff18; }
    html:not(.is-fullscreen).ui-hidden .floating-info-card { display: none; }
    html.is-fullscreen .floating-info-card {
      position: relative;
      top: auto;
      left: auto;
      width: 100%;
      max-width: none;
      border: 0;
      border-bottom: 1px solid #ffffff18;
      border-radius: 0;
      box-shadow: none;
      -webkit-app-region: no-drag;
    }
    html.is-fullscreen.ui-hidden .floating-info-card { display: none; }
    video { position: relative; z-index: 0; flex: 1 1 0; width: 100%; height: 0; min-width: 0; min-height: 0; object-fit: contain; background: #06090c; }
    html.is-fullscreen video { position: relative; inset: auto; width: 100%; height: 0; flex: 1 1 0; }
    button, input { font: inherit; outline: none; }
    button, input, label, .floating-controls { -webkit-app-region: no-drag; }
    button { cursor: pointer; color: inherit; border: 0; transition: background .15s, opacity .15s, filter .15s; }
    button:hover:not(:disabled) { filter: brightness(1.13); }
    button:focus-visible, input:focus-visible { outline: 2px solid var(--green); outline-offset: 3px; }
    .floating-controls {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: 5;
      display: flex;
      justify-content: flex-end;
      align-items: center;
      padding: 26px 15px 12px;
      color: #8ca59b;
      background: linear-gradient(transparent, #05090be6);
      opacity: 0;
      transform: translateY(4px);
      pointer-events: none;
      transition: opacity .16s ease, transform .16s ease;
    }
    .floating-controls.visible { opacity: 1; transform: translateY(0); pointer-events: auto; }
    .floating-controls-inner { display: flex; align-items: center; gap: 8px; }
    .floating-control-button {
      display: grid;
      place-items: center;
      width: 34px;
      height: 34px;
      padding: 7px;
      border-radius: 6px;
      color: #d0e6dc;
      background: #1c292acc;
    }
    .floating-control-button svg { width: 18px; height: 18px; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .floating-volume {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 3px 7px;
      height: 34px;
      border-radius: 6px;
      color: #d0e6dc;
      background: #1c292acc;
    }
    .floating-volume input { width: 92px; accent-color: var(--green); }
    .floating-volume span { width: 29px; color: #d0e6dc; font-size: 8px; text-align: right; }
    .audio-hidden { display: none !important; }
    html.cursor-hidden, html.cursor-hidden * { cursor: none !important; }
  `;
  doc.head.append(style);

  const icon = paths => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
  const icons = {
    volume: icon('<path d="M11 5 6 9H2v6h4l5 4z"></path><path d="M15.5 8.5a5 5 0 0 1 0 7"></path><path d="M18.5 5.5a9 9 0 0 1 0 13"></path>'),
    muted: icon('<path d="M11 5 6 9H2v6h4l5 4z"></path><path d="m22 9-6 6"></path><path d="m16 9 6 6"></path>'),
    fullscreen: icon('<path d="M8 3H5a2 2 0 0 0-2 2v3"></path><path d="M16 3h3a2 2 0 0 1 2 2v3"></path><path d="M8 21H5a2 2 0 0 1-2-2v-3"></path><path d="M16 21h3a2 2 0 0 0 2-2v-3"></path>'),
    exitFullscreen: icon('<path d="M8 3v3a2 2 0 0 1-2 2H3"></path><path d="M16 3v3a2 2 0 0 0 2 2h3"></path><path d="M8 21v-3a2 2 0 0 0-2-2H3"></path><path d="M16 21v-3a2 2 0 0 1 2-2h3"></path>'),
    pin: icon('<path d="m16 3 5 5-4 1-3 4-1 4-2 2-2-2-4-4-2-2 2-2 4-1 4-3z"></path><path d="m9 15-5 5"></path>'),
    exitWindow: icon('<path d="M9 18H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"></path><path d="m16 15 3-3-3-3"></path><path d="M19 12H9"></path>'),
  };

  const infoCard = doc.createElement('div');
  infoCard.className = 'floating-info-card';
  const infoTitle = doc.createElement('strong');
  const infoLines = Array.from({ length: 4 }, () => doc.createElement('span'));
  infoCard.append(infoTitle, ...infoLines);

  const infoState = {
    title: info?.title || title || '共享画面',
    avatarColor: normalizeAvatarColor(info?.avatarColor),
    lines: Array.isArray(info?.lines) ? info.lines.slice(0, 4) : [],
  };

  const renderInfo = () => {
    const [background, foreground] = AVATAR_PALETTE[infoState.avatarColor];
    infoCard.style.background = background;
    infoCard.style.color = foreground;
    infoCard.dataset.avatarColor = String(infoState.avatarColor);
    infoTitle.textContent = infoState.title;
    for (let index = 0; index < infoLines.length; index += 1) {
      const value = infoState.lines[index] || '';
      infoLines[index].textContent = value;
      infoLines[index].style.display = value ? '' : 'none';
    }
  };

  const updateInfo = next => {
    if (!next || disposed) return;
    if (typeof next.title === 'string' && next.title) infoState.title = next.title;
    if (Number.isInteger(next.avatarColor)) infoState.avatarColor = normalizeAvatarColor(next.avatarColor);
    if (Array.isArray(next.lines)) infoState.lines = next.lines.slice(0, 4);
    renderInfo();
  };

  const video = doc.createElement('video');
  video.autoplay = true;
  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;

  const controls = doc.createElement('div');
  controls.className = 'floating-controls';
  const controlsInner = doc.createElement('div');
  controlsInner.className = 'floating-controls-inner';
  controls.append(controlsInner);

  const makeButton = ({ label, html, action }) => {
    const node = doc.createElement('button');
    node.type = 'button';
    node.className = 'floating-control-button';
    node.title = label;
    node.setAttribute('aria-label', label);
    node.innerHTML = html;
    node.onclick = action;
    controlsInner.append(node);
    return node;
  };

  const audioState = {
    available: soundAvailable ?? typeof onSound === 'function',
    enabled: soundEnabled ?? !source.muted,
    volume: Number.isFinite(Number(initialVolume)) ? Number(initialVolume) : Number(source.volume || 0),
  };

  const soundButton = makeButton({
    label: '播放共享声音',
    html: icons.muted,
    action: () => {
      if (!audioState.available) return;
      const next = !audioState.enabled;
      audioState.enabled = next;
      renderAudio();
      onSound?.(next);
      source.play?.().catch?.(() => { });
    },
  });

  const volumeWrap = doc.createElement('label');
  volumeWrap.className = 'floating-volume';
  volumeWrap.title = `音量 ${Math.round(audioState.volume * 100)}%`;
  const volume = doc.createElement('input');
  volume.type = 'range';
  volume.min = '0';
  volume.max = '1';
  volume.step = '0.01';
  volume.value = String(audioState.volume);
  volume.setAttribute('aria-label', '共享音量');
  const volumeText = doc.createElement('span');
  volumeWrap.append(volume, volumeText);
  controlsInner.append(volumeWrap);

  const topButton = makeButton({
    label: '置顶小窗',
    html: icons.pin,
    action: () => bridge.floatingAction({ id, action: 'top' }).catch(() => { }),
  });

  const fullscreenButton = makeButton({
    label: '全屏',
    html: icons.fullscreen,
    action: () => bridge.floatingAction({ id, action: 'fullscreen' }).catch(() => { }),
  });

  makeButton({
    label: '退出小窗',
    html: icons.exitWindow,
    action: () => popup.close(),
  });

  doc.body.append(infoCard, video, controls);

  function renderAudio() {
    soundButton.classList.toggle('audio-hidden', !audioState.available);
    volumeWrap.classList.toggle('audio-hidden', !audioState.available);
    const audible = audioState.available && audioState.enabled && audioState.volume > 0;
    soundButton.title = audible ? '关闭共享声音' : '播放共享声音';
    soundButton.setAttribute('aria-label', soundButton.title);
    soundButton.innerHTML = audible ? icons.volume : icons.muted;
    volume.value = String(audioState.volume);
    volumeText.textContent = `${Math.round(audioState.volume * 100)}%`;
    volumeWrap.title = `音量 ${Math.round(audioState.volume * 100)}%`;
  }

  volume.oninput = () => {
    const next = Math.min(1, Math.max(0, Number(volume.value)));
    audioState.volume = next;
    if (next > 0 && !audioState.enabled) {
      audioState.enabled = true;
      onSound?.(true);
    }
    renderAudio();
    onVolume?.(next);
    source.play?.().catch?.(() => { });
  };

  const updateAudio = next => {
    if (!next || disposed) return;
    if (typeof next.soundAvailable === 'boolean') audioState.available = next.soundAvailable;
    if (typeof next.soundEnabled === 'boolean') audioState.enabled = next.soundEnabled;
    if (Number.isFinite(Number(next.volume))) audioState.volume = Math.min(1, Math.max(0, Number(next.volume)));
    renderAudio();
  };

  const syncAudioFromSource = () => {
    audioState.enabled = !source.muted;
    audioState.volume = Math.min(1, Math.max(0, Number(source.volume || 0)));
    renderAudio();
  };

  const clearUiTimer = () => {
    if (uiTimer) clearTimeout(uiTimer);
    uiTimer = null;
  };

  const hideUi = () => {
    clearUiTimer();
    controls.classList.remove('visible');
    doc.documentElement.classList.add('ui-hidden');
    doc.documentElement.classList.add('cursor-hidden');
  };

  const showUi = () => {
    clearUiTimer();
    controls.classList.add('visible');
    doc.documentElement.classList.remove('ui-hidden');
    doc.documentElement.classList.remove('cursor-hidden');
    uiTimer = setTimeout(hideUi, 2000);
  };

  const applyWindowState = (state, top) => {
    fullscreen = state === 'FLOATING_FULLSCREEN';
    alwaysOnTop = top === true;
    topButton.title = alwaysOnTop ? '取消置顶' : '置顶小窗';
    topButton.setAttribute('aria-label', topButton.title);
    topButton.setAttribute('aria-pressed', String(alwaysOnTop));
    topButton.style.color = alwaysOnTop ? 'var(--green)' : '';
    doc.documentElement.classList.toggle('is-fullscreen', fullscreen);
    fullscreenButton.title = fullscreen ? '取消全屏' : '全屏';
    fullscreenButton.setAttribute('aria-label', fullscreenButton.title);
    fullscreenButton.innerHTML = fullscreen ? icons.exitFullscreen : icons.fullscreen;
    showUi();
  };

  const pointerMoved = () => {
    showUi();
  };

  const pointerLeft = event => {
    if (event.relatedTarget && doc.documentElement.contains(event.relatedTarget)) return;
    clearUiTimer();
    uiTimer = setTimeout(hideUi, 2000);
  };

  doc.documentElement.addEventListener('pointerenter', pointerMoved);
  doc.documentElement.addEventListener('pointermove', pointerMoved);
  doc.documentElement.addEventListener('pointerleave', pointerLeft);

  const syncTracks = () => {
    if (disposed || !observedStream) return;

    const tracks = observedStream.getVideoTracks().filter(track => track.readyState !== 'ended');
    const current = video.srcObject instanceof MediaStream ? video.srcObject.getVideoTracks() : [];
    const sameTracks = tracks.length === current.length && tracks.every((track, index) => track === current[index]);

    for (const track of observedTracks) {
      if (!tracks.includes(track)) {
        track.removeEventListener('ended', syncTracks);
        observedTracks.delete(track);
      }
    }

    for (const track of tracks) {
      if (!observedTracks.has(track)) {
        observedTracks.add(track);
        track.addEventListener('ended', syncTracks);
      }
    }

    if (!sameTracks) video.srcObject = new MediaStream(tracks);
    video.play().catch(() => { });
  };

  const stopObserving = () => {
    if (observedStream) {
      observedStream.removeEventListener('addtrack', syncTracks);
      observedStream.removeEventListener('removetrack', syncTracks);
    }
    for (const track of observedTracks) track.removeEventListener('ended', syncTracks);
    observedTracks.clear();
    observedStream = null;
  };

  const releaseCapture = () => {
    const current = captured;
    captured = null;
    current?.getTracks().forEach(track => track.stop());
  };

  const observe = stream => {
    observedStream = stream;
    stream.addEventListener('addtrack', syncTracks);
    stream.addEventListener('removetrack', syncTracks);
    syncTracks();
  };

  const bind = () => {
    if (disposed) return;

    stopObserving();
    releaseCapture();

    if (source.srcObject instanceof MediaStream) {
      observe(source.srcObject);
      return;
    }

    if (typeof source.captureStream !== 'function') throw new Error('当前播放源不支持桌面浮窗复制。');
    captured = source.captureStream();
    observe(captured);
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;

    clearUiTimer();
    doc.documentElement.removeEventListener('pointerenter', pointerMoved);
    doc.documentElement.removeEventListener('pointermove', pointerMoved);
    doc.documentElement.removeEventListener('pointerleave', pointerLeft);
    source.removeEventListener('loadedmetadata', bind);
    source.removeEventListener('volumechange', syncAudioFromSource);
    unsubscribe?.();

    stopObserving();
    try { video.srcObject = null; } catch { }
    releaseCapture();

    if (!popup.closed) popup.close();
    onState?.('MAIN');
  };

  unsubscribe = bridge.onFloatingState(({ id: changedId, state, alwaysOnTop: top }) => {
    if (changedId !== id) return;
    if (state === 'MAIN') dispose();
    else {
      applyWindowState(state, top);
      onState?.(state);
    }
  });

  popup.addEventListener('pagehide', dispose);
  source.addEventListener('loadedmetadata', bind);
  source.addEventListener('volumechange', syncAudioFromSource);
  renderAudio();
  renderInfo();
  applyWindowState('FLOATING', false);
  showUi();

  try {
    bind();
    onState?.('FLOATING');
  } catch (error) {
    dispose();
    throw error;
  }

  return { close: dispose, id, updateAudio, updateInfo };
}
