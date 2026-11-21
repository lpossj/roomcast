import { loadPreference } from '../preferences.js';
import { readImageDimensions } from '../image-policy.js';
import { browserCapabilities, normalizeBrowserShareSettings } from '../browser-capabilities.js';

export const APP_VERSION = typeof __ROOMCAST_VERSION__ === 'string' ? __ROOMCAST_VERSION__ : '';
export const MAX_CHAT_IMAGES = 4;
const MAX_SHARED_IMAGE_EDGE = 2000;

export const PREVIEW_SCALE_MIN = 0.55;
export const PREVIEW_SCALE_MAX = 1;
export const PREVIEW_SCALE_STEP = 0.1;
export const LATENCY_POLL_MS = 3000;
export const LATENCY_TIMEOUT_MS = 4000;

export const presets = [
  { id: '1080p30', label: '1080p', detail: '30 FPS · 均衡清晰', width: 1920, height: 1080, fps: 30, bitrate: 4500 },
  { id: '720p30', label: '720p', detail: '30 FPS · 节省带宽', width: 1280, height: 720, fps: 30, bitrate: 2500 },
  { id: '1080p60', label: '1080p', detail: '最高 60 FPS · 高帧流畅', width: 1920, height: 1080, fps: 60, bitrate: 6500 },
];

export const defaultShareSettings = {
  captureBackend: 'obs',
  sourceType: 'monitor',
  sourceId: '',
  preset: '1080p30',
  width: 1920,
  height: 1080,
  fps: 30,
  bitrate: 6500,
  audioMode: 'none',
  audioSourceId: '',
  applicationMuted: false,
  microphoneMuted: false,
  systemAudio: false,
  microphone: false,
  compatibilityCanvas: false,
  performanceMode: 'quality',
  facingMode: 'user',
};

export function loadShareSettings() {
  try {
    const saved = loadPreference('shareSettings', {});
    const legacyAudioMode = saved.systemAudio
      ? (saved.microphone ? 'system-microphone' : 'system')
      : saved.microphone ? 'microphone' : 'none';
    const clean = { ...defaultShareSettings };
    for (const key of Object.keys(defaultShareSettings)) {
      if (Object.hasOwn(saved || {}, key)) clean[key] = saved[key];
    }
    if (
      clean.preset === '1080p60'
      && Number(clean.width) === 1920
      && Number(clean.height) === 1080
      && Number(clean.fps) === 60
      && Number(clean.bitrate) === 16000
    ) {
      clean.bitrate = 6500;
    }
    clean.captureBackend = !window.roomcast?.desktop || clean.captureBackend === 'native' ? 'native' : 'obs';
    clean.sourceType = clean.sourceType === 'window' ? 'window' : 'monitor';
    clean.audioMode = [
      'none', 'system', 'application', 'exclude', 'microphone',
      'system-microphone', 'application-microphone', 'exclude-microphone',
    ].includes(saved.audioMode) ? saved.audioMode : legacyAudioMode;
    clean.performanceMode = 'quality';
    clean.compatibilityCanvas = false;
    return window.roomcast?.desktop
      ? clean
      : normalizeBrowserShareSettings({ ...clean, sourceType: saved.sourceType }, browserCapabilities(window));
  } catch {
    return { ...defaultShareSettings, captureBackend: window.roomcast?.desktop ? 'obs' : 'native' };
  }
}

export const cleanIpcError = error => String(error?.message || '操作失败')
  .replace(/^Error invoking remote method '[^']*':\s*/, '')
  .replace(/^Error:\s*/, '');

export const latencyToneFor = value => {
  if (!Number.isFinite(value)) return 'neutral';
  if (value < 120) return 'good';
  if (value <= 250) return 'warning';
  return 'bad';
};

export const clampPreviewScale = value =>
  Math.min(PREVIEW_SCALE_MAX, Math.max(PREVIEW_SCALE_MIN, Math.round(value * 10) / 10));

export const previewColumnsFor = (count, width) => {
  if (count <= 1 || width < 680) return 1;
  if (count <= 4) return Math.min(2, count);
  if (count <= 9) return width >= 1180 ? 3 : 2;
  if (width >= 1480) return 4;
  return width >= 900 ? 3 : 2;
};

export const previewCardWidthFor = (count, width, scale) => {
  const outerWidth = Number(width) || 0;
  if (!count || outerWidth <= 0) return 0;
  const gap = 14;
  const horizontalPadding = 28;
  const innerWidth = Math.max(0, outerWidth - horizontalPadding);
  if (innerWidth <= 0) return 0;
  const columns = Math.max(1, Math.min(count, previewColumnsFor(count, innerWidth)));
  const baseWidth = Math.max(1, (innerWidth - (gap * (columns - 1))) / columns);
  const minimum = Math.min(260, innerWidth);
  return Math.round(Math.min(innerWidth, Math.max(minimum, baseWidth * clampPreviewScale(scale))));
};

export async function shrinkForSharing(file) {
  if (String(file.type || '').toLowerCase() === 'image/gif') return file;
  if (typeof createImageBitmap !== 'function') return file;
  let declared;
  try {
    declared = readImageDimensions(file.type, new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer()));
  } catch {
    declared = null;
  }
  if (declared && Math.max(declared.width, declared.height) <= MAX_SHARED_IMAGE_EDGE) return file;
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }
  try {
    const longest = Math.max(bitmap.width, bitmap.height);
    if (!longest || longest <= MAX_SHARED_IMAGE_EDGE) return file;
    const scale = MAX_SHARED_IMAGE_EDGE / longest;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) return file;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.9));
    if (!blob || blob.type !== 'image/webp' || blob.size > 10 * 1024 * 1024) return file;
    const stem = String(file.name || 'image').replace(/\.[^.]+$/, '') || 'image';
    return new File([blob], `${stem}.webp`, { type: 'image/webp', lastModified: file.lastModified || Date.now() });
  } finally {
    bitmap.close?.();
  }
}
