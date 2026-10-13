const STANDARD_VIDEO_RESOLUTIONS = Object.freeze([
  { width: 1920, height: 1080 },
  { width: 1280, height: 720 },
  { width: 854, height: 480 },
  { width: 640, height: 360 },
]);

function normalizedResolution(resolution, fallback) {
  const width = Math.round(Number(resolution?.width) || 0);
  const height = Math.round(Number(resolution?.height) || 0);
  return width >= 2 && height >= 2 ? { width, height } : fallback;
}

export function buildP2pVideoTiers(quality, targetFps) {
  const base = normalizedResolution(quality, { width: 1920, height: 1080 });
  const resolutions = [base];
  for (const resolution of STANDARD_VIDEO_RESOLUTIONS) {
    if (resolution.width >= base.width && resolution.height >= base.height) continue;
    if (resolutions.some(item => item.width === resolution.width && item.height === resolution.height)) continue;
    resolutions.push({ ...resolution });
  }
  const reducedFps = Math.min(30, targetFps);
  const tiers = [];
  for (const resolution of resolutions) {
    tiers.push({ ...resolution, fps: targetFps });
    if (reducedFps < targetFps) tiers.push({ ...resolution, fps: reducedFps });
  }
  return tiers;
}

