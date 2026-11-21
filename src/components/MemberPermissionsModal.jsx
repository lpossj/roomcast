import { Info, LoaderCircle, LogOut, Mic, Palette, ScreenShare, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import Modal from './Modal.jsx';
import Avatar from '../Avatar.jsx';

export default function MemberPermissionsModal({ member, self, onClose, command }) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const run = async (event, payload) => {
    setBusy(event);
    setError('');
    try {
      await command(event, payload);
      onClose();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy('');
    }
  };

  const owner = self?.role === 'owner';
  const canManageLaser = member.id !== self?.id && member.role !== 'owner'
    && (owner || (self?.role === 'admin' && member.role === 'user'));

  return (
    <Modal title={`管理 ${member.name}`} onClose={onClose} busy={!!busy}>
      <div className="permission-member">
        <Avatar member={member} />
        <div>
          <strong>{member.name}</strong>
          <span>{member.role === 'admin' ? '管理员' : '成员'} · {member.canShare ? '允许共享' : '已禁止共享'}</span>
        </div>
      </div>

      {owner && (
        <section className="settings-section">
          <h3><ShieldCheck size={16} />成员角色</h3>
          <div className="settings-buttons">
            <button type="button" className={`button small ${member.role === 'admin' ? 'primary' : 'secondary'}`} onClick={() => run('member:role', { memberId: member.id, role: 'admin' })} disabled={!!busy || member.role === 'admin'}>设为管理员</button>
            <button type="button" className={`button small ${member.role === 'user' ? 'primary' : 'secondary'}`} onClick={() => run('member:role', { memberId: member.id, role: 'user' })} disabled={!!busy || member.role === 'user'}>设为用户</button>
          </div>
        </section>
      )}

      {(owner || (self?.role === 'admin' && member.role === 'user')) && (
        <section className="settings-section">
          <h3><Mic size={16} />麦克风管理</h3>
          <button type="button" className="button danger-share small" disabled={!!busy || !member.voiceEnabled} onClick={() => run('member:mute', { memberId: member.id })}>
            关闭该成员麦克风
          </button>
        </section>
      )}

      {canManageLaser && (
        <section className="settings-section">
          <h3><Palette size={16} />激光笔权限</h3>
          <div className="settings-buttons">
            <button type="button" className="button secondary small" disabled={!!busy || member.canLaser !== false} onClick={() => run('laser:member-permission', { memberId: member.id, enabled: true })}>允许使用</button>
            <button type="button" className="button danger-share small" disabled={!!busy || member.canLaser === false} onClick={() => run('laser:member-permission', { memberId: member.id, enabled: false })}>禁止使用</button>
          </div>
        </section>
      )}

      <section className="settings-section">
        <h3><ScreenShare size={16} />屏幕共享权限</h3>
        <p className="setting-description">禁止后，该成员正在进行的共享会立即停止。</p>
        <div className="settings-buttons">
          <button type="button" className="button secondary small" onClick={() => run('member:share-permission', { memberId: member.id, canShare: true })} disabled={!!busy || member.canShare}>允许共享</button>
          <button type="button" className="button danger-share small" onClick={() => run('member:share-permission', { memberId: member.id, canShare: false })} disabled={!!busy || !member.canShare}>禁止共享</button>
        </div>
      </section>

      <section className="settings-section">
        <h3><LogOut size={16} />成员管理</h3>
        <p className="setting-description">踢出后，该成员的共享会立即结束并离开房间。</p>
        <button type="button" className="button danger-share small" onClick={() => run('member:kick', { memberId: member.id })} disabled={!!busy}>
          {busy === 'member:kick' ? <LoaderCircle size={15} className="spin" /> : <LogOut size={15} />}
          <span>踢出房间</span>
        </button>
      </section>

      {error && <div className="inline-error" role="alert"><Info size={16} /><span>{error}</span></div>}
    </Modal>
  );
}
