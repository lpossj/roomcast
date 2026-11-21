import { Check, Download, Headphones, Info, Link, LoaderCircle, Monitor, MonitorUp, Palette, RefreshCw, Server, ShieldCheck, Wifi } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import Modal from './Modal.jsx';
import { ProfileSettings, VoiceSettings } from '../ProfileAudioSettings.jsx';
import { savePreference } from '../preferences.js';
import { fetchRelayIce } from '../relay.js';
import { getLifecycleDiagnostics } from '../lib.js';
import { refreshControlNatDiagnostics } from '../control-nat-prediction.js';
import { readP2pDiagnostics } from '../p2p-video-policy.js';
import { APP_VERSION, cleanIpcError } from '../lib/previewLayout.js';
import { DEFAULT_THEME_COLOR, THEME_MODE_CUSTOM, THEME_MODE_WINDOWS, THEME_PRESETS } from '../lib/theme.js';

function UpdateSection({ version, update, autoCheck, setAutoCheck, onCheck, install, onAutoUpdate }) {
  const { status, result, error } = update;
  const [pageError, setPageError] = useState('');
  const available = Boolean(result?.available);
  const autoInstall = available && Boolean(install?.supported);
  const notes = String(result?.notes || '').replace(/\s+/g, ' ').slice(0, 320);
  const failure = error || pageError;

  return (
    <section className="settings-section">
      <h3><Download size={16} />软件更新</h3>
      <div className="diagnostic-row"><span>当前版本</span><span className="muted-text">{version || '未知'}</span></div>
      <label className="switch-row">
        <span><ShieldCheck size={17} /><span>启动时自动检查更新</span></span>
        <input type="checkbox" checked={autoCheck} onChange={event => { setAutoCheck(event.target.checked); savePreference('autoCheckUpdates', event.target.checked); }} />
        <span className="switch" aria-hidden="true" />
      </label>
      <div className="update-status">
        {status === 'checking' && <><LoaderCircle size={14} className="spin" />正在检查…</>}
        {status === 'done' && !failure && !available && <><Check size={14} />已是最新版本</>}
        {available && (
          <>
            <Info size={14} />
            发现新版本 <strong>{result.version}</strong>
            {result.prerelease ? '（测试版）' : ''}
            {result.viaFeed ? '（GitHub 接口受限，已改用发布订阅检查）' : result.viaManifest ? '（GitHub 接口受限，已改用固定站点版本清单）' : ''}
          </>
        )}
        {status === 'done' && !available && !failure && !result && <><Info size={14} />尚未检查</>}
      </div>
      {available && notes && <p className="about-note update-notes">{notes}{String(result.notes || '').length > 320 ? '…' : ''}</p>}
      {available && !notes && result.notesUnavailable && <p className="about-note update-notes">更新内容暂时读不到（GitHub 接口受限）；可以点下面的“打开发布页”查看，或直接更新。</p>}
      {autoInstall && (
        <div className="settings-buttons">
          <button type="button" className="button primary small" onClick={onAutoUpdate} disabled={Boolean(install?.busy)}>
            {install?.busy ? <LoaderCircle size={15} className="spin" /> : <Download size={15} />}
            <span>{install?.busy ? '正在准备自动更新…' : `立即更新到 ${result.version}`}</span>
          </button>
        </div>
      )}
      {available && !autoInstall && (
        <p className="about-note">当前运行方式不支持自动覆盖程序目录{install?.reason ? `：${install.reason}` : '。'}请用下面的「打开发布页」手动下载安装包。</p>
      )}
      {install?.error && <div className="update-manual" role="alert"><Info size={15} /><span>{install.error}</span></div>}
      {failure && <div className="update-manual" role="alert"><Info size={15} /><span>{failure}</span></div>}
      <div className="settings-buttons">
        <button type="button" className="button subtle small" onClick={onCheck} disabled={status === 'checking'}>
          {status === 'checking' ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}
          <span>检查更新</span>
        </button>
        <button
          type="button"
          className={`button ${failure ? 'secondary' : 'subtle'} small`}
          onClick={() => {
            setPageError('');
            window.roomcast?.openReleasePage?.().catch(err => setPageError(cleanIpcError(err)));
          }}
        >
          <Link size={15} />
          <span>打开发布页（手动下载）</span>
        </button>
      </div>
      <details className="about-details">
        <summary>更新说明</summary>
        <p className="about-note">更新包经 SHA256 校验后安装并重启；失败会回滚。Windows 程序未签名，网络受限时可手动下载。</p>
      </details>
    </section>
  );
}

