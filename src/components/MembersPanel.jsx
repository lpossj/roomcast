import { LockKeyhole, MonitorUp, Settings, Users, X } from 'lucide-react';
import Avatar from '../Avatar.jsx';
import PanelResizeHandle from '../PanelResizeHandle.jsx';
import { MemberVolumeControl } from '../ProfileAudioSettings.jsx';

export default function MembersPanel({
  room,
  self,
  selfId,
  onCloseMembers,
  onManageMember,
  voice,
  memberResizeHandlers,
}) {
  if (!room) return null;

  return (
    <aside className="channel-sidebar" aria-label="成员列表">
      <PanelResizeHandle side="members" handlers={memberResizeHandlers} />

      <header className="members-panel-header">
        <div className="members-panel-title">
          <Users size={15} />
          <strong>成员</strong>
          <span className="topbar-count-pill">{room.members.length}/10</span>
        </div>
        <button
          type="button"
          className="icon-button small-icon-btn"
          title="收起成员栏"
          aria-label="收起成员栏"
          onClick={onCloseMembers}
        >
          <X size={15} />
        </button>
      </header>

      <div className="sidebar-members">
        {room.members.map(member => {
          const manageable = member.id !== selfId && member.role !== 'owner' && ['owner', 'admin'].includes(self?.role);
          return (
            <div className="member-row" key={member.id}>
              <Avatar member={member} speaking={voice.speaking[member.id] === true} />
              <div className="member-details">
                <span>
                  <span className="member-name-text">{member.name}</span>
                  {member.id === selfId && <small>你</small>}
                  <em className={`role-badge ${member.role}`}>
                    {member.role === 'owner' ? '房主' : member.role === 'admin' ? '管理员' : '用户'}
                  </em>
                </span>
              </div>
              <div className="member-actions">
                {member.id !== selfId && room.features?.voice === 1 && <MemberVolumeControl member={member} voice={voice} />}
                {manageable ? (
                  <button type="button" className="icon-button" aria-label={`管理成员 ${member.name}`} onClick={() => onManageMember(member)}>
                    <Settings size={14} />
                  </button>
                ) : member.sharing ? (
                  <MonitorUp size={15} className="green-icon" title="正在共享屏幕" />
                ) : !member.canShare ? (
                  <LockKeyhole size={14} className="muted-icon" title="已禁止共享" />
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
