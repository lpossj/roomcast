import { Info, LoaderCircle, LogOut, Monitor, ScreenShare, Settings, Square, UserPlus, X, ZoomIn, ZoomOut } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import ScreenPlayer from './ScreenPlayer.jsx';
import { useLaser } from './useLaser.js';
import { safeAvatar, prepareAvatarForRoom } from './Avatar.jsx';
import { usePanelWidths } from './PanelResizeHandle.jsx';
import { VoiceControls } from './ProfileAudioSettings.jsx';
import useRoomVoice from './useRoomVoice.js';
import useBackgroundStatus from './useBackgroundStatus.js';
import useAppearance from './useAppearance.js';
import useDevices from './useDevices.js';
import useRoom from './useRoom.js';
import { useGpuSettings } from './lib/useGpuSettings.js';
import { playSound } from './sounds.js';
import { attachNativeAudio, startIntegratedCapture, startObsFixedFpsCapture } from './lib.js';
import { loadPreference, savePreference } from './preferences.js';
import { loadRelaySettings, saveRelaySettings } from './relay.js';
import { browserCapabilities } from './browser-capabilities.js';
import { startCameraCapture } from './browser-capture.js';
import { readPageInvite } from './invite-entry.js';
import { ack } from './lib.js';
import {
  applyThemeColor,
  DEFAULT_THEME_COLOR,
  loadThemeSettings,
  loadWindowsAccentColor,
  normalizeThemeColor,
  normalizeThemeMode,
  THEME_MODE_CUSTOM,
  THEME_MODE_WINDOWS,
} from './lib/theme.js';
import {
  APP_VERSION,
  clampPreviewScale,
  cleanIpcError,
  LATENCY_POLL_MS,
  LATENCY_TIMEOUT_MS,
  latencyToneFor,
  MAX_CHAT_IMAGES,
  PREVIEW_SCALE_MAX,
  PREVIEW_SCALE_MIN,
  PREVIEW_SCALE_STEP,
  previewCardWidthFor,
  shrinkForSharing,
} from './lib/previewLayout.js';
import StudioTopbar from './components/StudioTopbar.jsx';
import MembersPanel from './components/MembersPanel.jsx';
import EmptyScreen from './components/EmptyScreen.jsx';
import EntryModal from './components/EntryModal.jsx';
import ShareModal from './components/ShareModal.jsx';
import InviteModal from './components/InviteModal.jsx';
import SettingsDrawer, { UpdatePromptModal } from './components/SettingsDrawer.jsx';
import MemberPermissionsModal from './components/MemberPermissionsModal.jsx';
import ChatPanel from './components/ChatPanel.jsx';
import ImagePreviewOverlay from './components/ImagePreviewOverlay.jsx';

const initialInvite = readPageInvite(window);
const INITIAL_THEME_SETTINGS = loadThemeSettings();
const INITIAL_THEME_MODE = INITIAL_THEME_SETTINGS.mode;
const INITIAL_CUSTOM_THEME_COLOR = INITIAL_THEME_SETTINGS.color;
const INITIAL_WINDOWS_ACCENT_COLOR = loadWindowsAccentColor();
applyThemeColor(INITIAL_THEME_MODE === THEME_MODE_WINDOWS ? INITIAL_WINDOWS_ACCENT_COLOR : INITIAL_CUSTOM_THEME_COLOR);

