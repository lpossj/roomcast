const mainStartedAt = Date.now();
const { app, BrowserWindow, ipcMain, session, dialog, desktopCapturer, safeStorage, clipboard, ClipboardItem, screen, nativeImage, systemPreferences, net, shell } = require('electron');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');
let startupLogQueue = Promise.resolve();
function startupMark(stage) {
  if (!process.env.ROOMCAST_STARTUP_LOG) return;
  const entry = JSON.stringify({ stage, at: Date.now(), elapsedMs: Date.now() - mainStartedAt, pid: process.pid });
  startupLogQueue = startupLogQueue.then(() => fs.promises.appendFile(process.env.ROOMCAST_STARTUP_LOG, entry + '\n')).catch(() => {});
}
startupMark('main-entry');
const { createChromiumSessionFetch, workerRequest } = require('./worker-client.cjs');
const { resolveRuntimePaths } = require('./runtime-paths.cjs');
const { migratePreferences } = require('./preferences-migration.cjs');
const { installFloatingWindows } = require('./floating-window.cjs');
const { createWebInvite } = require('./web-invite.cjs');
const { ObsFixedFpsEngine, validateVideoSettings, waitForObsVirtualCameraAvailable } = require('./obs-fixed-fps.cjs');
const { ensureObsVirtualCameraRegistration, registrationStatus } = require('./obs-virtualcam-registration.cjs');
const { cleanText: cleanAudioText, normalizeCaptureSources, windowsAudioSources } = require('./windows-sources.cjs');
let service;
let webInvite;
let window;
let captureSources = new Map();
let captureSelection = null;
let quitting = false;
let privateSession;
let workerFetch;
let forceWindowClose = false;
let closeHandshakeTimer = null;
// Closing the window must never depend on the room handover finishing, so the window
// gets a short budget and then closes anyway; a second close request is an explicit
// "quit now" that skips the wait entirely.
const CLOSE_GRACE_MS = 2500;
// A stuck local service close or session clear must not outlive the window either.
const EXIT_GRACE_MS = 5000;
let closeRequestedAt = 0;
// Automatic update state. The updater window outlives the main window, so both are
// tracked here, and `updaterState` is the single source of truth the progress UI reads
// (the window may load after the download already started).
let updaterWindow = null;
let updaterState = { status: 'idle' };
const audioCaptures = new Map();
let LoopbackCapture;
let obsCaptureEngine = null;
let obsCaptureIdleTimer = null;
let obsCaptureActive = false;
let obsVideoPermissionUntil = 0;
let obsCaptureSessionId = '';
let obsCapturePhase = 'idle';
let obsCaptureOperationTail = Promise.resolve();

function runObsCaptureOperation(task) {
  const run = obsCaptureOperationTail.then(task, task);
  obsCaptureOperationTail = run.catch(() => {});
  return run;
}

function normalizeObsCaptureId(value) {
  const captureId = typeof value === 'string' ? value.trim() : '';
  return /^[A-Za-z0-9_-]{8,96}$/.test(captureId) ? captureId : '';
}

async function closeObsCaptureEngine({ expectedEngine = null, captureId = '' } = {}) {
  if (expectedEngine && obsCaptureEngine !== expectedEngine) return { ok: true, stale: true };
  const requestedCaptureId = normalizeObsCaptureId(captureId);
  if (requestedCaptureId && requestedCaptureId !== obsCaptureSessionId) {
    return { ok: true, stale: true, activeCaptureId: obsCaptureSessionId || null };
  }

  clearTimeout(obsCaptureIdleTimer);
  obsCaptureIdleTimer = null;
  const engine = obsCaptureEngine;
  const closedCaptureId = obsCaptureSessionId;
  obsCapturePhase = engine ? 'stopping' : 'idle';
  obsCaptureActive = false;
  obsVideoPermissionUntil = 0;
  obsCaptureSessionId = '';
  obsCaptureEngine = null;
  if (engine) await engine.close().catch(() => {});
  if (!obsCaptureEngine) obsCapturePhase = 'idle';
  return { ok: true, stale: false, captureId: closedCaptureId || null };
}

function handleObsCaptureUnexpectedExit(engine, details = {}) {
  if (obsCaptureEngine !== engine) return;
  const wasActive = obsCaptureActive;
  const endedCaptureId = obsCaptureSessionId;
  clearTimeout(obsCaptureIdleTimer);
  obsCaptureIdleTimer = null;
  obsCaptureActive = false;
  obsVideoPermissionUntil = 0;
  obsCaptureSessionId = '';
  obsCapturePhase = 'idle';
  obsCaptureEngine = null;
  if (!wasActive || !window || window.isDestroyed() || window.webContents.isDestroyed()) return;
  window.webContents.send('roomcast:obs-capture-ended', {
    captureId: endedCaptureId || null,
    reason: 'OBS 采集进程意外退出，当前屏幕共享已停止。',
    code: Number.isInteger(details.code) ? details.code : null,
    signal: details.signal ? String(details.signal).slice(0, 32) : '',
  });
}

