const { contextBridge, ipcRenderer } = require('electron');


contextBridge.exposeInMainWorld('roomcast', {
  desktop: true,

  setTitleBarTheme: color =>
    ipcRenderer.send('roomcast:titlebar-theme', color),
  getSystemAccentColor: () =>
    ipcRenderer.sendSync('roomcast:system-accent-color-get'),
  onSystemAccentColor: callback => {
    const listener = (_event, color) => callback(color);
    ipcRenderer.on('roomcast:system-accent-color-changed', listener);
    return () => ipcRenderer.removeListener('roomcast:system-accent-color-changed', listener);
  },

  getThemeSettings: () =>
    ipcRenderer.sendSync('roomcast:theme-settings-get'),
  setThemeSettings: settings =>
    ipcRenderer.sendSync('roomcast:theme-settings-set', settings),

  copyText: value =>
    ipcRenderer.invoke('roomcast:copy-text', value),
  startWebInvite: () =>
    ipcRenderer.invoke('roomcast:web-invite-start'),
  stopWebInvite: () =>
    ipcRenderer.invoke('roomcast:web-invite-stop'),
  onWebInviteState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('roomcast:web-invite-state', listener);
    return () => ipcRenderer.removeListener('roomcast:web-invite-state', listener);
  },
  copyImage: bytes =>
    ipcRenderer.invoke('roomcast:copy-image', bytes),
  saveImage: (bytes, fileName) =>
    ipcRenderer.invoke('roomcast:save-image', bytes, fileName),

  checkForUpdates: () =>
    ipcRenderer.invoke('roomcast:update-check'),
  // Manual download is deliberately limited to opening the release page: automatic update
  // installs by itself, and shipping per-asset download buttons only duplicated that.
  openReleasePage: () =>
    ipcRenderer.invoke('roomcast:update-open-page'),
  // Automatic update. The main process decides whether this install may replace itself
  // (portable EXE, program folder, or neither) and then hands the progress UI over to a
  // dedicated updater window, because this window is closed as the first step.
  updateTarget: () =>
    ipcRenderer.invoke('roomcast:update-target'),
  startAutomaticUpdate: () =>
    ipcRenderer.invoke('roomcast:update-start'),
  // A replacement that fails after the app exits leaves a marker; this reads and clears it
  // so the failure is reported exactly once instead of silently running the old version.
  takeUpdateFailure: () =>
    ipcRenderer.invoke('roomcast:update-last-failure'),

  audioSources: () =>
    ipcRenderer.invoke('roomcast:audio-sources'),

  startAudioCapture: payload =>
    ipcRenderer.invoke('roomcast:audio-capture-start', payload),

  stopAudioCapture: captureId =>
    ipcRenderer.invoke('roomcast:audio-capture-stop', captureId),

  onAudioCaptureData: callback => {
    const listener = (_event, packet) => callback(packet);
    ipcRenderer.on('roomcast:audio-capture-data', listener);

    return () =>
      ipcRenderer.removeListener(
        'roomcast:audio-capture-data',
        listener,
      );
  },

  onAudioCaptureEnded: callback => {
    const listener = (_event, packet) => callback(packet);
    ipcRenderer.on('roomcast:audio-capture-ended', listener);

    return () =>
      ipcRenderer.removeListener(
        'roomcast:audio-capture-ended',
        listener,
      );
  },

  fetchRelayIce: payload =>
    ipcRenderer.invoke(
      'roomcast:local',
      'relay:ice',
      payload,
    ),

  captureSources: () =>
    ipcRenderer.invoke('roomcast:capture-sources'),

  obsCaptureSources: payload =>
    ipcRenderer.invoke('roomcast:obs-capture-sources', payload),

  startObsCapture: payload =>
    ipcRenderer.invoke('roomcast:obs-capture-start', payload),

  stopObsCapture: captureId =>
    ipcRenderer.invoke('roomcast:obs-capture-stop', captureId ? { captureId } : {}),

  obsCaptureStatus: () =>
    ipcRenderer.invoke('roomcast:obs-capture-status'),

  onObsCaptureEnded: callback => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('roomcast:obs-capture-ended', listener);
    return () => ipcRenderer.removeListener('roomcast:obs-capture-ended', listener);
  },

  selectCapture: payload =>
    ipcRenderer.sendSync(
      'roomcast:capture-select',
      payload,
    ),

  prepareFullscreen: () =>
    ipcRenderer.invoke('roomcast:fullscreen-prepare'),

  finishFullscreen: () =>
    ipcRenderer.invoke('roomcast:fullscreen-finish'),

  prepareFloatingWindow: () =>
    ipcRenderer.sendSync('roomcast:floating-prepare'),

  floatingAction: payload =>
    ipcRenderer.invoke(
      'roomcast:floating-action',
      payload,
    ),

  onFloatingState: callback => {
    const listener = (_event, state) => callback(state);

    ipcRenderer.on(
      'roomcast:floating-state',
      listener,
    );

    return () =>
      ipcRenderer.removeListener(
        'roomcast:floating-state',
        listener,
      );
  },

  getPreference: key =>
    ipcRenderer.sendSync(
      'roomcast:preference-get',
      key,
    ),

  setPreference: (key, value) =>
    ipcRenderer.sendSync(
      'roomcast:preference-set',
      { key, value },
    ),

  onInvite: callback => {
    const listener = (_event, roomId) => callback(roomId);

    ipcRenderer.on(
      'roomcast:invite',
      listener,
    );

    return () =>
      ipcRenderer.removeListener(
        'roomcast:invite',
        listener,
      );
  },

  onBeforeClose: callback => {
    const listener = () => callback();

    ipcRenderer.on(
      'roomcast:before-close',
      listener,
    );

    return () =>
      ipcRenderer.removeListener(
        'roomcast:before-close',
        listener,
      );
  },

  closeReady: (result) =>
    ipcRenderer.send('roomcast:close-ready', result),
});
