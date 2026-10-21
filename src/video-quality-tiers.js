const STANDARD_VIDEO_RESOLUTIONS = Object.freeze([
  { width: 1920, height: 1080 },
  { width: 1280, height: 720 },
  { width: 854, height: 480 },
  { width: 640, height: 360 },
]);

export function p2pResolutionScale(track, quality) {
  const source = track?.getSettings?.() || {};
  if (!(source.width > 0 && source.height > 0 && quality.width > 0 && quality.height > 0)) return 1;
  return Math.max(1, source.width / quality.width, source.height / quality.height);
}

function normalizedResolution(resolution, fallback) {
  const width = Math.round(Number(resolution?.width) || 0);
  const height = Math.round(Number(resolution?.height) || 0);
  return width >= 2 && height >= 2 ? { width, height } : fallback;
}

export function buildVideoResolutionTiers(quality) {
  const base = normalizedResolution(quality, { width: 1920, height: 1080 });
  const resolutions = [base];
  for (const resolution of STANDARD_VIDEO_RESOLUTIONS) {
    if (resolution.width >= base.width && resolution.height >= base.height) continue;
    if (resolutions.some(item => item.width === resolution.width && item.height === resolution.height)) continue;
    resolutions.push({ ...resolution });
  }
  return resolutions;
}

