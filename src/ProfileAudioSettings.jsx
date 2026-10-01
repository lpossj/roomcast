import { ImagePlus, Mic, MicOff, Volume2, VolumeX, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import Avatar, { prepareAvatar } from './Avatar.jsx';

export function ProfileSettings({ avatar, name, onAvatar }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const change = async file => {
    setBusy(true); setError('');
    try { await onAvatar(file ? await prepareAvatar(file) : ''); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  };
  return <section className="settings-section"><h3><ImagePlus size={17} />个人头像</h3>
    <div className="profile-avatar-row"><Avatar member={{ name, avatar }} /><div className="settings-buttons">
      <label className={`button secondary small ${busy ? 'disabled' : ''}`}>选择图片<input aria-label="选择头像图片" type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void change(file); }} /></label>
      <button type="button" className="button subtle small" disabled={busy || !avatar} onClick={() => change(null)}>恢复默认头像</button>
    </div></div><p className="about-note">图片居中裁剪，头像会同步到人物栏、共享预览、小窗和全屏。</p>
    {error && <p className="inline-error" role="alert">{error}</p>}
  </section>;
}

export function VoiceSettings({ voice, avatar, name }) {
  useEffect(() => () => voice.setTesting(false), [voice.setTesting]);
  return <section className="settings-section"><h3><Mic size={17} />房间语音</h3>
    <label className="switch-row"><span>默认开启麦克风</span><input type="checkbox" checked={voice.settings.defaultMicrophone} onChange={event => voice.setSettings(value => ({ ...value, defaultMicrophone: event.target.checked }))} /><span className="switch" aria-hidden="true" /></label>
    <label className="switch-row"><span>默认开启成员声音</span><input type="checkbox" checked={voice.settings.defaultOutput} onChange={event => voice.setSettings(value => ({ ...value, defaultOutput: event.target.checked }))} /><span className="switch" aria-hidden="true" /></label>
    <p className="about-note">默认开启选项在下次加入房间时生效。成员声音只控制其他成员的麦克风，共享声音与软件提示音独立。</p>
    <div className="microphone-test"><Avatar member={{ name, avatar }} speaking={voice.testing && voice.testSpeaking} />
      <div className="microphone-meter"><span>麦克风测试</span><meter aria-label="麦克风输入电平" min="0" max="1" value={voice.testing ? voice.level : 0} /><span>{voice.testing ? '请说话，耳返会播放你的麦克风声音' : '测试时本地耳返，不会开启房间麦克风'}</span></div>
      <button type="button" className="button secondary small" onClick={() => voice.setTesting(value => !value)}>{voice.testing ? '结束测试' : '开始测试'}</button>
    </div>{voice.error && <div className="inline-error" role="alert">{voice.error}<button aria-label="关闭音频错误" onClick={voice.clearError}><X size={14} /></button></div>}
  </section>;
}

export function VoiceControls({ voice, inRoom }) {
  return <div className="voice-controls" aria-label="语音控制">
    <div className="voice-control"><button className={`voice-toggle ${voice.microphone ? 'enabled' : ''}`} aria-label={voice.microphone ? '关闭麦克风' : '开启麦克风'} title={voice.microphone ? '关闭麦克风' : '开启麦克风'} aria-pressed={voice.microphone} disabled={!inRoom} onClick={() => voice.setMicrophone(value => !value)}>{voice.microphone ? <Mic size={16} /> : <MicOff size={16} />}</button>
      <label className="voice-volume-popover">麦克风音量 <span>{Math.round(voice.settings.microphoneVolume * 100)}%</span><input aria-label="麦克风音量" type="range" min="0" max="1" step="0.01" value={voice.settings.microphoneVolume} onChange={event => voice.setSettings(value => ({ ...value, microphoneVolume: Number(event.target.value) }))} /></label>
    </div>
    <div className="voice-control"><button className={`voice-toggle ${voice.output ? 'enabled' : ''}`} aria-label={voice.output ? '关闭成员声音' : '开启成员声音'} title={voice.output ? '关闭成员声音' : '开启成员声音'} aria-pressed={voice.output} onClick={() => voice.setOutput(value => !value)}>{voice.output ? <Volume2 size={16} /> : <VolumeX size={16} />}</button>
      <label className="voice-volume-popover">成员声音音量 <span>{Math.round(voice.settings.outputVolume * 100)}%</span><input aria-label="成员声音音量" type="range" min="0" max="1" step="0.01" value={voice.settings.outputVolume} onChange={event => voice.setSettings(value => ({ ...value, outputVolume: Number(event.target.value) }))} /></label>
    </div>
  </div>;
}
