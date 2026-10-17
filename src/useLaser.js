import { useCallback, useEffect, useRef, useState } from 'react';

export const LASER_COLORS = ['#59e4d4','#ffab5d','#cf9cff','#f16e82','#ffe16f','#65a6ff','#7de078','#f491d9','#ffffff','#6de4ff'];
const idOf = item => item?.memberId || item?.id;
export function useLaser({ room, selfId, socketRef }) {
  const [revision, setRevision] = useState(0);
  const listeners = useRef(new Set());
  const latest = useRef(new Map());
  const timers = useRef(new Map());
  const getPackets = useCallback(ownerId => [...latest.current.values()].filter(p => p.ownerId === ownerId), []);
  const listen = useCallback(listener => { listeners.current.add(listener); return () => listeners.current.delete(listener); }, []);
  useEffect(() => {
    const socket = socketRef.current;
    if (!room?.features?.laser || !socket) return undefined;
    const receive = packet => {
      if (!packet || !room.streams.some(s => s.memberId === packet.ownerId && s.startedAt === packet.startedAt)) return;
      const member = room.members.find(m => m.id === packet.from);
      if (!member || member.canLaser === false || room.laserEnabled === false) return;
      if (!Array.isArray(packet.points)) return;
      latest.current.set(packet.ownerId + ':' + packet.from, { ...packet, at: performance.now() });
      for (const listener of listeners.current) listener(packet);
    };
    socket.on('laser:stroke', receive);
    return () => { socket.off?.('laser:stroke', receive); latest.current.clear(); for (const timer of timers.current.values()) clearTimeout(timer); timers.current.clear(); setRevision(v => v + 1); };
  }, [room?.id, socketRef.current, room?.features?.laser]);
  useEffect(() => { latest.current.clear(); for (const cb of listeners.current) cb(null); setRevision(v => v + 1); }, [room?.laserEnabled, room?.members.map(m => m.id + ':' + m.canLaser).join(','), room?.streams.map(s => s.memberId + ':' + s.startedAt).join(',')]);
  const send = useCallback((ownerId, startedAt, points, done = false) => {
    if (!room?.features?.laser || room.laserEnabled === false || room.members.find(m => m.id === selfId)?.canLaser === false) return;
    const socket = socketRef.current;
    if (!socket?.connected) return;
    socket.emit('laser:stroke', { ownerId, startedAt, points, done }, () => {});
  }, [room, selfId, socketRef]);
  return { listen, send, getPackets, revision };
}
