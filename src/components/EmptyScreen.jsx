import { Link, Monitor, Plus, Users } from 'lucide-react';
import { lazy, Suspense } from 'react';
import Avatar from '../Avatar.jsx';
import StaticStudioBackdrop from './StaticStudioBackdrop.jsx';

const SpatialStageCanvas = lazy(() => import('./SpatialStageCanvas.jsx'));

export default function EmptyScreen({
  room,
  canShare,
  onCreate,
  onJoin,
  gpuStageMode = 'high',
  hwAccelActive = true,
  isForegroundActive = true,
}) {
  const canRenderWebGL = !room && gpuStageMode !== 'off';
  const stagePaused = !isForegroundActive;

  if (room) {
    return (
      <div className="workspace-empty workspace-empty-inroom">
        <div className="inroom-waiting-card">
          <div className="inroom-waiting-icon" aria-hidden="true">
            <Monitor size={24} />
          </div>
          <h2>等待屏幕共享</h2>
          <p>
            {canShare
              ? `点击下方「${window.roomcast?.desktop ? '共享屏幕' : '共享画面'}」或「邀请好友」开始`
              : '等待成员发起共享，或点下方「邀请好友」'}
          </p>

          <div className="inroom-member-strip" aria-label="房间成员">
            <span className="inroom-member-strip-label"><Users size={14} /> {room.members.length} 人在房间</span>
            <div className="inroom-avatar-stack">
              {room.members.slice(0, 6).map(member => (
                <Avatar key={member.id} member={member} title={member.name} />
              ))}
              {room.members.length > 6 && (
                <span className="inroom-avatar-more">+{room.members.length - 6}</span>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="workspace-empty studio-landing">
      <div className="studio-hero-ambient" aria-hidden="true">
        <div className="workspace-ambient-glow" />
        <div className="workspace-grid-floor" />
        {canRenderWebGL ? (
          <Suspense fallback={<StaticStudioBackdrop />}>
            <SpatialStageCanvas
              stageMode={gpuStageMode}
              hwAccelActive={hwAccelActive}
              paused={stagePaused}
            />
          </Suspense>
        ) : (
          <StaticStudioBackdrop />
        )}
      </div>

      <div className="studio-landing-copy">
        <div className="hero-wordmark-wrap">
          <h1 className="hero-calligraphy-wordmark" aria-label="Roomcast">
            Roomcast
          </h1>
          <svg
            className="hero-calligraphy-flourish"
            viewBox="0 0 340 28"
            fill="none"
            aria-hidden="true"
          >
            <defs>
              <linearGradient id="rc-flourish-grad" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.95" />
                <stop offset="55%" stopColor="var(--text-brand)" stopOpacity="0.85" />
                <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
              </linearGradient>
            </defs>
            <path
              className="hero-flourish-path"
              d="M4 17C64 6 144 4 218 12C258 16 296 18 334 9"
              stroke="url(#rc-flourish-grad)"
              strokeWidth="2.4"
              strokeLinecap="round"
            />
            <path
              d="M28 23C86 15 148 15 198 19"
              stroke="var(--accent)"
              strokeOpacity="0.38"
              strokeWidth="1.2"
              strokeLinecap="round"
            />
            <circle cx="334" cy="9" r="2.5" fill="var(--accent)" />
          </svg>
        </div>

        <p className="studio-landing-lead">高清同屏 · 实时语音 · 激光标注</p>

        <div className="empty-actions">
          {onCreate && (
            <button type="button" className="button primary hero-cta" onClick={onCreate}>
              <Plus size={18} />
              <span>创建房间</span>
            </button>
          )}
          <button
            type="button"
            className={`${onCreate ? 'button secondary' : 'button primary'} hero-cta`}
            onClick={onJoin}
          >
            <Link size={17} />
            <span>加入房间</span>
          </button>
        </div>
      </div>
    </div>
  );
}