const TITLEBAR_HEIGHT = 32;
const DEFAULT_TITLEBAR_COLOR = '#78ddbd';
function normalizeTitlebarColor(value) {
  if (typeof value !== 'string') return '';
  const match = value.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!match) return '';
  const raw = match[1].length === 3
    ? [...match[1]].map(character => character + character).join('')
    : match[1];
  return `#${raw.toLowerCase()}`;
}
function normalizeSystemAccentColor(value) {
  if (typeof value !== 'string') return '';
  const raw = value.trim().replace(/^#/, '');
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(raw)) return '';
  return `#${raw.slice(0, 6).toLowerCase()}`;
}
function currentSystemAccentColor() {
  if (process.platform !== 'win32') return DEFAULT_TITLEBAR_COLOR;
  try {
    return normalizeSystemAccentColor(systemPreferences.getAccentColor()) || DEFAULT_TITLEBAR_COLOR;
  } catch {
    try { return normalizeSystemAccentColor(systemPreferences.getColor('selected-content-background')) || DEFAULT_TITLEBAR_COLOR; } catch { return DEFAULT_TITLEBAR_COLOR; }
  }
}
function titlebarSymbolColor(color) {
  const normalized = normalizeTitlebarColor(color) || DEFAULT_TITLEBAR_COLOR;
  const red = Number.parseInt(normalized.slice(1, 3), 16);
  const green = Number.parseInt(normalized.slice(3, 5), 16);
  const blue = Number.parseInt(normalized.slice(5, 7), 16);
  const luminance = (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
  return luminance >= 150 ? '#0b1116' : '#ffffff';
}

function loadLoopbackCapture() {
  if (LoopbackCapture) return LoopbackCapture;
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('当前系统不支持游戏声音捕获（需要 Windows x64）。');
  const addon = app.isPackaged
    ? path.join(process.resourcesPath, 'runtime', 'loopback-capture', 'loopback_capture_addon.node')
    : path.join(__dirname, '..', 'runtime', 'loopback-capture', 'loopback_capture_addon.node');
  if (!fs.existsSync(addon)) throw new Error('Roomcast 游戏声音组件不完整，请重新安装完整版本。');
  ({ LoopbackCapture } = require(addon));
  if (typeof LoopbackCapture !== 'function') throw new Error('Roomcast 游戏声音组件无法加载。');
  return LoopbackCapture;
}

function stopAudioCapture(captureId, reason = '') {
  const active = audioCaptures.get(captureId);
  if (!active) return false;
  audioCaptures.delete(captureId);
  clearInterval(active.watchTimer);
  try { active.capture.stop(); } catch { }
  if (reason && !active.sender.isDestroyed()) active.sender.send('roomcast:audio-capture-ended', { captureId, reason });
  return true;
}

function stopAllAudioCaptures() {
  for (const captureId of [...audioCaptures.keys()]) stopAudioCapture(captureId);
}
async function clearChatSession() {
  if (!privateSession) return;
  await Promise.allSettled([privateSession.clearCache(), privateSession.clearStorageData(), privateSession.clearAuthCache()]);
}
function inviteFrom(args) {
  for (const arg of args) {
    if (typeof arg !== 'string' || arg.length > 7000) continue;
    try {
      const url = new URL(arg);
      const room = url.pathname.match(/^\/([a-fA-F0-9]{8})\/?$/)?.[1];
      const relay = url.searchParams.get('relay');
      const secret = url.searchParams.get('secret');
      if (url.protocol === 'roomcast:' && url.hostname === 'join' && room && /^[A-Za-z0-9_-]{43}$/.test(secret || '') && (!relay || /^[A-Za-z0-9_-]{1,6000}$/.test(relay))) return `roomcast://join/${room.toUpperCase()}?secret=${secret}${relay ? `&relay=${relay}` : ''}`;
    } catch { }
  }
  return '';
}
let pendingInvite = inviteFrom(process.argv);
if (process.env.ROOMCAST_PROFILE_DIR) {
  require('node:fs').mkdirSync(process.env.ROOMCAST_PROFILE_DIR, { recursive: true });
  app.setPath('userData', process.env.ROOMCAST_PROFILE_DIR);
}
// Keep Chromium's mDNS host-candidate privacy and hardware video decoding defaults.
// Roomcast falls back at the affected stream/encoder instead of weakening every PC.
app.commandLine.appendSwitch('force-color-profile', 'srgb');
// Development-only dual-instance support. Normal launches still keep the
// single-instance lock; start:viewer opts out after moving to an isolated profile.
const allowParallelInstance = process.env.ROOMCAST_ALLOW_PARALLEL_INSTANCE === '1';
const locked = allowParallelInstance || app.requestSingleInstanceLock();
if (!locked) app.quit();
else {
  app.on('second-instance', (_event, argv) => {
    const roomId = inviteFrom(argv);
    if (window) { if (window.isMinimized()) window.restore(); window.focus(); if (roomId) window.webContents.send('roomcast:invite', roomId); }
    else if (roomId) pendingInvite = roomId;
  });
  app.whenReady().then(async () => {
    startupMark('app-ready');
    try {
      const runtimePaths = resolveRuntimePaths({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        projectDir: path.resolve(__dirname, '..'),
        dataDir: process.env.ROOMCAST_DATA_DIR,
      });

      const obsRuntimePreflightRequested = String(process.env.ROOMCAST_OBS_PREFLIGHT_RESULT || '').trim();
      const obsRuntimePreflightResult = obsRuntimePreflightRequested ? path.resolve(obsRuntimePreflightRequested) : '';
      const obsRuntimePreflightTempRoot = path.resolve(app.getPath('temp'));
      const obsRuntimePreflightRelative = obsRuntimePreflightResult
        ? path.relative(obsRuntimePreflightTempRoot, obsRuntimePreflightResult)
        : '';
      const obsRuntimePreflightAllowed = Boolean(
        obsRuntimePreflightResult
        && (obsRuntimePreflightRelative === '' || (!obsRuntimePreflightRelative.startsWith('..') && !path.isAbsolute(obsRuntimePreflightRelative))),
      );
      if (obsRuntimePreflightAllowed) {
        const preflightEngine = new ObsFixedFpsEngine({
          runtimeRoot: runtimePaths.runtimeRoot,
          dataRoot: app.getPath('userData'),
          port: 4457,
          allowBundleOverride: !app.isPackaged,
        });
        const report = {
          ok: false,
          appIsPackaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
          execPath: process.execPath,
          runtimeRoot: runtimePaths.runtimeRoot,
          dataRoot: app.getPath('userData'),
        };
        try {
          const prepared = await preflightEngine.prepare();
          Object.assign(report, {
            ok: true,
            prepared,
          });
        } catch (error) {
          Object.assign(report, {
            ok: false,
            error: String(error?.message || error),
            code: String(error?.code || ''),
            diagnostics: Array.isArray(error?.diagnostics) ? error.diagnostics : [],
          });
        } finally {
          await preflightEngine.close().catch(() => {});
          try {
            fs.mkdirSync(path.dirname(obsRuntimePreflightResult), { recursive: true });
            fs.writeFileSync(obsRuntimePreflightResult, JSON.stringify(report, null, 2), 'utf8');
          } catch { }
          app.quit();
        }
        return;
      }

      const rootDir = runtimePaths.dataRoot;
      const getObsCaptureEngine = () => {
        if (!obsCaptureEngine) {
          let engine;
          engine = new ObsFixedFpsEngine({
            runtimeRoot: runtimePaths.runtimeRoot,
            dataRoot: app.getPath('userData'),
            port: 4457,
            allowBundleOverride: !app.isPackaged,
            onUnexpectedExit: details => handleObsCaptureUnexpectedExit(engine, details),
          });
          obsCaptureEngine = engine;
        }
        return obsCaptureEngine;
      };
      const scheduleObsCaptureIdleClose = () => {
        clearTimeout(obsCaptureIdleTimer);
        const expectedEngine = obsCaptureEngine;
        obsCaptureIdleTimer = setTimeout(() => {
          void runObsCaptureOperation(async () => {
            if (!obsCaptureActive && obsCaptureEngine === expectedEngine) {
              await closeObsCaptureEngine({ expectedEngine });
            }
          });
        }, 45_000);
      };
      const windowStatePath = path.join(app.getPath('userData'), 'window-state.json');
      const preferencesPath = path.join(app.getPath('userData'), 'preferences.bin');
      // Theme settings are intentionally stored separately from encrypted general
      // preferences.  They are non-sensitive UI values and need to survive both
      // packaged and development launches even when a different Chromium profile
      // is used or safeStorage is temporarily unavailable.
      const themePreferencesPath = path.join(app.getPath('userData'), 'theme-preferences.json');
      const legacyThemePreferencesPath = path.join(rootDir, 'theme-preferences.json');
      const preferenceKeys = new Set(['shareSettings', 'relaySettings', 'audioDevices', 'playbackVolume', 'nickname', 'server', 'autoCheckUpdates', 'dismissedUpdateVersion']);
      let preferences = {};
      let themePreferences = {};
      let loadedThemeFromStablePath = false;
      try {
        const parsed = JSON.parse(fs.readFileSync(themePreferencesPath, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          themePreferences = parsed;
          loadedThemeFromStablePath = true;
        }
      } catch { }
      if (!loadedThemeFromStablePath) {
        try {
          const parsed = JSON.parse(fs.readFileSync(legacyThemePreferencesPath, 'utf8'));
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) themePreferences = parsed;
        } catch { }
      }
      try {
        const encrypted = fs.readFileSync(preferencesPath);
        preferences = JSON.parse(safeStorage.decryptString(encrypted));
      } catch { }
      const savePreferences = () => {
        const encoded = JSON.stringify(preferences);
        if (encoded.length > 32768 || !safeStorage.isEncryptionAvailable()) return false;
        try {
          fs.mkdirSync(path.dirname(preferencesPath), { recursive: true });
          const temporary = `${preferencesPath}.tmp`;
          fs.writeFileSync(temporary, safeStorage.encryptString(encoded));
          fs.renameSync(temporary, preferencesPath);
          return true;
        } catch { return false; }
      };
      const saveThemePreferences = () => {
        const themeMode = themePreferences.themeMode === 'windows' ? 'windows' : 'custom';
        const themeColor = normalizeTitlebarColor(themePreferences.themeColor) || DEFAULT_TITLEBAR_COLOR;
        const encoded = JSON.stringify({ themeMode, themeColor });
        try {
          fs.mkdirSync(path.dirname(themePreferencesPath), { recursive: true });
          const temporary = `${themePreferencesPath}.tmp`;
          fs.writeFileSync(temporary, encoded, 'utf8');
          fs.renameSync(temporary, themePreferencesPath);
          return true;
        } catch { return false; }
      };
      const migration = migratePreferences(preferences);
      preferences = migration.preferences;
      if (migration.changed) savePreferences();
      // One-time migration from the legacy encrypted store, then keep the
      // dedicated theme file authoritative for future launches.
      if (!themePreferences.themeMode && (preferences.themeMode === 'windows' || preferences.themeMode === 'custom')) themePreferences.themeMode = preferences.themeMode;
      if (!themePreferences.themeColor && normalizeTitlebarColor(preferences.themeColor)) themePreferences.themeColor = normalizeTitlebarColor(preferences.themeColor);
      themePreferences.themeMode = themePreferences.themeMode === 'windows' ? 'windows' : 'custom';
      themePreferences.themeColor = normalizeTitlebarColor(themePreferences.themeColor) || DEFAULT_TITLEBAR_COLOR;
      saveThemePreferences();

      // On a clean Windows PC Chromium may cache its first camera-device list
      // before OBS Virtual Camera exists. Roomcast defaults to OBS capture, so
      // repair the existing V4 dual COM registration before BrowserWindow (and
      // therefore the renderer's first enumerateDevices()) is created. Users
      // who explicitly saved native capture are not prompted for OBS setup.
      const preferredCaptureBackend = preferences?.shareSettings?.captureBackend === 'native' ? 'native' : 'obs';
      if (process.platform === 'win32' && app.isPackaged && !process.env.ROOMCAST_TEST_MODE && preferredCaptureBackend === 'obs') {
        let virtualCameraReadyAtStartup = false;
        try {
          virtualCameraReadyAtStartup = registrationStatus().roomcastReady === true;
        } catch { }
        if (!virtualCameraReadyAtStartup) {
          const bootstrapEngine = new ObsFixedFpsEngine({
            runtimeRoot: runtimePaths.runtimeRoot,
            dataRoot: app.getPath('userData'),
            port: 4457,
            allowBundleOverride: false,
          });
          try {
            const bootstrapRegistration = await ensureObsVirtualCameraRegistration({
              engine: bootstrapEngine,
              dataRoot: app.getPath('userData'),
            });
            startupMark(bootstrapRegistration?.installedByRoomcast ? 'obs-vcam-prewindow-installed' : 'obs-vcam-prewindow-ready');
          } catch (error) {
            // Do not block Roomcast itself when UAC is cancelled or registration
            // fails. Native capture must still open; the OBS start path will
            // surface the concrete registration error if the user selects OBS.
            startupMark('obs-vcam-prewindow-unavailable');
          } finally {
            await bootstrapEngine.close().catch(() => {});
          }
        }
      }

      let savedWindow = {};
      try { savedWindow = JSON.parse(fs.readFileSync(windowStatePath, 'utf8')); } catch { }
      const savedBounds = savedWindow?.bounds || {};
      privateSession = session.fromPartition('roomcast-private', { cache: false });
      workerFetch = createChromiumSessionFetch(privateSession);
      const initialTitlebarColor = themePreferences.themeMode === 'windows'
        ? currentSystemAccentColor()
        : themePreferences.themeColor;
      startupMark('create-window-start');
      window = new BrowserWindow({
        width: Number.isFinite(savedBounds.width) ? Math.max(920, savedBounds.width) : 1460,
        height: Number.isFinite(savedBounds.height) ? Math.max(640, savedBounds.height) : 930,
        ...(Number.isFinite(savedBounds.x) ? { x: savedBounds.x } : {}),
        ...(Number.isFinite(savedBounds.y) ? { y: savedBounds.y } : {}),
        minWidth: 920, minHeight: 640, title: '同屏 Roomcast', backgroundColor: '#11151c',
        ...(process.platform === 'win32' ? {
          titleBarStyle: 'hidden',
          titleBarOverlay: {
            color: initialTitlebarColor,
            symbolColor: titlebarSymbolColor(initialTitlebarColor),
            height: TITLEBAR_HEIGHT,
          },
          // Keep Windows' active-window border neutral. The themed title bar is
          // controlled independently by titleBarOverlay below/at runtime.
          accentColor: false,
        } : {}),
        show: false,
        autoHideMenuBar: true,
        webPreferences: { session: privateSession, preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false, backgroundThrottling: false },
      });
      startupMark('create-window-end');
      window.once('show', () => startupMark('window-show'));
      window.webContents.once('dom-ready', () => startupMark('dom-ready'));
      window.webContents.once('did-finish-load', () => startupMark('did-finish-load'));
      if (!process.env.ROOMCAST_TEST_MODE) window.show();
      startupMark('service-import-start');
      const { startServer } = await import(pathToFileURL(path.join(__dirname, '..', 'server', 'index.mjs')).href);
      const { normalizeWorkerOrigin } = await import(pathToFileURL(path.join(__dirname, 'worker-origin.mjs')).href);
      startupMark('service-import-end');
      // The desktop UI is a local service. Let Windows assign a free port unless
      // an explicit PORT is supplied for development or automated testing.
      // This prevents another Roomcast/Node process on 3210 from blocking startup.
      // A per-process token authenticates privileged local coordinator sockets.
      // It is stored only in this non-persistent Electron session as an HttpOnly cookie.
      const localCoordinatorToken = randomUUID();
      service = await startServer({
        rootDir,
        host: '127.0.0.1',
        trustedLocalToken: localCoordinatorToken,
        ...(!process.env.PORT ? { port: 0 } : {}),
      });
      await privateSession.cookies.set({
        url: service.url,
        name: 'roomcast_internal_auth',
        value: localCoordinatorToken,
        httpOnly: true,
        sameSite: 'strict',
        path: '/',
      });
      startupMark('service-ready');
      // No persist: prefix: chat DOM, browser storage and network cache stay in memory.
      const trusted = url => { try { return new URL(url).origin === service.url; } catch { return false; } };
      webInvite = createWebInvite({
        viewerUrl: process.env.ROOMCAST_WEB_VIEWER_URL || undefined,
        onState: state => { if (window && !window.isDestroyed()) window.webContents.send('roomcast:web-invite-state', state); },
      });
      let playerWindowBounds = null;
      const defaultPlayerBounds = () => {
        const workArea = screen.getDisplayMatching(window.getBounds()).workArea;
        const width = Math.min(1460, Math.max(920, Math.floor(workArea.width * 0.9)));
        const height = Math.min(930, Math.max(640, Math.floor(workArea.height * 0.9)));
        return { x: workArea.x + Math.round((workArea.width - width) / 2), y: workArea.y + Math.round((workArea.height - height) / 2), width, height };
      };
      const validPlayerBounds = bounds => {
        if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width < 920 || bounds.height < 640) return false;
        const area = screen.getDisplayMatching(bounds).workArea;
        return bounds.width < area.width * 0.97 && bounds.height < area.height * 0.97;
      };
      privateSession.setPermissionRequestHandler((contents, permission, callback, details) => {
        const mediaTypes = details.mediaTypes || [];
        const ownWindow = contents === window?.webContents && trusted(details.requestingUrl || contents.getURL());
        const obsVideoLease = permission === 'media'
          && mediaTypes.includes('video')
          && !mediaTypes.includes('audio')
          && Date.now() <= obsVideoPermissionUntil;
        callback(ownWindow && (permission === 'fullscreen' || permission === 'display-capture' || (permission === 'media' && (!mediaTypes.includes('video') || obsVideoLease))));
      });
      privateSession.setPermissionCheckHandler((contents, permission, origin) => contents === window?.webContents && trusted(origin) && ['media', 'display-capture', 'fullscreen'].includes(permission));
      privateSession.setDisplayMediaRequestHandler(async (request, callback) => {
        const selection = captureSelection;
        captureSelection = null;
        if (!selection || Date.now() - selection.at > 10000 || request.frame !== window?.webContents.mainFrame || !trusted(request.securityOrigin)) return callback(null);
        const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } }).catch(() => []);
        const source = sources.find(item => item.id === selection.id);
        if (!source) return callback(null);
        callback({ video: source, ...(selection.audio && request.audioRequested ? { audio: 'loopback' } : {}) });
      });
      installFloatingWindows(window, trusted);
      window.webContents.on('render-process-gone', () => {
        stopAllAudioCaptures();
        void runObsCaptureOperation(() => closeObsCaptureEngine());
      });
      window.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
        if (isMainFrame && !isInPlace && obsCaptureEngine) {
          void runObsCaptureOperation(() => closeObsCaptureEngine());
        }
      });
      window.webContents.on('will-navigate', (event, url) => { if (!trusted(url)) event.preventDefault(); });
      let saveTimer;
      const writeWindowState = () => {
        if (!window || window.isDestroyed()) return;
        const value = { bounds: window.getNormalBounds(), maximized: window.isMaximized() };
        try { fs.mkdirSync(path.dirname(windowStatePath), { recursive: true }); fs.writeFileSync(windowStatePath, JSON.stringify(value)); } catch { }
      };
      const saveWindowState = () => { clearTimeout(saveTimer); saveTimer = setTimeout(writeWindowState, 250); };
      window.on('resize', saveWindowState);
      window.on('move', saveWindowState);
      window.on('maximize', saveWindowState);
      window.on('unmaximize', saveWindowState);
      window.on('close', event => {
        clearTimeout(saveTimer);
        writeWindowState();

        if (forceWindowClose || quitting || process.env.ROOMCAST_TEST_MODE) return;

        event.preventDefault();

        const now = Date.now();

        // Asking twice inside the grace window is an explicit "quit now": a stuck
        // handover, a failed migration or an unresponsive renderer must never keep
        // the program open.
        if (closeRequestedAt && now - closeRequestedAt < CLOSE_GRACE_MS) {
          forceWindowClose = true;

          if (window && !window.isDestroyed()) window.close();

          return;
        }

        closeRequestedAt = now;

        window.webContents.send('roomcast:before-close');

        if (closeHandshakeTimer) clearTimeout(closeHandshakeTimer);

        closeHandshakeTimer = setTimeout(() => {
          closeHandshakeTimer = null;
          // The handover has had its budget. Close regardless: the room server ends
          // the room when the owner socket disappears without a completed migration.
          forceWindowClose = true;

          if (window && !window.isDestroyed()) window.close();
        }, CLOSE_GRACE_MS);
      });
      ipcMain.on('roomcast:close-ready', (event, result) => {
        if (
          event.sender !== window?.webContents ||
          event.senderFrame !== window.webContents.mainFrame ||
          !trusted(event.senderFrame.url)
        ) return;

        clearTimeout(closeHandshakeTimer);
        closeHandshakeTimer = null;
        closeRequestedAt = 0;

        // A negative report is information, not a veto: the renderer has already been
        // told to leave, and the deadline decides when the window goes away.
        if (result?.ok === false) {
          console.warn('[Roomcast] 关闭窗口前房间移交未能完成：', String(result?.reason || '未说明原因').slice(0, 200));
        }

        forceWindowClose = true;

        if (window && !window.isDestroyed()) window.close();
      });
      ipcMain.on('roomcast:system-accent-color-get', event => {
        const allowed = event.sender === window?.webContents && event.senderFrame === window.webContents.mainFrame && trusted(event.senderFrame.url);
        event.returnValue = allowed ? currentSystemAccentColor() : DEFAULT_TITLEBAR_COLOR;
      });
      const handleSystemAccentChanged = (_event, color) => {
        const next = normalizeSystemAccentColor(color) || currentSystemAccentColor();
        if (window && !window.isDestroyed()) window.webContents.send('roomcast:system-accent-color-changed', next);
      };
      if (process.platform === 'win32') systemPreferences.on('accent-color-changed', handleSystemAccentChanged);
      window.once('closed', () => {
        if (process.platform === 'win32') systemPreferences.removeListener('accent-color-changed', handleSystemAccentChanged);
      });
      ipcMain.on('roomcast:titlebar-theme', (event, value) => {
        if (
          event.sender !== window?.webContents ||
          event.senderFrame !== window.webContents.mainFrame ||
          !trusted(event.senderFrame.url) ||
          process.platform !== 'win32'
        ) return;
        const color = normalizeTitlebarColor(value);
        if (!color || !window || window.isDestroyed()) return;
        window.setTitleBarOverlay({
          color,
          symbolColor: titlebarSymbolColor(color),
          height: TITLEBAR_HEIGHT,
        });
        // Do not tint the outer Windows border with the Roomcast theme color.
        // Only the title-bar overlay follows the theme.
        window.setAccentColor(false);
      });
      ipcMain.handle('roomcast:copy-text', (event, value) => {
        if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame || !trusted(event.senderFrame.url)) throw new Error('不允许此窗口写入剪贴板。');
        if (typeof value !== 'string' || value.length < 1 || value.length > 20_000) throw new Error('复制内容格式错误。');
        clipboard.writeText(value);
        return { ok: true };
      });
      ipcMain.handle('roomcast:web-invite-start', event => {
        if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame || !trusted(event.senderFrame.url)) throw new Error('不允许此窗口开启网页入口。');
        return webInvite.start();
      });
      ipcMain.handle('roomcast:web-invite-stop', event => {
        if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame || !trusted(event.senderFrame.url)) throw new Error('不允许此窗口关闭网页入口。');
        return webInvite.stop();
      });
      // Update check and automatic update. Chromium's network stack is used instead of
      // Node's fetch so the request follows the Windows proxy and certificate
      // configuration; the renderer never supplies a URL, it only names an asset from the
      // result main already holds.
      //
      // The automatic path keeps the two halves deliberately apart: update-check.mjs
      // verifies the download, update-install.mjs refuses to touch the installed program
      // unless that verification happened. Nothing on disk changes before this process is
      // about to exit.
      // The updater window outlives the main window, so neither check may touch a destroyed
      // window: reading `webContents` off a destroyed BrowserWindow throws, which would make
      // every updater-window call (status/retry/open page) fail once the main window is gone.
      const windowAlive = candidate => Boolean(candidate) && !candidate.isDestroyed();
      const owns = (event, candidate) => windowAlive(candidate)
        && event.sender === candidate.webContents
        && event.senderFrame === candidate.webContents.mainFrame
        && trusted(event.senderFrame.url);
      const requireOwner = (event, reason) => {
        if (!owns(event, window) && !owns(event, updaterWindow)) throw new Error(reason);
      };
      const requireMainWindow = (event, reason) => {
        if (!owns(event, window)) throw new Error(reason);
      };
      const loadUpdateCheck = () => import(pathToFileURL(path.join(__dirname, 'update-check.mjs')).href);
      const loadUpdateInstall = () => import(pathToFileURL(path.join(__dirname, 'update-install.mjs')).href);
      // A replacement that fails after this process is gone cannot report itself, so the
      // apply script leaves a marker the next launch reads back (see update-last-failure).
      const updateFailureMarkerPath = path.join(app.getPath('userData'), 'update-failed.txt');
      let updateChecker = null;
      let lastUpdateCheck = null;
      let updatePipeline = null;
      const ensureUpdateChecker = async () => {
        if (!updateChecker) {
          const { createUpdateChecker } = await loadUpdateCheck();
          updateChecker = createUpdateChecker({
            currentVersion: app.getVersion(),
            fetchImpl: (url, options) => net.fetch(url, options),
          });
        }
        return updateChecker;
      };
      const describeTarget = async () => {
        const { describeInstallTarget } = await loadUpdateInstall();
        return describeInstallTarget({
          platform: process.platform,
          isPackaged: app.isPackaged,
          execPath: process.execPath,
          portableExecutableFile: process.env.PORTABLE_EXECUTABLE_FILE,
          // Authoritative: the asar this process actually loaded its code from.
          appPath: app.getAppPath(),
        });
      };
      const publishUpdaterState = () => {
        if (updaterWindow && !updaterWindow.isDestroyed()) updaterWindow.webContents.send('roomcast:update-state', updaterState);
      };
      const setUpdaterState = patch => {
        updaterState = { ...updaterState, ...patch };
        publishUpdaterState();
      };
      const createUpdaterWindow = () => {
        if (updaterWindow && !updaterWindow.isDestroyed()) return updaterWindow;
        updaterWindow = new BrowserWindow({
          width: 560, height: 360, resizable: false, minimizable: false, maximizable: false,
          title: '正在更新 Roomcast', backgroundColor: '#11151c', show: false, autoHideMenuBar: true, useContentSize: true,
          webPreferences: { session: privateSession, preload: path.join(__dirname, 'updater-preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false, backgroundThrottling: false },
        });
        // Automated update checks drive this window through remote debugging; in test mode it
        // stays hidden exactly like the main window, so a scripted run never steals focus.
        const showUpdaterWindow = () => {
          if (updaterWindow && !updaterWindow.isDestroyed() && !process.env.ROOMCAST_TEST_MODE) updaterWindow.show();
        };
        updaterWindow.once('ready-to-show', showUpdaterWindow);
        updaterWindow.on('closed', () => { updaterWindow = null; });
        // The main window is already gone, so this window must become visible even if the
        // page cannot be loaded; otherwise the app would keep running with no UI at all.
        updaterWindow.webContents.on('did-fail-load', showUpdaterWindow);
        setTimeout(showUpdaterWindow, 3000);
        updaterWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        updaterWindow.webContents.on('will-navigate', event => event.preventDefault());
        void updaterWindow.loadURL(`${service.url}/updater.html`).catch(() => { });
        return updaterWindow;
      };
      // The replacement needs this process to be gone. The main window normally closes
      // immediately (the renderer finishes its room handover first), but a stuck handover
      // must not stall a deliberately automatic update forever.
      const waitForMainWindowClose = async (timeoutMs = 25000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          if (!window || window.isDestroyed()) return true;
          await new Promise(resolve => setTimeout(resolve, 250));
        }
        return !window || window.isDestroyed();
      };
      const runUpdatePipeline = async ({ target, asset, version }) => {
        let plan = null;
        let workDir = '';
        try {
          const installer = await loadUpdateInstall();
          workDir = installer.updateWorkRoot();
          const downloadDir = path.join(workDir, 'download');
          await fs.promises.mkdir(downloadDir, { recursive: true });
          const destination = path.join(downloadDir, path.basename(asset.name));
          const checker = await ensureUpdateChecker();
          setUpdaterState({ status: 'running', phase: 'connecting', version, asset: asset.name, received: 0, total: Number(asset.size) || 0, done: 0, files: 0, error: '' });
          const downloaded = await checker.download(asset, destination, lastUpdateCheck.checksumUrl, progress => {
            setUpdaterState({ phase: progress.phase, received: progress.received, total: progress.total });
          });
          setUpdaterState({ phase: 'extracting', done: 0, files: 0 });
          plan = await installer.prepareUpdateInstall({
            target,
            download: downloaded,
            pid: process.pid,
            // A portable build runs as launcher.exe -> inner Roomcast.exe, and the launcher
            // keeps the downloaded EXE locked until it exits (portable.nsi ExecWait).
            parentPid: target.kind === 'portable-exe' ? process.ppid : 0,
            failureMarkerPath: updateFailureMarkerPath,
            version,
            workDir,
            onProgress: progress => setUpdaterState({ phase: 'extracting', done: progress.done, files: progress.total }),
          });
          setUpdaterState({ phase: 'closing' });
          // Room ownership migration must not be abandoned: if the renderer refused or never
          // answered the close handshake, cancel the update instead of forcing the app down.
          if (!await waitForMainWindowClose()) {
            throw Object.assign(new Error('程序还没有退出（房间迁移可能未完成），已取消自动更新，当前安装未被修改。可点"重试"，或手动退出程序后再更新。'), { code: 'close' });
          }
          const started = installer.startApplyScript(plan.scriptPath, {
            onError: error => setUpdaterState({ status: 'failed', phase: 'failed', error: `无法启动替换脚本：${error?.message || error}` }),
          });
          if (!started.pid) throw new Error('无法启动替换脚本，更新已取消，当前安装未被修改。');
          // A pid alone is not proof the script runs: if it never writes its first log line,
          // quitting here would leave the user with a closed app and no replacement at all.
          if (!await installer.waitForApplyScriptStart(plan.logPath)) {
            throw new Error('替换脚本没有真正开始运行（可能被安全软件或受限环境拦截），已取消自动更新，当前程序未被修改。可重试，或手动下载安装包。');
          }
          // Only now is it true that the app is going down for the replacement.
          setUpdaterState({ phase: 'restarting' });
          // Let the UI paint the final state before this process disappears.
          setTimeout(() => app.quit(), 900);
        } catch (error) {
          // Nothing outside the work directory was modified yet: drop it and report. This
          // must run even when the failure happened before the plan existed, otherwise a
          // downloaded 200+ MB archive stays in %TEMP% (observed in real testing).
          const cleanupDir = plan?.workDir || workDir;
          if (cleanupDir) await fs.promises.rm(cleanupDir, { recursive: true, force: true }).catch(() => { });
          setUpdaterState({ status: 'failed', phase: 'failed', error: String(error?.message || '更新失败') });
        } finally {
          updatePipeline = null;
        }
      };
      const beginUpdate = async () => {
        if (!lastUpdateCheck?.available) throw new Error('请先检查更新。');
        if (updatePipeline) return { ok: false, reason: '更新已经开始了。' };
        const target = await describeTarget();
        if (!target.supported) return { ok: false, unsupported: true, reason: target.reason };
        if (!lastUpdateCheck.checksumUrl) return { ok: false, unsupported: true, reason: '发布页没有提供 SHA256 校验文件，无法自动更新；请手动下载安装包。' };
        const { selectInstallAsset } = await loadUpdateCheck();
        const asset = selectInstallAsset(lastUpdateCheck.assets, target.kind);
        if (!asset) return { ok: false, unsupported: true, reason: '发布页没有与当前安装方式匹配的更新包。' };
        updaterState = { status: 'running', phase: 'starting', version: lastUpdateCheck.version, asset: asset.name, received: 0, total: Number(asset.size) || 0, done: 0, files: 0, error: '' };
        createUpdaterWindow();
        publishUpdaterState();
        // Step 2 of the requested flow: close the running program, then show progress.
        // window.close() reuses the existing renderer handshake, so sharing, the room and
        // the chat session are torn down exactly as they are on a normal close.
        if (window && !window.isDestroyed()) window.close();
        updatePipeline = runUpdatePipeline({ target, asset, version: lastUpdateCheck.version });
        return { ok: true, version: lastUpdateCheck.version, kind: target.kind, asset: asset.name };
      };
      ipcMain.handle('roomcast:update-check', async event => {
        requireOwner(event, '不允许此窗口检查更新。');
        lastUpdateCheck = await (await ensureUpdateChecker()).check();
        return lastUpdateCheck;
      });
      ipcMain.handle('roomcast:update-target', async event => {
        requireOwner(event, '不允许此窗口读取更新方式。');
        const target = await describeTarget();
        return { kind: target.kind, supported: target.supported, reason: target.reason };
      });
      ipcMain.handle('roomcast:update-start', async event => {
        requireMainWindow(event, '不允许此窗口启动自动更新。');
        return beginUpdate();
      });
      ipcMain.handle('roomcast:update-status', event => {
        requireOwner(event, '不允许此窗口读取更新状态。');
        return updaterState;
      });
      ipcMain.handle('roomcast:update-retry', async event => {
        requireOwner(event, '不允许此窗口重试更新。');
        return beginUpdate();
      });
      ipcMain.handle('roomcast:update-quit', event => {
        requireOwner(event, '不允许此窗口退出程序。');
        setTimeout(() => app.quit(), 50);
        return { ok: true };
      });
      // Failure recovery: bring the program back instead of leaving the user with nothing.
      ipcMain.handle('roomcast:update-relaunch', event => {
        requireOwner(event, '不允许此窗口重新打开程序。');
        app.relaunch();
        setTimeout(() => app.quit(), 50);
        return { ok: true };
      });
      // Read-and-clear, so a failed replacement is reported exactly once.
      ipcMain.handle('roomcast:update-last-failure', event => {
        requireMainWindow(event, '不允许此窗口读取更新失败记录。');
        let marker = '';
        try { marker = fs.readFileSync(updateFailureMarkerPath, 'utf8'); } catch { return null; }
        try { fs.rmSync(updateFailureMarkerPath, { force: true }); } catch { }
        const [version = '', workDir = ''] = String(marker).split(/\r?\n/);
        return { version, workDir, logPath: workDir ? path.join(workDir, 'apply.log') : '' };
      });
      ipcMain.handle('roomcast:update-open-page', async event => {
        requireOwner(event, '不允许此窗口打开发布页。');
        const { RELEASES_PAGE } = await import(pathToFileURL(path.join(__dirname, 'update-check.mjs')).href);
        const page = String(lastUpdateCheck?.pageUrl || '');
        // The only manual route: everything else installs itself, so this must work even when
        // the API check or a download timed out.
        const target = /^https:\/\/github\.com\/lpossj\/roomcast\/releases\//.test(page) ? page : RELEASES_PAGE;
        await shell.openExternal(target);
        return { ok: true, url: target };
      });
      ipcMain.handle('roomcast:copy-image', async (event, value) => {
        if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame || !trusted(event.senderFrame.url)) throw new Error('不允许此窗口写入图片剪贴板。');
        const bytes = value instanceof Uint8Array
          ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
          : ArrayBuffer.isView(value)
            ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
            : value instanceof ArrayBuffer
              ? Buffer.from(value)
              : null;
        if (!bytes || bytes.length < 1 || bytes.length > 96 * 1024 * 1024) throw new Error('复制图片数据无效。');
        const image = nativeImage.createFromBuffer(bytes);
        if (image.isEmpty()) throw new Error('无法解析要复制的图片。');
        if (typeof clipboard.writeImage === 'function') {
          await Promise.resolve(clipboard.writeImage(image));
        } else if (typeof clipboard.write === 'function' && typeof ClipboardItem === 'function') {
          const png = image.toPNG();
          await clipboard.write([new ClipboardItem({
            'image/png': new Blob([png], { type: 'image/png' }),
          })]);
        } else {
          throw new Error('当前 Electron 版本不支持写入图片剪贴板。');
        }
        return { ok: true };
      });
      ipcMain.handle('roomcast:save-image', async (event, value, suggestedName) => {
        if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame || !trusted(event.senderFrame.url)) throw new Error('不允许此窗口保存图片。');
        const bytes = value instanceof Uint8Array
          ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
          : ArrayBuffer.isView(value)
            ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
            : value instanceof ArrayBuffer
              ? Buffer.from(value)
              : null;
        if (!bytes || bytes.length < 1 || bytes.length > 96 * 1024 * 1024) throw new Error('保存图片数据无效。');
        const image = nativeImage.createFromBuffer(bytes);
        if (image.isEmpty()) throw new Error('无法解析要保存的图片。');
        const safeBase = String(suggestedName || `roomcast-image-${Date.now()}.png`)
          .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
          .replace(/\.[^.]+$/, '')
          .trim() || `roomcast-image-${Date.now()}`;
        const result = await dialog.showSaveDialog(window, {
          title: '保存图片',
          defaultPath: `${safeBase}.png`,
          filters: [{ name: 'PNG 图片', extensions: ['png'] }],
        });
        if (result.canceled || !result.filePath) return { ok: false, canceled: true };
        await fs.promises.writeFile(result.filePath, bytes);
        return { ok: true, canceled: false };
      });
      ipcMain.handle('roomcast:audio-sources', async event => {
        if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame || !trusted(event.senderFrame.url)) throw new Error('不允许此窗口枚举声音来源。');
        return windowsAudioSources();
      });
      ipcMain.handle('roomcast:audio-capture-start', async (event, payload) => {
        if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame || !trusted(event.senderFrame.url)) throw new Error('不允许此窗口捕获声音。');
        const mode = payload?.mode;
        const processId = Number(payload?.processId);
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !['system', 'application', 'exclude'].includes(mode)) throw new Error('声音捕获参数无效。');
        if (mode === 'application' || mode === 'exclude') {
          if (!Number.isInteger(processId) || processId <= 0) throw new Error('请选择有效的声音应用。');
          // Do not re-enumerate every Windows audio session here. On some PCs CIM/WMI
          // can take many seconds and used to block an otherwise valid screen share.
          // The picker already supplied a numeric PID; only reject it if Windows says
          // that process definitely no longer exists. The capture backend remains the
          // final authority on whether this PID has a capturable audio session.
          try { process.kill(processId, 0); }
          catch (error) {
            if (error?.code === 'ESRCH') throw new Error('所选游戏或应用已经退出，请刷新后重试。');
          }
        }
        stopAllAudioCaptures();
        const Capture = loadLoopbackCapture();
        const capture = new Capture();
        const captureId = randomUUID();
        const sender = event.sender;
        const active = { capture, sender, processId: mode === 'system' ? 0 : processId, watchTimer: null };
        audioCaptures.set(captureId, active);
        const onData = chunk => {
          if (!audioCaptures.has(captureId) || sender.isDestroyed()) return void stopAudioCapture(captureId);
          if (!Buffer.isBuffer(chunk) || chunk.length === 0 || chunk.length > 1024 * 1024) return;
          sender.send('roomcast:audio-capture-data', { captureId, chunk });
        };
        try {
          if (mode === 'application') capture.start(processId, true, onData);
          else capture.start(mode === 'exclude' ? processId : process.pid, false, onData);
        } catch (error) {
          stopAudioCapture(captureId);
          throw new Error(`无法启动游戏声音捕获：${cleanAudioText(error?.message, 300)}`);
        }
        if (mode === 'application' || mode === 'exclude') {
          active.watchTimer = setInterval(() => {
            try { process.kill(processId, 0); }
            catch (error) { if (error?.code === 'ESRCH') stopAudioCapture(captureId, mode === 'exclude' ? '被排除的应用已退出，请重新选择共享声音。' : '所选游戏或应用已退出，声音共享已停止。'); }
          }, 1500);
          active.watchTimer.unref?.();
        }
        return { captureId, sampleRate: 48000, channels: 2, sampleFormat: 's16le' };
      });
      ipcMain.handle('roomcast:audio-capture-stop', (event, captureId) => {
        if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame || !trusted(event.senderFrame.url)) throw new Error('不允许此窗口停止声音捕获。');
        if (typeof captureId !== 'string' || !/^[a-f0-9-]{36}$/i.test(captureId)) throw new Error('声音捕获会话无效。');
        const active = audioCaptures.get(captureId);
        if (active && active.sender !== event.sender) throw new Error('声音捕获会话不属于当前窗口。');
        return { ok: stopAudioCapture(captureId) };
      });
      ipcMain.handle('roomcast:local', async (event, action, payload) => {
        if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame || !trusted(event.senderFrame.url)) throw new Error('不允许此窗口执行本地服务操作');
        if (typeof action !== 'string' || action.length > 64 || (payload !== undefined && (!payload || typeof payload !== 'object' || Array.isArray(payload)))) throw new Error('IPC 请求格式错误');
        if (payload && JSON.stringify(payload).length > 96_000) throw new Error('IPC 请求过大');
        if (action === 'relay:ice') {
          const saved = preferences.relaySettings && typeof preferences.relaySettings === 'object' ? preferences.relaySettings : {};
          const endpoint = typeof payload?.endpoint === 'string' ? payload.endpoint.trim() : '';
          const origin = normalizeWorkerOrigin(endpoint);
          const savedOrigin = normalizeWorkerOrigin(saved.endpoint);
          if (!origin) throw new Error('中继地址必须是安全的 HTTPS Worker 根域名。');
          if (origin !== savedOrigin || typeof saved.accessKey !== 'string' || saved.accessKey.length < 16 || saved.accessKey.length > 512) throw new Error('请先保存有效的 Worker 访问密钥。');
          const data = await workerRequest({ workerUrl: origin, accessKey: saved.accessKey }, '/', { ttl: 3600 }, { fetchImpl: workerFetch, timeoutMs: 12_000, retries: 0 });
          const input = Array.isArray(data.iceServers) ? data.iceServers : Array.isArray(data) ? data : [];
          const iceServers = input.slice(0, 8).flatMap(item => {
            const urls = (Array.isArray(item?.urls) ? item.urls : [item?.urls]).filter(value => typeof value === 'string' && /^(stun|turn|turns):/i.test(value) && value.length <= 512);
            if (!urls.length) return [];
            const clean = { urls: urls.length === 1 ? urls[0] : urls };
            if (urls.some(value => /^turns?:/i.test(value))) {
              if (typeof item.username !== 'string' || typeof item.credential !== 'string' || item.username.length > 512 || item.credential.length > 512) return [];
              clean.username = item.username; clean.credential = item.credential;
            }
            return [clean];
          });
          if (!iceServers.some(item => (Array.isArray(item.urls) ? item.urls : [item.urls]).some(value => /^turns?:/i.test(value)))) throw new Error('中继服务没有返回可用的 TURN 地址。');
          return { ok: true, iceServers, expiresAt: Date.now() + 3_600_000 };
        }
        throw new Error('不允许的本地服务操作');
      });
      ipcMain.on('roomcast:theme-settings-get', event => {
        const allowed = event.sender === window?.webContents && event.senderFrame === window.webContents.mainFrame && trusted(event.senderFrame.url);
        if (!allowed) return void (event.returnValue = { mode: 'custom', color: DEFAULT_TITLEBAR_COLOR });
        event.returnValue = {
          mode: themePreferences.themeMode === 'windows' ? 'windows' : 'custom',
          color: normalizeTitlebarColor(themePreferences.themeColor) || DEFAULT_TITLEBAR_COLOR,
        };
      });
      ipcMain.on('roomcast:theme-settings-set', (event, payload) => {
        const allowed = event.sender === window?.webContents && event.senderFrame === window.webContents.mainFrame && trusted(event.senderFrame.url);
        if (!allowed || !payload || typeof payload !== 'object' || Array.isArray(payload)) return void (event.returnValue = false);
        const nextMode = payload.mode === 'windows' ? 'windows' : 'custom';
        const nextColor = normalizeTitlebarColor(payload.color);
        if (!nextColor) return void (event.returnValue = false);
        themePreferences = { themeMode: nextMode, themeColor: nextColor };
        const saved = saveThemePreferences();
        if (saved && window && !window.isDestroyed() && process.platform === 'win32') {
          const activeColor = nextMode === 'windows' ? currentSystemAccentColor() : nextColor;
          try { window.setTitleBarOverlay({ color: activeColor, symbolColor: titlebarSymbolColor(activeColor), height: TITLEBAR_HEIGHT }); } catch { }
        }
        event.returnValue = saved;
      });
      ipcMain.on('roomcast:preference-get', (event, key) => {
        const allowed = event.sender === window?.webContents && event.senderFrame === window.webContents.mainFrame && trusted(event.senderFrame.url) && preferenceKeys.has(key);
        if (!allowed) return void (event.returnValue = undefined);
        if (key === 'relaySettings' && preferences[key] && typeof preferences[key] === 'object') {
          const { accessKey, ...safe } = preferences[key];
          return void (event.returnValue = { ...safe, accessKey: '', hasAccessKey: typeof accessKey === 'string' && accessKey.length >= 16 });
        }
        event.returnValue = preferences[key];
      });
      ipcMain.on('roomcast:preference-set', (event, payload) => {
        const allowed = event.sender === window?.webContents && event.senderFrame === window.webContents.mainFrame && trusted(event.senderFrame.url)
          && payload && preferenceKeys.has(payload.key);
        if (!allowed) return void (event.returnValue = false);
        try {
          const serialized = JSON.stringify(payload.value);
          if (serialized.length > 12000) return void (event.returnValue = false);
          if (payload.key === 'relaySettings') {
            const previous = preferences.relaySettings && typeof preferences.relaySettings === 'object' ? preferences.relaySettings : {};
            const next = payload.value && typeof payload.value === 'object' && !Array.isArray(payload.value) ? payload.value : {};
            preferences.relaySettings = { enabled: next.enabled === true, endpoint: String(next.endpoint || '').trim().slice(0, 2048), accessKey: String(next.accessKey || previous.accessKey || '').slice(0, 512) };
          } else preferences[payload.key] = payload.value;
          event.returnValue = savePreferences();
        } catch { event.returnValue = false; }
      });
      ipcMain.handle('roomcast:capture-sources', async event => {
        if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame || !trusted(event.senderFrame.url)) throw new Error('不允许此窗口枚举屏幕');
        const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
        const normalized = normalizeCaptureSources(sources);
        captureSources = new Map(normalized.map(item => [item.id, sources.find(source => source.id === item.id)]));
        return normalized;
      });
      ipcMain.handle('roomcast:obs-capture-sources', async (event, payload = {}) => {
        if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame || !trusted(event.senderFrame.url)) throw new Error('不允许此窗口枚举 OBS 采集源。');
        const settings = validateVideoSettings(payload);
        return runObsCaptureOperation(async () => {
          const engine = getObsCaptureEngine();
          try {
            // Merely selecting the OBS backend must not require Virtual Camera
            // registration. Source enumeration only needs the bundled OBS
            // runtime + websocket control. Registration is deferred until the
            // user actually starts an OBS share.
            await engine.prepare();
            await engine.launch(settings);
            const value = await engine.sources();
            scheduleObsCaptureIdleClose();
            return {
              ok: true,
              monitors: (value.monitors || []).slice(0, 32),
              windows: (value.windows || []).filter(item => !/(?:Roomcast|obs64\.exe)/i.test(String(item?.name || ''))).slice(0, 256),
            };
          } catch (error) {
            await closeObsCaptureEngine({ expectedEngine: engine });
            return {
              ok: false,
              fallbackNative: false,
              phase: 'sources',
              message: `OBS 来源读取失败：${String(error?.message || 'OBS 采集初始化失败。')}`,
            };
          }
        });
      });
      ipcMain.handle('roomcast:obs-capture-start', async (event, payload = {}) => {
        if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame || !trusted(event.senderFrame.url)) throw new Error('不允许此窗口启动 OBS 采集。');
        const settings = validateVideoSettings(payload);
        const type = payload?.sourceType === 'monitor' ? 'monitor' : payload?.sourceType === 'window' ? 'window' : '';
        const id = typeof payload?.sourceId === 'string' ? payload.sourceId.trim().slice(0, 4096) : '';
        if (!type || !id) throw new Error('OBS 采集源无效。');
        const requestedCaptureId = normalizeObsCaptureId(payload?.captureId) || randomUUID();
        return runObsCaptureOperation(async () => {
          clearTimeout(obsCaptureIdleTimer);
          obsCaptureIdleTimer = null;

          if (obsCaptureActive) {
            if (obsCaptureSessionId === requestedCaptureId && obsCaptureEngine) {
              const status = await obsCaptureEngine.status();
              return { ok: true, reused: true, captureId: obsCaptureSessionId, status };
            }
            return {
              ok: false,
              busy: true,
              fallbackNative: false,
              captureId: obsCaptureSessionId || null,
              message: 'OBS 已有一个活动采集会话，请先停止当前共享。',
            };
          }

          const engine = getObsCaptureEngine();
          obsCaptureSessionId = requestedCaptureId;
          obsCapturePhase = 'starting';
          let startPhase = 'registration';
          try {
            startPhase = 'registration';
            const registration = await ensureObsVirtualCameraRegistration({ engine, dataRoot: app.getPath('userData') });

            // If registration had to happen after BrowserWindow/Chromium already
            // started, do not poll a camera list that may remain stale for this
            // browser process. Normal clean-PC OBS launches are handled by the
            // pre-window bootstrap above; this is only a deterministic fallback
            // for cases such as cancelling the startup UAC and accepting it later.
            if (process.platform === 'win32' && app.isPackaged && registration?.installedByRoomcast) {
              await closeObsCaptureEngine({ expectedEngine: engine, captureId: requestedCaptureId });
              return {
                ok: false,
                fallbackNative: false,
                phase: 'registration',
                code: 'OBS_RESTART_REQUIRED_AFTER_INSTALL',
                message: 'OBS Virtual Camera 已完成首次注册。当前 Chromium 进程是在注册前启动的，请完全退出 Roomcast 后重新打开一次，再使用 OBS 共享。',
              };
            }

            // A clean-PC first registration necessarily restarts the OBS process.
            // The websocket client is generation-isolated, so a delayed close
            // event from the pre-registration OBS cannot invalidate this fresh
            // connection.
            startPhase = 'launch';
            await engine.launch(settings);

            // Do not treat the first 604 immediately after a fresh OBS launch as
            // permanent unavailability. On slower Windows machines the frontend
            // virtual-camera subsystem can become ready after obs-websocket.
            startPhase = 'virtual-camera-ready';
            await waitForObsVirtualCameraAvailable(engine, {
              timeoutMs: registration?.installedByRoomcast ? 15000 : 8000,
              pollMs: 200,
            });

            startPhase = 'clear-source';
            await engine.clearSource();
            startPhase = 'configure-video';
            await engine.configureVideo(settings);
            startPhase = 'select-source';
            await engine.selectSource({ type, id, cursor: payload.cursor !== false, clientArea: payload.clientArea !== false });
            startPhase = 'start-virtual-camera';
            await engine.startVirtualCamera();
            if (obsCaptureEngine !== engine || obsCaptureSessionId !== requestedCaptureId) {
              throw new Error('OBS 采集启动已被取消。');
            }
            obsCaptureActive = true;
            obsCapturePhase = 'active';
            obsVideoPermissionUntil = Date.now() + 30_000;
            startPhase = 'verify';
            const status = await engine.status();
            if (!status.running || !status.connected || !status.virtualCamActive) {
              throw new Error('OBS 采集进程未保持运行状态。');
            }
            return { ok: true, captureId: requestedCaptureId, status };
          } catch (error) {
            // Registration failures already include regsvr32/UAC/registry diagnostics.
            // For virtual-camera readiness failures, add the two COM registry
            // views explicitly. OBS 32.1.2 win-dshow needs Registry32 to expose
            // the output, while Roomcast's x64 Chromium consumer needs Registry64.
            let diagnostics = '';
            if (startPhase === 'virtual-camera-ready') {
              let registrationLine = '';
              try {
                const currentRegistration = registrationStatus();
                registrationLine = [
                  'Virtual Camera 注册状态',
                  `x86=${currentRegistration.reg32 && currentRegistration.reg32PathExists ? 'ready' : 'missing/stale'}`,
                  `x64=${currentRegistration.reg64 && currentRegistration.reg64PathExists ? 'ready' : 'missing/stale'}`,
                  currentRegistration.reg32Path ? `reg32=${currentRegistration.reg32Path}` : '',
                  currentRegistration.reg64Path ? `reg64=${currentRegistration.reg64Path}` : '',
                ].filter(Boolean).join('；');
              } catch (registrationError) {
                registrationLine = `Virtual Camera 注册状态读取失败：${String(registrationError?.message || registrationError)}`;
              }
              const obsDiagnostics = await engine.virtualCameraDiagnostics?.().catch(() => '') || '';
              diagnostics = [registrationLine, obsDiagnostics].filter(Boolean).join('\n');
            } else if (startPhase !== 'registration') {
              diagnostics = await engine.virtualCameraDiagnostics?.().catch(() => '') || '';
            }
            if (obsCaptureEngine === engine || obsCaptureSessionId === requestedCaptureId) {
              await closeObsCaptureEngine({ expectedEngine: engine, captureId: requestedCaptureId });
            }
            return {
              ok: false,
              // A transient OBS failure must not mutate the user's selected
              // backend or overwrite their saved preference. Native capture is
              // still one click away, but the real OBS error stays visible.
              fallbackNative: false,
              phase: startPhase,
              code: String(error?.code || 'OBS_START_FAILED'),
              message: `OBS 启动阶段 ${startPhase} 失败：${String(error?.message || 'OBS 采集启动失败。')}${diagnostics ? `\n${diagnostics}` : ''}`,
            };
          }
        });
      });
      ipcMain.handle('roomcast:obs-capture-stop', async (event, payload = {}) => {
        if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame || !trusted(event.senderFrame.url)) throw new Error('不允许此窗口停止 OBS 采集。');
        const requestedCaptureId = normalizeObsCaptureId(payload?.captureId);
        return runObsCaptureOperation(() => closeObsCaptureEngine({ captureId: requestedCaptureId }));
      });
      ipcMain.handle('roomcast:obs-capture-status', async event => {
        if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame || !trusted(event.senderFrame.url)) throw new Error('不允许此窗口读取 OBS 状态。');
        return runObsCaptureOperation(async () => {
          if (!obsCaptureEngine) {
            return { prepared: false, running: false, connected: false, active: false, phase: obsCapturePhase, captureId: null };
          }
          const status = await obsCaptureEngine.status();
          return { ...status, active: obsCaptureActive, phase: obsCapturePhase, captureId: obsCaptureSessionId || null };
        });
      });

      ipcMain.handle('roomcast:fullscreen-prepare', event => {
        if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame || !trusted(event.senderFrame.url)) throw new Error('不允许此窗口切换全屏。');
        const bounds = window.getBounds();
        playerWindowBounds = !window.isMaximized() && !window.isFullScreen() && validPlayerBounds(bounds) ? bounds : defaultPlayerBounds();
        return true;
      });
      ipcMain.handle('roomcast:fullscreen-finish', event => {
        if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame || !trusted(event.senderFrame.url)) throw new Error('不允许此窗口恢复尺寸。');
        const bounds = validPlayerBounds(playerWindowBounds) ? playerWindowBounds : defaultPlayerBounds();
        playerWindowBounds = null;
        setTimeout(() => {
          if (!window || window.isDestroyed()) return;
          if (window.isMaximized()) window.unmaximize();
          if (window.isFullScreen()) window.setFullScreen(false);
          window.setBounds(bounds, false);
        }, 80);
        return true;
      });
      ipcMain.on('roomcast:capture-select', (event, payload) => {
        const allowed = event.sender === window?.webContents && event.senderFrame === window.webContents.mainFrame && trusted(event.senderFrame.url) && payload && captureSources.has(payload.id);
        captureSelection = allowed ? { id: payload.id, audio: payload.audio === true, at: Date.now() } : null;
        event.returnValue = allowed;
      });
      startupMark('load-start');
      await window.loadURL(service.url + (pendingInvite ? `/?room=${encodeURIComponent(pendingInvite)}` : ''));
      startupMark('load-end');
      if (savedWindow?.maximized) window.maximize();
      // Neither default-session cleanup nor protocol registration is needed to
      // render the private-session UI. Keep both off the first-window path.
      setImmediate(() => {
        if (quitting || !window || window.isDestroyed()) return;
        if (app.isPackaged && !process.env.ROOMCAST_TEST_MODE) {
          app.setAsDefaultProtocolClient('roomcast', process.env.PORTABLE_EXECUTABLE_FILE || process.execPath);
        }
        void Promise.allSettled([session.defaultSession.clearCache(), session.defaultSession.clearStorageData()])
          .then(() => startupMark('maintenance-end'));
        // A previous automatic update cannot delete its own temporary directory; do it here
        // once the app is up again (anything newer than ten minutes is left alone).
        void loadUpdateInstall()
          .then(module => module.cleanupStaleUpdateWorkDirs())
          .catch(() => { });
      });
    } catch (e) {
      dialog.showErrorBox('同屏启动失败', `${e.message}\n\n请关闭其他正在运行的 Roomcast 后重试；若仍失败，请查看使用说明。`);
      stopAllAudioCaptures(); await webInvite?.stop(); await service?.close(); app.quit();
    }
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (quitting || !service) return;
    event.preventDefault(); quitting = true;
    stopAllAudioCaptures();
    // Hard stop for the quitting path: a local service close that waits on a lingering
    // connection, or session clearing that never settles, must not prevent the exit.
    const hardExit = setTimeout(() => app.exit(0), EXIT_GRACE_MS);
    void Promise.allSettled([service.close(), webInvite?.stop(), runObsCaptureOperation(() => closeObsCaptureEngine())]).finally(async () => {
      await Promise.race([clearChatSession(), new Promise(resolve => setTimeout(resolve, 1000))]).catch(() => { });
      clearTimeout(hardExit);
      app.exit(0);
    });
  });
}