export function UpdatePromptModal({ current, result, install, dontRemind, setDontRemind, onClose, onUpdate, onOpenPage }) {
  const [error, setError] = useState('');
  const busy = Boolean(install?.busy);
  const notes = String(result?.notes || '').trim();
  const published = String(result?.publishedAt || '').slice(0, 10);
  const run = () => {
    setError('');
    Promise.resolve(onUpdate()).catch(failure => setError(cleanIpcError(failure)));
  };

  return (
    <Modal
      title={`发现新版本 ${result?.version || ''}`}
      subtitle={`当前版本 ${current || '未知'}${result?.prerelease ? ' · 公开测试版' : ''}`}
      onClose={onClose}
      busy={busy}
    >
      <div className="update-prompt">
        <div className="update-prompt-head">
          <strong>{result?.name || `Roomcast ${result?.version || ''}`}</strong>
          {published && <span>{published}</span>}
        </div>
        <div className="update-prompt-notes">
          {notes || (result?.notesUnavailable ? '更新内容暂时读不到（GitHub 接口受限）。可以点下面按钮到发布页查看，或直接更新。' : '本次更新没有提供说明。')}
        </div>
        {!install?.supported && (
          <div className="update-manual" role="status">
            <Info size={15} />
            <span>{install?.reason || '当前运行方式不支持自动更新，请手动下载安装包。'}</span>
          </div>
        )}
        {(error || install?.error) && <div className="inline-error" role="alert"><Info size={16} /><span>{error || install.error}</span></div>}
        <label className="update-prompt-remind">
          <input type="checkbox" checked={dontRemind} onChange={event => setDontRemind(event.target.checked)} />
          <span>不再弹出此框（下次启动不再提示 {result?.version || '此版本'}）</span>
        </label>
      </div>
      <footer className="modal-actions">
        <button type="button" className="button secondary" onClick={onClose} disabled={busy}>稍后</button>
        {install?.supported ? (
          <button type="button" className="button primary" onClick={run} disabled={busy}>
            {busy ? <LoaderCircle size={17} className="spin" /> : <Download size={17} />}
            <span>{busy ? '正在准备更新…' : '立即更新'}</span>
          </button>
        ) : (
          <button type="button" className="button primary" onClick={onOpenPage} disabled={busy}>
            <Link size={17} />
            <span>打开发布页下载</span>
          </button>
        )}
      </footer>
    </Modal>
  );
}

