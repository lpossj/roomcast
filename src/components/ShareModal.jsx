import { AppWindow, Camera, Check, Info, LoaderCircle, Mic, Monitor, RefreshCw, ScreenShare, Volume2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import Modal from './Modal.jsx';
import Dropdown from './Dropdown.jsx';
import { integratedSources, nativeAudioSources } from '../lib.js';
import { savePreference } from '../preferences.js';
import { normalizeBrowserShareSettings } from '../browser-capabilities.js';
import { loadShareSettings, presets } from '../lib/previewLayout.js';

export default function ShareModal({ onClose, onStart, busy, audioDevices, capabilities, editing = false }) {
  const desktop = window.roomcast?.desktop === true;
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
    if (!desktop) {
      setSettings(current => normalizeBrowserShareSettings({ ...current, ...overrides }, capabilities));
      setLoading(false);
      return;
    }
    const generation = ++refreshGeneration.current;
    const currentRequest = () => mounted.current && generation === refreshGeneration.current;
    const requested = { ...settings, ...overrides };
    const requestedBackend = requested.captureBackend === 'native' ? 'native' : 'obs';
    const requestedType = requested.sourceType === 'window' ? 'window' : 'monitor';
    const preferredSourceId = String(requested.sourceId || '');
    setLoading(true);
    setAudioLoading(false);
    setError('');
    setAudioError('');
    setBackendNotice('');
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
      const value = await integratedSources({
        backend: requestedBackend,
        width: Number(requested.width) || 1920,
        height: Number(requested.height) || 1080,
        fps: Number(requested.fps) || 30,
      });
      if (!currentRequest()) return;
      applySources(value, requestedBackend);
      setLoading(false);
      if (!window.roomcast?.desktop) return;
      await refreshAudioSources({ initial: true });
    } catch (failure) {
      if (!currentRequest()) return;
      setError(failure.message);
    } finally {
      if (currentRequest()) setLoading(false);
    }
  };

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { refreshGeneration.current += 1; };
  }, []);

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
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [busy, refreshAudioSources]);

  useEffect(() => { savePreference('shareSettings', settings); }, [settings]);
  useEffect(() => {
    if (!desktop) setSettings(current => normalizeBrowserShareSettings(current, capabilities));
  }, [desktop, capabilities.screen, capabilities.camera, capabilities.microphone]);

  const items = (type === 'monitor' ? sources.monitors : sources.windows) || [];
  const update = patch => setSettings(current => ({ ...current, ...patch }));
  const switchBackend = next => {
    update({ captureBackend: next, sourceId: '' });
    void load({ captureBackend: next, sourceId: '' });
  };
  const switchType = next => {
    if (!desktop) {
      update(normalizeBrowserShareSettings({ ...settings, sourceType: next }, capabilities));
      return;
    }
    const nextItems = next === 'monitor' ? sources.monitors : sources.windows;
    update({ sourceType: next, sourceId: nextItems?.[0]?.id == null ? '' : String(nextItems[0].id) });
  };
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
    const width = Number(settings.width);
    const height = Number(settings.height);
    const fps = Number(settings.fps);
    const bitrate = Number(settings.bitrate);
    const maxWidth = backend === 'obs' ? 4096 : 7680;
    const maxHeight = backend === 'obs' ? 4096 : 4320;
    if (!Number.isInteger(width) || width < 320 || width > maxWidth) return setError(`宽度范围为 320–${maxWidth}。`);
    if (!Number.isInteger(height) || height < 240 || height > maxHeight) return setError(`高度范围为 240–${maxHeight}。`);
    if (backend === 'obs' && (width % 2 || height % 2)) return setError('OBS 模式要求宽高为偶数。');
    if (!Number.isInteger(fps) || fps < 1 || fps > 120) return setError('帧率范围为 1–120 FPS。');
    if (!Number.isInteger(bitrate) || (bitrate !== 0 && (bitrate < 200 || bitrate > 50000))) return setError('码率请输入 0，或 200–50000 Kbps。');
    const effective = desktop ? settings : normalizeBrowserShareSettings(settings, capabilities);
    if (!desktop && !(effective.sourceType === 'camera' ? capabilities.camera : capabilities.screen)) return setError('当前浏览器或页面权限不支持此共享来源。');
    const audioMode = effective.audioMode || 'none';
    if ((audioMode.includes('application') || audioMode.includes('exclude')) && !processAudioAvailable) return setError('当前环境不支持按应用捕获或排除声音。');
    if ((audioMode.includes('application') || audioMode.includes('exclude')) && !settings.audioSourceId) return setError(audioMode.includes('exclude') ? '请选择要从系统声音中排除的软件。' : '请选择要捕获声音的软件。');
    const systemAudio = audioMode === 'system' || audioMode === 'system-microphone';
    const microphone = audioMode === 'microphone' || audioMode.endsWith('-microphone');
    try {
      await onStart({ ...effective, width, height, fps, bitrate, audioMode, systemAudio, microphone });
    } catch (failure) {
      setError(failure.message);
    }
  };

  return (
    <Modal title={desktop ? '屏幕共享' : '画面共享'} subtitle="选择采集画面、清晰度与音频混流方案" onClose={onClose} wide busy={busy} cancellable={!busy}>
      {window.roomcast?.desktop && (
        <div className="segmented" role="group" aria-label="采集引擎">
          <button type="button" className={backend === 'obs' ? 'selected' : ''} onClick={() => switchBackend('obs')} disabled={busy || loading}>OBS 固定帧率</button>
          <button type="button" className={backend === 'native' ? 'selected' : ''} onClick={() => switchBackend('native')} disabled={busy || loading}>原生采集</button>
        </div>
      )}

      {desktop ? (
        <>
          <div className="source-tabs">
            <button type="button" className={type === 'monitor' ? 'active' : ''} onClick={() => switchType('monitor')} disabled={busy}>
              <Monitor size={16} />整个屏幕
            </button>
            <button type="button" className={type === 'window' ? 'active' : ''} onClick={() => switchType('window')} disabled={busy}>
              <AppWindow size={16} />应用窗口
            </button>
            <button type="button" className="icon-button refresh-sources" title="刷新采集来源" aria-label="刷新采集来源" onClick={() => load()} disabled={loading || busy}>
              <RefreshCw size={15} className={loading ? 'spin' : ''} />
            </button>
          </div>
          <div className="source-grid">
            {loading ? (
              <div className="source-empty"><LoaderCircle className="spin" size={22} /><span>正在读取本机采集来源…</span></div>
            ) : items.length ? (
              items.map(source => (
                <button
                  type="button"
                  key={source.id}
                  className={`source-card ${settings.sourceId === String(source.id) ? 'selected' : ''}`}
                  onClick={() => update({ sourceId: String(source.id) })}
                  disabled={busy}
                >
                  <div className="source-art">
                    {type === 'monitor' ? <Monitor size={34} strokeWidth={1.3} /> : <AppWindow size={34} strokeWidth={1.3} />}
                    <span className="source-check">{settings.sourceId === String(source.id) && <Check size={12} />}</span>
                  </div>
                  <span className="source-name" title={source.name}>{source.name}</span>
                </button>
              ))
            ) : (
              <div className="source-empty">
                <Monitor size={28} />
                <strong>还没有可用的采集来源</strong>
                <span>请打开要共享的应用窗口，然后刷新来源。</span>
              </div>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="source-tabs">
            {capabilities.screen && (
              <button type="button" className={type === 'monitor' ? 'active' : ''} onClick={() => switchType('monitor')} disabled={busy}>
                <Monitor size={16} />屏幕或窗口
              </button>
            )}
            {capabilities.camera && (
              <button type="button" className={type === 'camera' ? 'active' : ''} onClick={() => switchType('camera')} disabled={busy}>
                <Camera size={16} />摄像头
              </button>
            )}
          </div>
          <p className="setting-inline-note">
            {type === 'camera'
              ? '开始共享时，浏览器会请求摄像头权限。实际画质和帧率受设备能力限制。'
              : '开始共享时，由浏览器选择屏幕、窗口或标签页。可共享的声音由浏览器决定。'}
          </p>
          {type === 'camera' && (
            <Dropdown
              label="摄像头方向"
              value={settings.facingMode || 'user'}
              onChange={value => update({ facingMode: value })}
              disabled={busy}
              options={[
                { value: 'user', label: '前置摄像头（优先）' },
                { value: 'environment', label: '后置摄像头（优先）' },
              ]}
            />
          )}
        </>
      )}

      <div className="share-group">
        <label className="section-label">画面质量</label>
        <div className="quality-options">
          {presets.map(item => (
            <button type="button" key={item.id} className={settings.preset === item.id ? 'selected' : ''} onClick={() => selectPreset(item)} disabled={busy}>
              <div className="quality-head">
                <strong>{item.label}</strong>
                {settings.preset === item.id && <Check size={14} />}
              </div>
              <span>{item.detail}</span>
            </button>
          ))}
        </div>

        <div className="custom-parameters">
          <label>宽度<input aria-label="共享宽度" type="number" min="320" max="7680" value={settings.width} onChange={event => numeric('width', event.target.value)} /></label>
          <span className="dim-sep">×</span>
          <label>高度<input aria-label="共享高度" type="number" min="240" max="4320" value={settings.height} onChange={event => numeric('height', event.target.value)} /></label>
          <label>帧率<input aria-label="共享帧率" type="number" min="1" max="120" value={settings.fps} onChange={event => numeric('fps', event.target.value)} /><small>FPS</small></label>
          <label>码率<input aria-label="共享码率" type="number" min="0" max="50000" step="100" value={settings.bitrate} onChange={event => numeric('bitrate', event.target.value)} /><small>Kbps · 0=自动</small></label>
        </div>

        <div className="share-parameter-summary">
          <strong>当前输出规格</strong>
          <span>{settings.width || '—'} × {settings.height || '—'} · {settings.fps || '—'} FPS · {Number(settings.bitrate) === 0 ? '自动码率' : `${settings.bitrate || '—'} Kbps`}</span>
        </div>
      </div>

      <div className="share-group">
        <label className="section-label">共享声音</label>
        <div className="audio-mode-options" role="radiogroup" aria-label="共享声音来源">
          <label className={currentAudioMode === 'none' || currentAudioMode === 'microphone' ? 'selected' : ''}>
            <input type="radio" name="share-audio-mode" checked={currentAudioMode === 'none' || currentAudioMode === 'microphone'} onChange={() => toggleAudioSource('', false)} disabled={busy} />
            <span><strong>不共享声音</strong><small>仅发送画面帧</small></span>
          </label>
          {(desktop || type !== 'camera') && (
            <label className={sharesSystemAudio ? 'selected' : ''}>
              <input type="radio" name="share-audio-mode" checked={sharesSystemAudio} onChange={() => toggleAudioSource('system', true)} disabled={busy} />
              <span><strong>{desktop ? '全部应用声音' : '浏览器允许的声音'}</strong><small>{desktop ? '包括游戏与媒体播放器' : '取决于浏览器与共享来源'}</small></span>
            </label>
          )}
          {desktop && (
            <label className={sharesApplicationAudio ? 'selected' : ''}>
              <input type="radio" name="share-audio-mode" checked={sharesApplicationAudio} onChange={() => toggleAudioSource('application', true)} disabled={busy || !processAudioAvailable} />
              <span><strong>所选程序声音</strong><small>推荐，避免通话回声</small></span>
            </label>
          )}
          {desktop && (
            <label className={excludesApplicationAudio ? 'selected' : ''}>
              <input type="radio" name="share-audio-mode" checked={excludesApplicationAudio} onChange={() => toggleAudioSource('exclude', true)} disabled={busy || !processAudioAvailable} />
              <span><strong>排除所选程序</strong><small>本机可听，观看者不收听</small></span>
            </label>
          )}
        </div>

        {backendNotice && <div className="setting-inline-note" role="status">{backendNotice}</div>}
        {audioLoading && <div className="setting-inline-note">正在读取可按应用处理的声音来源…</div>}
        {audioError && <div className="setting-inline-note" role="status" title={audioError}>应用声音列表暂不可用；仍可正常共享画面、全部应用声音或麦克风。Roomcast 会自动重试。</div>}

        {(sharesApplicationAudio || excludesApplicationAudio) && (
          <Dropdown
            label={excludesApplicationAudio ? '从系统声音中排除' : '选择游戏或应用'}
            value={settings.audioSourceId || ''}
            onChange={value => update({ audioSourceId: value })}
            disabled={busy}
            options={[
              ...(!settings.audioSourceId ? [{ value: '', label: '请选择应用' }] : []),
              ...(sources.applications || []).map(item => ({ value: String(item.id), label: audioApplicationLabel(item) })),
            ]}
          />
        )}

        {(sharesSystemAudio || sharesApplicationAudio || excludesApplicationAudio) && (
          <label className="switch-row compact-audio-switch">
            <span><Volume2 size={17} /><span>静音共享声音</span></span>
            <input type="checkbox" checked={settings.applicationMuted === true} onChange={event => update({ applicationMuted: event.target.checked })} disabled={busy} />
            <span className="switch" aria-hidden="true" />
          </label>
        )}

        {(desktop || capabilities.microphone) && (
          <label className="switch-row">
            <span><Mic size={17} /><span>加入麦克风<small>{audioDevices?.preferences.inputId ? '所选麦克风' : '系统默认'}</small></span></span>
            <input
              type="checkbox"
              checked={sharesMicrophone}
              onChange={event => update({
                audioMode: composeAudioMode(
                  sharesSystemAudio ? 'system' : sharesApplicationAudio ? 'application' : excludesApplicationAudio ? 'exclude' : '',
                  event.target.checked,
                ),
              })}
              disabled={busy}
            />
            <span className="switch" aria-hidden="true" />
          </label>
        )}

        {sharesMicrophone && (
          <label className="switch-row">
            <span><Mic size={17} /><span>静音共享麦克风</span></span>
            <input type="checkbox" checked={settings.microphoneMuted === true} onChange={event => update({ microphoneMuted: event.target.checked })} disabled={busy} />
            <span className="switch" aria-hidden="true" />
          </label>
        )}
      </div>

      {error && <div className="inline-error" role="alert"><Info size={16} /><span>{error}</span></div>}

      <footer className="modal-actions">
        <button type="button" className="button secondary" onClick={onClose} disabled={busy || loading}>取消</button>
        <button type="button" className="button primary" onClick={submit} disabled={!settings.sourceId || busy || loading}>
          {busy ? <LoaderCircle size={17} className="spin" /> : <ScreenShare size={17} />}
          <span>{busy ? (editing ? '正在应用设置…' : '正在建立共享…') : (editing ? '应用并重新共享' : '开始共享')}</span>
        </button>
      </footer>
    </Modal>
  );
}
