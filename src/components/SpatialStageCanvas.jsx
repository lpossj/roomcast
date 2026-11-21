import { useEffect, useRef } from 'react';

function hexToRgb(input, fallback = [120, 221, 189]) {
  const s = String(input || '').trim();
  if (s.startsWith('#')) {
    const h = s.slice(1);
    if (h.length === 3) {
      return [
        parseInt(h[0] + h[0], 16),
        parseInt(h[1] + h[1], 16),
        parseInt(h[2] + h[2], 16),
      ];
    }
    if (h.length >= 6) {
      return [
        parseInt(h.slice(0, 2), 16),
        parseInt(h.slice(2, 4), 16),
        parseInt(h.slice(4, 6), 16),
      ];
    }
  }
  const m = s.match(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  return fallback;
}

function lerpRgb(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

function rgbaStr(rgb, alpha) {
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha.toFixed(3)})`;
}

function createSubdividedOctahedron(radius, detail = 1) {
  const baseVerts = [
    [1, 0, 0], [-1, 0, 0],
    [0, 1, 0], [0, -1, 0],
    [0, 0, 1], [0, 0, -1],
  ];
  let faces = [
    [0, 2, 4], [4, 2, 1], [1, 2, 5], [5, 2, 0],
    [0, 4, 3], [4, 1, 3], [1, 5, 3], [5, 0, 3],
  ];
  const verts = baseVerts.map(v => [...v]);
  const midCache = new Map();
  const midpoint = (a, b) => {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (midCache.has(key)) return midCache.get(key);
    const va = verts[a], vb = verts[b];
    const mx = va[0] + vb[0], my = va[1] + vb[1], mz = va[2] + vb[2];
    const len = Math.hypot(mx, my, mz) || 1;
    const idx = verts.length;
    verts.push([mx / len, my / len, mz / len]);
    midCache.set(key, idx);
    return idx;
  };
  for (let d = 0; d < detail; d += 1) {
    const next = [];
    for (const [a, b, c] of faces) {
      const ab = midpoint(a, b);
      const bc = midpoint(b, c);
      const ca = midpoint(c, a);
      next.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]);
    }
    faces = next;
  }
  return {
    verts: verts.map(([x, y, z]) => [x * radius, y * radius, z * radius]),
    faces,
  };
}

function createIcosahedron(radius) {
  const phi = (1 + Math.sqrt(5)) / 2;
  const raw = [
    [-1, phi, 0], [1, phi, 0], [-1, -phi, 0], [1, -phi, 0],
    [0, -1, phi], [0, 1, phi], [0, -1, -phi], [0, 1, -phi],
    [phi, 0, -1], [phi, 0, 1], [-phi, 0, -1], [-phi, 0, 1],
  ];
  const verts = raw.map(([x, y, z]) => {
    const len = Math.hypot(x, y, z) || 1;
    return [(x / len) * radius, (y / len) * radius, (z / len) * radius];
  });
  const faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  const edgeSet = new Set();
  const edges = [];
  for (const [a, b, c] of faces) {
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const k = u < v ? `${u}:${v}` : `${v}:${u}`;
      if (!edgeSet.has(k)) {
        edgeSet.add(k);
        edges.push([u, v]);
      }
    }
  }
  return { verts, faces, edges };
}

function rotateXYZ(x, y, z, rx, ry, rz) {
  const cx = Math.cos(rx), sx = Math.sin(rx);
  const cy = Math.cos(ry), sy = Math.sin(ry);
  const cz = Math.cos(rz), sz = Math.sin(rz);

  // X
  const y1 = y * cx - z * sx;
  const z1 = y * sx + z * cx;
  // Y
  const x2 = x * cy + z1 * sy;
  const z2 = -x * sy + z1 * cy;
  // Z
  const x3 = x2 * cz - y1 * sz;
  const y3 = x2 * sz + y1 * cz;
  return [x3, y3, z2];
}

function createDotSprite(rgb, isLight = false) {
  const size = 32;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d');
  if (g) {
    const grad = g.createRadialGradient(16, 16, 1, 16, 16, 15);
    grad.addColorStop(0, isLight ? rgbaStr(rgb, 0.96) : 'rgba(255,255,255,0.95)');
    grad.addColorStop(0.28, rgbaStr(rgb, isLight ? 0.72 : 0.92));
    grad.addColorStop(0.62, rgbaStr(rgb, isLight ? 0.22 : 0.34));
    grad.addColorStop(1, rgbaStr(rgb, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
  }
  return c;
}

function readScenePalette() {
  const styles = getComputedStyle(document.documentElement);
  const accent = hexToRgb(styles.getPropertyValue('--accent').trim() || '#78ddbd');
  const isLight = document.documentElement.dataset.appearance === 'light';
  const primary = isLight ? lerpRgb(accent, [11, 59, 92], 0.42) : lerpRgb(accent, [255, 255, 255], 0.14);
  const secondary = isLight ? lerpRgb(accent, [37, 99, 235], 0.48) : lerpRgb(accent, [56, 189, 248], 0.52);
  const shell = isLight ? [191, 219, 254] : [16, 30, 48];
  const node = isLight ? [15, 23, 42] : [255, 255, 255];
  return { isLight, accent, primary, secondary, shell, node };
}

export default function SpatialStageCanvas({
  stageMode = 'high',
  hwAccelActive = true,
  paused = false,
}) {
  const canvasRef = useRef(null);
  const ctrlRef = useRef({ paused, hwAccelActive, wake: null });
  ctrlRef.current.paused = paused;
  ctrlRef.current.hwAccelActive = hwAccelActive;

  useEffect(() => {
    ctrlRef.current.wake?.();
  }, [paused, hwAccelActive]);

  useEffect(() => {
    if (stageMode === 'off') return undefined;
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return undefined;

    const innerPoly = createSubdividedOctahedron(0.68, 1);
    const outerPoly = createIcosahedron(1.26);

    // Precompute wave base grid (18 x 10 dots)
    const waveCols = 18;
    const waveRows = 10;
    const waveGrid = [];
    for (let r = 0; r <= waveRows; r += 1) {
      for (let c = 0; c <= waveCols; c += 1) {
        const bx = (c / waveCols - 0.5) * 15.6;
        const by = (r / waveRows - 0.5) * 8.4;
        waveGrid.push({ bx, by });
      }
    }

    // Floating 3D starfield
    const particles = Array.from({ length: 46 }, (_, i) => {
      const angle = (i / 46) * Math.PI * 2 * 2.3;
      const radius = 1.65 + ((i * 7) % 13) * 0.24;
      const y = (((i * 11) % 17) - 8) * 0.26;
      return {
        x: Math.cos(angle) * radius,
        y,
        z: Math.sin(angle) * radius * 0.72 - 0.4,
        phase: i * 0.47,
        size: 1.5 + (i % 3) * 0.55,
      };
    });

    let width = 1280;
    let height = 820;
    let dpr = 1;
    let rigOffsetX = 1.9;
    let rigScale = 1;
    let disposed = false;
    let rafId = 0;
    let simTime = 0;
    let lastNow = performance.now();

    let palette = readScenePalette();
    let waveSprite = createDotSprite(palette.primary, palette.isLight);
    let starSprite = createDotSprite(palette.secondary, palette.isLight);

    const refreshSprites = () => {
      palette = readScenePalette();
      waveSprite = createDotSprite(palette.primary, palette.isLight);
      starSprite = createDotSprite(palette.secondary, palette.isLight);
    };

    const pointer = { x: 0, y: 0, targetX: 0, targetY: 0 };
    const stageHost = canvas.closest('.studio-hero-ambient') || window;
    const onPointerMove = event => {
      if (ctrlRef.current.paused) return;
      pointer.targetX = (event.clientX / (window.innerWidth || 1) - 0.5) * 2;
      pointer.targetY = (event.clientY / (window.innerHeight || 1) - 0.5) * 2;
    };
    const onPointerLeave = () => {
      pointer.targetX = 0;
      pointer.targetY = 0;
    };
    stageHost.addEventListener('pointermove', onPointerMove, { passive: true });
    stageHost.addEventListener('pointerleave', onPointerLeave, { passive: true });

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, Math.round(rect.width || window.innerWidth || 1280));
      height = Math.max(1, Math.round(rect.height || window.innerHeight || 820));
      const maxDpr = ctrlRef.current.hwAccelActive ? 1.35 : 1.0;
      dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      rigOffsetX = width > 960 ? 1.85 : 0;
      rigScale = Math.min(1.12, Math.max(0.76, width / 1060));
    };

    const camZ = 8.4;
    const fovScale = 1 / Math.tan((38 * Math.PI) / 360);

    const project = (x, y, z) => {
      const dz = camZ - z;
      if (dz <= 0.3) return null;
      const factor = (fovScale * (height * 0.5)) / dz;
      return [width * 0.5 + x * factor, height * 0.5 - y * factor, z, factor];
    };

    const projectRig = (lx, ly, lz, rigRotY, rigRotX, rigY) => {
      const sx = lx * rigScale;
      const sy = ly * rigScale;
      const sz = lz * rigScale;
      const [rx, ry, rz] = rotateXYZ(sx, sy, sz, rigRotX, rigRotY, 0);
      return project(rx + rigOffsetX, ry + rigY, rz);
    };

    const renderFrame = (dt = 0) => {
      simTime += dt;
      pointer.x += (pointer.targetX - pointer.x) * 0.08;
      pointer.y += (pointer.targetY - pointer.y) * 0.08;

      const t = simTime;
      const { isLight, accent, primary, secondary, shell, node } = palette;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      // 1. Undulating 3D wave orb floor
      ctx.globalCompositeOperation = isLight ? 'source-over' : 'lighter';
      const wRotX = -Math.PI * 0.39;
      const wRotZ = -0.08;
      for (let i = 0; i < waveGrid.length; i += 1) {
        const { bx, by } = waveGrid[i];
        const bz = Math.sin(bx * 0.65 + t * 1.5) * 0.28 + Math.cos(by * 0.85 - t * 1.2) * 0.22;
        const [rx, ry, rz] = rotateXYZ(bx, by, bz, wRotX, 0, wRotZ);
        const p = project(rx + 0.6, ry - 2.05, rz - 1.5);
        if (!p) continue;
        const size = Math.max(4, p[3] * 0.085);
        ctx.globalAlpha = isLight ? 0.42 : 0.66;
        ctx.drawImage(waveSprite, p[0] - size * 0.5, p[1] - size * 0.5, size, size);
      }

      const rigRotY = -0.2 + pointer.x * 0.22 + Math.sin(t * 0.55) * 0.08;
      const rigRotX = 0.08 - pointer.y * 0.14 + Math.cos(t * 0.45) * 0.05;
      const rigY = Math.sin(t * 0.9) * 0.08;

      // Center aura radial sphere glow
      const centerP = projectRig(0, 0, 0, rigRotY, rigRotX, rigY);
      if (centerP) {
        const auraR = centerP[3] * 1.85 * rigScale;
        const auraGrad = ctx.createRadialGradient(centerP[0], centerP[1], auraR * 0.1, centerP[0], centerP[1], auraR);
        auraGrad.addColorStop(0, rgbaStr(primary, isLight ? 0.16 : 0.26));
        auraGrad.addColorStop(0.55, rgbaStr(secondary, isLight ? 0.11 : 0.14));
        auraGrad.addColorStop(0.84, rgbaStr(primary, isLight ? 0.04 : 0.06));
        auraGrad.addColorStop(1, rgbaStr(primary, 0));
        ctx.globalAlpha = 1;
        ctx.fillStyle = auraGrad;
        ctx.beginPath();
        ctx.arc(centerP[0], centerP[1], auraR, 0, Math.PI * 2);
        ctx.fill();
      }

      // 2. Floating 3D starfield
      for (let i = 0; i < particles.length; i += 1) {
        const pt = particles[i];
        const py = pt.y + Math.sin(t * 1.15 + pt.phase) * 0.14;
        const [rx, ry, rz] = rotateXYZ(pt.x, py, pt.z, 0, t * 0.14, 0);
        const p = projectRig(rx, ry, rz, rigRotY, rigRotX, rigY);
        if (!p) continue;
        const s = Math.max(5, p[3] * 0.048 * pt.size);
        ctx.globalAlpha = isLight ? 0.48 : 0.78;
        ctx.drawImage(starSprite, p[0] - s * 0.5, p[1] - s * 0.5, s, s);
      }

      ctx.globalCompositeOperation = 'source-over';

      // Helper to project & draw a 3D ring/arc + optional satellite beacons
      const drawRing = (radius, tiltX, tiltY, spinZ, color, alpha, lineWidth, startA = 0, endA = Math.PI * 2, passBehind = true) => {
        const steps = endA - startA >= Math.PI * 1.9 ? 68 : 26;
        let prev = null;
        for (let i = 0; i <= steps; i += 1) {
          const a = startA + ((endA - startA) * i) / steps;
          const lx = Math.cos(a) * radius;
          const ly = Math.sin(a) * radius;
          const [tx, ty, tz] = rotateXYZ(lx, ly, 0, tiltX, tiltY, spinZ);
          const p = projectRig(tx, ty, tz, rigRotY, rigRotX, rigY);
          if (p && prev) {
            const avgZ = (p[2] + prev[2]) * 0.5;
            const isBack = avgZ < 0;
            if ((passBehind && isBack) || (!passBehind && !isBack)) {
              ctx.strokeStyle = rgbaStr(color, isBack ? alpha * 0.52 : alpha);
              ctx.lineWidth = isBack ? lineWidth * 0.8 : lineWidth;
              ctx.beginPath();
              ctx.moveTo(prev[0], prev[1]);
              ctx.lineTo(p[0], p[1]);
              ctx.stroke();
            }
          }
          prev = p;
        }
      };

      const drawBeacon = (radius, angle, tiltX, tiltY, spinZ, passBehind) => {
        const lx = Math.cos(angle) * radius;
        const ly = Math.sin(angle) * radius;
        const [tx, ty, tz] = rotateXYZ(lx, ly, 0, tiltX, tiltY, spinZ);
        const p = projectRig(tx, ty, tz, rigRotY, rigRotX, rigY);
        if (!p) return;
        const isBack = p[2] < 0;
        if ((passBehind && !isBack) || (!passBehind && isBack)) return;
        const r = Math.max(4, p[3] * 0.08 * rigScale);
        ctx.globalAlpha = isBack ? 0.45 : 0.95;
        ctx.fillStyle = rgbaStr(secondary, 0.24);
        ctx.beginPath();
        ctx.arc(p[0], p[1], r * 2.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = rgbaStr(node, 1);
        ctx.beginPath();
        ctx.moveTo(p[0], p[1] - r);
        ctx.lineTo(p[0] + r, p[1]);
        ctx.lineTo(p[0], p[1] + r);
        ctx.lineTo(p[0] - r, p[1]);
        ctx.closePath();
        ctx.fill();
      };

      const r1TiltX = Math.PI * 0.34;
      const r1TiltY = 0.32 + Math.sin(t * 0.4) * 0.14;
      const r1SpinZ = t * 0.48;

      const r2TiltX = -Math.PI * 0.29 + Math.cos(t * 0.35) * 0.12;
      const r2TiltY = -0.38;
      const r2SpinZ = -t * 0.36;

      const arcTiltX = Math.PI * 0.24;
      const arcTiltY = -0.32;
      const arcSpinZ = t * 0.62;

      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.globalAlpha = 1;

      // Back halves of rings & beacons
      drawRing(2.78, r2TiltX, r2TiltY, r2SpinZ, secondary, isLight ? 0.56 : 0.52, 2.0, 0, Math.PI * 2, true);
      drawRing(2.15, r1TiltX, r1TiltY, r1SpinZ, primary, isLight ? 0.7 : 0.66, 2.3, 0, Math.PI * 2, true);
      drawRing(2.48, arcTiltX, arcTiltY, arcSpinZ, secondary, isLight ? 0.72 : 0.8, 2.4, 0, Math.PI * 0.68, true);
      drawRing(2.48, arcTiltX, arcTiltY, arcSpinZ + Math.PI, secondary, isLight ? 0.72 : 0.8, 2.4, 0, Math.PI * 0.68, true);
      drawBeacon(2.15, 0.4, r1TiltX, r1TiltY, r1SpinZ, true);
      drawBeacon(2.15, Math.PI + 0.4, r1TiltX, r1TiltY, r1SpinZ, true);
      drawBeacon(2.78, 1.3, r2TiltX, r2TiltY, r2SpinZ, true);

      // 3. Outer Glass Icosahedron back faces
      const outerRx = t * 0.22;
      const outerRy = t * 0.34;
      const outerWorld = outerPoly.verts.map(([x, y, z]) => rotateXYZ(x, y, z, outerRx, outerRy, 0));
      const outerProj = outerWorld.map(([x, y, z]) => projectRig(x, y, z, rigRotY, rigRotX, rigY));

      const outerFaceList = [];
      for (const [ia, ib, ic] of outerPoly.faces) {
        const va = outerWorld[ia], vb = outerWorld[ib], vc = outerWorld[ic];
        const pa = outerProj[ia], pb = outerProj[ib], pc = outerProj[ic];
        if (!pa || !pb || !pc) continue;
        const ux = vb[0] - va[0], uy = vb[1] - va[1], uz = vb[2] - va[2];
        const vx = vc[0] - va[0], vy = vc[1] - va[1], vz = vc[2] - va[2];
        const nx = uy * vz - uz * vy;
        const ny = uz * vx - ux * vz;
        const nz = ux * vy - uy * vx;
        const nLen = Math.hypot(nx, ny, nz) || 1;
        const light = Math.max(0, (nx * 0.42 + ny * 0.56 + nz * 0.71) / nLen);
        const depth = (pa[2] + pb[2] + pc[2]) / 3;
        outerFaceList.push({ pa, pb, pc, light, depth });
      }
      outerFaceList.sort((a, b) => a.depth - b.depth);

      for (const f of outerFaceList) {
        if (f.depth >= 0) continue;
        const col = lerpRgb(shell, secondary, f.light * 0.38);
        ctx.fillStyle = rgbaStr(col, isLight ? 0.14 : 0.22);
        ctx.beginPath();
        ctx.moveTo(f.pa[0], f.pa[1]);
        ctx.lineTo(f.pb[0], f.pb[1]);
        ctx.lineTo(f.pc[0], f.pc[1]);
        ctx.closePath();
        ctx.fill();
      }

      // 4. Inner Glowing Shaded Gem (Subdivided Octahedron)
      const pulse = 1 + Math.sin(t * 2.1) * 0.065;
      const innerRx = t * 0.42;
      const innerRy = -t * 0.65;
      const innerWorld = innerPoly.verts.map(([x, y, z]) => rotateXYZ(x * pulse, y * pulse, z * pulse, innerRx, innerRy, 0));
      const innerProj = innerWorld.map(([x, y, z]) => projectRig(x, y, z, rigRotY, rigRotX, rigY));

      const innerFaceList = [];
      for (const [ia, ib, ic] of innerPoly.faces) {
        const va = innerWorld[ia], vb = innerWorld[ib], vc = innerWorld[ic];
        const pa = innerProj[ia], pb = innerProj[ib], pc = innerProj[ic];
        if (!pa || !pb || !pc) continue;
        // Backface cull in projected screen space
        const cross2d = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0]);
        if (cross2d > 0) continue;
        const ux = vb[0] - va[0], uy = vb[1] - va[1], uz = vb[2] - va[2];
        const vx = vc[0] - va[0], vy = vc[1] - va[1], vz = vc[2] - va[2];
        const nx = uy * vz - uz * vy;
        const ny = uz * vx - ux * vz;
        const nz = ux * vy - uy * vx;
        const nLen = Math.hypot(nx, ny, nz) || 1;
        const light = Math.max(0, (nx * 0.38 + ny * 0.58 + nz * 0.72) / nLen);
        const depth = (pa[2] + pb[2] + pc[2]) / 3;
        innerFaceList.push({ pa, pb, pc, light, depth });
      }
      innerFaceList.sort((a, b) => a.depth - b.depth);

      for (const f of innerFaceList) {
        const base = isLight ? primary : accent;
        const lit = lerpRgb(base, isLight ? secondary : [235, 255, 250], 0.16 + f.light * 0.64);
        ctx.fillStyle = rgbaStr(lit, isLight ? 0.78 : 0.9);
        ctx.strokeStyle = rgbaStr(lit, 0.35);
        ctx.lineWidth = 0.6;
        ctx.beginPath();
        ctx.moveTo(f.pa[0], f.pa[1]);
        ctx.lineTo(f.pb[0], f.pb[1]);
        ctx.lineTo(f.pc[0], f.pc[1]);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }

      // 5. Outer Glass Icosahedron front faces + crisp 3D wireframe + glowing vertices
      for (const f of outerFaceList) {
        if (f.depth < 0) continue;
        const col = lerpRgb(shell, primary, 0.12 + f.light * 0.42);
        ctx.fillStyle = rgbaStr(col, isLight ? 0.2 : 0.24);
        ctx.beginPath();
        ctx.moveTo(f.pa[0], f.pa[1]);
        ctx.lineTo(f.pb[0], f.pb[1]);
        ctx.lineTo(f.pc[0], f.pc[1]);
        ctx.closePath();
        ctx.fill();
      }

      for (const [ia, ib] of outerPoly.edges) {
        const pa = outerProj[ia], pb = outerProj[ib];
        if (!pa || !pb) continue;
        const depth = (pa[2] + pb[2]) * 0.5;
        ctx.strokeStyle = rgbaStr(primary, depth >= 0 ? (isLight ? 0.76 : 0.84) : (isLight ? 0.3 : 0.34));
        ctx.lineWidth = depth >= 0 ? 1.45 : 1.0;
        ctx.beginPath();
        ctx.moveTo(pa[0], pa[1]);
        ctx.lineTo(pb[0], pb[1]);
        ctx.stroke();
      }

      for (const p of outerProj) {
        if (!p) continue;
        const isFront = p[2] >= 0;
        const s = (isFront ? 14 : 9.5) * rigScale;
        ctx.globalAlpha = isFront ? 0.95 : 0.48;
        ctx.drawImage(waveSprite, p[0] - s * 0.5, p[1] - s * 0.5, s, s);
      }

      // 6. Front halves of rings & beacons (passing cleanly in front of polyhedron!)
      ctx.globalAlpha = 1;
      drawRing(2.78, r2TiltX, r2TiltY, r2SpinZ, secondary, isLight ? 0.62 : 0.58, 2.2, 0, Math.PI * 2, false);
      drawRing(2.15, r1TiltX, r1TiltY, r1SpinZ, primary, isLight ? 0.78 : 0.74, 2.5, 0, Math.PI * 2, false);
      drawRing(2.48, arcTiltX, arcTiltY, arcSpinZ, secondary, isLight ? 0.8 : 0.88, 2.6, 0, Math.PI * 0.68, false);
      drawRing(2.48, arcTiltX, arcTiltY, arcSpinZ + Math.PI, secondary, isLight ? 0.8 : 0.88, 2.6, 0, Math.PI * 0.68, false);
      drawBeacon(2.15, 0.4, r1TiltX, r1TiltY, r1SpinZ, false);
      drawBeacon(2.15, Math.PI + 0.4, r1TiltX, r1TiltY, r1SpinZ, false);
      drawBeacon(2.78, 1.3, r2TiltX, r2TiltY, r2SpinZ, false);
      ctx.globalAlpha = 1;
    };

    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

    const tick = now => {
      rafId = 0;
      if (disposed) return;
      const dt = Math.min(0.05, Math.max(0, (now - lastNow) * 0.001));
      lastNow = now;
      renderFrame(dt);
      if (!reducedMotion && !ctrlRef.current.paused) {
        rafId = requestAnimationFrame(tick);
      }
    };

    ctrlRef.current.wake = () => {
      if (disposed) return;
      lastNow = performance.now();
      if (ctrlRef.current.paused) {
        if (rafId) {
          cancelAnimationFrame(rafId);
          rafId = 0;
        }
        renderFrame(0);
      } else if (!reducedMotion && !rafId) {
        rafId = requestAnimationFrame(tick);
      }
    };

    const observer = new MutationObserver(() => {
      refreshSprites();
      if (ctrlRef.current.paused) renderFrame(0);
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-appearance', 'style'],
    });

    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
      resize();
      renderFrame(0);
    }) : null;
    ro?.observe(canvas);
    if (!ro) window.addEventListener('resize', resize);

    resize();
    renderFrame(0);
    if (!reducedMotion && !paused) {
      rafId = requestAnimationFrame(tick);
    }

    return () => {
      disposed = true;
      if (rafId) cancelAnimationFrame(rafId);
      observer.disconnect();
      ro?.disconnect();
      if (!ro) window.removeEventListener('resize', resize);
      stageHost.removeEventListener('pointermove', onPointerMove);
      stageHost.removeEventListener('pointerleave', onPointerLeave);
    };
  }, [stageMode]);

  if (stageMode === 'off') return null;
  return <canvas ref={canvasRef} className="spatial-stage-canvas" aria-hidden="true" />;
}
