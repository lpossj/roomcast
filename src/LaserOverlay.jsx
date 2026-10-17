import { useEffect, useRef } from 'react';
import { attachLaserSurface } from './laser-surface.js';

export default function LaserOverlay({ laser, stream, selfId, videoRef, active, onActiveChange }) {
  const canvasRef = useRef(null), stageRef = useRef(null), binding = useRef(null);
  const exit = useRef(onActiveChange); exit.current = onActiveChange;
  useEffect(() => {
    if (!laser || !videoRef.current) return undefined;
    const surface = attachLaserSurface({ canvas: canvasRef.current, surface: stageRef.current, video: videoRef.current, laser, stream, selfId, active, onExit: () => exit.current?.(false) });
    binding.current = surface;
    return () => { binding.current = null; surface.destroy(); };
  }, [laser, stream.memberId, stream.startedAt, selfId, videoRef]);
  useEffect(() => { binding.current?.setActive(active); }, [active]);
  return <div ref={stageRef} className="laser-layer"><canvas ref={canvasRef} /></div>;
}