function AboutPanel({ version = '' }) {
  const exportDiagnostics = async () => {
    await refreshControlNatDiagnostics();
    const diagnostics = {
      ...getLifecycleDiagnostics(version),
      networkPermissions: await window.roomcast?.networkDiagnostics?.().catch(() => null) ?? null,
      media: {
        connections: readP2pDiagnostics(),
        vdoPublisher: window.roomcastVdoDiagnostics?.() ?? null,
      },
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(diagnostics, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `Roomcast-${version || 'dev'}-diagnostics.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <>
      <section className="settings-section">
        <h3><Info size={16} />关于</h3>
        <div className="about-card">
          <div className="about-brand">
            <span className="brand-mark"><span /><span /></span>
            <div>
              <strong>同屏 Roomcast</strong>
              <span>{version ? `版本 ${version}` : '本地开发版'} · 公开测试版（Beta）</span>
            </div>
          </div>
          <p className="about-line">作者与维护：D4Y0 / Roomcast</p>
          <p className="about-line">问题反馈：<a href="https://github.com/lpossj/roomcast/issues" target="_blank" rel="noreferrer noopener">GitHub Issues</a> · 2106841308@qq.com · z2106841308@163.com</p>
          <p className="about-line">源码仓库：<a href="https://github.com/lpossj/roomcast" target="_blank" rel="noreferrer noopener">github.com/lpossj/roomcast</a></p>
        </div>
      </section>
      <details className="settings-section about-details">
        <summary>隐私与使用说明</summary>
        <p className="about-note">仅用于合法、知情同意的屏幕共享与聊天。禁止用于未经同意的监控、偷拍、监听、跟踪、骚扰或其他违法用途；使用者应自行遵守当地法律与平台规则。</p>
        <p className="about-note">房间状态与聊天是内存态，房间结束后释放，不写入数据库。屏幕媒体通过 WebRTC DTLS-SRTP 在成员之间传输。</p>
        <div className="settings-buttons"><button type="button" className="button subtle small" onClick={exportDiagnostics}><Download size={15} />导出诊断</button></div>
        <p className="about-note">诊断保留本次页面会话最近 200 条操作阶段和耗时，以及有限的画质、编码和网络统计；不记录画面内容、网络地址、邀请、密钥、成员信息或聊天，不自动上传。</p>
        <p className="about-note">网页观看入口使用固定 HTTPS 站点，分享者和观看者无需注册或登录；邀请链接等同于入房凭据，请只发给预期成员。站点可访问不代表信令和媒体连接一定可用。</p>
        <p className="about-note">未使用商业代码签名，Windows SmartScreen 可能提示未知发布者；下载后请核对发布页提供的 SHA-256。</p>
      </details>
      <details className="settings-section about-details">
        <summary>许可与第三方组件</summary>
        <p className="about-note">Roomcast 主体源码采用 Apache License 2.0。</p>
        <p className="about-note">随包组件：OBS Studio 32.1.2（GPL-2.0-or-later，附对应源码归档）、Windows 系统音频 loopback 采集组件（第三方 MIT 预编译二进制）。完整清单见安装目录下的 <code>NOTICE</code> 与 <code>THIRD-PARTY-NOTICES.txt</code>，隐私与安全边界见 <code>PRIVACY.md</code> 与 <code>SECURITY.md</code>。</p>
      </details>
    </>
  );
}

export default function SettingsDrawer({
  avatar, avatarName, onAvatar, voice, onClose, isDesktop, canShareScreen, localConfig, refresh,
  devices, devicePreferences, setDevicePreferences, refreshDevices,
  relaySettings, setRelaySettings,
  themeColor, setThemeColor, themeMode, setThemeMode, effectiveThemeColor,
  update, autoCheckUpdates, setAutoCheckUpdates, onCheckUpdates, updateInstall, onAutoUpdate,
  gpu, initialSection = 'general',
}) {
  const activeTest = useRef(true);
  useEffect(() => {
    activeTest.current = true;
    return () => { activeTest.current = false; };
  }, []);

  const [working, setWorking] = useState('');
  const [error, setError] = useState('');
  const [relayNotice, setRelayNotice] = useState('');
  const [section, setSection] = useState(initialSection);

  useEffect(() => {
    if (initialSection) setSection(initialSection);
  }, [initialSection]);

  const testRelay = async () => {
    setWorking('relay');
    setError('');
    setRelayNotice('');
    try {
      const servers = await fetchRelayIce(relaySettings);
      if (!activeTest.current) return;
      setRelaySettings(relaySettings);
      setRelayNotice(`TURN 可用，已获取 ${servers.length} 组临时 ICE 地址。`);
    } catch (failure) {
      if (activeTest.current) setError(failure.message);
    } finally {
      if (activeTest.current) setWorking('');
    }
  };

  const canSelectOutput = typeof globalThis.HTMLMediaElement?.prototype?.setSinkId === 'function';
  const canEnumerateDevices = typeof navigator.mediaDevices?.enumerateDevices === 'function';
  const sections = [
    { id: 'general', label: '通用', icon: Palette },
    ...((canShareScreen || canSelectOutput) ? [{ id: 'audio', label: '音频与采集', icon: Headphones }] : []),
    { id: 'performance', label: '性能与加速', icon: Monitor },
    { id: 'network', label: '网络', icon: Wifi },
    ...(isDesktop ? [{ id: 'service', label: '本地服务', icon: Server }] : []),
    { id: 'about', label: '关于', icon: Info },
  ];
  const active = sections.some(item => item.id === section) ? section : 'general';

  return (
    <Modal title="设置" onClose={onClose} wide busy={!!working} cancellable>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="设置分类">
          {sections.map(item => (
            <button
              key={item.id}
              type="button"
              className={active === item.id ? 'selected' : ''}
              aria-current={active === item.id ? 'true' : undefined}
              onClick={() => setSection(item.id)}
            >
              <item.icon size={16} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="settings-panel">
          {active === 'general' && (
            <>
              <ProfileSettings avatar={avatar} name={avatarName} onAvatar={onAvatar} />
              <section className="settings-section">
                <h3><Palette size={16} />界面主题</h3>
                {isDesktop && (
                  <div className="theme-mode-toggle" role="group" aria-label="主题颜色来源">
                    <button type="button" className={themeMode === THEME_MODE_WINDOWS ? 'selected' : ''} onClick={() => setThemeMode(THEME_MODE_WINDOWS)}>跟随 Windows</button>
                    <button type="button" className={themeMode === THEME_MODE_CUSTOM ? 'selected' : ''} onClick={() => setThemeMode(THEME_MODE_CUSTOM)}>自定义</button>
                  </div>
                )}
                {themeMode === THEME_MODE_CUSTOM ? (
                  <>
                    <div className="theme-color-row">
                      <label className="theme-color-picker" title="选择自定义主题色">
                        <input type="color" value={themeColor} onChange={event => setThemeColor(event.target.value)} aria-label="选择主题色" />
                        <span className="theme-color-swatch" style={{ background: themeColor }} />
                      </label>
                      <div className="theme-preset-list" aria-label="主题色预设">
                        {THEME_PRESETS.map(color => (
                          <button
                            key={color}
                            type="button"
                            className={`theme-preset ${themeColor === color ? 'selected' : ''}`}
                            style={{ '--swatch': color }}
                            onClick={() => setThemeColor(color)}
                            aria-label={`使用主题色 ${color}`}
                          >
                            <span />
                          </button>
                        ))}
                      </div>
                      <button type="button" className="button subtle small" onClick={() => setThemeColor(DEFAULT_THEME_COLOR)} disabled={themeColor === DEFAULT_THEME_COLOR}>恢复默认</button>
                    </div>
                    <div className="theme-color-value"><span>当前主题色</span><code>{themeColor.toUpperCase()}</code></div>
                  </>
                ) : (
                  <div className="theme-windows-color">
                    <span className="theme-windows-swatch" style={{ background: effectiveThemeColor }} aria-hidden="true" />
                    <span>使用 Windows 强调色</span>
                    <code>{effectiveThemeColor.toUpperCase()}</code>
                  </div>
                )}
              </section>
            </>
          )}

          {active === 'audio' && (
            <>
              <VoiceSettings voice={voice} avatar={avatar} name={avatarName} />
              <section className="settings-section">
                <h3><Headphones size={16} />共享音频设备</h3>
                <div className="device-grid">
                  <label>
                    麦克风
                    <select aria-label="选择麦克风" value={devicePreferences.inputId} onChange={event => setDevicePreferences(value => ({ ...value, inputId: event.target.value }))}>
                      <option value="">系统默认麦克风</option>
                      {devices.inputs.filter(item => item.id && item.id !== 'default').map(item => <option value={item.id} key={item.id}>{item.label}</option>)}
                    </select>
                  </label>
                  {canSelectOutput && (
                    <label>
                      声音播放设备
                      <select aria-label="选择扬声器" value={devicePreferences.outputId} onChange={event => setDevicePreferences(value => ({ ...value, outputId: event.target.value }))}>
                        <option value="">系统默认扬声器</option>
                        {devices.outputs.filter(item => item.id && item.id !== 'default').map(item => <option value={item.id} key={item.id}>{item.label}</option>)}
                      </select>
                    </label>
                  )}
                </div>
                {canEnumerateDevices && (
                  <div className="settings-buttons">
                    <button type="button" className="button subtle small" onClick={() => refreshDevices().catch(failure => setError(failure.message))}><RefreshCw size={15} />刷新设备</button>
                  </div>
                )}
              </section>
              {isDesktop && (
                <section className="settings-section">
                  <h3><MonitorUp size={16} />屏幕采集</h3>
                  <div className="diagnostic-row"><span>原生屏幕 / 窗口采集</span><span className="good-text"><Check size={14} />WebRTC P2P</span></div>
                  <div className="diagnostic-row"><span>采集引擎</span><span className="muted-text">OBS 固定帧率 / 原生采集</span></div>
                </section>
              )}
            </>
          )}

          {active === 'performance' && gpu && (
            <>
              <section className="settings-section">
                <h3><Monitor size={16} />背景动效</h3>
                <div className="segmented gpu-stage-segmented" role="radiogroup" aria-label="背景动效模式">
                  <button
                    type="button"
                    className={gpu.settings.stageMode !== 'off' ? 'selected' : ''}
                    onClick={() => gpu.updateSettings({ stageMode: 'high' })}
                  >
                    流畅
                  </button>
                  <button
                    type="button"
                    className={gpu.settings.stageMode === 'off' ? 'selected' : ''}
                    onClick={() => gpu.updateSettings({ stageMode: 'off' })}
                  >
                    关闭
                  </button>
                </div>
                <label className="switch-row">
                  <span>
                    <ShieldCheck size={17} />
                    <span>
                      后台自动休眠
                      <small>最小化或切出窗口后暂停背景动效</small>
                    </span>
                  </span>
                  <input
                    type="checkbox"
                    checked={gpu.settings.lowPowerBackground}
                    onChange={event => gpu.updateSettings({ lowPowerBackground: event.target.checked })}
                  />
                  <span className="switch" aria-hidden="true" />
                </label>
              </section>

              {isDesktop && (
                <section className="settings-section">
                  <h3><MonitorUp size={16} />硬件加速</h3>
                  <label className="switch-row">
                    <span>
                      <Monitor size={17} />
                      <span>
                        启用 GPU 硬件加速
                        <small>关闭可减少显存与后台占用，需重启生效</small>
                      </span>
                    </span>
                    <input
                      type="checkbox"
                      checked={gpu.hwAccel.hardwareAcceleration}
                      onChange={event => {
                        void gpu.setHardwareAcceleration(event.target.checked).catch(failure => setError(cleanIpcError(failure)));
                      }}
                    />
                    <span className="switch" aria-hidden="true" />
                  </label>
                  <div className="diagnostic-row">
                    <span>图形状态</span>
                    <span className={gpu.hwAccel.activeHardwareAcceleration ? 'good-text' : 'muted-text'}>
                      {gpu.hwAccel.activeHardwareAcceleration ? '硬件加速' : '软件模式'}
                    </span>
                  </div>
                  {gpu.needsRestartForHwAccel && (
                    <div className="inline-success" role="status">
                      <Info size={15} />
                      <span>已保存设置，重启后生效</span>
                      <button
                        type="button"
                        className="button primary small"
                        onClick={() => void gpu.relaunchApp().catch(failure => setError(cleanIpcError(failure)))}
                      >
                        立即重启
                      </button>
                    </div>
                  )}
                </section>
              )}
            </>
          )}

          {active === 'network' && (
            <section className="settings-section">
              <h3><Wifi size={16} />Cloudflare TURN 中继</h3>
              <label className="switch-row">
                <span><ShieldCheck size={17} /><span>启用 TURN</span></span>
                <input type="checkbox" checked={relaySettings.enabled} onChange={event => setRelaySettings({ ...relaySettings, enabled: event.target.checked })} />
                <span className="switch" aria-hidden="true" />
              </label>
              <label className="standalone-label">
                Worker 地址
                <input value={relaySettings.endpoint} onChange={event => setRelaySettings({ ...relaySettings, endpoint: event.target.value })} placeholder="https://roomcast.example.com" spellCheck={false} />
              </label>
              <label className="standalone-label">
                Worker 访问密钥
                <input type="password" value={relaySettings.accessKey} onChange={event => setRelaySettings({ ...relaySettings, accessKey: event.target.value })} placeholder="部署 Worker 时自己设置的随机密钥" autoComplete="off" />
              </label>
              <div className="settings-buttons">
                <button type="button" className="button secondary small" onClick={testRelay} disabled={!relaySettings.enabled || !!working}>
                  {working === 'relay' ? <LoaderCircle size={15} className="spin" /> : <Wifi size={15} />}
                  <span>保存并测试 TURN</span>
                </button>
              </div>
              {relayNotice && <div className="inline-success" role="status"><Check size={15} /><span>{relayNotice}</span></div>}
            </section>
          )}

          {active === 'service' && isDesktop && (
            <section className="settings-section">
              <h3><Server size={16} />本地服务</h3>
              <div className="diagnostic-row">
                <span>房间控制服务</span>
                <span className={localConfig ? 'good-text' : 'muted-text'}>
                  {localConfig ? <><Check size={14} />正在运行 · :{localConfig.port}</> : '无法连接'}
                </span>
              </div>
              <div className="settings-buttons">
                <button type="button" className="button subtle small" onClick={refresh}><RefreshCw size={15} />刷新状态</button>
              </div>
            </section>
          )}

          {active === 'about' && (
            <>
              <AboutPanel version={localConfig?.version || APP_VERSION} />
              {isDesktop && (
                <UpdateSection
                  version={localConfig?.version || APP_VERSION}
                  update={update}
                  autoCheck={autoCheckUpdates}
                  setAutoCheck={setAutoCheckUpdates}
                  onCheck={onCheckUpdates}
                  install={updateInstall}
                  onAutoUpdate={onAutoUpdate}
                />
              )}
            </>
          )}

          {error && <div className="inline-error" role="alert"><Info size={16} /><span>{error}</span></div>}
        </div>
      </div>

      <footer className="settings-footer">
        <span><ShieldCheck size={14} />P2P 房间 · 最多 10 人</span>
        <span>{localConfig?.version || APP_VERSION ? `Roomcast ${localConfig?.version || APP_VERSION}` : 'Roomcast'}</span>
      </footer>
    </Modal>
  );
}
