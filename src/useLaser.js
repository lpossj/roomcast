import { useCallback, useEffect, useMemo, useRef } from 'react';

const COLORS = ['#59e4d4', '#ffab5d', '#cf9cff', '#f16e82', '#ffe16f', '#65a6ff', '#7de078', '#f491d9', '#ffffff', '#6de4ff'];
export function useLaser({ room, selfId, socketRef }) {
  const listeners = useRef(new Set()), latest = useRef(null);
  // Avatar colors can collide; laser colors are unique within the ten-member room.
  const members = useMemo(() => [...(room?.members || [])]
    .sort((a, b) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id))
    .map((m, i) => ({ ...m, color: COLORS[i % COLORS.length] })), [room?.members]);
  latest.current = { room, selfId, members };
  const member = useCallback(id => latest.current?.members.find(m => m.id === id && m.canLaser !== false), []);
  const allowed = useCallback(() => {
    const current = latest.current;
    return Boolean(current?.room?.features?.laser === 1 && current.room.laserEnabled !== false && member(current.selfId));
  }, [member]);
  const notify = useCallback(packet => { for (const listener of listeners.current) listener(packet); }, []);
  const listen = useCallback(listener => { listeners.current.add(listener); return () => listeners.current.delete(listener); }, []);
  const valid = useCallback(packet => {
    const current = latest.current;
    return Boolean(current?.room?.features?.laser === 1 && current.room.laserEnabled !== false && packet
      && current.room.streams.some(s => s.memberId === packet.ownerId && s.startedAt === packet.startedAt)
      && member(packet.from) && Array.isArray(packet.points) && packet.points.length <= 8
      && packet.points.every(p => Array.isArray(p) && p.length === 2 && p.every(n => Number.isInteger(n) && n >= 0 && n <= 10000))
      && (packet.strokeId === undefined || typeof packet.strokeId === 'string' && packet.strokeId.length <= 64)
      && (packet.seq === undefined || Number.isSafeInteger(packet.seq) && packet.seq >= 0));
  }, [member]);
  const socket = socketRef.current;
  useEffect(() => {
    if (!room?.features?.laser || !socket) return undefined;
    const receive = packet => {
      if (!valid(packet)) return;
      notify(packet);
      const current = latest.current;
      if (packet.ownerId === current.selfId && packet.from !== current.selfId) {
        window.roomcast?.desktopLaser?.({ packet, members: current.members.map(({ id, name, color }) => ({ id, name, color })) });
      }
    };
    const disconnected = () => { notify(null); window.roomcast?.desktopLaser?.({ clear: true }); };
    socket.on('laser:stroke', receive); socket.on('disconnect', disconnected);
    return () => {
      socket.off?.('laser:stroke', receive); socket.off?.('disconnect', disconnected);
      disconnected();
    };
  }, [room?.id, room?.features?.laser, socket, valid, notify]);
  const policyKey = JSON.stringify([room?.id, selfId, room?.laserEnabled !== false,
    room?.members.map(m => [m.id, m.canLaser]), room?.streams.map(s => [s.memberId, s.startedAt])]);
  useEffect(() => { notify(null); window.roomcast?.desktopLaser?.({ clear: true }); }, [policyKey, notify]);
  const send = useCallback(packet => {
    const current = latest.current, outgoing = { ...packet, from: current.selfId };
    if (!allowed() || !valid(outgoing)) return;
    notify(outgoing);
    const connection = socketRef.current;
    if (!connection?.connected) return;
    const { from, ...payload } = outgoing;
    if (connection.sendLaser) connection.sendLaser(payload);
    else (connection.volatile || connection).emit('laser:stroke', payload);
  }, [allowed, notify, socketRef, valid]);
  return useMemo(() => ({ listen, send, member, allowed }), [listen, send, member, allowed]);
}
