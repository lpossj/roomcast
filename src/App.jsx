import { AppWindow, ArrowRight, AudioLines, Check, ChevronDown, ChevronRight, Copy, Download, Headphones, ImagePlus, Info, Link, LoaderCircle, LockKeyhole, LogOut, Maximize2, MessageSquare, Mic, Monitor, MonitorUp, Palette, Plus, RefreshCw, RotateCcw, RotateCw, ScreenShare, Send, Server, Settings, ShieldCheck, Square, Users, Volume2, Wifi, X, ZoomIn, ZoomOut } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import ScreenPlayer from './ScreenPlayer.jsx';
import { ack, attachNativeAudio, initials, integratedSources, nativeAudioSources, startIntegratedCapture, startObsFixedFpsCapture, timeLabel } from './lib.js';
import { readImageDimensions } from './image-policy.js';
import { loadPreference, savePreference } from './preferences.js';
import { fetchRelayIce, loadRelaySettings, saveRelaySettings } from './relay.js';
import useDevices from './useDevices.js';
import useRoom from './useRoom.js';
import { MEDIA_RACE_BUILD_PROBE } from './media-race-manager.js';

void MEDIA_RACE_BUILD_PROBE;

const presets = [
  { id: '1080p30', label: '1080p', detail: '30 FPS · 推荐', width: 1920, height: 1080, fps: 30, bitrate: 4500 },
  { id: '720p30', label: '720p', detail: '30 FPS · 节省带宽', width: 1280, height: 720, fps: 30, bitrate: 2500 },
  { id: '1080p60', label: '1080p', detail: '60 FPS · 更流畅', width: 1920, height: 1080, fps: 60, bitrate: 6500 },
];
const defaultShareSettings = { captureBackend: 'obs', sourceType: 'monitor', sourceId: '', preset: '1080p30', width: 1920, height: 1080, fps: 30, bitrate: 6500, audioMode: 'none', audioSourceId: '', applicationMuted: false, microphoneMuted: false, systemAudio: false, microphone: false, compatibilityCanvas: false, performanceMode: 'quality' };
const avatarClass = color => `avatar-color-${Number.isInteger(color) && color >= 0 && color < 10 ? color : 0}`;
function loadShareSettings() {
  try {
    const saved = loadPreference('shareSettings', {});
    const legacyAudioMode = saved.systemAudio ? (saved.microphone ? 'system-microphone' : 'system') : saved.microphone ? 'microphone' : 'none';
    const clean = { ...defaultShareSettings };
    for (const key of Object.keys(defaultShareSettings)) if (Object.hasOwn(saved || {}, key)) clean[key] = saved[key];
    clean.captureBackend = !window.roomcast?.desktop || clean.captureBackend === 'native' ? 'native' : 'obs';
    clean.sourceType = clean.sourceType === 'window' ? 'window' : 'monitor';
    clean.audioMode = ['none', 'system', 'application', 'exclude', 'microphone', 'system-microphone', 'application-microphone', 'exclude-microphone'].includes(saved.audioMode) ? saved.audioMode : legacyAudioMode;
    clean.performanceMode = 'quality';
    clean.compatibilityCanvas = false;
    return clean;
  } catch { return { ...defaultShareSettings, captureBackend: window.roomcast?.desktop ? 'obs' : 'native' }; }
}
const params = new URLSearchParams(window.location.search);
const fragmentInvite = new URLSearchParams(window.location.hash.slice(1)).get('room') || '';
// Storage can throw (private mode / disabled storage). This runs at module scope, so an
// uncaught error here would blank the whole page on the invite-link entry path.
let rememberedInvite = '';
try {
  if (fragmentInvite && !window.roomcast?.desktop) {
    sessionStorage.setItem('roomcast:invite', fragmentInvite);
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }
  rememberedInvite = sessionStorage.getItem('roomcast:invite') || '';
} catch { rememberedInvite = ''; }
const initialInvite = fragmentInvite || rememberedInvite || params.get('room') || '';
const MAX_CHAT_IMAGES = 4;
// A backgrounded page cannot answer the room handover probe, so web clients leave the
// room after this long hidden instead of blocking the desktop owner from exiting.
const BACKGROUND_LEAVE_DELAY_MS = 30000;
// Phone photos decode to tens of MB at full resolution while the chat only ever shows a
// small thumbnail, so oversized photos are downscaled once before being staged.
const MAX_SHARED_IMAGE_EDGE = 2000;
const APP_VERSION = typeof __ROOMCAST_VERSION__ === 'string' ? __ROOMCAST_VERSION__ : '';

async function shrinkForSharing(file) {
  // GIF keeps its animation; re-encoding would flatten it.
  if (String(file.type || '').toLowerCase() === 'image/gif') return file;
  if (typeof createImageBitmap !== 'function') return file;
  // Read the header instead of decoding first: a 12 megapixel JPEG can be well under
  // 1 MB, so file size says nothing about the decoded bitmap.
  let declared;
  try { declared = readImageDimensions(file.type, new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer())); } catch { declared = null; }
  if (declared && Math.max(declared.width, declared.height) <= MAX_SHARED_IMAGE_EDGE) return file;
  let bitmap;
  try { bitmap = await createImageBitmap(file); } catch { return file; }
  try {
    const longest = Math.max(bitmap.width, bitmap.height);
    if (!longest || longest <= MAX_SHARED_IMAGE_EDGE) return file;
    const scale = MAX_SHARED_IMAGE_EDGE / longest;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) return file;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.9));
    // Browsers without WebP encoding would silently fall back to another format; keeping
    // the original is safer than changing the user's image behind their back.
    if (!blob || blob.type !== 'image/webp' || blob.size > 10 * 1024 * 1024) return file;
    const stem = String(file.name || 'image').replace(/\.[^.]+$/, '') || 'image';
    return new File([blob], `${stem}.webp`, { type: 'image/webp', lastModified: file.lastModified || Date.now() });
  } finally { bitmap.close?.(); }
}
const DEFAULT_THEME_COLOR = '#78ddbd';
const THEME_MODE_CUSTOM = 'custom';
const THEME_MODE_WINDOWS = 'windows';
const PREVIEW_SCALE_MIN = 0.55;
const PREVIEW_SCALE_MAX = 1.6;
const PREVIEW_SCALE_STEP = 0.1;
const LATENCY_POLL_MS = 3000;
const LATENCY_TIMEOUT_MS = 4000;
const latencyToneFor = value => {
  if (!Number.isFinite(value)) return 'neutral';
  if (value < 120) return 'good';
  if (value <= 250) return 'warning';
  return 'bad';
};
const clampPreviewScale = value => Math.min(PREVIEW_SCALE_MAX, Math.max(PREVIEW_SCALE_MIN, Math.round(value * 10) / 10));
const previewColumnsFor = (count, width) => {
  if (count <= 1 || width < 680) return 1;
  if (count <= 4) return Math.min(2, count);
  if (count <= 9) return width >= 1180 ? 3 : 2;
  if (width >= 1480) return 4;
  return width >= 900 ? 3 : 2;
};
const previewCardWidthFor = (count, width, scale) => {
  const outerWidth = Number(width) || 0;
  if (!count || outerWidth <= 0) return 0;
  const gap = 12;
  const horizontalPadding = 24;
  const innerWidth = Math.max(0, outerWidth - horizontalPadding);
  if (innerWidth <= 0) return 0;
  const columns = Math.max(1, Math.min(count, previewColumnsFor(count, innerWidth)));
  const baseWidth = Math.max(1, (innerWidth - (gap * (columns - 1))) / columns);
  const minimum = Math.min(260, innerWidth);
  return Math.round(Math.min(innerWidth, Math.max(minimum, baseWidth * clampPreviewScale(scale))));
};
const normalizeThemeColor = value => /^#[0-9a-f]{6}$/i.test(String(value || '').trim()) ? String(value).trim().toLowerCase() : DEFAULT_THEME_COLOR;
const normalizeThemeMode = value => value === THEME_MODE_WINDOWS ? THEME_MODE_WINDOWS : THEME_MODE_CUSTOM;
const themeForegroundFor = color => {
  const raw = normalizeThemeColor(color).slice(1);
  const red = Number.parseInt(raw.slice(0, 2), 16);
  const green = Number.parseInt(raw.slice(2, 4), 16);
  const blue = Number.parseInt(raw.slice(4, 6), 16);
  return ((0.2126 * red) + (0.7152 * green) + (0.0722 * blue)) >= 150 ? '#0b1116' : '#ffffff';
};
function loadThemeSettings() {
  try {
    const saved = window.roomcast?.getThemeSettings?.();
    if (saved && typeof saved === 'object') {
      return {
        mode: normalizeThemeMode(saved.mode),
        color: normalizeThemeColor(saved.color),
      };
    }
  } catch { }
  return { mode: THEME_MODE_CUSTOM, color: DEFAULT_THEME_COLOR };
}
function loadWindowsAccentColor() {
  try { return normalizeThemeColor(window.roomcast?.getSystemAccentColor?.() || DEFAULT_THEME_COLOR); }
  catch { return DEFAULT_THEME_COLOR; }
}
function applyThemeColor(value) {
  const color = normalizeThemeColor(value);
  document.documentElement.style.setProperty('--accent', color);
  document.documentElement.style.setProperty('--accent-foreground', themeForegroundFor(color));
  return color;
}
const INITIAL_THEME_SETTINGS = loadThemeSettings();
const INITIAL_THEME_MODE = INITIAL_THEME_SETTINGS.mode;
const INITIAL_CUSTOM_THEME_COLOR = INITIAL_THEME_SETTINGS.color;
const INITIAL_WINDOWS_ACCENT_COLOR = loadWindowsAccentColor();
applyThemeColor(INITIAL_THEME_MODE === THEME_MODE_WINDOWS ? INITIAL_WINDOWS_ACCENT_COLOR : INITIAL_CUSTOM_THEME_COLOR);
function Modal({ title, subtitle, children, onClose, wide, busy }) {
  const dialog = useRef(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    const first = dialog.current?.querySelector('input, button, select'); first?.focus();
    const key = event => {
      if (event.key === 'Escape' && !busy) closeRef.current();
      if (event.key === 'Tab') {
        const elements = [...dialog.current.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], textarea:not(:disabled)')];
        if (!elements.length) return;
        const start = elements[0], end = elements.at(-1);
        if (event.shiftKey && document.activeElement === start) { event.preventDefault(); end.focus(); }
        else if (!event.shiftKey && document.activeElement === end) { event.preventDefault(); start.focus(); }
      }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); previous?.focus(); };
  }, [busy]);
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}><section className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby="modal-title" ref={dialog}><header className="modal-header"><div><h2 id="modal-title">{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" onClick={onClose} disabled={busy} aria-label="关闭"><X size={20} /></button></header>{children}</section></div>;
}

