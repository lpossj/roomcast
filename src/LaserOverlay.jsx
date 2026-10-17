import { useEffect, useRef, useState } from 'react';
import { LASER_COLORS } from './useLaser.js';

const LIVE_MS = 1250;
const LABEL_MS = 750;
const rectFor = video => {
  if (!video) return null;
  const box = video.getBoundingClientRect();
  const w = video.videoWidth || 1920, h = video.videoHeight || 1080;
  const scale = Math.min(box.width / w, box.height / h);
  const width = w * scale, height = h * scale;
  return { left: (box.width - width) / 2, top: (box.height - height) / 2, width, height };
};
export default function LaserOverlay({ laser, room, stream, selfId, videoRef, active, onActiveChange, floating = false }) {
  const canvasRef = useRef(null);
  const stageRef = useRef(null);
  const strokes = useRef(new Map());
  const pending = useRef([]);
  const sendClock = useRef(0);
  const dragging = useRef(false);
  const raf = useRef(0);
  const [canDraw, setCanDraw] = useState(false);
  const enabled = Boolean(room?.features?.laser && room?.laserEnabled !== false && room?.members.find(m => m.id === selfId)?.canLaser !== false);
  const drawEnabled = enabled && active && !floating;
  useEffect(() => {
    setCanDraw(drawEnabled);
    if (!drawEnabled) { pending.current = []; dragging.current = false; }
  }, [drawEnabled]);
  useEffect(() => {
    if (!laser || !room || !stream) return undefined;
    const listener = packet => {
      if (!packet) { strokes.current.clear(); return; }
      if (packet.ownerId !== stream.memberId || packet.startedAt !== stream.startedAt) return;
      const key = packet.from;
      const existing = strokes.current.get(key) || { points: [] };
      const now = performance.now();
      const points = packet.points.map(p => ({ x:p[0] / 10000, y:p[1] / 10000, at:now }));
      existing.points.push(...points);
      existing.at = now; existing.done = packet.done;
      strokes.current.set(key, existing);
    };
    return laser.listen(listener);
  }, [laser?.listen, room?.id, stream?.memberId, stream?.startedAt]);
  useEffect(() => {
    const stage = stageRef.current, canvas = canvasRef.current;
    if (!stage || !canvas || !room?.features?.laser || floating) return undefined;
    let stopped = false;
    const paint = () => {
      if (stopped) return;
      const video = videoRef.current;
      const bounds = rectFor(video), ctx = canvas.getContext('2d');
      if (!bounds || !ctx) { raf.current = requestAnimationFrame(paint); return; }
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const width = Math.round(stage.clientWidth * dpr), height = Math.round(stage.clientHeight * dpr);
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      ctx.clearRect(0,0,width,height);
      const now = performance.now();
      if (room.laserEnabled !== false) for (const [id, entry] of strokes.current) {
        const member = room.members.find(m => m.id === id);
        if (!member || member.canLaser === false) { strokes.current.delete(id); continue; }
        entry.points = entry.points.filter(p => now - p.at < LIVE_MS);
        if (!entry.points.length) { strokes.current.delete(id); continue; }
        const color = LASER_COLORS[member.avatarColor % LASER_COLORS.length] || LASER_COLORS[0];
        ctx.strokeStyle = color; ctx.lineWidth = 3 * dpr; ctx.lineJoin='round'; ctx.lineCap='round';
        ctx.beginPath();
        entry.points.forEach((p,i) => {
          const x=(bounds.left+p.x*bounds.width)*dpr, y=(bounds.top+p.y*bounds.height)*dpr;
          if(i===0)ctx.moveTo(x,y); else ctx.lineTo(x,y);
        }); ctx.stroke();
        const last = entry.points.at(-1), x=(bounds.left+last.x*bounds.width)*dpr, y=(bounds.top+last.y*bounds.height)*dpr;
        ctx.beginPath(); ctx.fillStyle = color; ctx.arc(x,y,5*dpr,0,Math.PI*2); ctx.fill();
        if (now-entry.at < LABEL_MS) {
          const name = String(member.name||'访客').slice(0,12);
          ctx.font = `${11*dpr}px sans-serif`;
          const boxW=ctx.measureText(name).width+15*dpr, bx=Math.min(x+12*dpr,width-boxW-3*dpr), by=Math.max(20*dpr,y-10*dpr);
          ctx.fillStyle='rgba(8,16,22,.8)';ctx.fillRect(bx,by-15*dpr,boxW,19*dpr);
          ctx.fillStyle=color;ctx.fillText(name,bx+7*dpr,by);
        }
      }
      raf.current = requestAnimationFrame(paint);
    };
    raf.current = requestAnimationFrame(paint);
    return () => { stopped = true; cancelAnimationFrame(raf.current); strokes.current.clear(); };
  }, [room?.id, room?.laserEnabled, room?.members, room?.features?.laser, stream?.startedAt, floating]);
  const coords = event => {
    const stage=stageRef.current, b=rectFor(videoRef.current);
    if(!stage||!b)return null;
    const area=stage.getBoundingClientRect(), x=event.clientX-area.left-b.left, y=event.clientY-area.top-b.top;
    if(x<0||y<0||x>b.width||y>b.height)return null;
    return [Math.max(0,Math.min(10000,Math.round(x/b.width*10000))),Math.max(0,Math.min(10000,Math.round(y/b.height*10000)))];
  };
  const flush = done => {
    if (!pending.current.length && !done)return;
    const points=pending.current.splice(0,8);
    laser?.send(stream.memberId,stream.startedAt,points,done);
    if (points.length) for(const listenerPacket of [{ownerId:stream.memberId,startedAt:stream.startedAt,from:selfId,points,done}]) {
      const e=strokes.current.get(selfId)||{points:[]};const now=performance.now();
      e.points.push(...listenerPacket.points.map(p=>({x:p[0]/10000,y:p[1]/10000,at:now})));e.at=now;strokes.current.set(selfId,e);
    }
  };
  const move=e=>{
    if(!dragging.current)return;
    const p=coords(e);
    if(!p)return;
    pending.current.push(p);
    if(pending.current.length>=8||performance.now()-sendClock.current>120){flush(false);sendClock.current=performance.now();}
  };
  const up=e=>{if(!dragging.current)return;dragging.current=false;flush(true);try{e.currentTarget.releasePointerCapture(e.pointerId);}catch{}};
  return <div ref={stageRef} className={'laser-layer'+(canDraw?' laser-drawing':'')} onPointerDown={e=>{if(!canDraw||e.button!==0)return;dragging.current=true;e.currentTarget.setPointerCapture(e.pointerId);move(e);}} onPointerMove={move} onPointerUp={up} onPointerCancel={up}><canvas ref={canvasRef} /></div>;
}
