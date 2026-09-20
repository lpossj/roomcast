const allowedKeys = new Set(['shareSettings', 'relaySettings', 'audioDevices', 'playbackVolume', 'nickname', 'server']);

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
