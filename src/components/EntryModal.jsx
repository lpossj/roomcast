import { ArrowRight, Info, Link, LoaderCircle, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import Modal from './Modal.jsx';
import { loadPreference } from '../preferences.js';
import { roomInviteFromUrl } from '../invite-entry.js';

const params = new URLSearchParams(window.location.search);

export default function EntryModal({ mode, onClose, onEnter, busy, defaultServer, peerServer, inviteRoom, canHost = true }) {
  const [kind, setKind] = useState(canHost ? mode : 'join');
  const [form, setForm] = useState({
    nickname: loadPreference('nickname', ''),
    name: '朋友的放映室',
    roomId: inviteRoom || '',
    createKey: '',
    server: params.get('server') || loadPreference('server', '') || defaultServer || window.location.origin,
  });
  const [error, setError] = useState('');

  useEffect(() => {
    if (kind !== 'create' || !window.roomcast?.desktop) return;
    let origin;
    try {
      origin = new URL(peerServer || 'https://0.peerjs.com').origin;
    } catch {
      return;
    }
    const hint = document.createElement('link');
    hint.rel = 'preconnect';
    hint.href = origin;
    hint.crossOrigin = 'anonymous';
    document.head.append(hint);
    return () => hint.remove();
  }, [kind, peerServer]);

  const field = key => ({
    value: form[key],
    onChange: event => setForm(value => ({
      ...value,
      [key]: key === 'roomId' ? roomInviteFromUrl(event.target.value) || event.target.value : event.target.value,
    })),
  });

  const submit = async event => {
    event.preventDefault();
    setError('');
    try {
      if (kind === 'join' && !/^roomcast:\/\/join\//i.test(form.roomId.trim())) {
        throw new Error('请粘贴完整的 Roomcast 邀请链接。');
      }
      await onEnter(kind, { ...form, networkMode: 'p2p' });
    } catch (failure) {
      setError(failure.message);
    }
  };

  return (
    <Modal
      title={kind === 'create' ? '创建房间' : '加入房间'}
      subtitle={kind === 'create' ? '建立一个端到端私密同屏空间，最多支持 10 人同时在线' : '粘贴房主发来的 Roomcast 邀请链接即可加入'}
      onClose={onClose}
      busy={busy}
      cancellable
    >
      {canHost && (
        <div className="segmented" role="tablist" aria-label="房间模式">
          <button type="button" className={kind === 'create' ? 'selected' : ''} onClick={() => { setKind('create'); setError(''); }} disabled={busy}>
            <Plus size={15} />创建
          </button>
          <button type="button" className={kind === 'join' ? 'selected' : ''} onClick={() => { setKind('join'); setError(''); }} disabled={busy}>
            <Link size={15} />加入
          </button>
        </div>
      )}
      <form onSubmit={submit} className="entry-form">
        <label>
          你的昵称
          <input {...field('nickname')} autoComplete="nickname" placeholder="大家怎么称呼你？" required maxLength={24} disabled={busy} />
        </label>
        <label>
          {kind === 'create' ? '房间名称' : '邀请链接'}
          <input
            {...field(kind === 'create' ? 'name' : 'roomId')}
            placeholder={kind === 'create' ? '例如：周末放映室' : '粘贴 roomcast://join/…'}
            required
            maxLength={kind === 'create' ? 40 : 7000}
            disabled={busy}
          />
        </label>
        {error && <div className="inline-error" role="alert"><Info size={16} /><span>{error}</span></div>}
        {kind === 'create' && !window.roomcast?.desktop && (
          <p className="setting-inline-note">请保持房主网页在前台。关闭网页或手机进入后台可能中断房间，长时间使用建议由桌面端主持。</p>
        )}
        <button className="button primary full" type="submit" disabled={busy}>
          {busy ? <LoaderCircle size={17} className="spin" /> : kind === 'create' ? <Plus size={17} /> : <ArrowRight size={17} />}
          <span>{busy ? '正在连接…' : kind === 'create' ? '创建并进入房间' : '进入房间'}</span>
        </button>
      </form>
    </Modal>
  );
}
