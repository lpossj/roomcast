import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { loadPreference, savePreference } from './preferences.js';
import { playPop } from './sounds.js';
import { confetti, fallbackReveal, revealSnapshot } from './appearance-effects.js';

export default function useAppearance() {
  const [appearance, setAppearance] = useState(() => loadPreference('appearance', 'dark') === 'light' ? 'light' : 'dark');
  const target = useRef(appearance), active = useRef(null), stopParticles = useRef(null);
  const cancel = (commit = true) => {
    const run = active.current;
    if (commit) run?.apply();
    active.current = null;
    run?.transition?.skipTransition(); run?.animation?.cancel(); stopParticles.current?.();
    delete document.documentElement.dataset.themeReveal;
  };
  useLayoutEffect(() => { document.documentElement.dataset.appearance = appearance; }, [appearance]);
  useEffect(() => {
    const hidden = () => { if (document.hidden) cancel(); };
    const resized = () => cancel();
    // Some engines retarget clicks on the captured root to html even when the
    // snapshot ignores pointer events. End that snapshot and activate the real button.
    const clicked = event => {
      if (!active.current || !event.isTrusted || event.detail === 0) return;
      if (![document, document.documentElement, document.body].includes(event.target)) return;
      cancel();
      const button = document.elementFromPoint(event.clientX, event.clientY)?.closest('button');
      if (!button || button.disabled) return;
      event.preventDefault(); event.stopPropagation(); button.click();
    };
    document.addEventListener('visibilitychange', hidden); window.addEventListener('resize', resized);
    document.addEventListener('click', clicked, true);
    return () => {
      document.removeEventListener('visibilitychange', hidden); window.removeEventListener('resize', resized);
      document.removeEventListener('click', clicked, true); cancel(false);
    };
  }, []);
  const toggle = async event => {
    cancel();
    const next = target.current === 'dark' ? 'light' : 'dark';
    target.current = next;
    const run = { transition: null, animation: null, apply: null };
    active.current = run;
    const current = () => active.current === run;
    const box = event.currentTarget.getBoundingClientRect(), x = box.x + box.width / 2, y = box.y + box.height / 2;
    const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y)) + 28;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    let applied = false;
    const apply = () => {
      if (applied || !current()) return;
      applied = true;
      flushSync(() => setAppearance(next)); document.documentElement.dataset.appearance = next; savePreference('appearance', next);
    };
    run.apply = apply;
    const fallback = async () => {
      apply();
      if (!current() || document.hidden) return;
      run.animation = fallbackReveal(x, y, radius);
      await run.animation.finished;
    };
    // Invoke before yielding the click's user activation.
    playPop();
    try {
      if (reduced) { apply(); return; }
      if (typeof document.startViewTransition !== 'function') {
        await fallback();
      } else {
        try {
          const root = document.documentElement;
          root.style.setProperty('--theme-reveal-x', `${Math.max(0, Math.min(100, x / innerWidth * 100))}%`);
          root.style.setProperty('--theme-reveal-y', `${Math.max(0, Math.min(100, y / innerHeight * 100))}%`);
          root.style.setProperty('--theme-reveal-radius', '0%');
          root.dataset.themeReveal = '';
          // Keep the snapshot until the frame driver has painted full coverage.
          run.transition = document.startViewTransition(apply);
          void run.transition.finished.catch(() => {});
          await run.transition.ready;
          if (!current()) return;
          run.animation = revealSnapshot(root);
          await run.animation.finished;
          if (!current()) return;
          run.transition.skipTransition();
          await run.transition.finished;
        } catch {
          run.animation?.cancel(); run.transition?.skipTransition();
          // Drop the snapshot layer before showing the ordinary DOM fallback.
          await run.transition?.finished.catch(() => {});
          if (current()) { delete document.documentElement.dataset.themeReveal; await fallback(); }
        }
      }
      // A canvas created after ready is hidden below the transition snapshots.
      if (current() && !document.hidden) stopParticles.current = confetti(x, y);
    } catch { /* The theme still commits when effects are interrupted. */ }
    finally {
      if (current()) {
        apply();
        run.animation?.cancel(); active.current = null;
        delete document.documentElement.dataset.themeReveal;
      }
    }
  };
  return { appearance, toggle };
}
