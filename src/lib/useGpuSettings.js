import { useCallback, useEffect, useState } from 'react';
import { loadPreference, savePreference } from '../preferences.js';

const DEFAULT_GPU_SETTINGS = {
  stageMode: 'high', // 'high' | 'off'
  lowPowerBackground: true,
};

function normalizeGpuSettings(raw) {
  const stageMode = raw?.stageMode === 'off' ? 'off' : 'high';
  const lowPowerBackground = raw?.lowPowerBackground !== false;
  return { stageMode, lowPowerBackground };
}

export function useGpuSettings() {
  const [settings, setSettingsState] = useState(() => normalizeGpuSettings(loadPreference('gpuSettings', DEFAULT_GPU_SETTINGS)));
  const [hwAccel, setHwAccel] = useState({
    hardwareAcceleration: true,
    activeHardwareAcceleration: true,
  });
  const [windowActivity, setWindowActivity] = useState(() => ({
    visible: typeof document !== 'undefined' ? !document.hidden : true,
    focused: typeof document !== 'undefined' ? (!document.hidden && (typeof document.hasFocus !== 'function' || document.hasFocus())) : true,
  }));

  useEffect(() => {
    let cancelled = false;
    window.roomcast?.getGpuConfig?.()
      .then(result => {
        if (!cancelled && result && typeof result === 'object') {
          setHwAccel({
            hardwareAcceleration: result.hardwareAcceleration !== false,
            activeHardwareAcceleration: result.activeHardwareAcceleration !== false,
          });
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const syncFromDom = () => {
      const visible = !document.hidden;
      const focused = visible && (typeof document.hasFocus !== 'function' || document.hasFocus());
      setWindowActivity(current => (current.visible === visible && current.focused === focused ? current : { visible, focused }));
    };
    document.addEventListener('visibilitychange', syncFromDom);
    window.addEventListener('focus', syncFromDom);
    window.addEventListener('blur', syncFromDom);
    const unsubscribe = window.roomcast?.onWindowActivity?.(state => {
      if (!state || typeof state !== 'object') return;
      const visible = state.visible !== false && !document.hidden;
      const focused = visible && state.focused !== false;
      setWindowActivity({ visible, focused });
    });
    return () => {
      document.removeEventListener('visibilitychange', syncFromDom);
      window.removeEventListener('focus', syncFromDom);
      window.removeEventListener('blur', syncFromDom);
      unsubscribe?.();
    };
  }, []);

  const isForegroundActive = windowActivity.visible;

  useEffect(() => {
    document.documentElement.dataset.gpuStage = settings.stageMode;
    document.documentElement.dataset.windowActive = (settings.lowPowerBackground && !isForegroundActive) ? 'false' : 'true';
  }, [settings.stageMode, settings.lowPowerBackground, isForegroundActive]);

  const updateSettings = useCallback(patch => {
    setSettingsState(current => {
      const next = normalizeGpuSettings({ ...current, ...(typeof patch === 'function' ? patch(current) : patch) });
      savePreference('gpuSettings', next);
      return next;
    });
  }, []);

  const setHardwareAcceleration = useCallback(async enabled => {
    if (!window.roomcast?.setHardwareAcceleration) return null;
    const next = await window.roomcast.setHardwareAcceleration(enabled !== false);
    if (next && typeof next === 'object') {
      setHwAccel({
        hardwareAcceleration: next.hardwareAcceleration !== false,
        activeHardwareAcceleration: next.activeHardwareAcceleration !== false,
      });
    }
    return next;
  }, []);

  const relaunchApp = useCallback(() => window.roomcast?.relaunchApp?.(), []);

  return {
    settings,
    updateSettings,
    hwAccel,
    setHardwareAcceleration,
    relaunchApp,
    windowActivity,
    isForegroundActive,
    needsRestartForHwAccel: Boolean(window.roomcast?.desktop) && hwAccel.hardwareAcceleration !== hwAccel.activeHardwareAcceleration,
  };
}
