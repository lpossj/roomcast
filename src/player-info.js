// Display existing measurements only; never change capture or transport settings.
export function playerInfo(metrics = {}) {
  const positive = value => Number.isFinite(value) && value > 0;
  const rawRoute = String(metrics.route || '').toUpperCase();
  return {
    resolution: positive(metrics.width) && positive(metrics.height) ? `${metrics.width}×${metrics.height}` : '—',
    fps: positive(metrics.fps) ? `${Math.round(metrics.fps)} FPS` : '— FPS',
    bitrate: positive(metrics.bitrate) ? `${metrics.bitrate.toFixed(0)} Kbps` : '— Kbps',
    route: metrics.source === 'capture' ? '—' : rawRoute.startsWith('TURN') ? 'TURN' : rawRoute.startsWith('VDO') ? 'VDO' : rawRoute.startsWith('P2P') ? 'P2P' : '—',
  };
}