function Dropdown({ label, value, options, onChange, disabled = false, description = '', className = '' }) {
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  const selected = options.find(option => option.value === value) || options[0];
  useEffect(() => {
    if (!open) return undefined;
    const close = event => { if (!root.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  return <div className={`app-select-field standalone-label compact-select ${className}`} ref={root} onKeyDown={event => { if (event.key === 'Escape' && open) { event.stopPropagation(); setOpen(false); } }}>
    <span className="app-select-label">{label}</span>
    <button type="button" className="app-select-trigger" aria-label={label} aria-haspopup="listbox" aria-expanded={open} disabled={disabled} onClick={() => setOpen(current => !current)}><span>{selected?.label || ''}</span><ChevronDown size={18} aria-hidden="true" /></button>
    {open && <div className="app-select-menu" role="listbox" aria-label={`${label}选项`}>{options.map(option => <button type="button" role="option" aria-selected={option.value === value} className={option.value === value ? 'selected' : ''} key={option.value} onClick={() => { onChange(option.value); setOpen(false); }}><span>{option.label}</span>{option.value === value && <Check size={15} />}</button>)}</div>}
    {description && <small>{description}</small>}
  </div>;
}

function EntryModal({ mode, onClose, onEnter, busy, defaultServer, inviteRoom }) {
  const [kind, setKind] = useState(mode);
  const [form, setForm] = useState({ nickname: loadPreference('nickname', ''), name: '朋友的放映室', roomId: inviteRoom || initialInvite, createKey: '', server: params.get('server') || loadPreference('server', '') || defaultServer || window.location.origin });
  const [error, setError] = useState('');
  const field = key => ({ value: form[key], onChange: event => setForm(value => ({ ...value, [key]: event.target.value })) });
  const setServer = event => {
    const value = event.target.value;
    try {
      const url = new URL(value);
      const room = new URLSearchParams(url.hash.slice(1)).get('room') || url.searchParams.get('room');
      if (room) { setKind('join'); setForm(current => ({ ...current, server: url.searchParams.get('server') || url.origin, roomId: room })); return; }
    } catch { }
    setForm(current => ({ ...current, server: value }));
  };
  const submit = async event => {
    event.preventDefault();
    setError('');

    try {
      if (kind === 'join' && !/^roomcast:\/\/join\//i.test(form.roomId.trim())) throw new Error('请粘贴完整的 Roomcast 邀请链接。');
      await onEnter(kind, {
        ...form,
        networkMode: 'p2p',
      });
    } catch (failure) {
      setError(failure.message);
    }
  };
  return <Modal title={kind === 'create' ? '创建房间' : '加入房间'} onClose={onClose} busy={busy}>
    <div className="segmented"><button className={kind === 'create' ? 'selected' : ''} onClick={() => { setKind('create'); setError(''); }} disabled={busy}><Plus size={16} />创建</button><button className={kind === 'join' ? 'selected' : ''} onClick={() => { setKind('join'); setError(''); }} disabled={busy}><Link size={16} />加入</button></div>
    <form onSubmit={submit} className="entry-form">
      <label>你的昵称<input {...field('nickname')} autoComplete="nickname" placeholder="大家怎么称呼你？" required maxLength={24} disabled={busy} /></label>
      <label>{kind === 'create' ? '房间名称' : '邀请链接'}<input {...field(kind === 'create' ? 'name' : 'roomId')} placeholder={kind === 'create' ? '例如：周末放映室' : '粘贴 roomcast://join/…'} required maxLength={kind === 'create' ? 40 : 7000} disabled={busy} /></label>
      {error && <div className="inline-error" role="alert"><Info size={16} />{error}</div>}
      <button className="button primary full" type="submit" disabled={busy}>{busy ? <LoaderCircle size={17} className="spin" /> : kind === 'create' ? <Plus size={17} /> : <ArrowRight size={17} />}{busy ? '正在连接…' : kind === 'create' ? '创建并进入房间' : '进入房间'}</button>
    </form>
  </Modal>;
}

function ShareModal({ onClose, onStart, busy, audioDevices, editing = false }) {
  const [settings, setSettings] = useState(loadShareSettings);
  const backend = settings.captureBackend === 'native' ? 'native' : 'obs';
  const type = settings.sourceType;
  const [sources, setSources] = useState({ monitors: [], windows: [], applications: [] });
  const [loading, setLoading] = useState(false);
  const [audioLoading, setAudioLoading] = useState(false);
  const [error, setError] = useState('');
  const [audioError, setAudioError] = useState('');
  const [backendNotice, setBackendNotice] = useState('');
  const mounted = useRef(true);
  const refreshGeneration = useRef(0);
  const audioRefreshInFlight = useRef(false);
  useEffect(() => () => { mounted.current = false; }, []);
  const refreshAudioSources = useCallback(async ({ initial = false } = {}) => {
    if (!window.roomcast?.desktop || audioRefreshInFlight.current || !mounted.current) return;
    audioRefreshInFlight.current = true;
    if (initial) setAudioLoading(true);
    try {
      const applications = await nativeAudioSources();
      if (!mounted.current) return;
      setAudioError('');
      setSources(current => ({ ...current, applications }));
      setSettings(current => ({
        ...current,
        audioSourceId: applications.some(item => String(item.id) === current.audioSourceId) ? current.audioSourceId : '',
      }));
    } catch (failure) {
      if (mounted.current) setAudioError(String(failure?.message || 'Windows 音频应用枚举失败。'));
    } finally {
      audioRefreshInFlight.current = false;
      if (initial && mounted.current) setAudioLoading(false);
    }
  }, []);

  const load = async (overrides = {}) => {
    const generation = ++refreshGeneration.current;
    const currentRequest = () => mounted.current && generation === refreshGeneration.current;
    const requested = { ...settings, ...overrides };
    const requestedBackend = requested.captureBackend === 'native' ? 'native' : 'obs';
    const requestedType = requested.sourceType === 'window' ? 'window' : 'monitor';
    const preferredSourceId = String(requested.sourceId || '');
    setLoading(true); setAudioLoading(false); setError(''); setAudioError(''); setBackendNotice('');
    // IDs belong to the backend that enumerated them. A failed refresh must
    // never leave native sources selectable as OBS sources (or vice versa).
    setSources(current => ({ ...current, monitors: [], windows: [] }));
    setSettings(current => ({ ...current, sourceId: '' }));
    const applySources = (value, activeBackend) => {
      const items = requestedType === 'monitor' ? value.monitors : value.windows;
      setSources(current => ({ ...value, applications: current.applications || [] }));
      setSettings(current => ({
        ...current,
        captureBackend: activeBackend,
        sourceType: requestedType,
        sourceId: items?.some(item => String(item.id) === preferredSourceId) ? preferredSourceId : items?.[0]?.id == null ? '' : String(items[0].id),
      }));
    };
    try {
      const value = await integratedSources({ backend: requestedBackend, width: Number(requested.width) || 1920, height: Number(requested.height) || 1080, fps: Number(requested.fps) || 30 });
      if (!currentRequest()) return;
      // Make screen/window sharing available immediately. Application-audio enumeration
      // is optional and runs independently because WMI/CIM can be slow on some PCs.
      applySources(value, requestedBackend);
      setLoading(false);

      if (!window.roomcast?.desktop) return;
      await refreshAudioSources({ initial: true });
    } catch (failure) {
      if (!currentRequest()) return;
      // Never mutate the user's selected capture backend because OBS had a
      // transient initialization error. Keeping OBS selected makes the real
      // failure visible and prevents a failed clean-PC first registration from
      // silently overwriting the saved preference with native capture.
      setError(failure.message);
    } finally { if (currentRequest()) setLoading(false); }
  };
  useEffect(() => { mounted.current = true; void load(); return () => { refreshGeneration.current += 1; }; }, []);
  useEffect(() => {
    if (!window.roomcast?.desktop) return undefined;
    let cancelled = false;
    let timer = null;
    const tick = async () => {
      if (cancelled || busy) return;
      await refreshAudioSources();
      if (!cancelled) timer = window.setTimeout(tick, 1500);
    };
    timer = window.setTimeout(tick, 1500);
    return () => { cancelled = true; if (timer) window.clearTimeout(timer); };
  }, [busy, refreshAudioSources]);
  useEffect(() => { savePreference('shareSettings', settings); }, [settings]);
  const items = (type === 'monitor' ? sources.monitors : sources.windows) || [];
  const update = patch => setSettings(current => ({ ...current, ...patch }));
  const switchBackend = next => { update({ captureBackend: next, sourceId: '' }); void load({ captureBackend: next, sourceId: '' }); };
  const switchType = next => { const nextItems = next === 'monitor' ? sources.monitors : sources.windows; update({ sourceType: next, sourceId: nextItems?.[0]?.id == null ? '' : String(nextItems[0].id) }); };
  const selectPreset = item => update({ preset: item.id, width: item.width, height: item.height, fps: item.fps, bitrate: item.bitrate });
  const numeric = (key, value) => update({ preset: 'custom', [key]: value === '' ? '' : Number(value) });
  const currentAudioMode = settings.audioMode || 'none';
  const sharesSystemAudio = currentAudioMode === 'system' || currentAudioMode === 'system-microphone';
  const sharesApplicationAudio = currentAudioMode === 'application' || currentAudioMode === 'application-microphone';
  const excludesApplicationAudio = currentAudioMode === 'exclude' || currentAudioMode === 'exclude-microphone';
  const sharesMicrophone = currentAudioMode === 'microphone' || currentAudioMode.endsWith('-microphone');
  const composeAudioMode = (source, microphone) => source ? `${source}${microphone ? '-microphone' : ''}` : microphone ? 'microphone' : 'none';
  const toggleAudioSource = (source, enabled) => update({ audioMode: composeAudioMode(enabled ? source : '', sharesMicrophone) });
  const processAudioAvailable = Boolean(window.roomcast?.startAudioCapture);
  const audioApplicationLabel = item => {
    const friendly = String(item?.name || '').trim();
    const executable = String(item?.processName || '').trim();
    if (!executable) return friendly || '未知应用';
    const stem = executable.replace(/\.exe$/i, '');
    if (!friendly || friendly.toLowerCase() === executable.toLowerCase() || friendly.toLowerCase() === stem.toLowerCase()) return executable;
    return `${friendly}（${executable}）`;
  };
  const submit = async () => {
    setError('');
    const width = Number(settings.width), height = Number(settings.height), fps = Number(settings.fps), bitrate = Number(settings.bitrate);
    const maxWidth = backend === 'obs' ? 4096 : 7680;
    const maxHeight = backend === 'obs' ? 4096 : 4320;
    if (!Number.isInteger(width) || width < 320 || width > maxWidth) return setError(`宽度范围为 320–${maxWidth}。`);
    if (!Number.isInteger(height) || height < 240 || height > maxHeight) return setError(`高度范围为 240–${maxHeight}。`);
    if (backend === 'obs' && (width % 2 || height % 2)) return setError('OBS 模式要求宽高为偶数。');
    if (!Number.isInteger(fps) || fps < 1 || fps > 120) return setError('帧率范围为 1–120 FPS。');
    if (!Number.isInteger(bitrate) || (bitrate !== 0 && (bitrate < 200 || bitrate > 50000))) return setError('码率请输入 0，或 200–50000 Kbps。');
    const audioMode = settings.audioMode || 'none';
    if ((audioMode.includes('application') || audioMode.includes('exclude')) && !processAudioAvailable) return setError('当前环境不支持按应用捕获或排除声音。');
    if ((audioMode.includes('application') || audioMode.includes('exclude')) && !settings.audioSourceId) return setError(audioMode.includes('exclude') ? '请选择要从系统声音中排除的软件。' : '请选择要捕获声音的软件。');
    const systemAudio = audioMode === 'system' || audioMode === 'system-microphone';
    const microphone = audioMode === 'microphone' || audioMode.endsWith('-microphone');
    try {
      await onStart({ ...settings, width, height, fps, bitrate, audioMode, systemAudio, microphone });
    } catch (failure) {
      // OBS start errors stay on OBS. The user can switch to native manually,
      // but Roomcast must not hide the failing phase by changing modes itself.
      setError(failure.message);
    }
  };
  return <Modal title="屏幕共享" onClose={onClose} wide busy={busy || loading}>
    {window.roomcast?.desktop && <div className="segmented" role="group" aria-label="采集引擎"><button type="button" className={backend === 'obs' ? 'selected' : ''} onClick={() => switchBackend('obs')} disabled={busy || loading}>OBS</button><button type="button" className={backend === 'native' ? 'selected' : ''} onClick={() => switchBackend('native')} disabled={busy || loading}>原生采集</button></div>}
    <div className="source-tabs"><button className={type === 'monitor' ? 'active' : ''} onClick={() => switchType('monitor')} disabled={busy}><Monitor size={17} />整个屏幕</button><button className={type === 'window' ? 'active' : ''} onClick={() => switchType('window')} disabled={busy}><AppWindow size={17} />应用窗口</button><button className="icon-button refresh-sources" title="刷新采集来源" aria-label="刷新采集来源" onClick={() => load()} disabled={loading || busy}><RefreshCw size={15} className={loading ? 'spin' : ''} /></button></div>
    <div className="source-grid">{loading ? <div className="source-empty"><LoaderCircle className="spin" />正在读取本机采集来源…</div> : items.length ? items.map(source => <button key={source.id} className={`source-card ${settings.sourceId === String(source.id) ? 'selected' : ''}`} onClick={() => update({ sourceId: String(source.id) })} disabled={busy}><div className="source-art">{type === 'monitor' ? <Monitor size={38} strokeWidth={1.1} /> : <AppWindow size={38} strokeWidth={1.1} />}<span className="source-check">{settings.sourceId === String(source.id) && <Check size={13} />}</span></div><span title={source.name}>{source.name}</span></button>) : <div className="source-empty"><Monitor size={30} /><strong>还没有可用的采集来源</strong><span>请打开要共享的应用窗口，然后刷新来源。</span></div>}</div>
    <label className="section-label">画面质量</label><div className="quality-options">{presets.map(item => <button key={item.id} className={settings.preset === item.id ? 'selected' : ''} onClick={() => selectPreset(item)} disabled={busy}><strong>{item.label}</strong><span>{item.detail}</span>{settings.preset === item.id && <Check size={14} />}</button>)}</div>
    <div className="custom-parameters"><label>宽度<input aria-label="共享宽度" type="number" min="320" max="7680" value={settings.width} onChange={event => numeric('width', event.target.value)} /></label><span>×</span><label>高度<input aria-label="共享高度" type="number" min="240" max="4320" value={settings.height} onChange={event => numeric('height', event.target.value)} /></label><label>帧率<input aria-label="共享帧率" type="number" min="1" max="120" value={settings.fps} onChange={event => numeric('fps', event.target.value)} /><small>FPS</small></label><label>码率<input aria-label="共享码率" type="number" min="0" max="50000" step="100" value={settings.bitrate} onChange={event => numeric('bitrate', event.target.value)} /><small>Kbps · 0=自动</small></label></div>
    <div className="share-parameter-summary"><strong>将使用的共享参数</strong><span>{settings.width || '—'} × {settings.height || '—'} · {settings.fps || '—'} FPS · {Number(settings.bitrate) === 0 ? '码率自动（不设应用上限）' : `${settings.bitrate || '—'} Kbps 上限`}</span><span>WebRTC / DTLS-SRTP · P2P 每位观看者占用一份上行带宽</span></div>
    <label className="section-label">共享声音</label>
    <div className="audio-mode-options" role="radiogroup" aria-label="共享声音来源">
      <label className={currentAudioMode === 'none' || currentAudioMode === 'microphone' ? 'selected' : ''}><input type="radio" name="share-audio-mode" checked={currentAudioMode === 'none' || currentAudioMode === 'microphone'} onChange={() => toggleAudioSource('', false)} disabled={busy} /><span><strong>不共享声音</strong><small>只共享画面</small></span></label>
      <label className={sharesSystemAudio ? 'selected' : ''}><input type="radio" name="share-audio-mode" checked={sharesSystemAudio} onChange={() => toggleAudioSource('system', true)} disabled={busy} /><span><strong>全部应用声音</strong><small>包括游戏和播放器</small></span></label>
      <label className={sharesApplicationAudio ? 'selected' : ''}><input type="radio" name="share-audio-mode" checked={sharesApplicationAudio} onChange={() => toggleAudioSource('application', true)} disabled={busy || !processAudioAvailable} /><span><strong>所选程序声音</strong><small>推荐，避免通话回声</small></span></label>
      <label className={excludesApplicationAudio ? 'selected' : ''}><input type="radio" name="share-audio-mode" checked={excludesApplicationAudio} onChange={() => toggleAudioSource('exclude', true)} disabled={busy || !processAudioAvailable} /><span><strong>排除所选程序</strong><small>本机可听，观看者听不到</small></span></label>
    </div>
    {backendNotice && <div className="setting-inline-note" role="status">{backendNotice}</div>}
    {audioLoading && <div className="setting-inline-note">正在读取可按应用处理的声音来源…</div>}
    {audioError && <div className="setting-inline-note" role="status" title={audioError}>应用声音列表暂不可用；仍可正常共享画面、全部应用声音或麦克风。Roomcast 会自动重试。</div>}
    {(sharesApplicationAudio || excludesApplicationAudio) && <Dropdown label={excludesApplicationAudio ? '从系统声音中排除' : '选择游戏或应用'} value={settings.audioSourceId || ''} onChange={value => update({ audioSourceId: value })} disabled={busy} options={[...(!settings.audioSourceId ? [{ value: '', label: '请选择应用' }] : []), ...(sources.applications || []).map(item => ({ value: String(item.id), label: audioApplicationLabel(item) }))]} />}
    {(sharesSystemAudio || sharesApplicationAudio || excludesApplicationAudio) && <label className="switch-row compact-audio-switch"><span><Volume2 size={18} /><span>静音共享声音</span></span><input type="checkbox" checked={settings.applicationMuted === true} onChange={event => update({ applicationMuted: event.target.checked })} disabled={busy} /><span className="switch" aria-hidden="true" /></label>}
    <label className="switch-row"><span><Mic size={18} /><span>加入麦克风<small>{audioDevices?.preferences.inputId ? '使用设置中选择的麦克风，可与共享声音分别静音。' : '使用系统默认麦克风，可与共享声音分别静音。'}</small></span></span><input type="checkbox" checked={sharesMicrophone} onChange={event => update({ audioMode: composeAudioMode(sharesSystemAudio ? 'system' : sharesApplicationAudio ? 'application' : excludesApplicationAudio ? 'exclude' : '', event.target.checked) })} disabled={busy} /><span className="switch" aria-hidden="true" /></label>
    {sharesMicrophone && <label className="switch-row"><span><Mic size={18} /><span>静音共享麦克风<small>保留麦克风音轨，但暂时不发送声音。</small></span></span><input type="checkbox" checked={settings.microphoneMuted === true} onChange={event => update({ microphoneMuted: event.target.checked })} disabled={busy} /><span className="switch" aria-hidden="true" /></label>}
    {error && <div className="inline-error" role="alert"><Info size={16} />{error}</div>}
    <footer className="modal-actions"><button className="button secondary" onClick={onClose} disabled={busy || loading}>取消</button><button className="button primary" onClick={submit} disabled={!settings.sourceId || busy || loading}>{busy ? <LoaderCircle size={17} className="spin" /> : <ScreenShare size={17} />}{busy ? editing ? '正在应用设置…' : '正在建立共享…' : editing ? '应用并重新共享' : '开始共享'}</button></footer>
  </Modal>;
}

function AboutPanel({ version = '' }) {
  return <>
    <section className="settings-section"><h3><Info size={17} />关于</h3>
      <div className="about-card">
        <div className="about-brand"><span className="brand-mark"><span /><span /></span><div><strong>同屏 Roomcast</strong><span>{version ? `版本 ${version}` : '本地开发版'} · 公开测试版（Beta）</span></div></div>
        <p className="about-line">作者与维护：D4Y0 / Roomcast</p>
        <p className="about-line">问题反馈：<a href="https://github.com/lpossj/roomcast/issues" target="_blank" rel="noreferrer noopener">GitHub Issues</a> · 2106841308@qq.com · z2106841308@163.com</p>
        <p className="about-line">源码仓库：<a href="https://github.com/lpossj/roomcast" target="_blank" rel="noreferrer noopener">github.com/lpossj/roomcast</a></p>
      </div>
    </section>
    <section className="settings-section"><h3><ShieldCheck size={17} />使用声明</h3>
      <p className="about-note">仅用于合法、知情同意的屏幕共享与聊天。禁止用于未经同意的监控、偷拍、监听、跟踪、骚扰或其他违法用途；使用者应自行遵守当地法律与平台规则。</p>
      <p className="about-note">房间状态与聊天是内存态，房间结束后释放，不写入数据库。屏幕媒体通过 WebRTC DTLS-SRTP 在成员之间传输。</p>
      <p className="about-note">网页观看入口基于 Cloudflare Quick Tunnel（临时地址、可能变化且不保证可用性，有并发限制），仅由"分享房间"按需创建；邀请链接等同于入房凭据，请只发给预期成员。</p>
      <p className="about-note">未使用商业代码签名，Windows SmartScreen 可能提示未知发布者；下载后请核对发布页提供的 SHA-256。</p>
    </section>
    <section className="settings-section"><h3><Palette size={17} />许可与第三方组件</h3>
      <p className="about-note">Roomcast 主体源码采用 Apache License 2.0。</p>
      <p className="about-note">随包组件：OBS Studio 32.1.2（GPL-2.0-or-later，附对应源码归档）、cloudflared 2026.9.2（Apache-2.0）、Windows 系统音频 loopback 采集组件（第三方 MIT 预编译二进制）。完整清单见安装目录下的 <code>NOTICE</code> 与 <code>THIRD-PARTY-NOTICES.txt</code>，隐私与安全边界见 <code>PRIVACY.md</code> 与 <code>SECURITY.md</code>。</p>
    </section>
  </>;
}

function SettingsModal({ onClose, isDesktop, canShareScreen, localConfig, refresh, devices, devicePreferences, setDevicePreferences, refreshDevices, relaySettings, setRelaySettings, themeColor, setThemeColor, themeMode, setThemeMode, effectiveThemeColor }) {
  const [working, setWorking] = useState('');
  const [error, setError] = useState('');
  const [section, setSection] = useState('general');
  const testRelay = async () => { setWorking('relay'); setError(''); try { const servers = await fetchRelayIce(relaySettings); setRelaySettings(relaySettings); alert(`TURN 可用，已获取 ${servers.length} 组临时 ICE 地址。`); } catch (failure) { setError(failure.message); } finally { setWorking(''); } };
  const themePresets = ['#78ddbd', '#6aa9ff', '#a98bff', '#ff8fb8', '#f0b35f', '#8bd36e'];
  // Web clients cannot capture a screen or enumerate capture devices, so those sections
  // are not rendered at all instead of being shown disabled.
  const sections = [
    { id: 'general', label: '通用', icon: Palette },
    ...(canShareScreen ? [{ id: 'audio', label: '音频与采集', icon: Headphones }] : []),
    { id: 'network', label: '网络', icon: Wifi },
    ...(isDesktop ? [{ id: 'service', label: '本地服务', icon: Server }] : []),
    { id: 'about', label: '关于', icon: Info },
  ];
  const active = sections.some(item => item.id === section) ? section : 'general';
  return <Modal title="设置" onClose={onClose} wide busy={!!working}>
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="设置分类">
        {sections.map(item => <button key={item.id} type="button" className={active === item.id ? 'selected' : ''} aria-current={active === item.id ? 'true' : undefined} onClick={() => setSection(item.id)}><item.icon size={16} />{item.label}</button>)}
      </nav>
      <div className="settings-panel">
        {active === 'general' && <>
          <section className="settings-section"><h3><Palette size={17} />界面主题</h3><div className="theme-mode-toggle" role="group" aria-label="主题颜色来源"><button type="button" className={themeMode === THEME_MODE_WINDOWS ? 'selected' : ''} onClick={() => setThemeMode(THEME_MODE_WINDOWS)}>跟随 Windows</button><button type="button" className={themeMode === THEME_MODE_CUSTOM ? 'selected' : ''} onClick={() => setThemeMode(THEME_MODE_CUSTOM)}>自定义</button></div>{themeMode === THEME_MODE_CUSTOM ? <><div className="theme-color-row"><label className="theme-color-picker" title="选择自定义主题色"><input type="color" value={themeColor} onChange={event => setThemeColor(event.target.value)} aria-label="选择主题色" /><span className="theme-color-swatch" style={{ background: themeColor }} /></label><div className="theme-preset-list" aria-label="主题色预设">{themePresets.map(color => <button key={color} type="button" className={`theme-preset ${themeColor === color ? 'selected' : ''}`} style={{ '--swatch': color }} onClick={() => setThemeColor(color)} aria-label={`使用主题色 ${color}`}><span /></button>)}</div><button type="button" className="button subtle small" onClick={() => setThemeColor(DEFAULT_THEME_COLOR)} disabled={themeColor === DEFAULT_THEME_COLOR}>恢复默认</button></div><div className="theme-color-value"><span>当前主题色</span><code>{themeColor.toUpperCase()}</code></div></> : <div className="theme-windows-color"><span className="theme-windows-swatch" style={{ background: effectiveThemeColor }} aria-hidden="true" /><span>使用 Windows 强调色</span><code>{effectiveThemeColor.toUpperCase()}</code></div>}</section>
          {isDesktop && <section className="settings-section"><h3><MonitorUp size={17} />屏幕采集</h3><div className="diagnostic-row"><span>原生屏幕 / 窗口采集</span><span className="good-text"><Check size={14} />WebRTC P2P</span></div></section>}
        </>}
        {active === 'audio' && <><section className="settings-section"><h3><Headphones size={17} />共享音频设备</h3><div className="device-grid"><label>共享用麦克风<select aria-label="选择麦克风" value={devicePreferences.inputId} onChange={event => setDevicePreferences(value => ({ ...value, inputId: event.target.value }))}><option value="">系统默认麦克风</option>{devices.inputs.filter(item => item.id && item.id !== 'default').map(item => <option value={item.id} key={item.id}>{item.label}</option>)}</select></label><label>共享声音播放设备<select aria-label="选择扬声器" value={devicePreferences.outputId} onChange={event => setDevicePreferences(value => ({ ...value, outputId: event.target.value }))}><option value="">系统默认扬声器</option>{devices.outputs.filter(item => item.id && item.id !== 'default').map(item => <option value={item.id} key={item.id}>{item.label}</option>)}</select></label></div><div className="settings-buttons"><button className="button subtle small" onClick={() => refreshDevices().catch(failure => setError(failure.message))}><RefreshCw size={15} />刷新设备</button></div></section>
          {isDesktop && <section className="settings-section"><h3><MonitorUp size={17} />屏幕采集</h3><div className="diagnostic-row"><span>原生屏幕 / 窗口采集</span><span className="good-text"><Check size={14} />WebRTC P2P</span></div><div className="diagnostic-row"><span>采集引擎</span><span className="muted-text">OBS 固定帧率 / 原生采集</span></div></section>}</>}
        {active === 'network' && <section className="settings-section"><h3><Wifi size={17} />Cloudflare TURN 中继</h3><label className="switch-row"><span><ShieldCheck size={18} /><span>启用 TURN</span></span><input type="checkbox" checked={relaySettings.enabled} onChange={event => setRelaySettings({ ...relaySettings, enabled: event.target.checked })} /><span className="switch" aria-hidden="true" /></label><label className="standalone-label">Worker 地址<input value={relaySettings.endpoint} onChange={event => setRelaySettings({ ...relaySettings, endpoint: event.target.value })} placeholder="https://roomcast.example.com" spellCheck={false} /></label><label className="standalone-label">Worker 访问密钥<input type="password" value={relaySettings.accessKey} onChange={event => setRelaySettings({ ...relaySettings, accessKey: event.target.value })} placeholder="部署 Worker 时自己设置的随机密钥" autoComplete="off" /></label><div className="settings-buttons"><button className="button secondary small" onClick={testRelay} disabled={!relaySettings.enabled || !!working}>{working === 'relay' ? <LoaderCircle size={15} className="spin" /> : <Wifi size={15} />}保存并测试 TURN</button></div></section>}
        {active === 'service' && isDesktop && <section className="settings-section"><h3><Server size={17} />本地服务</h3><div className="diagnostic-row"><span>房间控制服务</span><span className={localConfig ? 'good-text' : 'muted-text'}>{localConfig ? <><Check size={14} />正在运行 · :{localConfig.port}</> : '无法连接'}</span></div><div className="settings-buttons"><button className="button subtle small" onClick={refresh}><RefreshCw size={15} />刷新状态</button></div></section>}
        {active === 'about' && <AboutPanel version={localConfig?.version || APP_VERSION} />}
        {error && <div className="inline-error" role="alert"><Info size={16} />{error}</div>}
      </div>
    </div>
    <footer className="settings-footer"><span><ShieldCheck size={14} />P2P 房间 · 最多 10 人</span><span>{localConfig?.version || APP_VERSION ? `Roomcast ${localConfig?.version || APP_VERSION}` : 'Roomcast'}</span></footer>
  </Modal>;
}

function MemberPermissionsModal({ member, self, onClose, command }) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const run = async (event, payload) => { setBusy(event); setError(''); try { await command(event, payload); onClose(); } catch (failure) { setError(failure.message); } finally { setBusy(''); } };
  const owner = self?.role === 'owner';
  return <Modal title={`管理 ${member.name}`} subtitle="角色和共享权限由房间服务校验，修改会立即同步给所有成员。" onClose={onClose} busy={!!busy}>
    <div className="permission-member"><div className={`avatar ${avatarClass(member.avatarColor)}`}>{initials(member.name)}</div><div><strong>{member.name}</strong><span>{member.role === 'admin' ? '管理员' : '用户'} · {member.canShare ? '允许共享' : '已禁止共享'}</span></div></div>
    {owner && <section className="settings-section"><h3><ShieldCheck size={17} />成员角色</h3><div className="settings-buttons"><button className={`button small ${member.role === 'admin' ? 'primary' : 'secondary'}`} onClick={() => run('member:role', { memberId: member.id, role: 'admin' })} disabled={!!busy || member.role === 'admin'}>设为管理员</button><button className={`button small ${member.role === 'user' ? 'primary' : 'secondary'}`} onClick={() => run('member:role', { memberId: member.id, role: 'user' })} disabled={!!busy || member.role === 'user'}>设为用户</button></div></section>}
    <section className="settings-section"><h3><ScreenShare size={17} />屏幕共享权限</h3><p className="setting-description">禁止后，该成员正在进行的共享会立即停止。</p><div className="settings-buttons"><button className="button secondary small" onClick={() => run('member:share-permission', { memberId: member.id, canShare: true })} disabled={!!busy || member.canShare}>允许共享</button><button className="button danger-share small" onClick={() => run('member:share-permission', { memberId: member.id, canShare: false })} disabled={!!busy || !member.canShare}>禁止共享</button></div></section>
    <section className="settings-section"><h3><LogOut size={17} />成员管理</h3><p className="setting-description">踢出后，该成员的共享会立即结束并离开房间。</p><button className="button danger-share small" onClick={() => run('member:kick', { memberId: member.id })} disabled={!!busy}>{busy === 'member:kick' ? <LoaderCircle size={15} className="spin" /> : <LogOut size={15} />}踢出房间</button></section>
    {error && <div className="inline-error"><Info size={16} />{error}</div>}
  </Modal>;
}

function InviteModal({ room, server, localConfig, onClose, copy, isP2P, relayInvite, inviteSecret, peerServer }) {
  const addresses = (localConfig?.addresses || []).map(value => typeof value === 'string' ? value : value.url).filter(Boolean);
  const loopback = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(server);
  const [address, setAddress] = useState(loopback ? addresses.find(value => /^https?:\/\/100\./.test(value)) || addresses.find(value => !/localhost|127\.0\.0\.1/.test(value)) || server : server);
  const [webViewerUrl, setWebViewerUrl] = useState(window.roomcast?.desktop ? '' : window.location.origin);
  const [webViewerError, setWebViewerError] = useState('');
  const [webViewerBusy, setWebViewerBusy] = useState(false);
  const startWebViewer = useCallback(() => {
    if (!window.roomcast?.startWebInvite) return;
    setWebViewerBusy(true);
    setWebViewerError('');
    window.roomcast.startWebInvite().then(result => setWebViewerUrl(result.url || '')).catch(error => setWebViewerError(error.message || '网页入口连接失败。')).finally(() => setWebViewerBusy(false));
  }, []);
  useEffect(() => {
    if (!isP2P || !window.roomcast?.startWebInvite) return undefined;
    startWebViewer();
    return window.roomcast.onWebInviteState?.(state => { if (!state.url) setWebViewerUrl(''); });
  }, [isP2P, startWebViewer]);
  const link = `${address}/?room=${encodeURIComponent(room.id)}&server=${encodeURIComponent(address)}`;
  const p2pLink = `roomcast://join/${room.id}?secret=${encodeURIComponent(inviteSecret || '')}${relayInvite ? `&relay=${relayInvite}` : ''}${peerServer ? `&signal=${encodeURIComponent(peerServer)}` : ''}`;
  const webLink = (() => {
    try {
      const url = new URL(webViewerUrl.trim());
      if (url.protocol !== 'https:' || url.username || url.password) return '';
      url.search = '';
      url.hash = '';
      url.hash = new URLSearchParams({ room: p2pLink }).toString();
      return url.href;
    } catch { return ''; }
  })();
  if (isP2P) return <Modal title="分享房间" onClose={onClose}>
    <div className="invite-room"><div className="room-symbol"><AudioLines size={27} /></div><div><strong>{room.name}</strong><span>{room.members.length} / 10 位成员在线</span></div></div>
    <label className="standalone-label">邀请链接<input value={p2pLink} readOnly onFocus={event => event.target.select()} /></label>
    <button className="button primary full" onClick={() => copy(p2pLink)}><Copy size={17} />复制邀请链接</button>
    <><label className="standalone-label">电脑／手机网页观看链接<input value={webLink} readOnly placeholder={webViewerBusy ? '正在创建安全网页入口…' : '网页入口尚未就绪'} onFocus={event => event.target.select()} /></label>
      <button className="button secondary full" onClick={() => copy(webLink)} disabled={!webLink}><Copy size={17} />复制网页观看链接</button>
      {webViewerError && <div className="inline-error"><Info size={16} />{webViewerError}<button className="button secondary small" onClick={startWebViewer} disabled={webViewerBusy}>重试</button></div>}</>
  </Modal>;
  return <Modal title="分享房间" onClose={onClose}>
    <div className="invite-room"><div className="room-symbol"><AudioLines size={27} /></div><div><strong>{room.name}</strong><span>{room.members.length} / 10 位成员在线</span></div></div>
    <label className="standalone-label">朋友可以连接的服务地址<input value={address} onChange={event => setAddress(event.target.value.replace(/\/$/, ''))} spellCheck={false} /></label>
    {loopback && addresses.length > 1 && <div className="address-suggestions">{addresses.filter(value => !/localhost|127\.0\.0\.1/.test(value)).map(value => <button key={value} onClick={() => setAddress(value)}>{value}</button>)}</div>}
    <button className="button primary full" onClick={() => copy(`来同屏「${room.name}」\n服务地址：${address}\n邀请链接：${link}`)}><Copy size={17} />复制邀请信息</button>
  </Modal>;
}

function ChatItem({ message, selfId, onRecall, onPreview, onImageContextMenu }) {
  if (message.system) return <div className="system-message">{message.text}</div>;
  const own = message.memberId === selfId;
  const images = message.kind === 'image'
    ? (Array.isArray(message.images) && message.images.length
      ? message.images
      : [{ id: message.id, fileName: message.fileName, objectUrl: message.objectUrl }])
    : [];
  return <article className={`chat-message ${own ? 'own-message' : ''}`}>
    <div className={`avatar ${avatarClass(message.avatarColor)}`}>{initials(message.name)}</div>
    <div className="chat-message-body"><div className="chat-message-meta"><strong>{message.name}</strong><time dateTime={new Date(message.at).toISOString()}>{timeLabel(message.at)}</time>{own && !message.recalled && <button className="chat-recall" title="撤回消息" aria-label="撤回消息" onClick={() => onRecall(message.id)}><RotateCcw size={12} /></button>}</div>
      {message.recalled ? <p className="recalled-message">该消息已撤回</p> : message.kind === 'image' ? <>
        {message.text && <p>{message.text}</p>}
        <div className={`chat-image-grid count-${Math.min(images.length, MAX_CHAT_IMAGES)}`}>
          {images.map((image, index) => image.objectUrl
            ? <button key={image.id || index} type="button" className="chat-image-button" onClick={() => onPreview({ src: image.objectUrl, alt: image.fileName || `聊天图片 ${index + 1}`, fileName: image.fileName || '' })} onContextMenu={event => onImageContextMenu(event, image.objectUrl)} aria-label={`查看第 ${index + 1} 张大图`}><img className="chat-image" src={image.objectUrl} alt={image.fileName || `聊天图片 ${index + 1}`} /></button>
            : <p key={image.id || index} className="image-unavailable">图片未保留（{image.fileName || `图片 ${index + 1}`}）</p>)}
        </div>
      </> : <p>{message.text}</p>}
    </div>
  </article>;
}

function ImagePreviewOverlay({ image, onClose, onImageContextMenu, onCopy, onDownload }) {
  const MIN_ZOOM = 0.001, MAX_ZOOM = 8;
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const stageRef = useRef(null);
  const imageRef = useRef(null);
  const dragRef = useRef(null);
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 });
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [initialized, setInitialized] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [view, setView] = useState({ scale: 1, rotation: 0, panX: 0, panY: 0 });

  const clampZoom = value => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
  const normalizeRotation = value => ((value % 360) + 360) % 360;
  const rotatedSize = (size, rotation) => {
    const normalized = normalizeRotation(rotation);
    const sideways = normalized === 90 || normalized === 270;
    return sideways
      ? { width: size.height, height: size.width }
      : { width: size.width, height: size.height };
  };
  const fitScaleFor = (size, rotation, frame = viewport) => {
    if (!size.width || !size.height || !frame.width || !frame.height) return 1;
    const rotated = rotatedSize(size, rotation);
    return clampZoom(Math.min(1, frame.width / rotated.width, frame.height / rotated.height));
  };
  const clampPan = (candidate, scale, rotation, size = naturalSize, frame = viewport) => {
    if (!size.width || !size.height || !frame.width || !frame.height) return { x: 0, y: 0 };
    const rotated = rotatedSize(size, rotation);
    const displayWidth = rotated.width * scale;
    const displayHeight = rotated.height * scale;
    // Center-based coordinate model: when the transformed image is larger than
    // the viewport, its edge can be brought exactly to the opposite viewport edge.
    // When it is smaller, that axis stays centered instead of drifting.
    const maxX = Math.max(0, (displayWidth - frame.width) / 2);
    const maxY = Math.max(0, (displayHeight - frame.height) / 2);
    return {
      x: Math.min(maxX, Math.max(-maxX, candidate.x)),
      y: Math.min(maxY, Math.max(-maxY, candidate.y)),
    };
  };
  const zoomBy = (factor, anchor = null) => {
    if (!initialized) return;
    setView(current => {
      const nextScale = clampZoom(current.scale * factor);
      if (Math.abs(nextScale - current.scale) < 0.000001) return current;
      let candidate = { x: current.panX, y: current.panY };
      if (anchor) {
        const ratio = nextScale / current.scale;
        candidate = {
          x: anchor.x - (anchor.x - current.panX) * ratio,
          y: anchor.y - (anchor.y - current.panY) * ratio,
        };
      }
      const nextPan = clampPan(candidate, nextScale, current.rotation);
      return { ...current, scale: nextScale, panX: nextPan.x, panY: nextPan.y };
    });
  };
  const resetSize = () => {
    setView({ scale: 1, rotation: 0, panX: 0, panY: 0 });
  };
  const fitToWindow = () => {
    if (!naturalSize.width || !naturalSize.height || !viewport.width || !viewport.height) return;
    setView(current => ({
      ...current,
      scale: fitScaleFor(naturalSize, current.rotation),
      panX: 0,
      panY: 0,
    }));
  };
  const rotate = delta => {
    if (!initialized) return;
    setView(current => {
      const nextRotation = normalizeRotation(current.rotation + delta);
      const nextPan = clampPan({ x: current.panX, y: current.panY }, current.scale, nextRotation);
      return { ...current, rotation: nextRotation, panX: nextPan.x, panY: nextPan.y };
    });
  };

  useEffect(() => {
    const key = event => { if (event.key === 'Escape') closeRef.current(); };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    const update = () => {
      const width = stage.clientWidth;
      const height = stage.clientHeight;
      if (!width || !height) return;
      setViewport(current => current.width === width && current.height === height ? current : { width, height });
    };
    update();
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(update);
      observer.observe(stage);
      return () => observer.disconnect();
    }
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  useEffect(() => {
    if (initialized || !naturalSize.width || !naturalSize.height || !viewport.width || !viewport.height) return;
    setView({ scale: fitScaleFor(naturalSize, 0, viewport), rotation: 0, panX: 0, panY: 0 });
    setInitialized(true);
  }, [initialized, naturalSize.width, naturalSize.height, viewport.width, viewport.height]);

  useEffect(() => {
    if (!initialized) return;
    setView(current => {
      const nextPan = clampPan({ x: current.panX, y: current.panY }, current.scale, current.rotation);
      if (Math.abs(nextPan.x - current.panX) < 0.001 && Math.abs(nextPan.y - current.panY) < 0.001) return current;
      return { ...current, panX: nextPan.x, panY: nextPan.y };
    });
  }, [initialized, viewport.width, viewport.height, naturalSize.width, naturalSize.height]);

  if (!image) return null;
  return <div className="image-preview-overlay" role="dialog" aria-modal="true" aria-label="图片预览">
    <button type="button" className="image-preview-close" onClick={onClose} aria-label="关闭图片预览"><X size={24} /></button>
    <div
      className={`image-preview-canvas ${dragging ? 'dragging' : ''}`}
      ref={stageRef}
      onWheel={event => {
        if (!initialized) return;
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        zoomBy(event.deltaY < 0 ? 1.12 : 1 / 1.12, {
          x: event.clientX - rect.left - rect.width / 2,
          y: event.clientY - rect.top - rect.height / 2,
        });
      }}
      onPointerDown={event => {
        if (!initialized || event.button !== 0 || event.target !== imageRef.current) return;
        dragRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          panX: view.panX,
          panY: view.panY,
        };
        event.currentTarget.setPointerCapture?.(event.pointerId);
        setDragging(true);
        event.preventDefault();
      }}
      onPointerMove={event => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        if (event.buttons === 0) {
          dragRef.current = null;
          setDragging(false);
          try { event.currentTarget.releasePointerCapture?.(event.pointerId); } catch {}
          return;
        }
        const candidate = {
          x: drag.panX + event.clientX - drag.startX,
          y: drag.panY + event.clientY - drag.startY,
        };
        setView(current => {
          const nextPan = clampPan(candidate, current.scale, current.rotation);
          return { ...current, panX: nextPan.x, panY: nextPan.y };
        });
        event.preventDefault();
      }}
      onPointerUp={event => {
        if (dragRef.current?.pointerId !== event.pointerId) return;
        dragRef.current = null;
        setDragging(false);
        try { event.currentTarget.releasePointerCapture?.(event.pointerId); } catch {}
      }}
      onPointerCancel={event => {
        if (dragRef.current?.pointerId !== event.pointerId) return;
        dragRef.current = null;
        setDragging(false);
      }}
      onLostPointerCapture={event => {
        if (dragRef.current?.pointerId !== event.pointerId) return;
        dragRef.current = null;
        setDragging(false);
      }}
    >
      <div
        className="image-preview-transform"
        style={{ transform: `translate3d(${view.panX}px, ${view.panY}px, 0)` }}
      >
        <img
          ref={imageRef}
          src={image.src}
          alt={image.alt || '聊天图片预览'}
          draggable={false}
          style={{
            width: naturalSize.width ? `${naturalSize.width}px` : undefined,
            height: naturalSize.height ? `${naturalSize.height}px` : undefined,
            transform: `translate(-50%, -50%) rotate(${view.rotation}deg) scale(${view.scale})`,
            visibility: initialized ? 'visible' : 'hidden',
          }}
          onLoad={event => {
            const size = {
              width: event.currentTarget.naturalWidth || 1,
              height: event.currentTarget.naturalHeight || 1,
            };
            setNaturalSize(size);
          }}
          onContextMenu={event => onImageContextMenu?.(event, image.src)}
        />
      </div>
    </div>
    <div className="image-preview-toolbar" role="toolbar" aria-label="图片预览工具">
      <button type="button" title="缩小（以图片中心为中心）" aria-label="缩小" disabled={view.scale <= MIN_ZOOM + 0.0001} onClick={() => zoomBy(1 / 1.2)}><ZoomOut size={22} /></button>
      <button type="button" title="放大（以图片中心为中心）" aria-label="放大" disabled={view.scale >= MAX_ZOOM - 0.001} onClick={() => zoomBy(1.2)}><ZoomIn size={22} /></button>
      <button type="button" className="image-preview-reset-size" title="还原大小（100%）" aria-label="还原大小" onClick={resetSize}>1:1</button>
      <button type="button" title="适应窗口" aria-label="适应窗口" onClick={fitToWindow}><Maximize2 size={21} /></button>
      <span className="image-preview-tool-separator" aria-hidden="true" />
      <button type="button" title="向左旋转 90°" aria-label="向左旋转 90 度" onClick={() => rotate(-90)}><RotateCcw size={22} /></button>
      <button type="button" title="向右旋转 90°" aria-label="向右旋转 90 度" onClick={() => rotate(90)}><RotateCw size={22} /></button>
      <span className="image-preview-tool-separator" aria-hidden="true" />
      <button type="button" title="下载图片" aria-label="下载图片" onClick={() => onDownload?.(image)}><Download size={22} /></button>
      <button type="button" title="复制图片" aria-label="复制图片" onClick={() => onCopy?.(image.src)}><Copy size={21} /></button>
    </div>
  </div>;
}

function EmptyScreen({ room, onShare, onCreate, onJoin }) {
  return <div className="empty-screen">
    <div className="empty-grid" aria-hidden="true" />
    <div className="screen-illustration" aria-hidden="true"><div className="illustration-orbit orbit-one" /><div className="illustration-orbit orbit-two" /><div className="floating-tile tile-a"><AudioLines size={23} /></div><div className="floating-tile tile-b"><MessageSquare size={20} /></div><div className="monitor-assembly"><div className="illustration-monitor"><div className="illustration-title"><i /><i /><i /><span /></div><div className="illustration-content"><div className="share-glyph"><ScreenShare size={36} strokeWidth={1.35} /></div><div className="illustration-line" /><div className="illustration-line short" /></div><div className="illustration-cursor"><ArrowRight size={17} /></div></div><div className="monitor-neck" /><div className="monitor-foot" /></div></div>
    <div className="empty-copy"><span className="eyebrow">A LITTLE CLOSER, EVEN FROM AFAR</span><h1>{room ? onShare ? '你的屏幕，就是聚会的开始' : '等待朋友共享屏幕' : <>分享一个屏幕，<br />一起多待一会儿。</>}</h1><div className="empty-actions">{room ? onShare ? <button className="button primary" onClick={onShare}><ScreenShare size={18} />开始屏幕共享<ArrowRight size={16} /></button> : <p className="setting-description">当前浏览器不支持屏幕采集，可以观看和聊天。</p> : <>{onCreate && <button className="button primary" onClick={onCreate}><Plus size={18} />创建房间</button>}<button className={onCreate ? 'button secondary' : 'button primary'} onClick={onJoin}><Link size={17} />加入房间</button></>}</div></div>
    <span className="stage-corner top-left" /><span className="stage-corner top-right" /><span className="stage-corner bottom-left" /><span className="stage-corner bottom-right" />
  </div>;
}

export default function App() {
  const desktopChrome = window.roomcast?.desktop === true;
  const canShareScreen = desktopChrome || typeof navigator.mediaDevices?.getDisplayMedia === 'function';
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);
  const notify = useCallback(text => { clearTimeout(toastTimer.current); setToast({ text }); toastTimer.current = setTimeout(() => setToast(null), 8500); }, []);
  const session = useRoom(notify);
  const { room, selfId, server, config, connection, socketRef, messages, hasOlderMessages, historyLoading, loadOlderMessages, sendMessage, sendImages, recallMessage, enter, leave, command } = session;
  const audioDevices = useDevices();
  const [relaySettings, setRelaySettingsState] = useState(loadRelaySettings);
  const [themeColor, setThemeColorState] = useState(INITIAL_CUSTOM_THEME_COLOR);
  const [themeMode, setThemeModeState] = useState(INITIAL_THEME_MODE);
  const [windowsAccentColor, setWindowsAccentColor] = useState(INITIAL_WINDOWS_ACCENT_COLOR);
  const effectiveThemeColor = themeMode === THEME_MODE_WINDOWS ? windowsAccentColor : themeColor;
  const persistThemeSettings = useCallback((mode, color) => {
    try { return window.roomcast?.setThemeSettings?.({ mode: normalizeThemeMode(mode), color: normalizeThemeColor(color) }) === true; }
    catch { return false; }
  }, []);
  const setThemeColor = useCallback(value => {
    const nextColor = normalizeThemeColor(value);
    const nextMode = THEME_MODE_CUSTOM;
    persistThemeSettings(nextMode, nextColor);
    setThemeColorState(nextColor);
    setThemeModeState(nextMode);
  }, [persistThemeSettings]);
  const setThemeMode = useCallback(value => {
    const nextMode = normalizeThemeMode(value);
    persistThemeSettings(nextMode, themeColor);
    setThemeModeState(nextMode);
    if (nextMode === THEME_MODE_WINDOWS) {
      try { setWindowsAccentColor(normalizeThemeColor(window.roomcast?.getSystemAccentColor?.() || DEFAULT_THEME_COLOR)); } catch { }
    }
  }, [persistThemeSettings, themeColor]);
  useEffect(() => { applyThemeColor(effectiveThemeColor); }, [effectiveThemeColor]);
  useEffect(() => window.roomcast?.onSystemAccentColor?.(color => setWindowsAccentColor(normalizeThemeColor(color))), []);
  const setRelaySettings = useCallback(value => { const next = typeof value === 'function' ? value(loadRelaySettings()) : value; saveRelaySettings(next); setRelaySettingsState(next); }, []);
  const [modal, setModal] = useState(initialInvite ? 'join' : null);
  const [managedMember, setManagedMember] = useState(null);
  const [inviteRoom, setInviteRoom] = useState(initialInvite);
  useEffect(() => window.roomcast?.onInvite?.(roomId => { setInviteRoom(roomId); setModal('join'); }), []);
  useEffect(() => {
    if (!desktopChrome || !window.roomcast?.setTitleBarTheme) return undefined;
    let previous = '';
    const syncTitlebar = () => {
      const color = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
      if (!/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(color) || color === previous) return;
      const raw = color.slice(1);
      const full = raw.length === 3 ? [...raw].map(character => character + character).join('') : raw;
      const red = Number.parseInt(full.slice(0, 2), 16);
      const green = Number.parseInt(full.slice(2, 4), 16);
      const blue = Number.parseInt(full.slice(4, 6), 16);
      const luminance = (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
      document.documentElement.style.setProperty('--titlebar-foreground', luminance >= 150 ? '#0b1116' : '#ffffff');
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
  const [showChat, setShowChat] = useState(() => window.innerWidth > 850);
  const [showMembers, setShowMembers] = useState(false);
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
  const streams = room?.streams || [];
  const ownShare = streams.some(stream => stream.memberId === selfId);
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
      if (!stopped) timer = setTimeout(measure, LATENCY_POLL_MS);
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

    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [room?.id, connection, socketRef]);
  useEffect(() => {
    const grid = screenGridRef.current;
    if (!grid) {
      setScreenGridWidth(0);
      return undefined;
    }
    const measure = () => setScreenGridWidth(Math.round(grid.getBoundingClientRect().width));
    measure();
    if (typeof ResizeObserver !== 'function') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect?.width;
      if (Number.isFinite(width)) setScreenGridWidth(Math.round(width));
    });
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
    const memberIds = new Set((room?.members || []).map(member => member.id));
    for (const ownerId of watchingStreams.current) if (!memberIds.has(ownerId)) watchingStreams.current.delete(ownerId);
  }, [room?.members]);

  const stopLocalShare = useCallback(async (socket = socketRef.current) => {
    socket?.stopScreenStream?.();
  }, [socketRef]);

  const refresh = useCallback(async () => {
    if (!desktopChrome) return;
    await fetch('/api/config').then(response => { if (!response.ok) throw new Error('本地服务未启动'); return response.json(); }).then(setLocalConfig).catch(() => setLocalConfig(null));
  }, [desktopChrome]);
  useEffect(() => { refresh(); return () => clearTimeout(toastTimer.current); }, [refresh]);
  useEffect(() => {
    const ended = event => notify(event.detail || '声音来源已不可用。');
    window.addEventListener('roomcast:audio-capture-ended', ended);
    return () => window.removeEventListener('roomcast:audio-capture-ended', ended);
  }, [notify]);
  useEffect(() => { if (stickToChatEnd.current) chatEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [messages.at(-1)?.seq]);
  useEffect(() => {
    if (!room && ownsCapture.current) { ownsCapture.current = false; stopLocalShare().catch(error => notify(`连接已结束，但停止采集失败：${error.message}`)); }
  }, [room, notify, stopLocalShare]);
  useEffect(() => {
    const unload = () => {
      if (ownsCapture.current) socketRef.current?.stopScreenStream?.();
      if (!window.roomcast?.desktop) socketRef.current?.disconnect?.();
    };
    window.addEventListener('beforeunload', unload);
    window.addEventListener('pagehide', unload);
    return () => { window.removeEventListener('beforeunload', unload); window.removeEventListener('pagehide', unload); };
  }, []);

  const copy = async text => {
    try {
      if (window.roomcast?.desktop && window.roomcast?.copyText) {
        const result = await window.roomcast.copyText(text);
        if (!result?.ok) throw new Error('Electron 剪贴板写入失败');
      } else if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else {
        const input = document.createElement('textarea'); input.value = text; input.style.position = 'fixed'; input.style.opacity = '0'; document.body.append(input); input.select();
        const ok = document.execCommand('copy'); input.remove(); if (!ok) throw new Error('请手动选择并复制内容');
      }
    } catch (error) { notify(`复制失败：${error.message}`); }
  };
  const handleEnter = async (mode, details) => {
    await enter(mode, { ...details, relaySettings });
    setModal(null);
    if (!desktopChrome && mode === 'create') notify('网页建房由本页面充当房间服务：请保持标签页运行，关闭或长时间切到后台会断开房间。');
  };
  const handleLeave = async () => {
    if (ownsCapture.current) { ownsCapture.current = false; try { await stopLocalShare(); } catch (error) { notify(`停止采集失败：${error.message}`); } }
    try {
      const outcome = await leave(); setModal(null); setChat(''); refresh();
      if (outcome?.closed) notify(outcome.reason || '房间已关闭。');
    } catch (error) { notify(error.message); }
  };
  // A backgrounded web page cannot answer the room handover probe, which used to leave the
  // desktop owner unable to exit. Web clients therefore leave the room themselves once the
  // page has been hidden for a while; the remembered invite makes rejoining a single tap.
  const backgroundLeaveRef = useRef(handleLeave);
  backgroundLeaveRef.current = handleLeave;
  useEffect(() => {
    if (desktopChrome) return undefined;
    let timer;
    const onVisibilityChange = () => {
      clearTimeout(timer);
      if (document.visibilityState !== 'hidden') return;
      timer = setTimeout(() => {
        if (!socketRef.current) return;
        void backgroundLeaveRef.current();
        setModal(initialInvite ? 'join' : null);
        notify('页面在后台停留过久，已退出房间；返回后可直接重新加入。');
      }, BACKGROUND_LEAVE_DELAY_MS);
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', onVisibilityChange); };
  }, [desktopChrome, notify]);
  const startShare = async options => {
    if (!room || shareBusy) return;
    const screenSocket = socketRef.current;
    const expectedRoom = room.id, expectedSocket = screenSocket?.id;
    let claimed = false, captured = null;
    const captureOptions = { ...options, inputDeviceId: audioDevices.preferences.inputId, outputDeviceId: audioDevices.preferences.outputId };
    const nativeShareAudio = Boolean(window.roomcast?.startAudioCapture && /(?:system|application|exclude)/.test(String(options.audioMode || '')));
    const captureRequest = nativeShareAudio ? { ...captureOptions, systemAudio: false, microphone: false } : captureOptions;
    const captureFactory = options.captureBackend === 'obs' ? startObsFixedFpsCapture : startIntegratedCapture;
    const capturePromise = captureFactory(captureRequest).then(stream => ({ stream }), error => ({ error }));
    setShareBusy(true);
    try {
      const result = await command('share:claim'); claimed = true;
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
        screenSocket?.stopScreenStream?.();
        command('share:stop').catch(() => { });
        if (captureEndedReason) notify(captureEndedReason);
      }, { once: true });
      screenSocket.setScreenStream(captured, options);
      if (activeRoomId.current !== expectedRoom || socketRef.current?.id !== expectedSocket) throw new Error('房间连接已变化，已取消屏幕共享');
      if (captureEnded || capturedVideoTrack?.readyState === 'ended') throw new Error(captureEndedReason || '屏幕采集在共享建立前已经结束。');
      ownsCapture.current = true;
      await command('share:started', { settings: options, microphone: options.microphone === true });
      if (captureEnded || capturedVideoTrack?.readyState === 'ended') throw new Error(captureEndedReason || '屏幕采集在共享建立时已经结束。');
      setModal(null); await refresh();
    } catch (error) {
      if (!captured) captured = (await capturePromise).stream || null;
      if (screenSocket?.screenStream === captured) screenSocket.stopScreenStream();
      else { for (const track of captured?.getTracks() || []) track.stop(); captured?.roomcastCleanup?.(); }
      if (claimed && socketRef.current?.id === expectedSocket) await command('share:stop').catch(() => { });
      ownsCapture.current = false; throw error;
    } finally { setShareBusy(false); }
  };
  const stopShare = async () => {
    if (shareBusy) return;
    setShareBusy(true);
    try { ownsCapture.current = false; await stopLocalShare(); await command('share:stop'); }
    catch (error) { notify(error.message); }
    finally { setShareBusy(false); refresh(); }
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
    if (!room) { setModal('create'); return; }
    if (!canShareScreen) { notify('当前浏览器不支持屏幕采集，可以观看和聊天。'); return; }
    if (!self?.canShare && !ownShare) { notify('管理员已关闭你的屏幕共享权限。'); return; }
    setModal('share');
  };
  const sendChat = async event => {
    event?.preventDefault();
    if ((!chat.trim() && !pendingImages.length) || sending || sendingImage || !room) return;
    if (pendingImages.length) { await sendPendingImages(chat.trim()); return; }
    setSending(true);
    try { await sendMessage(chat.trim()); setChat(''); stickToChatEnd.current = true; }
    catch (error) { notify(error.message); }
    finally { setSending(false); }
  };
  const stageImages = useCallback(files => {
    if (sendingImage || !room) return;
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
      const staged = prepared.map(file => ({ file, objectUrl: URL.createObjectURL(file) }));
      setPendingImages(current => [...current, ...staged]);
      stickToChatEnd.current = true;
      requestAnimationFrame(() => chatEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
    })();
  }, [notify, room, sendingImage]);
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
    } catch (error) { notify(error.message); }
    finally { setSendingImage(false); }
  };
  const handleImageContextMenu = (event, src) => {
    if (!window.roomcast?.copyImage || !src) return;
    event.preventDefault();
    event.stopPropagation();
    const menuWidth = 136, menuHeight = 40, edge = 8, titlebarOffset = desktopChrome ? 32 : 0;
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
    } catch (error) { notify(`下载图片失败：${error.message}`); }
  };
  const recall = async messageId => { try { await recallMessage(messageId); } catch (error) { notify(error.message); } };
  const reportViewing = useCallback((ownerId, event) => command(event, { ownerId }), [command]);
  const rememberViewing = useCallback((ownerId, viewing) => {
    if (viewing) watchingStreams.current.add(ownerId);
    else watchingStreams.current.delete(ownerId);
  }, []);
  const scrollChat = () => {
    const element = chatList.current;
    if (!element) return;
    stickToChatEnd.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100;
    if (element.scrollTop > 40 || historyLoading || !hasOlderMessages) return;
    const beforeHeight = element.scrollHeight, beforeTop = element.scrollTop;
    void loadOlderMessages().then(count => {
      if (!count) return;
      requestAnimationFrame(() => { if (chatList.current === element) element.scrollTop = element.scrollHeight - beforeHeight + beforeTop; });
    }).catch(error => notify(error.message));
  };

  return <div className={`app-shell ${showChat ? '' : 'chat-hidden'} ${showMembers ? 'members-open' : ''} ${desktopChrome ? 'desktop-chrome' : ''}`}>
    {desktopChrome && <div className="roomcast-titlebar" aria-hidden="true"><span className="roomcast-titlebar-logo"><span className="roomcast-titlebar-mark"><i /><i /></span></span><span className="roomcast-titlebar-name">同屏 Roomcast</span></div>}
    <aside className="icon-rail"><button className="brand-icon" title="同屏 Roomcast" aria-label="同屏首页" onClick={() => { if (!room) setModal(null); }}><span className="brand-mark"><span /><span /></span></button><div className="rail-divider" /><button className="rail-button active" title="房间" aria-label="房间" onClick={() => !room && setModal('create')}><AudioLines size={25} /><span className="rail-active-indicator" /></button><button className="rail-button add-room" title={room ? '邀请朋友' : '创建房间'} aria-label={room ? '邀请朋友' : '创建房间'} onClick={() => setModal(room ? 'invite' : 'create')}><Plus size={23} /></button>{room && <button className="rail-button leave-room-rail" title="离开房间" aria-label="离开房间" onClick={handleLeave}><LogOut size={20} /></button>}<div className="rail-spacer" /><button className="rail-button" title="设置" aria-label="设置" onClick={() => setModal('settings')}><Settings size={21} /></button><div className={`rail-avatar ${avatarClass(self?.avatarColor)}`} title={self?.name || '尚未加入'}>{initials(self?.name || loadPreference('nickname', '') || '你')}</div></aside>

    <aside className="channel-sidebar"><header className="brand-header"><div><strong>同屏<span>Roomcast</span></strong><small>A SPACE FOR YOUR PEOPLE</small></div><span className="version-pill">BETA</span>{!desktopChrome && <button className="icon-button mobile-members-close" aria-label="关闭成员栏" onClick={() => setShowMembers(false)}><X size={18} /></button>}</header><div className="sidebar-section-heading"><span>房间</span></div><button className="channel-item selected" onClick={() => !room && setModal('create')}><Volume2 size={19} /><span>{room?.name || '开始你的房间'}</span>{room ? <span className="channel-count">{room.members.length}</span> : <ChevronRight size={16} />}</button><div className="channel-subtitle"><span className={`status-dot ${room ? 'online' : ''}`} />{room ? `${room.members.length} 人在线 · 最多 10 人` : '房间准备好了，只差你们'}</div>
      <div className="sidebar-section-heading members-heading"><span>成员 <small>{room ? String(room.members.length).padStart(2, '0') : '00'}</small></span><Users size={14} /></div>
      <div className="sidebar-members">{room ? room.members.map(member => { const manageable = member.id !== selfId && member.role !== 'owner' && ['owner', 'admin'].includes(self?.role); return <div className="member-row" key={member.id}><div className={`avatar ${avatarClass(member.avatarColor)}`}>{initials(member.name)}<span className="presence-dot" /></div><div className="member-details"><span>{member.name}{member.id === selfId && <small>你</small>}<em className={`role-badge ${member.role}`}>{member.role === 'owner' ? '房主' : member.role === 'admin' ? '管理员' : '用户'}</em></span></div>{manageable ? <button className="icon-button" aria-label={`管理成员 ${member.name}`} onClick={() => setManagedMember(member)}><Settings size={14} /></button> : member.sharing ? <MonitorUp size={15} className="green-icon" /> : !member.canShare ? <LockKeyhole size={14} /> : null}</div>; }) : <div className="members-empty"><div className="empty-member-icons"><span /><span /><span /></div></div>}</div>
      <div className="sidebar-bottom"><span className={`network-latency ${latencyTone}`} aria-label={`网络延迟：${latencyMs == null ? '-- ms' : `${latencyMs} ms`}`}><Wifi className="network-latency-icon" size={17} strokeWidth={2.2} aria-hidden="true" /><span>{latencyMs == null ? '-- ms' : `${latencyMs} ms`}</span></span></div>
    </aside>

    <main className="main-content"><header className="room-header">{room && <div className="room-header-title"><Volume2 size={22} /><h2>{room.name}</h2></div>}<div className="room-header-actions"><span className={`connection-pill ${room ? 'connected' : ''}`}><span className="status-dot" />房间连接：{room ? config?.roomConnection || 'P2P' : '未连接'}</span>{!desktopChrome && <button className={`icon-button mobile-members-toggle ${showMembers ? 'toggled' : ''}`} title={showMembers ? '收起成员' : '查看成员'} aria-label={showMembers ? '收起成员' : '查看成员'} onClick={() => { setShowChat(false); setShowMembers(value => !value); }}><Users size={19} /></button>}<button className={`icon-button ${showChat ? 'toggled' : ''}`} title={showChat ? '收起聊天' : '展开聊天'} aria-label={showChat ? '收起聊天' : '展开聊天'} onClick={() => { setShowMembers(false); setShowChat(value => !value); }}><MessageSquare size={19} /></button></div></header>
      <div className="content-columns"><section className="stage-column"><div className="stage-heading"><div><span className="small-icon-box"><Monitor size={17} /></span><h3>共享屏幕</h3><span className="stage-state">{streams.length ? `${streams.length} 路共享` : '等待分享'}</span></div></div>
        <div className={`screen-stage ${streams.length ? 'has-stream multi-stage' : ''}`}>{streams.length ? <div ref={screenGridRef} className={`screen-grid count-${streams.length}`} data-preview-scale={previewScale.toFixed(1)} style={previewCardWidth ? { '--preview-card-width': `${previewCardWidth}px` } : undefined}>{streams.map(stream => <ScreenPlayer key={[stream.memberId, stream.startedAt].join("-")} stream={stream} iceServers={config?.mediaIceServers} outputDeviceId={audioDevices.preferences.outputId} viewerMemberId={selfId} deafened={false} transport={socketRef.current?.mediaP2P ? socketRef.current : undefined} reportViewing={reportViewing} initiallyEntered={watchingStreams.current.has(stream.memberId)} onViewingChange={rememberViewing} />)}</div> : <EmptyScreen room={room} onShare={canShareScreen ? openShare : null} onCreate={() => setModal('create')} onJoin={() => setModal('join')} />}</div>
      </section>
        {showChat && <aside className={`chat-panel ${chatDragActive ? 'chat-drag-active' : ''}`} onDragEnter={handleChatDragEnter} onDragOver={handleChatDragOver} onDragLeave={handleChatDragLeave} onDrop={handleChatDrop}><header><h3><MessageSquare size={17} />房间聊天</h3></header><div className="chat-messages" ref={chatList} onScroll={scrollChat} role="log" aria-label="房间聊天记录" aria-live="polite">{room && (historyLoading || hasOlderMessages) && <div className="chat-history-status">{historyLoading ? <><LoaderCircle size={13} className="spin" />正在加载消息…</> : '向上滚动加载更早消息'}</div>}{messages.length > 0 && <div className="chat-date"><span />今天<span /></div>}{messages.map(message => <ChatItem key={message.seq} message={message} selfId={selfId} onRecall={recall} onPreview={setPreviewImage} onImageContextMenu={handleImageContextMenu} />)}<div ref={chatEnd} /></div><form className="chat-compose" onSubmit={sendChat}>
          <input ref={imageInput} className="visually-hidden" type="file" multiple accept="image/jpeg,image/png,image/webp,image/gif,.jpg,.jpeg,.png,.webp,.gif" onChange={chooseImage} />
          <div className="chat-input-wrap">
            {pendingImages.length > 0 && <div className={`chat-pending-images count-${pendingImages.length}`}>
              {pendingImages.map((item, index) => <div className="chat-pending-tile" key={`${item.file.name}-${item.file.lastModified}-${index}`}>
                <button type="button" className="chat-pending-preview" onClick={() => setPreviewImage({ src: item.objectUrl, alt: item.file.name || `待发送图片 ${index + 1}`, fileName: item.file.name || '' })} aria-label={`查看第 ${index + 1} 张待发送图片`}><img src={item.objectUrl} alt={item.file.name || `待发送图片 ${index + 1}`} /></button>
                <button type="button" className="chat-pending-remove" title="移除图片" aria-label={`移除第 ${index + 1} 张待发送图片`} disabled={sendingImage} onClick={() => removePendingImage(index)}><X size={13} /></button>
              </div>)}
            </div>}
            <textarea aria-label="发送消息" placeholder={room ? `发消息给 ${room.name}` : '加入房间后发送消息'} value={chat} onChange={event => setChat(event.target.value)} onPaste={pasteImage} maxLength={2000} disabled={!room || sending || sendingImage} rows={2} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void sendChat(event); } }} />
            <div className="chat-input-footer">
              <span>Enter 发送 · 图片最大 10MB</span>
              <span className="chat-actions"><button type="button" title="选择图片" aria-label="选择图片" disabled={!room || sendingImage || pendingImages.length >= MAX_CHAT_IMAGES} onClick={() => imageInput.current?.click()}>{sendingImage ? <LoaderCircle size={16} className="spin" /> : <ImagePlus size={16} />}</button><button type="submit" title="发送消息" aria-label="发送消息" disabled={!room || (!chat.trim() && !pendingImages.length) || sending || sendingImage}>{sending ? <LoaderCircle size={16} className="spin" /> : <Send size={16} />}</button></span>
            </div>
          </div>
        </form></aside>}
      </div>

      <footer className="voice-dock">{canShareScreen && <div className="dock-controls"><button className="button share-button" onClick={openShare} disabled={shareBusy || (!!room && !self?.canShare && !ownShare)}>{shareBusy ? <LoaderCircle size={18} className="spin" /> : ownShare ? <Settings size={18} /> : <ScreenShare size={19} />}<span>{ownShare ? '修改共享设置' : '共享屏幕'}</span></button>{ownShare && <button className="control-button leave-button" onClick={stopShare} disabled={shareBusy} title="停止共享" aria-label="停止共享"><Square size={16} /></button>}</div>}</footer>
    </main>
    {['create', 'join'].includes(modal) && <EntryModal key={inviteRoom} inviteRoom={inviteRoom} mode={modal} onClose={() => setModal(null)} onEnter={handleEnter} busy={connection === 'connecting'} defaultServer={server} />}
    {modal === 'share' && room && canShareScreen && <ShareModal onClose={() => setModal(null)} onStart={ownShare ? restartShare : startShare} editing={ownShare} busy={shareBusy} audioDevices={audioDevices} />}
    {modal === 'settings' && <SettingsModal onClose={() => setModal(null)} isDesktop={desktopChrome} canShareScreen={canShareScreen} localConfig={localConfig} refresh={refresh} devices={audioDevices.devices} devicePreferences={audioDevices.preferences} setDevicePreferences={audioDevices.setPreferences} refreshDevices={audioDevices.refresh} relaySettings={relaySettings} setRelaySettings={setRelaySettings} themeColor={themeColor} setThemeColor={setThemeColor} themeMode={themeMode} setThemeMode={setThemeMode} effectiveThemeColor={effectiveThemeColor} />}
    {modal === 'invite' && room && <InviteModal isP2P={config?.p2p} room={room} server={server} localConfig={localConfig} onClose={() => setModal(null)} copy={copy} relayInvite={config?.relayInvite} inviteSecret={config?.inviteSecret} peerServer={config?.peerServer} />}
    {managedMember && room?.members.some(member => member.id === managedMember.id) && <MemberPermissionsModal member={room.members.find(member => member.id === managedMember.id)} self={self} command={command} onClose={() => setManagedMember(null)} />}
    {previewImage && <ImagePreviewOverlay key={previewImage.src} image={previewImage} onClose={() => setPreviewImage(null)} onImageContextMenu={handleImageContextMenu} onCopy={copyPreviewImage} onDownload={downloadPreviewImage} />}
    {imageContextMenu && <div className="image-context-menu" role="menu" style={{ left: imageContextMenu.x, top: imageContextMenu.y }} onPointerDown={event => event.stopPropagation()}>
      <button type="button" role="menuitem" onClick={() => void copyContextImage()}>复制图片</button>
    </div>}
    {toast && <div className="toast error" role="alert"><Info size={18} /><span>{toast.text}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setToast(null)}><X size={15} /></button></div>}
  </div>;
}