export default function App() {
  const desktopChrome = window.roomcast?.desktop === true;
  const [cameraPermission, setCameraPermission] = useState('prompt');
  const capabilities = browserCapabilities(window, cameraPermission);
  const canShareScreen = desktopChrome || capabilities.screen || capabilities.camera;
  const canHostRoom = desktopChrome || capabilities.host;

  useEffect(() => {
    if (desktopChrome || !navigator.permissions?.query) return undefined;
    let active = true;
    let status;
    const changed = () => { if (active) setCameraPermission(status.state); };
    navigator.permissions.query({ name: 'camera' }).then(value => {
      if (!active) return;
      status = value;
      changed();
      status.addEventListener('change', changed);
    }).catch(() => { });
    return () => { active = false; status?.removeEventListener('change', changed); };
  }, [desktopChrome]);

  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);
  const notify = useCallback(text => {
    clearTimeout(toastTimer.current);
    setToast({ text });
    toastTimer.current = setTimeout(() => setToast(null), 8500);
  }, []);

  const roomAction = useRef(0);
  const session = useRoom(notify);
  const { room, selfId, server, config, connection, socketRef, messages, hasOlderMessages, historyLoading, loadOlderMessages, sendMessage, sendImages, recallMessage, enter, leave, command } = session;
  const laser = useLaser({ room, selfId, socketRef });
  const [globalLaserPending, setGlobalLaserPending] = useState(false);
  const audioDevices = useDevices();
  const [avatar, setAvatar] = useState(() => safeAvatar(loadPreference('avatar', '')));
  const profilePending = useRef(false);
  const voice = useRoomVoice({ room, selfId, socket: socketRef.current, config, devicePreferences: audioDevices.preferences });
  const selfAvatar = room?.members.find(member => member.id === selfId)?.avatar || '';
  const animatedAvatars = room?.features?.animatedAvatars === 1;

  useEffect(() => {
    if (room?.features?.profiles !== 1 || !room?.id || !selfId || profilePending.current) return;
    let cancelled = false;
    void prepareAvatarForRoom(avatar, animatedAvatars).then(value => {
      if (!cancelled && !profilePending.current && selfAvatar !== value) return command('member:profile', { avatar: value });
    }).catch(failure => { if (!cancelled) notify(failure.message); });
    return () => { cancelled = true; };
  }, [room?.id, room?.features?.profiles, selfId, selfAvatar, avatar, animatedAvatars, command, notify]);

  useEffect(() => { if (voice.error) notify(voice.error); }, [voice.error, notify]);

  const changeAvatar = async value => {
    const socket = socketRef.current;
    profilePending.current = true;
    try {
      if (room?.features?.profiles === 1) {
        const outgoing = await prepareAvatarForRoom(value, animatedAvatars);
        if (socketRef.current === socket) await command('member:profile', { avatar: outgoing });
      }
      savePreference('avatar', value);
      setAvatar(value);
    } finally {
      profilePending.current = false;
    }
  };

  const [relaySettings, setRelaySettingsState] = useState(loadRelaySettings);
  const [themeColor, setThemeColorState] = useState(INITIAL_CUSTOM_THEME_COLOR);
  const [themeMode, setThemeModeState] = useState(INITIAL_THEME_MODE);
  const [windowsAccentColor, setWindowsAccentColor] = useState(INITIAL_WINDOWS_ACCENT_COLOR);
  const effectiveThemeColor = themeMode === THEME_MODE_WINDOWS ? windowsAccentColor : themeColor;

  const persistThemeSettings = useCallback((mode, color) => {
    try {
      return window.roomcast?.setThemeSettings?.({ mode: normalizeThemeMode(mode), color: normalizeThemeColor(color) }) === true;
    } catch {
      return false;
    }
  }, []);

  const setThemeColor = useCallback(value => {
    const nextColor = normalizeThemeColor(value);
    const nextMode = THEME_MODE_CUSTOM;
    persistThemeSettings(nextMode, nextColor);
    setThemeColorState(nextColor);
    setThemeModeState(nextMode);
  }, [persistThemeSettings]);

  const setThemeMode = useCallback(value => {
    const nextMode = desktopChrome ? normalizeThemeMode(value) : THEME_MODE_CUSTOM;
    persistThemeSettings(nextMode, themeColor);
    setThemeModeState(nextMode);
    if (nextMode === THEME_MODE_WINDOWS) {
      try { setWindowsAccentColor(normalizeThemeColor(window.roomcast?.getSystemAccentColor?.() || DEFAULT_THEME_COLOR)); } catch { }
    }
  }, [desktopChrome, persistThemeSettings, themeColor]);

  useEffect(() => { applyThemeColor(effectiveThemeColor); }, [effectiveThemeColor]);
  useEffect(() => window.roomcast?.onSystemAccentColor?.(color => setWindowsAccentColor(normalizeThemeColor(color))), []);

  const setRelaySettings = useCallback(value => {
    const next = typeof value === 'function' ? value(loadRelaySettings()) : value;
    saveRelaySettings(next);
    setRelaySettingsState(next);
  }, []);

  const [modal, setModal] = useState(initialInvite ? 'join' : null);
  const [managedMember, setManagedMember] = useState(null);
  const [inviteRoom, setInviteRoom] = useState(initialInvite);

  useEffect(() => window.roomcast?.onInvite?.(roomId => { setInviteRoom(roomId); setModal('join'); }), []);
  useEffect(() => {
    const showInvite = () => {
      const invite = readPageInvite(window, false);
      if (!invite) return;
      roomAction.current++;
      if (connection === 'connecting') void leave(true);
      setInviteRoom(invite);
      setModal('join');
    };
    window.addEventListener('hashchange', showInvite);
    window.addEventListener('popstate', showInvite);
    return () => {
      window.removeEventListener('hashchange', showInvite);
      window.removeEventListener('popstate', showInvite);
    };
  }, [connection, leave]);

  useEffect(() => {
    if (!desktopChrome || !window.roomcast?.setTitleBarTheme) return undefined;
    let previous = '';
    const syncTitlebar = () => {
      const color = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
      if (!/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(color) || color === previous) return;
      const raw = color.slice(1);
      const full = raw.length === 3 ? [...raw].map(ch => ch + ch).join('') : raw;
      const red = Number.parseInt(full.slice(0, 2), 16);
      const green = Number.parseInt(full.slice(2, 4), 16);
      const blue = Number.parseInt(full.slice(4, 6), 16);
      const luminance = (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
      document.documentElement.style.setProperty('--titlebar-foreground', luminance >= 150 ? '#091017' : '#ffffff');
      previous = color;
      window.roomcast.setTitleBarTheme(color);
    };
    syncTitlebar();
    const observer = new MutationObserver(syncTitlebar);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
    if (document.body) observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
    return () => observer.disconnect();
  }, [desktopChrome]);

  const [localConfig, setLocalConfig] = useState(null);
  const [shareBusy, setShareBusy] = useState(false);
  const [chat, setChat] = useState('');
  const [sending, setSending] = useState(false);
  const [sendingImage, setSendingImage] = useState(false);
  const [pendingImages, setPendingImages] = useState([]);
  const pendingImagesRef = useRef([]);
  const [chatDragActive, setChatDragActive] = useState(false);
  const chatDragDepth = useRef(0);
  const [previewImage, setPreviewImage] = useState(null);
  const [imageContextMenu, setImageContextMenu] = useState(null);
  const imageInput = useRef(null);

  useEffect(() => { pendingImagesRef.current = pendingImages; }, [pendingImages]);

  const clearPendingImages = useCallback(() => {
    setPendingImages(current => {
      current.forEach(item => { if (item.objectUrl) URL.revokeObjectURL(item.objectUrl); });
      return [];
    });
  }, []);

  useEffect(() => {
    if (!room) {
      void window.roomcast?.stopWebInvite?.();
      setChat('');
      clearPendingImages();
      chatDragDepth.current = 0;
      setChatDragActive(false);
    }
  }, [room, clearPendingImages]);

  useEffect(() => () => {
    pendingImagesRef.current.forEach(item => { if (item.objectUrl) URL.revokeObjectURL(item.objectUrl); });
  }, []);

  useEffect(() => {
    if (!imageContextMenu) return undefined;
    const closeMenu = () => setImageContextMenu(null);
    const closeOnKey = event => { if (event.key === 'Escape') closeMenu(); };
    document.addEventListener('pointerdown', closeMenu);
    document.addEventListener('scroll', closeMenu, true);
    document.addEventListener('keydown', closeOnKey);
    window.addEventListener('blur', closeMenu);
    window.addEventListener('resize', closeMenu);
    return () => {
      document.removeEventListener('pointerdown', closeMenu);
      document.removeEventListener('scroll', closeMenu, true);
      document.removeEventListener('keydown', closeOnKey);
      window.removeEventListener('blur', closeMenu);
      window.removeEventListener('resize', closeMenu);
    };
  }, [imageContextMenu]);

  const [compactPanels, setCompactPanels] = useState(() => window.matchMedia('(max-width: 850px)').matches);
  const [openDrawer, setOpenDrawer] = useState(null);
  const [wideChat, setWideChat] = useState(true);
  const [wideMembers, setWideMembers] = useState(() => window.innerWidth > 1060);
  const showChat = compactPanels ? openDrawer === 'chat' : wideChat;
  const showMembers = compactPanels ? openDrawer === 'members' : wideMembers;
  useEffect(() => {
    const query = window.matchMedia('(max-width: 850px)');
    const sync = () => {
      setCompactPanels(query.matches);
      setOpenDrawer(null);
    };
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);
  useEffect(() => { setOpenDrawer(null); }, [room?.id]);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (desktopChrome || !viewport) return;
    const root = document.documentElement;
    // Some mobile keyboards resize only the visual viewport. Keep the chat
    // composer and open dialog inside it without interfering with pinch zoom.
    const sync = () => {
      if (viewport.scale === 1 && viewport.height + 1 < root.clientHeight) {
        root.style.setProperty('--web-visible-height', `${viewport.height}px`);
        root.style.setProperty('--web-visible-top', `${viewport.offsetTop}px`);
      } else {
        root.style.removeProperty('--web-visible-height');
        root.style.removeProperty('--web-visible-top');
      }
    };
    sync();
    viewport.addEventListener('resize', sync);
    viewport.addEventListener('scroll', sync);
    return () => {
      viewport.removeEventListener('resize', sync);
      viewport.removeEventListener('scroll', sync);
      root.style.removeProperty('--web-visible-height');
      root.style.removeProperty('--web-visible-top');
    };
  }, [desktopChrome]);
  const [settingsSection, setSettingsSection] = useState('general');
  const [unreadChat, setUnreadChat] = useState(false);
  const lastSeenMessageCount = useRef(0);
  const [previewScale, setPreviewScale] = useState(1);
  const [latencyMs, setLatencyMs] = useState(null);
  const [screenGridWidth, setScreenGridWidth] = useState(0);
  const screenGridRef = useRef(null);
  const chatList = useRef(null);
  const chatEnd = useRef(null);
  const stickToChatEnd = useRef(true);
  const ownsCapture = useRef(false);
  const watchingStreams = useRef(new Set());
  const activeRoomId = useRef(null);
  activeRoomId.current = room?.id || null;

  const self = room?.members.find(member => member.id === selfId);
  const canManageGlobalLaser = room?.features?.laser === 1 && ['owner', 'admin'].includes(self?.role);
  const toggleGlobalLaser = async () => {
    if (!canManageGlobalLaser || globalLaserPending) return;
    setGlobalLaserPending(true);
    try { await command('laser:global-permission', { enabled: room.laserEnabled === false }); }
    catch (error) { notify(error.message); }
    finally { setGlobalLaserPending(false); }
  };

  const streams = room?.streams || [];
  const ownShare = streams.some(stream => stream.memberId === selfId);
  const panels = usePanelWidths(Boolean(room) && showChat);
  const appearance = useAppearance();
  const gpu = useGpuSettings();
  useBackgroundStatus({ desktop: desktopChrome, room, sharing: ownShare });

  useEffect(() => {
    if (!room || showChat) {
      lastSeenMessageCount.current = messages.length;
      setUnreadChat(false);
      return;
    }
    if (messages.length > lastSeenMessageCount.current) {
      setUnreadChat(true);
    }
    lastSeenMessageCount.current = messages.length;
  }, [room, showChat, messages.length]);

  const openSettings = (section = 'general') => {
    setSettingsSection(section);
    setModal('settings');
  };

  const previewCardWidth = previewCardWidthFor(streams.length, screenGridWidth, previewScale);
  const latencyTone = latencyToneFor(latencyMs);

  useEffect(() => { setPreviewScale(1); }, [room?.id]);

  useEffect(() => {
    let stopped = false;
    let timer = null;
    let running = false;
    let failures = 0;

    if (!room?.id || connection !== 'connected') {
      setLatencyMs(null);
      return undefined;
    }

    const schedule = () => {
      const interval = (!gpu.isForegroundActive && gpu.settings.lowPowerBackground)
        ? 10000
        : LATENCY_POLL_MS;
      if (!stopped) timer = setTimeout(measure, interval);
    };

    const measure = async () => {
      if (stopped || running) return;
      const socket = socketRef.current;
      if (!socket?.connected) {
        failures += 1;
        if (failures >= 2) setLatencyMs(null);
        schedule();
        return;
      }

      running = true;
      const startedAt = performance.now();

      try {
        await ack(socket, 'room:ping', {}, LATENCY_TIMEOUT_MS);
        if (stopped || socket !== socketRef.current) return;
        failures = 0;
        setLatencyMs(Math.max(0, Math.round(performance.now() - startedAt)));
      } catch {
        if (!stopped) {
          failures += 1;
          if (failures >= 2) setLatencyMs(null);
        }
      } finally {
        running = false;
        schedule();
      }
    };

    void measure();
    return () => { stopped = true; clearTimeout(timer); };
  }, [room?.id, connection, socketRef, gpu.isForegroundActive, gpu.settings.lowPowerBackground]);

  useEffect(() => {
    const grid = screenGridRef.current;
    if (!grid) { setScreenGridWidth(0); return undefined; }
    const measure = () => setScreenGridWidth(Math.round(grid.getBoundingClientRect().width));
    measure();
    if (typeof ResizeObserver !== 'function') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    return () => observer.disconnect();
  }, [streams.length]);

  useEffect(() => {
    const grid = screenGridRef.current;
    if (!grid) return undefined;
    const handlePreviewWheel = event => {
      if (!event.ctrlKey) return;
      if (event.target.closest?.('.player-controls, .player-top, .exit-view-button, button, input, textarea, select')) return;
      event.preventDefault();
      event.stopPropagation();
      const direction = event.deltaY < 0 ? 1 : -1;
      setPreviewScale(current => clampPreviewScale(current + (direction * PREVIEW_SCALE_STEP)));
    };
    grid.addEventListener('wheel', handlePreviewWheel, { passive: false });
    return () => grid.removeEventListener('wheel', handlePreviewWheel);
  }, [streams.length]);

  useEffect(() => {
    const activeKeys = new Set((room?.streams || []).map(stream => `${stream.memberId}:${stream.startedAt ?? ''}`));
    for (const key of watchingStreams.current) if (!activeKeys.has(key)) watchingStreams.current.delete(key);
  }, [room?.streams]);

  const stopLocalShare = useCallback(async (socket = socketRef.current) => {
    window.roomcast?.desktopLaser?.({ captureStopped: true });
    socket?.stopScreenStream?.();
  }, [socketRef]);

  const refresh = useCallback(async () => {
    if (!desktopChrome) return;
    await fetch('/api/config')
      .then(response => { if (!response.ok) throw new Error('本地服务未启动'); return response.json(); })
      .then(setLocalConfig)
      .catch(() => setLocalConfig(null));
  }, [desktopChrome]);

  useEffect(() => { refresh(); return () => clearTimeout(toastTimer.current); }, [refresh]);
  useEffect(() => {
    const ended = event => notify(event.detail || '声音来源已不可用。');
    window.addEventListener('roomcast:audio-capture-ended', ended);
    return () => window.removeEventListener('roomcast:audio-capture-ended', ended);
  }, [notify]);

  useEffect(() => { if (stickToChatEnd.current) chatEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [messages.at(-1)?.seq]);
  useEffect(() => {
    if ((!room || self?.canShare === false) && ownsCapture.current) {
      ownsCapture.current = false;
      stopLocalShare().catch(error => notify(`停止采集失败：${error.message}`));
    }
  }, [room, self?.canShare, notify, stopLocalShare]);

  useEffect(() => {
    const unload = event => {
      if (event.type === 'pagehide' && event.persisted) return;
      if (!window.roomcast?.desktop) { void leave(true); return; }
      if (ownsCapture.current) socketRef.current?.stopScreenStream?.();
    };
    if (desktopChrome) window.addEventListener('beforeunload', unload);
    window.addEventListener('pagehide', unload);
    return () => { window.removeEventListener('beforeunload', unload); window.removeEventListener('pagehide', unload); };
  }, [leave, desktopChrome, socketRef]);

  const copy = async text => {
    try {
      if (window.roomcast?.desktop && window.roomcast?.copyText) {
        const result = await window.roomcast.copyText(text);
        if (!result?.ok) throw new Error('Electron 剪贴板写入失败');
      } else if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else {
        const input = document.createElement('textarea');
        input.value = text;
        input.style.position = 'fixed';
        input.style.opacity = '0';
        document.body.append(input);
        input.select();
        const ok = document.execCommand('copy');
        input.remove();
        if (!ok) throw new Error('请手动选择并复制内容');
      }
    } catch (error) {
      notify(`复制失败：${error.message}`);
    }
  };

  const handleEnter = async (mode, details) => {
    if (mode === 'create' && !canHostRoom) {
      setModal(null);
      notify('网页端只用于用邀请链接加入并观看；请在电脑上用 Roomcast 客户端创建房间。');
      return;
    }
    const action = ++roomAction.current;
    const result = await enter(mode, { ...details, relaySettings });
    if (action === roomAction.current && !result?.cancelled) setModal(null);
  };

  const cancelEntry = () => {
    roomAction.current++;
    if (connection === 'connecting') void leave(true);
    setModal(null);
  };

  const handleLeave = async () => {
    const action = ++roomAction.current;
    setModal(null);
    const socket = socketRef.current;
    if (socket?.connected) playSound('leave');
    if (ownsCapture.current) {
      ownsCapture.current = false;
      void stopLocalShare(socket).catch(error => { if (action === roomAction.current) notify(`停止采集失败：${error.message}`); });
    }
    try {
      const outcome = await leave(true);
      if (action !== roomAction.current) return;
      setChat('');
      refresh();
      if (outcome?.closed) notify(outcome.reason || '房间已关闭。');
    } catch (error) {
      if (action === roomAction.current) notify(error.message);
    }
  };

  const [update, setUpdate] = useState({ status: 'idle', result: null, error: '' });
  const [autoCheckUpdates, setAutoCheckUpdates] = useState(() => loadPreference('autoCheckUpdates', true));
  const updateAvailable = Boolean(update.result?.available);

  const checkUpdates = useCallback(async () => {
    if (!window.roomcast?.checkForUpdates) return;
    setUpdate(current => ({ ...current, status: 'checking', error: '' }));
    try {
      const result = await window.roomcast.checkForUpdates();
      setUpdate(current => ({ ...current, status: 'done', result: result || null }));
    } catch (error) {
      setUpdate(current => ({ ...current, status: 'done', error: cleanIpcError(error) }));
    }
  }, []);

  useEffect(() => {
    if (!desktopChrome || !autoCheckUpdates) return undefined;
    const timer = setTimeout(() => { void checkUpdates(); }, 4000);
    return () => clearTimeout(timer);
  }, [desktopChrome, autoCheckUpdates, checkUpdates]);

  const [updateInstall, setUpdateInstall] = useState({ busy: false, error: '', supported: false, kind: '', reason: '' });
  const [dismissedUpdateVersion, setDismissedUpdateVersion] = useState(() => String(loadPreference('dismissedUpdateVersion', '') || ''));
  const [updatePrompt, setUpdatePrompt] = useState({ open: false, dontRemind: false });
  const promptedUpdateVersion = useRef('');

  useEffect(() => {
    if (!desktopChrome || !window.roomcast?.updateTarget) return undefined;
    let cancelled = false;
    window.roomcast.updateTarget()
      .then(target => { if (!cancelled) setUpdateInstall(current => ({ ...current, ...target })); })
      .catch(() => { });
    return () => { cancelled = true; };
  }, [desktopChrome]);

  useEffect(() => {
    if (!desktopChrome || !window.roomcast?.takeUpdateFailure) return undefined;
    let cancelled = false;
    window.roomcast.takeUpdateFailure()
      .then(failure => {
        if (cancelled || !failure?.version) return;
        setUpdateInstall(current => ({ ...current, error: `上次自动更新到 ${failure.version} 失败，当前仍是旧版本。` }));
        notify(`上次自动更新到 ${failure.version} 失败，已保留旧版本${failure.logPath ? `；日志：${failure.logPath}` : ''}`);
      })
      .catch(() => { });
    return () => { cancelled = true; };
  }, [desktopChrome, notify]);

  useEffect(() => {
    const result = update.result;
    if (!desktopChrome || !result?.available) return;
    if (modal) return;
    const version = String(result.version || '');
    if (!version || version === dismissedUpdateVersion) return;
    if (promptedUpdateVersion.current === version) return;
    promptedUpdateVersion.current = version;
    setUpdatePrompt({ open: true, dontRemind: false });
  }, [desktopChrome, update.result, dismissedUpdateVersion, modal]);

  const rememberDismissedVersion = () => {
    const version = String(update.result?.version || '');
    if (!updatePrompt.dontRemind || !version) return;
    setDismissedUpdateVersion(version);
    savePreference('dismissedUpdateVersion', version);
  };
  const closeUpdatePrompt = () => { rememberDismissedVersion(); setUpdatePrompt({ open: false, dontRemind: false }); };
  const startAutoUpdate = async () => {
    if (!window.roomcast?.startAutomaticUpdate) return;
    rememberDismissedVersion();
    setUpdateInstall(current => ({ ...current, busy: true, error: '' }));
    try {
      const result = await window.roomcast.startAutomaticUpdate();
      if (result?.ok === false) {
        setUpdateInstall(current => ({ ...current, busy: false, supported: result.unsupported ? false : current.supported, error: result.reason || '无法自动更新。' }));
        return;
      }
      setUpdateInstall(current => ({ ...current, busy: false }));
    } catch (error) {
      setUpdateInstall(current => ({ ...current, busy: false, error: cleanIpcError(error) }));
    }
  };

  const startShare = async options => {
    if (!room || shareBusy) return;
    const screenSocket = socketRef.current;
    const expectedRoom = room.id;
    const expectedSocket = screenSocket?.id;
    let claimed = false;
    let captured = null;
    const captureOptions = { ...options, inputDeviceId: audioDevices.preferences.inputId, outputDeviceId: audioDevices.preferences.outputId };
    const nativeShareAudio = Boolean(window.roomcast?.startAudioCapture && /(?:system|application|exclude)/.test(String(options.audioMode || '')));
    const captureRequest = nativeShareAudio ? { ...captureOptions, systemAudio: false, microphone: false } : captureOptions;
    const captureFactory = options.sourceType === 'camera' ? startCameraCapture : options.captureBackend === 'obs' ? startObsFixedFpsCapture : startIntegratedCapture;
    // Retry incomplete desktop setup on an explicit share action. Preserve the
    // browser's immediate capture call and its transient user activation.
    const captureTask = window.roomcast?.prepareNetwork
      ? window.roomcast.prepareNetwork().catch(() => null).then(() => captureFactory(captureRequest))
      : captureFactory(captureRequest);
    const capturePromise = captureTask.then(stream => ({ stream }), error => ({ error }));
    setShareBusy(true);
    try {
      await command('share:claim');
      claimed = true;
      const capture = await capturePromise;
      if (capture.error) throw capture.error;
      captured = capture.stream;
      if (nativeShareAudio) captured = await attachNativeAudio(captured, captureOptions);
      if (!screenSocket?.mediaP2P) throw new Error('当前房间不支持原生 WebRTC 屏幕共享。');
      const capturedVideoTrack = captured.getVideoTracks()[0] || null;
      let captureEnded = capturedVideoTrack?.readyState === 'ended';
      let captureEndedReason = String(capturedVideoTrack?.roomcastBackendEndedReason || '');
      capturedVideoTrack?.addEventListener('ended', event => {
        const endedTrack = event.currentTarget;
        captureEnded = true;
        captureEndedReason = String(endedTrack?.roomcastBackendEndedReason || captureEndedReason || '');
        if (!ownsCapture.current || socketRef.current !== screenSocket) return;
        ownsCapture.current = false;
        window.roomcast?.desktopLaser?.({ captureStopped: true });
        screenSocket?.stopScreenStream?.();
        command('share:stop').catch(() => { });
        if (captureEndedReason) notify(captureEndedReason);
      }, { once: true });
      screenSocket.setScreenStream(captured, options);
      if (activeRoomId.current !== expectedRoom || socketRef.current?.id !== expectedSocket) throw new Error('房间连接已变化，已取消屏幕共享');
      if (captureEnded || capturedVideoTrack?.readyState === 'ended') throw new Error(captureEndedReason || '屏幕采集在共享建立前已经结束。');
      ownsCapture.current = true;
      await command('share:started', {
        settings: options,
        microphone: options.microphone === true,
        campusCapable: screenSocket.canUseCampus?.() === true,
        nativeCapable: !!screenSocket.p2p && !!window.roomcast?.nativeIce,
      });
      if (captureEnded || capturedVideoTrack?.readyState === 'ended') throw new Error(captureEndedReason || '屏幕采集在共享建立时已经结束。');
      if (options.sourceType !== 'camera') window.roomcast?.desktopLaser?.({ captureStarted: true });
      setModal(null);
      await refresh();
    } catch (error) {
      window.roomcast?.desktopLaser?.({ captureStopped: true });
      if (!captured) captured = (await capturePromise).stream || null;
      if (screenSocket?.screenStream === captured) screenSocket.stopScreenStream();
      else {
        for (const track of captured?.getTracks() || []) track.stop();
        captured?.roomcastCleanup?.();
      }
      if (claimed && socketRef.current?.id === expectedSocket) await command('share:stop').catch(() => { });
      ownsCapture.current = false;
      throw error;
    } finally {
      setShareBusy(false);
    }
  };

  const stopShare = async () => {
    if (shareBusy) return;
    setShareBusy(true);
    try {
      ownsCapture.current = false;
      await stopLocalShare();
      await command('share:stop');
    } catch (error) {
      notify(error.message);
    } finally {
      setShareBusy(false);
      refresh();
    }
  };

  const restartShare = async options => {
    if (!ownShare) return startShare(options);
    setShareBusy(true);
    try {
      ownsCapture.current = false;
      await stopLocalShare();
      await command('share:stop');
    } catch (error) {
      setShareBusy(false);
      throw new Error(`关闭旧共享失败：${error.message}`);
    }
    setShareBusy(false);
    try {
      await startShare(options);
    } catch (error) {
      throw new Error(`旧共享已关闭，但重新开启失败：${error.message}`);
    }
  };

  const openShare = () => {
    if (!room) { setModal(canHostRoom ? 'create' : 'join'); return; }
    if (!canShareScreen) { notify('此浏览器仅支持观看和聊天'); return; }
    if (!self?.canShare && !ownShare) { notify('管理员已关闭你的屏幕共享权限。'); return; }
    setModal('share');
  };

  const sendChat = async event => {
    event?.preventDefault();
    if ((!chat.trim() && !pendingImages.length) || sending || sendingImage || !room) return;
    if (pendingImages.length) { await sendPendingImages(chat.trim()); return; }
    setSending(true);
    try {
      await sendMessage(chat.trim());
      setChat('');
      stickToChatEnd.current = true;
    } catch (error) {
      notify(error.message);
    } finally {
      setSending(false);
    }
  };

  const stageImages = useCallback(files => {
    if (sendingImage || !room) return;
    const socket = socketRef.current;
    const action = roomAction.current;
    const list = [...(files || [])].filter(Boolean);
    if (!list.length) return;
    if (pendingImagesRef.current.length + list.length > MAX_CHAT_IMAGES) {
      notify(`一次最多发送 ${MAX_CHAT_IMAGES} 张图片。`);
      return;
    }
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    for (const file of list) {
      const mime = String(file.type || '').toLowerCase();
      const name = String(file.name || '图片');
      if (!allowed.includes(mime) || !/\.(?:jpe?g|png|webp|gif)$/i.test(name) || /\.(?:svg|html?|exe|dll|com|bat|cmd|msi)$/i.test(name)) {
        notify('仅支持 JPG、PNG、WebP 和 GIF 图片文件。');
        return;
      }
      if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > 10 * 1024 * 1024) {
        notify('图片大小不能超过 10MB。');
        return;
      }
    }
    void (async () => {
      const prepared = await Promise.all(list.map(async file => {
        const shrunk = await shrinkForSharing(file).catch(() => file);
        if (shrunk.size > 10 * 1024 * 1024) return file;
        return shrunk;
      }));
      if (socketRef.current !== socket || roomAction.current !== action || activeRoomId.current !== room.id) return;
      const staged = prepared.map(file => ({ file, objectUrl: URL.createObjectURL(file) }));
      setPendingImages(current => {
        if (socketRef.current !== socket || roomAction.current !== action || current.length + staged.length > MAX_CHAT_IMAGES) {
          staged.forEach(item => URL.revokeObjectURL(item.objectUrl));
          return current;
        }
        return [...current, ...staged];
      });
      stickToChatEnd.current = true;
      requestAnimationFrame(() => chatEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
    })();
  }, [notify, room, sendingImage, socketRef]);

  const chooseImage = event => {
    stageImages(event.target.files);
    event.target.value = '';
  };

  const normalizeIncomingImageFiles = (files, prefix = 'image') => [...(files || [])].map((source, index) => {
    if (!source) return null;
    const mimeToExtension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
    const extensionToMime = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
    const originalName = String(source.name || '').trim();
    const match = originalName.match(/\.([a-z0-9]+)$/i);
    const sourceExtension = String(match?.[1] || '').toLowerCase();
    const sourceMime = String(source.type || '').toLowerCase();
    const normalizedMime = mimeToExtension[sourceMime] ? sourceMime : extensionToMime[sourceExtension] || sourceMime;
    const normalizedExtension = mimeToExtension[normalizedMime];
    if (!normalizedExtension) return source;
    if (sourceExtension && extensionToMime[sourceExtension] === normalizedMime && sourceMime === normalizedMime) return source;
    const safeName = sourceExtension && extensionToMime[sourceExtension] === normalizedMime
      ? originalName
      : `${prefix}-${Date.now()}-${index + 1}.${normalizedExtension}`;
    return new File([source], safeName, { type: normalizedMime, lastModified: source.lastModified || Date.now() });
  }).filter(Boolean);

  const pasteImage = event => {
    if (!room || sendingImage) return;
    const items = [...(event.clipboardData?.items || [])].filter(entry => entry.kind === 'file' && String(entry.type || '').toLowerCase().startsWith('image/'));
    if (!items.length) return;
    const files = normalizeIncomingImageFiles(items.map(item => item.getAsFile()).filter(Boolean), 'clipboard');
    if (!files.length) return;
    event.preventDefault();
    stageImages(files);
  };

  const dragContainsFiles = dataTransfer => {
    if (!dataTransfer) return false;
    const items = [...(dataTransfer.items || [])];
    if (items.some(item => item.kind === 'file' && (!item.type || String(item.type).toLowerCase().startsWith('image/')))) return true;
    return [...(dataTransfer.types || [])].includes('Files');
  };

  const handleChatDragEnter = event => {
    if (!dragContainsFiles(event.dataTransfer)) return;
    event.preventDefault();
    if (!room || sendingImage) return;
    chatDragDepth.current += 1;
    setChatDragActive(true);
  };

  const handleChatDragOver = event => {
    if (!dragContainsFiles(event.dataTransfer)) return;
    event.preventDefault();
    if (!room || sendingImage) return;
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    setChatDragActive(true);
  };

  const handleChatDragLeave = event => {
    if (!chatDragActive) return;
    event.preventDefault();
    chatDragDepth.current = Math.max(0, chatDragDepth.current - 1);
    if (chatDragDepth.current === 0) setChatDragActive(false);
  };

  const handleChatDrop = event => {
    if (!dragContainsFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    chatDragDepth.current = 0;
    setChatDragActive(false);
    if (!room || sendingImage) return;
    const itemFiles = [...(event.dataTransfer?.items || [])]
      .filter(item => item.kind === 'file')
      .map(item => item.getAsFile())
      .filter(Boolean);
    const dropped = itemFiles.length ? itemFiles : [...(event.dataTransfer?.files || [])];
    const files = normalizeIncomingImageFiles(dropped, 'dragged-image');
    if (!files.length) return;
    stageImages(files);
  };

  const removePendingImage = index => {
    setPendingImages(current => {
      const item = current[index];
      if (item?.objectUrl) URL.revokeObjectURL(item.objectUrl);
      return current.filter((_, itemIndex) => itemIndex !== index);
    });
  };

  const sendPendingImages = async (caption = chat.trim()) => {
    if (!pendingImages.length || sendingImage || !room) return;
    const files = pendingImages.map(item => item.file);
    setSendingImage(true);
    try {
      await sendImages(files, caption);
      clearPendingImages();
      setChat('');
      stickToChatEnd.current = true;
    } catch (error) {
      notify(error.message);
    } finally {
      setSendingImage(false);
    }
  };

  const handleImageContextMenu = (event, src) => {
    if (!window.roomcast?.copyImage || !src) return;
    event.preventDefault();
    event.stopPropagation();
    const menuWidth = 136;
    const menuHeight = 40;
    const edge = 8;
    const titlebarOffset = desktopChrome ? 32 : 0;
    const maxX = Math.max(edge, window.innerWidth - menuWidth - edge);
    const maxY = Math.max(titlebarOffset + edge, window.innerHeight - menuHeight - edge);
    setImageContextMenu({
      src,
      x: Math.min(Math.max(edge, event.clientX), maxX),
      y: Math.min(Math.max(titlebarOffset + edge, event.clientY), maxY),
    });
  };

  const imageToPngBytes = async src => {
    const image = new Image();
    image.src = src;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d', { alpha: true });
    if (!context) throw new Error('无法读取图片。');
    context.drawImage(image, 0, 0);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('无法读取图片。');
    return new Uint8Array(await blob.arrayBuffer());
  };

  const copyImageToClipboard = async src => {
    const bytes = await imageToPngBytes(src);
    if (desktopChrome) {
      const result = await window.roomcast.copyImage(bytes);
      if (!result?.ok) throw new Error('复制图片失败。');
    } else {
      if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('当前浏览器不支持复制图片。');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })]);
    }
  };

  const copyContextImage = async () => {
    const src = imageContextMenu?.src;
    setImageContextMenu(null);
    if (!src) return;
    try { await copyImageToClipboard(src); }
    catch (error) { notify(`复制图片失败：${error.message}`); }
  };

  const copyPreviewImage = async src => {
    if (!src) return;
    try { await copyImageToClipboard(src); }
    catch (error) { notify(`复制图片失败：${error.message}`); }
  };

  const downloadPreviewImage = async image => {
    if (!image?.src) return;
    try {
      const rawName = image.fileName || `roomcast-image-${Date.now()}.png`;
      const stem = rawName.replace(/\.[^.]+$/, '').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim() || `roomcast-image-${Date.now()}`;
      if (desktopChrome) {
        const result = await window.roomcast.saveImage(await imageToPngBytes(image.src), `${stem}.png`);
        if (!result?.ok && !result?.canceled) throw new Error('保存图片失败。');
      } else {
        const link = document.createElement('a');
        link.href = image.src;
        link.download = `${stem}.png`;
        link.click();
      }
    } catch (error) {
      notify(`下载图片失败：${error.message}`);
    }
  };

  const recall = async messageId => {
    try { await recallMessage(messageId); }
    catch (error) { notify(error.message); }
  };

  const viewingSocket = socketRef.current;
  const reportViewing = useCallback((ownerId, event) => ack(viewingSocket, event, { ownerId }), [viewingSocket]);
  const rememberViewing = useCallback((ownerId, viewing, startedAt = '') => {
    const key = `${ownerId}:${startedAt ?? ''}`;
    if (viewing) watchingStreams.current.add(key);
    else watchingStreams.current.delete(key);
  }, []);

  const scrollChat = () => {
    const element = chatList.current;
    if (!element) return;
    stickToChatEnd.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100;
    if (element.scrollTop > 40 || historyLoading || !hasOlderMessages) return;
    const beforeHeight = element.scrollHeight;
    const beforeTop = element.scrollTop;
    void loadOlderMessages().then(count => {
      if (!count) return;
      requestAnimationFrame(() => { if (chatList.current === element) element.scrollTop = element.scrollHeight - beforeHeight + beforeTop; });
    }).catch(error => notify(error.message));
  };

  return (
    <div
      ref={panels.shell}
      style={panels.style}
      className={`app-shell studio-shell ${room ? 'in-room' : 'pre-room'} ${room && showChat ? '' : 'chat-hidden'} ${room && showMembers ? 'members-open' : ''} ${desktopChrome ? 'desktop-chrome' : ''}`}
    >
      {desktopChrome && (
        <div className="roomcast-titlebar" aria-hidden="true">
          <span className="roomcast-titlebar-logo"><span className="roomcast-titlebar-mark"><i /><i /></span></span>
          <span className="roomcast-titlebar-name">同屏 Roomcast</span>
        </div>
      )}

      <StudioTopbar
        appearance={appearance}
        room={room}
        self={self}
        avatar={avatar}
        config={config}
        latencyMs={latencyMs}
        latencyTone={latencyTone}
        canManageGlobalLaser={canManageGlobalLaser}
        globalLaserPending={globalLaserPending}
        onToggleGlobalLaser={toggleGlobalLaser}
        showMembers={showMembers}
        onToggleMembers={() => compactPanels ? setOpenDrawer(showMembers ? null : 'members') : setWideMembers(!wideMembers)}
        showChat={showChat}
        onToggleChat={() => compactPanels ? setOpenDrawer(showChat ? null : 'chat') : setWideChat(!wideChat)}
        unreadChat={unreadChat}
        updateAvailable={updateAvailable}
        updateVersion={update.result?.version}
        onOpenSettings={() => openSettings('general')}
      />

      <main className="main-content studio-workspace">
        <div className="content-columns">
          {room && compactPanels && openDrawer && (
            <button type="button" className="panel-scrim" aria-label={showChat ? '关闭聊天面板' : '关闭成员面板'} onClick={() => setOpenDrawer(null)} />
          )}
          {room && showMembers && (
            <MembersPanel
              room={room}
              self={self}
              selfId={selfId}
              onCloseMembers={() => compactPanels ? setOpenDrawer(null) : setWideMembers(false)}
              onManageMember={setManagedMember}
              voice={voice}
              memberResizeHandlers={panels.handle('members')}
            />
          )}

          <section className="stage-column">
            {room && (
              <div className="stage-heading">
                <div className="stage-heading-left">
                  <span className="small-icon-box"><Monitor size={16} /></span>
                  <h3>共享屏幕</h3>
                  <span className="stage-state">{streams.length ? `${streams.length} 路共享` : '等待分享'}</span>
                </div>
                {streams.length > 0 && (
                  <div className="stage-zoom-controls" aria-label="画面缩放">
                    <button
                      type="button"
                      className="icon-button"
                      data-tooltip="缩小预览"
                      data-tooltip-pos="bottom"
                      aria-label="缩小预览"
                      disabled={previewScale <= PREVIEW_SCALE_MIN}
                      onClick={() => setPreviewScale(s => clampPreviewScale(s - PREVIEW_SCALE_STEP))}
                    >
                      <ZoomOut size={15} />
                    </button>
                    <button
                      type="button"
                      className="stage-zoom-readout"
                      title="重置预览缩放 (100%)"
                      onClick={() => setPreviewScale(1)}
                    >
                      {Math.round(previewScale * 100)}%
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      title="放大预览（最大 100%）"
                      aria-label="放大预览"
                      disabled={previewScale >= PREVIEW_SCALE_MAX}
                      onClick={() => setPreviewScale(s => clampPreviewScale(s + PREVIEW_SCALE_STEP))}
                    >
                      <ZoomIn size={15} />
                    </button>
                  </div>
                )}
              </div>
            )}

            <div className={`screen-stage ${streams.length ? 'has-stream multi-stage' : ''}`}>
              {streams.length ? (
                <div
                  ref={screenGridRef}
                  className={`screen-grid count-${streams.length}`}
                  data-preview-scale={previewScale.toFixed(1)}
                  style={previewCardWidth ? { '--preview-card-width': `${previewCardWidth}px` } : undefined}
                >
                  {streams.map(stream => (
                    <ScreenPlayer
                      key={[stream.memberId, stream.startedAt].join('-')}
                      laser={laser}
                      room={room}
                      stream={stream}
                      iceServers={config?.mediaIceServers}
                      outputDeviceId={audioDevices.preferences.outputId}
                      viewerMemberId={selfId}
                      initialSound={true}
                      transport={viewingSocket?.mediaP2P ? viewingSocket : undefined}
                      reportViewing={reportViewing}
                      initiallyEntered={watchingStreams.current.has(`${stream.memberId}:${stream.startedAt ?? ''}`)}
                      onViewingChange={rememberViewing}
                    />
                  ))}
                </div>
              ) : (
                <EmptyScreen
                  room={room}
                  canShare={canShareScreen && self?.canShare}
                  onCreate={canHostRoom ? () => setModal('create') : undefined}
                  onJoin={() => setModal('join')}
                  gpuStageMode={gpu.settings.stageMode}
                  hwAccelActive={gpu.hwAccel.activeHardwareAcceleration}
                  isForegroundActive={gpu.isForegroundActive || !gpu.settings.lowPowerBackground}
                />
              )}
            </div>

            {room && (
              <footer className="voice-dock studio-dock">
                {canShareScreen && (
                  <div className="dock-controls">
                    <button
                      type="button"
                      className="button share-button"
                      onClick={openShare}
                      disabled={shareBusy || (!self?.canShare && !ownShare)}
                    >
                      {shareBusy ? <LoaderCircle size={18} className="spin" /> : ownShare ? <Settings size={18} /> : <ScreenShare size={18} />}
                      <span>{ownShare ? '共享设置' : desktopChrome ? '共享屏幕' : '共享画面'}</span>
                    </button>
                    {ownShare && (
                      <button
                        type="button"
                        className="dock-action-btn dock-leave-btn"
                        onClick={stopShare}
                        disabled={shareBusy}
                        title="停止共享"
                        aria-label="停止共享"
                      >
                        <Square size={14} />
                        <span>停止共享</span>
                      </button>
                    )}
                  </div>
                )}

                <div className="studio-dock-divider" aria-hidden="true" />
                <VoiceControls voice={voice} inRoom={room.features?.voice === 1} />

                <div className="studio-dock-divider" aria-hidden="true" />
                <button
                  type="button"
                  className="dock-action-btn dock-invite-btn"
                  aria-label="邀请好友"
                  onClick={() => setModal('invite')}
                >
                  <UserPlus size={16} />
                  <span>邀请好友</span>
                </button>
                <button
                  type="button"
                  className="control-button leave-button"
                  data-tooltip="退出房间"
                  aria-label="退出房间"
                  onClick={handleLeave}
                >
                  <LogOut size={16} />
                </button>
              </footer>
            )}
          </section>

          {room && showChat && (
            <ChatPanel
              room={room}
              selfId={selfId}
              desktopChrome={desktopChrome}
              resizeHandlers={panels.handle('chat')}
              chatDragActive={chatDragActive}
              onDragEnter={handleChatDragEnter}
              onDragOver={handleChatDragOver}
              onDragLeave={handleChatDragLeave}
              onDrop={handleChatDrop}
              chatListRef={chatList}
              chatEndRef={chatEnd}
              onScroll={scrollChat}
              historyLoading={historyLoading}
              hasOlderMessages={hasOlderMessages}
              messages={messages}
              onRecall={recall}
              onPreviewImage={setPreviewImage}
              onImageContextMenu={handleImageContextMenu}
              imageInputRef={imageInput}
              onChooseImage={chooseImage}
              pendingImages={pendingImages}
              onRemovePendingImage={removePendingImage}
              chat={chat}
              setChat={setChat}
              onPasteImage={pasteImage}
              sending={sending}
              sendingImage={sendingImage}
              onSendChat={sendChat}
            />
          )}
        </div>
      </main>

      {updatePrompt.open && update.result?.available && (
        <UpdatePromptModal
          current={update.result.current || localConfig?.version || APP_VERSION}
          result={update.result}
          install={updateInstall}
          dontRemind={updatePrompt.dontRemind}
          setDontRemind={value => setUpdatePrompt(current => ({ ...current, dontRemind: value }))}
          onClose={closeUpdatePrompt}
          onUpdate={startAutoUpdate}
          onOpenPage={() => { window.roomcast?.openReleasePage?.().catch(() => { }); }}
        />
      )}

      {['create', 'join'].includes(modal) && (
        <EntryModal
          key={inviteRoom}
          inviteRoom={inviteRoom}
          mode={modal}
          canHost={canHostRoom}
          onClose={cancelEntry}
          onEnter={handleEnter}
          busy={connection === 'connecting'}
          defaultServer={server}
          peerServer={localConfig?.peerServer}
        />
      )}

      {modal === 'share' && room && canShareScreen && (
        <ShareModal
          onClose={() => setModal(null)}
          onStart={ownShare ? restartShare : startShare}
          editing={ownShare}
          busy={shareBusy}
          audioDevices={audioDevices}
          capabilities={capabilities}
        />
      )}

      {modal === 'settings' && (
        <SettingsDrawer
          avatar={avatar}
          avatarName={self?.name || loadPreference('nickname', '访客')}
          onAvatar={changeAvatar}
          voice={voice}
          onClose={() => setModal(null)}
          isDesktop={desktopChrome}
          canShareScreen={canShareScreen}
          update={update}
          autoCheckUpdates={autoCheckUpdates}
          setAutoCheckUpdates={setAutoCheckUpdates}
          onCheckUpdates={checkUpdates}
          updateInstall={updateInstall}
          onAutoUpdate={startAutoUpdate}
          localConfig={localConfig}
          refresh={refresh}
          devices={audioDevices.devices}
          devicePreferences={audioDevices.preferences}
          setDevicePreferences={audioDevices.setPreferences}
          refreshDevices={audioDevices.refresh}
          relaySettings={relaySettings}
          setRelaySettings={setRelaySettings}
          themeColor={themeColor}
          setThemeColor={setThemeColor}
          themeMode={themeMode}
          setThemeMode={setThemeMode}
          effectiveThemeColor={effectiveThemeColor}
          gpu={gpu}
          initialSection={settingsSection}
        />
      )}

      {modal === 'invite' && room && (
        <InviteModal
          isP2P={config?.p2p}
          room={room}
          server={server}
          localConfig={localConfig}
          onClose={() => setModal(null)}
          copy={copy}
          relayInvite={config?.relayInvite}
          inviteSecret={config?.inviteSecret}
          peerServer={config?.peerServer}
          campusSecret={config?.campusSecret}
          nativeHost={socketRef.current?.isHost ? !!window.roomcast?.nativeIce : !!socketRef.current?.nativeHost}
        />
      )}

      {managedMember && room?.members.some(member => member.id === managedMember.id) && (
        <MemberPermissionsModal
          member={room.members.find(member => member.id === managedMember.id)}
          self={self}
          command={command}
          onClose={() => setManagedMember(null)}
        />
      )}

      {previewImage && (
        <ImagePreviewOverlay
          key={previewImage.src}
          image={previewImage}
          onClose={() => setPreviewImage(null)}
          onImageContextMenu={handleImageContextMenu}
          onCopy={copyPreviewImage}
          onDownload={downloadPreviewImage}
        />
      )}

      {imageContextMenu && (
        <div
          className="image-context-menu"
          role="menu"
          style={{ left: imageContextMenu.x, top: imageContextMenu.y }}
          onPointerDown={event => event.stopPropagation()}
        >
          <button type="button" role="menuitem" onClick={() => void copyContextImage()}>复制图片</button>
        </div>
      )}

      {toast && (
        <div className="toast error" role="alert">
          <Info size={18} />
          <span>{toast.text}</span>
          <button type="button" className="icon-button" aria-label="关闭提示" onClick={() => setToast(null)}>
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}
