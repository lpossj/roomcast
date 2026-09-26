// `autoCheckUpdates` and `dismissedUpdateVersion` must be listed here as well as in the
// main process `preferenceKeys`, otherwise the startup-check switch and "不再弹出此框"
// would silently fall back to their defaults on every launch.
const allowedKeys = new Set(['shareSettings', 'relaySettings', 'audioDevices', 'playbackVolume', 'nickname', 'server', 'autoCheckUpdates', 'dismissedUpdateVersion']);

export function loadPreference(key, fallback, legacyKey = `roomcast.${key}`) {
  if (!allowedKeys.has(key)) return fallback;
  try {
    const stored = window.roomcast?.getPreference?.(key);
    if (stored !== undefined && stored !== null) return stored;
  } catch {}
  try {
    const legacy = localStorage.getItem(legacyKey);
    if (legacy == null) return fallback;
    const value = typeof fallback === 'string' ? legacy : JSON.parse(legacy);
    savePreference(key, value);
    if (key === 'relaySettings') {
      localStorage.removeItem(legacyKey);
      if (window.roomcast?.desktop) return window.roomcast.getPreference(key) || fallback;
    }
    return value;
  } catch { return fallback; }
}

export function savePreference(key, value) {
  if (!allowedKeys.has(key)) return;
  try { if (window.roomcast?.setPreference?.(key, value)) return; } catch {}
  if (key === 'relaySettings') return;
  // Keep a fallback for browser development and migrate older installations.
  try { localStorage.setItem(`roomcast.${key}`, typeof value === 'string' ? value : JSON.stringify(value)); } catch {}
}
