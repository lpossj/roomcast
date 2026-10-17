// Shared by the player, floating player and the capture-excluded desktop window.
// Only live trails schedule frames; an idle surface releases its backing bitmap.
export const LASER_LIFETIME_MS = 1250;
export function createLaserCanvas(canvas, { getBounds, getMember, onIdle } = {}) {
  const view = canvas.ownerDocument.defaultView;
  const ctx = canvas.getContext('2d');
  const trails = new Map();
  let frame = 0, destroyed = false;
  const erase = () => { canvas.width = 1; canvas.height = 1; };
  const clear = () => {
    if (frame) view.cancelAnimationFrame(frame);
    frame = 0;
    trails.clear();
    erase();
  };
  const paint = () => {
    frame = 0;
    if (destroyed || !ctx) return;
    const now = performance.now();
    for (const [key, trail] of trails) {
      trail.points = trail.points.filter(p => now - p.at < LASER_LIFETIME_MS);
      if (!trail.points.length || !getMember(trail.from)) trails.delete(key);
    }
    if (!trails.size) { erase(); onIdle?.(); return; }
    const box = canvas.getBoundingClientRect(), bounds = getBounds();
    if (box.width > 0 && box.height > 0 && bounds?.width > 0 && bounds?.height > 0) {
      // Bound even a high-DPI/4K surface to four million pixels.
      const dpr = Math.min(view.devicePixelRatio || 1, 1.5, Math.sqrt(4_000_000 / (box.width * box.height)));
      const w = Math.max(1, Math.round(box.width * dpr)), h = Math.max(1, Math.round(box.height * dpr));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, box.width, box.height);
      ctx.save();
      ctx.beginPath(); ctx.rect(bounds.left, bounds.top, bounds.width, bounds.height); ctx.clip();
      ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = 2.5;
      const heads = new Map();
      const position = p => ({ x: bounds.left + p.x * bounds.width, y: bounds.top + p.y * bounds.height });
      for (const trail of trails.values()) {
        const member = getMember(trail.from);
        if (!member) continue;
        ctx.strokeStyle = member.color; ctx.fillStyle = member.color;
        for (let i = 1; i < trail.points.length; i += 1) {
          const before = position(trail.points[i - 1]), point = position(trail.points[i]);
          const previous = position(trail.points[Math.max(0, i - 2)]);
          ctx.globalAlpha = Math.max(0, 1 - (now - trail.points[i - 1].at) / LASER_LIFETIME_MS);
          ctx.beginPath();
          ctx.moveTo(i === 1 ? before.x : (previous.x + before.x) / 2, i === 1 ? before.y : (previous.y + before.y) / 2);
          ctx.quadraticCurveTo(before.x, before.y, (before.x + point.x) / 2, (before.y + point.y) / 2);
          ctx.stroke();
          if (i === trail.points.length - 1) {
            ctx.beginPath(); ctx.moveTo((before.x + point.x) / 2, (before.y + point.y) / 2); ctx.lineTo(point.x, point.y); ctx.stroke();
          }
        }
        const last = trail.points.at(-1), head = position(last);
        ctx.globalAlpha = Math.max(0, 1 - (now - last.at) / LASER_LIFETIME_MS);
        ctx.beginPath(); ctx.arc(head.x, head.y, 4, 0, Math.PI * 2); ctx.fill();
        if (!heads.has(trail.from) || heads.get(trail.from).at < last.at) heads.set(trail.from, { ...head, at: last.at, member });
      }
      const labels = [];
      ctx.font = '11px "Segoe UI", "Microsoft YaHei", sans-serif'; ctx.textBaseline = 'middle';
      for (const { x, y, at, member } of heads.values()) {
        if (now - at > 750) continue;
        const name = [...String(member.name || '访客')].slice(0, 12).join('');
        const width = Math.min(ctx.measureText(name).width + 12, bounds.width), height = 18;
        const left = Math.max(bounds.left, Math.min(x + 10, bounds.left + bounds.width - width));
        let top = Math.max(bounds.top, Math.min(y - 24, bounds.top + bounds.height - height));
        for (let tries = 0; tries < 10 && labels.some(b => left < b.left + b.width && left + width > b.left && top < b.top + height && top + height > b.top); tries += 1) {
          top = top + height + 2 <= bounds.top + bounds.height - height ? top + height + 2 : Math.max(bounds.top, y - 24 - (tries + 1) * (height + 2));
        }
        if (labels.some(b => left < b.left + b.width && left + width > b.left && top < b.top + height && top + height > b.top)) continue;
        labels.push({ left, top, width });
        ctx.globalAlpha = Math.min(1, (750 - (now - at)) / 200);
        ctx.fillStyle = 'rgba(8,16,22,.78)'; ctx.fillRect(left, top, width, height);
        ctx.fillStyle = member.color; ctx.fillText(name, left + 6, top + height / 2, Math.max(1, width - 12));
      }
      ctx.restore(); ctx.globalAlpha = 1;
    }
    frame = view.requestAnimationFrame(paint);
  };
  const receive = packet => {
    if (destroyed || !packet || !Array.isArray(packet.points) || !getMember(packet.from)) return;
    const key = `${packet.from}:${packet.strokeId || 'legacy'}`;
    let trail = trails.get(key);
    if (trail && Number.isSafeInteger(packet.seq) && packet.seq <= trail.seq) return;
    if (!packet.points.length) return;
    if (!trail) {
      if (trails.size >= 64) trails.delete(trails.keys().next().value);
      trail = { from: packet.from, seq: -1, points: [] };
      trails.set(key, trail);
    }
    const now = performance.now();
    // A late/reconnected packet starts a new segment instead of bridging an old trail.
    if (now - (trail.points.at(-1)?.at || 0) > 250) trail.points = [];
    trail.seq = packet.seq ?? trail.seq + 1;
    for (const point of packet.points) {
      if (!Array.isArray(point) || point.length !== 2 || !point.every(n => Number.isInteger(n) && n >= 0 && n <= 10000)) continue;
      const last = trail.points.at(-1);
      const x = point[0] / 10000, y = point[1] / 10000;
      if (last?.x === x && last?.y === y) { last.at = now; continue; }
      trail.points.push({ x, y, at: now });
    }
    trail.points = trail.points.slice(-256);
    if (!frame) frame = view.requestAnimationFrame(paint);
  };
  erase();
  return { receive, clear, destroy() { destroyed = true; clear(); } };
}
