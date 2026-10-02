import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { loadPreference, savePreference } from './preferences.js';
import { playPop } from './sounds.js';

function confetti(x, y) {
  const canvas = document.createElement('canvas'); canvas.className = 'theme-confetti'; canvas.setAttribute('aria-hidden', 'true');
  const ratio = Math.min(devicePixelRatio || 1, 2); canvas.width = innerWidth * ratio; canvas.height = innerHeight * ratio;
  document.body.append(canvas); const ctx = canvas.getContext('2d');
  if (!ctx) { canvas.remove(); return () => {}; }
  ctx.scale(ratio, ratio);
  const colors = ['#f6bf4f', '#fd8092', '#61baf9', '#88ddb8', '#a79cf9'];
  const particles = Array.from({ length: 24 }, (_, index) => ({ angle: index * Math.PI * 2 / 24, speed: 80 + Math.random() * 80, color: colors[index % colors.length], spin: Math.random() * 8 }));
  let frame, stopped = false; const started = performance.now();
  const stop = () => { stopped = true; cancelAnimationFrame(frame); canvas.remove(); };
  const draw = now => {
    if (stopped) return;
    const time = (now - started) / 1000;
    if (time >= 0.8) { stop(); return; }
    ctx.clearRect(0, 0, innerWidth, innerHeight); ctx.globalAlpha = Math.max(0, 1 - time / 0.8);
    for (const particle of particles) {
      const distance = particle.speed * (1 - Math.exp(-time * 3));
      ctx.save(); ctx.translate(x + Math.cos(particle.angle) * distance, y + Math.sin(particle.angle) * distance + time * time * 70);
      ctx.rotate(particle.angle + time * particle.spin); ctx.fillStyle = particle.color;
      ctx.fillRect(-2, -5, 4, 10); ctx.restore();
    }
    frame = requestAnimationFrame(draw);
  };
  frame = requestAnimationFrame(draw); return stop;
}

export default function useAppearance() {
  const [appearance, setAppearance] = useState(() => loadPreference('appearance', 'dark') === 'light' ? 'light' : 'dark');
  const busy = useRef(false), lastClick = useRef(-Infinity), transition = useRef(null), animation = useRef(null), stopParticles = useRef(null);
  const cancel = () => { transition.current?.skipTransition(); animation.current?.cancel(); stopParticles.current?.(); };
  useLayoutEffect(() => { document.documentElement.dataset.appearance = appearance; }, [appearance]);
  useEffect(() => {
    const hidden = () => { if (document.hidden) cancel(); };
    document.addEventListener('visibilitychange', hidden); window.addEventListener('resize', cancel);
    return () => { document.removeEventListener('visibilitychange', hidden); window.removeEventListener('resize', cancel); cancel(); };
  }, []);
  const toggle = async event => {
    if (busy.current || performance.now() - lastClick.current < 200) return;
    lastClick.current = performance.now();
    busy.current = true;
    stopParticles.current?.();
    const next = appearance === 'dark' ? 'light' : 'dark';
    const box = event.currentTarget.getBoundingClientRect(), x = box.x + box.width / 2, y = box.y + box.height / 2;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const apply = () => { flushSync(() => setAppearance(next)); document.documentElement.dataset.appearance = next; savePreference('appearance', next); };
    playPop();
    try {
      if (reduced || !document.startViewTransition) {
        apply();
        if (!reduced) {
          stopParticles.current?.(); stopParticles.current = confetti(x, y);
          animation.current = document.documentElement.animate([{ opacity: 1 }, { opacity: 1 }], { duration: 680 });
          await animation.current.finished;
        }
        return;
      }
      const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y)) + 28;
      document.documentElement.style.setProperty('--theme-x', `${x}px`); document.documentElement.style.setProperty('--theme-y', `${y}px`);
      transition.current = document.startViewTransition(apply);
      await transition.current.ready;
      stopParticles.current = confetti(x, y);
      animation.current = document.documentElement.animate([{ '--theme-reveal': '0px' }, { '--theme-reveal': `${radius}px` }], { duration: 680, easing: 'cubic-bezier(.18,.65,.3,1)', fill: 'both', pseudoElement: '::view-transition-new(root)' });
      await animation.current.finished;
    } catch { /* Skipping on resize/background leaves the committed theme intact. */ }
    finally {
      transition.current?.skipTransition(); animation.current?.cancel(); transition.current = null; animation.current = null; busy.current = false;
    }
  };
  return { appearance, toggle };
}
