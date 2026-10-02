import { useEffect } from 'react';

// Visibility is a presentation state, never a voluntary room departure.
export default function useBackgroundStatus({ desktop, room, sharing }) {
  useEffect(() => {
    if (desktop) return;
    const update = () => { document.title = room && document.visibilityState === 'hidden' ? `同屏 · ${sharing ? '后台共享' : '后台聊天'}` : '同屏 Roomcast'; };
    update(); document.addEventListener('visibilitychange', update); window.addEventListener('pageshow', update);
    return () => { document.removeEventListener('visibilitychange', update); window.removeEventListener('pageshow', update); document.title = '同屏 Roomcast'; };
  }, [desktop, room?.id, sharing]);
}
