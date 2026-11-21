import {
  MessageSquare,
  Moon,
  Settings,
  Sun,
  Users,
  Volume2,
  Wifi,
} from 'lucide-react';
import Avatar from '../Avatar.jsx';
import LaserIcon from './LaserIcon.jsx';
import { loadPreference } from '../preferences.js';

export default function StudioTopbar({
  appearance,
  room,
  self,
  avatar,
  config,
  latencyMs,
  latencyTone,
  canManageGlobalLaser,
  globalLaserPending,
  onToggleGlobalLaser,
  showMembers,
  onToggleMembers,
  showChat,
  onToggleChat,
  unreadChat,
  updateAvailable,
  updateVersion,
  onOpenSettings,
}) {
  const displayName = self?.name || loadPreference('nickname', '访客');
  const isDark = appearance.appearance === 'dark';
  const laserOn = room?.laserEnabled !== false;

  return (
    <header className="studio-topbar">
      <div className="topbar-left">
        <button
          type="button"
          className="brand-icon"
          title={isDark ? '切换日间主题' : '切换夜间主题'}
          aria-label={isDark ? '切换日间主题' : '切换夜间主题'}
          aria-pressed={!isDark}
          onClick={appearance.toggle}
        >
          <span className="brand-mark"><span /><span /></span>
        </button>

        <div className="topbar-brand-title">
          <strong>同屏<span>Roomcast</span></strong>
          <span className="version-pill">BETA</span>
        </div>

        {room && (
          <>
            <div className="topbar-divider" aria-hidden="true" />
            <div className="topbar-room-cluster">
              <span className="topbar-room-pill">
                <Volume2 size={14} />
                <strong>{room.name}</strong>
                <span className="topbar-room-count">{room.members.length}/10</span>
              </span>
              <span
                className={`connection-pill connected network-latency ${latencyTone}`}
                aria-label={`连接状态 ${config?.roomConnection || 'P2P'}，延迟 ${latencyMs == null ? '-- ms' : `${latencyMs} ms`}`}
              >
                <span className="status-dot" />
                <span>{config?.roomConnection || 'P2P'}</span>
                <Wifi className="network-latency-icon" size={13} strokeWidth={2.2} aria-hidden="true" />
                <span>{latencyMs == null ? '-- ms' : `${latencyMs} ms`}</span>
              </span>
            </div>
          </>
        )}
      </div>

      <div className="topbar-actions">
        {room && (
          <>
            {canManageGlobalLaser && (
              <button
                type="button"
                className="icon-button global-laser-toggle"
                data-tooltip={laserOn ? '全局激光笔：已开启' : '全局激光笔：已关闭'}
                data-tooltip-pos="bottom"
                aria-label={laserOn ? '全局激光笔：已开启' : '全局激光笔：已关闭'}
                aria-pressed={laserOn}
                disabled={globalLaserPending}
                onClick={onToggleGlobalLaser}
              >
                <LaserIcon size={17} />
              </button>
            )}

            <button
              type="button"
              className={`topbar-toggle-btn ${showMembers ? 'toggled' : ''}`}
              aria-label={showMembers ? '收起成员栏' : '展开成员栏'}
              aria-pressed={showMembers}
              onClick={onToggleMembers}
            >
              <Users size={16} />
              <span className="topbar-btn-label">成员</span>
              <span className="topbar-count-pill">{room.members.length}</span>
            </button>

            <button
              type="button"
              className={`topbar-toggle-btn ${showChat ? 'toggled' : ''}`}
              aria-label={showChat ? '收起聊天' : '展开聊天'}
              aria-pressed={showChat}
              onClick={onToggleChat}
            >
              <MessageSquare size={16} />
              <span className="topbar-btn-label">聊天</span>
              {unreadChat && <span className="topbar-unread-dot" aria-label="有未读消息" />}
            </button>
          </>
        )}

        <button
          type="button"
          className="icon-button topbar-theme-btn"
          data-tooltip={isDark ? '切换日间模式' : '切换夜间模式'}
          data-tooltip-pos="bottom"
          aria-label={isDark ? '切换日间模式' : '切换夜间模式'}
          aria-pressed={!isDark}
          onClick={appearance.toggle}
        >
          {isDark ? <Moon size={16} /> : <Sun size={16} />}
        </button>

        <button
          type="button"
          className={`icon-button topbar-settings-btn ${updateAvailable ? 'has-update' : ''}`}
          data-tooltip={updateAvailable ? `设置 · 有更新 ${updateVersion}` : '设置'}
          data-tooltip-pos="bottom"
          aria-label={updateAvailable ? `设置，有可用更新 ${updateVersion}` : '设置'}
          onClick={onOpenSettings}
        >
          <Settings size={17} />
          {updateAvailable && <span className="rail-update-dot" aria-hidden="true" />}
        </button>

        <Avatar className="avatar topbar-avatar" member={{ ...self, avatar, name: displayName }} title={displayName} />
      </div>
    </header>
  );
}
