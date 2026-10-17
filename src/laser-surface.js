import { createLaserCanvas } from '../electron/laser-canvas.mjs';

export function videoBounds(video, surface) {
  if (!video?.videoWidth || !video.videoHeight) return null;
  const box = video.getBoundingClientRect(), outer = surface.getBoundingClientRect();
  const scale = Math.min(box.width / video.videoWidth, box.height / video.videoHeight);
  const width = video.videoWidth * scale, height = video.videoHeight * scale;
  return { left: box.left - outer.left + (box.width - width) / 2, top: box.top - outer.top + (box.height - height) / 2, width, height };
}

// The popup shares only the DOM adapter. It never creates a media connection.
export function attachLaserSurface({ canvas, surface, video, laser, stream, selfId, active = false, onExit }) {
  const view = surface.ownerDocument.defaultView;
  const painter = createLaserCanvas(canvas, { getBounds: () => videoBounds(video, surface), getMember: laser.member });
  let enabled = active, pointer = null, strokeId = '', seq = 0, pending = [], done = false, timer = null, sentAt = -Infinity;
  let sendStrokeId = '', sendSeq = 0;
  const unsubscribe = laser.listen(packet => {
    if (!packet) { cancel(); painter.clear(); return; }
    if (packet.ownerId === stream.memberId && packet.startedAt === stream.startedAt) painter.receive(packet);
  });
  const packet = (points, finish, id = strokeId, sequence = seq) => ({ ownerId: stream.memberId, startedAt: stream.startedAt, from: selfId, strokeId: id, seq: sequence, points, done: finish });
  function flush() {
    timer = null;
    if (!pending.length && !done) return;
    if (!laser.allowed()) { cancel(); return; }
    laser.send(packet(pending, done, sendStrokeId, sendSeq));
    sentAt = performance.now(); pending = []; done = false;
  }
  function schedule() {
    if (timer !== null) return;
    const delay = Math.max(0, 50 - (performance.now() - sentAt));
    // A room-wide per-surface budget also bounds rapid repeated clicks.
    if (!delay) flush(); else timer = view.setTimeout(flush, delay);
  }
  function release() {
    const captured = pointer; pointer = null;
    if (captured !== null) { try { surface.releasePointerCapture(captured); } catch { /* Already released. */ } }
  }
  function cancel() {
    release();
    if (timer !== null) view.clearTimeout(timer);
    timer = null; pending = []; done = false;
  }
  function sample(event) {
    const bounds = videoBounds(video, surface), box = surface.getBoundingClientRect();
    if (!bounds?.width || !bounds.height) return false;
    const x = event.clientX - box.left - bounds.left, y = event.clientY - box.top - bounds.top;
    if (x < 0 || y < 0 || x > bounds.width || y > bounds.height) return false;
    const point = [Math.round(x / bounds.width * 10000), Math.round(y / bounds.height * 10000)];
    seq += 1;
    painter.receive(packet([point], false));
    if (sendStrokeId !== strokeId) { pending = []; done = false; sendStrokeId = strokeId; }
    sendSeq = seq;
    if (pending.length < 8) pending.push(point); else pending[7] = point;
    schedule();
    return true;
  }
  const down = event => {
    if (!enabled || !laser.allowed() || pointer !== null || event.button !== 0) return;
    strokeId = crypto.randomUUID(); seq = 0;
    if (!sample(event)) return;
    pointer = event.pointerId; surface.setPointerCapture(pointer); event.preventDefault();
  };
  const move = event => {
    if (event.pointerId !== pointer) return;
    if (!enabled || !laser.allowed()) { cancel(); return; }
    sample(event);
  };
  const up = event => {
    if (event.pointerId !== pointer) return;
    if (event.type === 'pointerup') sample(event);
    release(); done = true; sendStrokeId = strokeId; sendSeq = ++seq; schedule();
  };
  const key = event => { if (event.key === 'Escape' && enabled) { cancel(); onExit?.(); } };
  const blur = () => { if (pointer !== null) { release(); done = true; sendSeq = ++seq; schedule(); } };
  const setActive = value => { enabled = value === true; surface.classList.toggle('laser-drawing', enabled); if (!enabled) cancel(); };
  surface.addEventListener('pointerdown', down); surface.addEventListener('pointermove', move);
  surface.addEventListener('pointerup', up); surface.addEventListener('pointercancel', up);
  surface.addEventListener('lostpointercapture', blur);
  view.addEventListener('blur', blur); view.addEventListener('keydown', key);
  setActive(active);
  return {
    setActive,
    destroy() {
      cancel(); unsubscribe(); painter.destroy(); surface.classList.remove('laser-drawing');
      surface.removeEventListener('pointerdown', down); surface.removeEventListener('pointermove', move);
      surface.removeEventListener('pointerup', up); surface.removeEventListener('pointercancel', up);
      surface.removeEventListener('lostpointercapture', blur);
      view.removeEventListener('blur', blur); view.removeEventListener('keydown', key);
    },
  };
}
