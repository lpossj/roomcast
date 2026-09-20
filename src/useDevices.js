import { useCallback, useEffect, useState } from 'react';
import { loadPreference, savePreference } from './preferences.js';

const storageKey = 'roomcast.audioDevices';
function loadPreferences() {
  try { return { inputId: '', outputId: '', ...loadPreference('audioDevices', {}, storageKey) }; }
  catch { return { inputId: '', outputId: '' }; }
}

export default function useDevices() {
  const [preferences, setPreferencesState] = useState(loadPreferences);
  const [devices, setDevices] = useState({ inputs: [], outputs: [] });
  const refresh = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const list = await navigator.mediaDevices.enumerateDevices();
    const named = (items, prefix) => items.map((item, index) => ({ id: item.deviceId, label: item.label || `${prefix} ${index + 1}` }));
    setDevices({
      inputs: named(list.filter(item => item.kind === 'audioinput'), '麦克风'),
      outputs: named(list.filter(item => item.kind === 'audiooutput'), '扬声器'),
    });
  }, []);
  const setPreferences = useCallback(next => {
    setPreferencesState(current => {
      const value = typeof next === 'function' ? next(current) : next;
      savePreference('audioDevices', value);
      return value;
    });
  }, []);
  useEffect(() => {
    refresh().catch(() => {});
    const changed = () => refresh().catch(() => {});
    navigator.mediaDevices?.addEventListener?.('devicechange', changed);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', changed);
  }, [refresh]);
  return { devices, preferences, setPreferences, refresh };
}
