export function confetti(x, y) {
  const canvas = document.createElement('canvas');
  canvas.className = 'theme-confetti';
  canvas.setAttribute('aria-hidden', 'true');
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = innerWidth * ratio; canvas.height = innerHeight * ratio;
  document.body.append(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) { canvas.remove(); return () => {}; }
  ctx.scale(ratio, ratio);
  const colors = ['#f6bf4f', '#fd8092', '#61baf9', '#88ddb8', '#a79cf9'];
  const particles = Array.from({ length: 24 }, (_, index) => ({ angle: index * Math.PI * 2 / 24, speed: 80 + Math.random() * 80, color: colors[index % colors.length], spin: Math.random() * 8 }));
  let frame, stopped = false;
  const started = performance.now();
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
  frame = requestAnimationFrame(draw);
  return stop;
}

// Drive the snapshot explicitly; its CSS animation only keeps it alive.
// Percentages use the snapshot's reference box, independent of display scaling.
export function revealSnapshot(root) {
  let frame, started, settled = false, resolve, reject;
  const finished = new Promise((done, failed) => { resolve = done; reject = failed; });
  const cancel = () => {
    if (settled) return;
    settled = true; cancelAnimationFrame(frame); resolve();
  };
  const draw = now => {
    if (settled) return;
    try {
      started ??= now;
      const progress = Math.min(1, (now - started) / 680);
      // Quadratic ease-out reaches zero velocity only at the outer edge.
      const radius = 144 * progress * (2 - progress);
      root.style.setProperty('--theme-reveal-radius', `${radius}%`);
      if (progress < 1) frame = requestAnimationFrame(draw);
      else frame = requestAnimationFrame(cancel); // Paint full coverage before release.
    } catch (error) { settled = true; reject(error); }
  };
  frame = requestAnimationFrame(draw);
  return { finished, cancel };
}

// Normal DOM/CSS works without View Transitions or pseudo-element animations.
// This fallback never clones live media or captures the room's contents.
export function fallbackReveal(x, y, radius) {
  const ripple = document.createElement('div');
  ripple.className = 'theme-reveal-fallback';
  ripple.setAttribute('aria-hidden', 'true');
  Object.assign(ripple.style, { left: `${x - radius}px`, top: `${y - radius}px`, width: `${radius * 2}px`, height: `${radius * 2}px` });
  document.body.append(ripple);
  let timer, frame, settled = false, resolve;
  const finished = new Promise(done => { resolve = done; });
  const cancel = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer); cancelAnimationFrame(frame);
    ripple.remove(); resolve();
  };
  frame = requestAnimationFrame(() => {
    // Commit the start geometry so engines do not coalesce both CSS states.
    void ripple.offsetWidth;
    ripple.classList.add('is-active');
    timer = setTimeout(cancel, 680);
  });
  return { finished, cancel };
}
