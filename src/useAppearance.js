import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { loadPreference, savePreference } from './preferences.js';
import { playPop } from './sounds.js';
import { confetti, fallbackReveal } from './appearance-effects.js';

export default function useAppearance() {
  const [appearance, setAppearance] = useState(() => loadPreference('appearance', 'dark') === 'light' ? 'light' : 'dark');
  const target = useRef(appearance), active = useRef(null), stopParticles = useRef(null);
  const cancel = (commit = true) => {
    const run = active.current;
    if (commit) run?.apply();
    active.current = null;
    run?.animation?.cancel(); stopParticles.current?.();
  };
  useLayoutEffect(() => { document.documentElement.dataset.appearance = appearance; }, [appearance]);
  useEffect(() => {
    const hidden = () => { if (document.hidden) cancel(); };
    const resized = () => cancel();
    document.addEventListener('visibilitychange', hidden); window.addEventListener('resize', resized);
    return () => {
      document.removeEventListener('visibilitychange', hidden); window.removeEventListener('resize', resized);
      cancel(false);
    };
  }, []);
  const toggle = async event => {
    cancel();
    const next = target.current === 'dark' ? 'light' : 'dark';
    target.current = next;
    const run = { animation: null, apply: null };
    active.current = run;
    const current = () => active.current === run;
    const box = event.currentTarget.getBoundingClientRect(), x = box.x + box.width / 2, y = box.y + box.height / 2;
    const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y)) + 28;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    let applied = false;
    const apply = () => {
      if (applied || !current()) return;
      applied = true;
      setAppearance(next);
      document.documentElement.dataset.appearance = next;
      savePreference('appearance', next);
    };
    run.apply = apply;
    playPop();
    try {
      // Apply DOM theme tokens directly without View Transitions root snapshotting
      // so live stage vector animations keep running smoothly at 60fps without freezing.
      apply();
      if (!reduced && current() && !document.hidden) {
        stopParticles.current = confetti(x, y);
        run.animation = fallbackReveal(x, y, radius);
        await run.animation.finished;
      }
    } catch { /* The theme still commits when effects are interrupted. */ }
    finally {
      if (current()) {
        apply();
        run.animation?.cancel(); active.current = null;
      }
    }
  };
  return { appearance, toggle };
}
