import { useEffect, useRef, useState } from 'react';
import { loadPreference, savePreference } from './preferences.js';

export function usePanelWidths(showChat) {
  const [widths, setWidths] = useState(() => {
    const saved = loadPreference('panelWidths', {});
    return Object.fromEntries(['members', 'chat'].filter(key => Number.isFinite(saved?.[key])).map(key => [key, saved[key]]));
  });
  const shell = useRef(null), drag = useRef(null), current = useRef(widths);
  current.current = widths;
  const limits = side => {
    const root = shell.current;
    const available = root.clientWidth - root.querySelector('.icon-rail').getBoundingClientRect().width;
    const other = side === 'members' ? (showChat ? root.querySelector('.chat-panel')?.getBoundingClientRect().width || 0 : 0) : root.querySelector('.channel-sidebar').getBoundingClientRect().width;
    const min = side === 'members' ? 180 : 200;
    return { min, max: Math.max(min, Math.min(side === 'members' ? 420 : 600, available - other - 300)) };
  };
  const change = (side, width, persist = false) => {
    const { min, max } = limits(side);
    const next = { ...current.current, [side]: Math.round(Math.max(min, Math.min(max, width))) };
    current.current = next; setWidths(next);
    if (persist) savePreference('panelWidths', next);
  };
  const finish = () => {
    if (!drag.current) return;
    drag.current = null; shell.current?.classList.remove('panels-resizing');
    savePreference('panelWidths', current.current);
  };
  useEffect(() => {
    const resize = () => {
      finish();
      if (window.innerWidth <= 850) return;
      for (const side of ['members', 'chat']) if (Number.isFinite(current.current[side])) change(side, current.current[side]);
    };
    resize();
    window.addEventListener('resize', resize); window.addEventListener('blur', finish);
    return () => { window.removeEventListener('resize', resize); window.removeEventListener('blur', finish); finish(); };
  }, [showChat]);
  const handle = side => ({
    'aria-valuenow': widths[side] ?? (side === 'members' ? 240 : 285),
    'aria-valuemin': side === 'members' ? 180 : 200,
    'aria-valuemax': side === 'members' ? 420 : 600,
    onPointerDown(event) {
      if (event.button !== 0) return;
      event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
      const panel = shell.current.querySelector(side === 'members' ? '.channel-sidebar' : '.chat-panel');
      drag.current = { side, x: event.clientX, width: panel.getBoundingClientRect().width };
      shell.current.classList.add('panels-resizing');
    },
    onPointerMove(event) {
      const active = drag.current;
      if (active?.side === side) change(side, active.width + (event.clientX - active.x) * (side === 'members' ? 1 : -1));
    },
    onPointerUp: finish, onPointerCancel: finish, onLostPointerCapture: finish,
    onKeyDown(event) {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const { min, max } = limits(side), panel = shell.current.querySelector(side === 'members' ? '.channel-sidebar' : '.chat-panel');
      const width = panel.getBoundingClientRect().width;
      change(side, event.key === 'Home' ? min : event.key === 'End' ? max : width + (event.key === 'ArrowRight' ? 10 : -10) * (side === 'members' ? 1 : -1), true);
    },
    onDoubleClick() {
      const next = { ...current.current }; delete next[side]; current.current = next; setWidths(next); savePreference('panelWidths', next);
    },
  });
  return { shell, style: { '--members-width': widths.members ? `${widths.members}px` : undefined, '--chat-width': widths.chat ? `${widths.chat}px` : undefined }, handle };
}

export default function PanelResizeHandle({ side, handlers }) {
  return <div className={`panel-resize-handle ${side}`} role="separator" aria-label={side === 'members' ? '调整成员栏宽度' : '调整聊天栏宽度'} aria-orientation="vertical" tabIndex={0} title="拖动调整宽度，双击恢复" {...handlers} />;
}
