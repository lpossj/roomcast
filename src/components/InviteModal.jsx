import { AudioLines, Check, Copy, Globe, Info } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import Modal from './Modal.jsx';
import { cleanIpcError } from '../lib/previewLayout.js';

export default function InviteModal({ room, server, localConfig, onClose, copy, isP2P, relayInvite, inviteSecret, peerServer, campusSecret, nativeHost }) {
  const addresses = (localConfig?.addresses || []).map(value => typeof value === 'string' ? value : value.url).filter(Boolean);
  const loopback = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(server);
  const [address, setAddress] = useState(loopback ? addresses.find(value => /^https?:\/\/100\./.test(value)) || addresses.find(value => !/localhost|127\.0\.0\.1/.test(value)) || server : server);
  const [webViewerUrl, setWebViewerUrl] = useState(window.roomcast?.desktop ? '' : new URL('.', window.location.href).href);
  const [webViewerError, setWebViewerError] = useState('');
  const [webViewerBusy, setWebViewerBusy] = useState(false);
  const [copiedKey, setCopiedKey] = useState('');
  const webRequest = useRef(0);
  const copiedTimer = useRef(null);

  useEffect(() => () => {
    webRequest.current++;
    clearTimeout(copiedTimer.current);
  }, []);

  const triggerCopy = async (key, text) => {
    await copy(text);
    setCopiedKey(key);
    clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopiedKey(''), 2000);
  };

  const startWebViewer = useCallback(() => {
    const request = ++webRequest.current;
    if (!window.roomcast?.startWebInvite) return;
    setWebViewerBusy(true);
    setWebViewerError('');
    window.roomcast.startWebInvite()
      .then(result => { if (request === webRequest.current) setWebViewerUrl(result.url || ''); })
      .catch(error => { if (request === webRequest.current) setWebViewerError(cleanIpcError(error)); })
      .finally(() => { if (request === webRequest.current) setWebViewerBusy(false); });
  }, []);

  useEffect(() => {
    if (!isP2P || !window.roomcast?.startWebInvite) return undefined;
    startWebViewer();
    return window.roomcast.onWebInviteState?.(state => { if (!state.url) setWebViewerUrl(''); });
  }, [isP2P, startWebViewer]);

  const link = `${address}/?room=${encodeURIComponent(room.id)}&server=${encodeURIComponent(address)}`;
  const p2pLink = `roomcast://join/${room.id}?secret=${encodeURIComponent(inviteSecret || '')}${relayInvite ? `&relay=${relayInvite}` : ''}${nativeHost ? '&native=1' : ''}${peerServer ? `&signal=${encodeURIComponent(peerServer)}` : ''}${campusSecret ? `&campus=${encodeURIComponent(campusSecret)}` : ''}`;
  const webLink = (() => {
    try {
      const url = new URL(webViewerUrl.trim());
      if (url.protocol !== 'https:' || url.username || url.password) return '';
      url.search = '';
      url.hash = '';
      const webInvite = new URL(p2pLink);
      webInvite.searchParams.delete('campus');
      url.hash = new URLSearchParams({ room: webInvite.href }).toString();
      return url.href;
    } catch {
      return '';
    }
  })();

  if (isP2P) {
    return (
      <Modal title="分享房间" subtitle="邀请链接包含房间访问凭据，请仅发给可信成员" onClose={onClose}>
        <div className="invite-room">
          <div className="room-symbol"><AudioLines size={24} /></div>
          <div className="invite-room-meta">
            <strong>{room.name}</strong>
            <span>{room.members.length} / 10 位成员在线</span>
          </div>
        </div>

        <div className="invite-block">
          <label className="standalone-label">
            客户端邀请链接
            <input value={p2pLink} readOnly onFocus={event => event.target.select()} />
          </label>
          <button type="button" className="button primary full" onClick={() => void triggerCopy('p2p', p2pLink)}>
            {copiedKey === 'p2p' ? <Check size={16} /> : <Copy size={16} />}
            <span>{copiedKey === 'p2p' ? '已复制邀请链接' : '复制邀请链接'}</span>
          </button>
        </div>

        <div className="invite-block">
          <label className="standalone-label">
            <span className="label-inline"><Globe size={14} />电脑／手机网页观看链接</span>
            <input
              value={webLink}
              readOnly
              placeholder={webViewerBusy ? '正在生成网页观看链接…' : '网页入口尚未就绪'}
              onFocus={event => event.target.select()}
            />
          </label>
          <button type="button" className="button secondary full" onClick={() => void triggerCopy('web', webLink)} disabled={!webLink}>
            {copiedKey === 'web' ? <Check size={16} /> : <Copy size={16} />}
            <span>{copiedKey === 'web' ? '已复制网页链接' : '复制网页观看链接'}</span>
          </button>
        </div>

        {webViewerError && (
          <div className="inline-error">
            <Info size={16} />
            <span>{webViewerError}</span>
            <button type="button" className="button secondary small" onClick={startWebViewer} disabled={webViewerBusy}>重试</button>
          </div>
        )}
      </Modal>
    );
  }

  return (
    <Modal title="分享房间" onClose={onClose}>
      <div className="invite-room">
        <div className="room-symbol"><AudioLines size={24} /></div>
        <div className="invite-room-meta">
          <strong>{room.name}</strong>
          <span>{room.members.length} / 10 位成员在线</span>
        </div>
      </div>
      <label className="standalone-label">
        朋友可以连接的服务地址
        <input value={address} onChange={event => setAddress(event.target.value.replace(/\/$/, ''))} spellCheck={false} />
      </label>
      {loopback && addresses.length > 1 && (
        <div className="address-suggestions">
          {addresses.filter(value => !/localhost|127\.0\.0\.1/.test(value)).map(value => (
            <button type="button" key={value} onClick={() => setAddress(value)}>{value}</button>
          ))}
        </div>
      )}
      <button type="button" className="button primary full" onClick={() => void triggerCopy('lan', `来同屏「${room.name}」\n服务地址：${address}\n邀请链接：${link}`)}>
        {copiedKey === 'lan' ? <Check size={16} /> : <Copy size={16} />}
        <span>{copiedKey === 'lan' ? '已复制邀请信息' : '复制邀请信息'}</span>
      </button>
    </Modal>
  );
}
