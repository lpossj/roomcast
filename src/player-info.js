function routeLabel(route) {
  if (/^原生直连(?: · (?:TCP|UDP))?$/.test(route)) return route;
  if (route === 'EasyTier虚拟网') return route;
  return ['TURN', 'VDO', 'P2P'].find(label => route.toUpperCase().startsWith(label));
}

export function playerInfo(metrics = {}) {
  const positive = value => Number.isFinite(value) && value > 0;
  const routes = String(metrics.route || '').split(' / ').map(routeLabel).filter(Boolean);
  return {
    resolution: positive(metrics.width) && positive(metrics.height) ? `${metrics.width}×${metrics.height}` : '—',
    fps: positive(metrics.fps) ? `${Math.round(metrics.fps)} FPS` : '— FPS',
    bitrate: positive(metrics.bitrate) ? `${metrics.bitrate.toFixed(0)} Kbps` : '— Kbps',
    route: metrics.source === 'capture' ? '—' : [...new Set(routes)].join(' / ') || '—',
  };
}
