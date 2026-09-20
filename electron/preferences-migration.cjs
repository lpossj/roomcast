const DEPRECATED_TOP_LEVEL_KEYS = ['captureEngine', 'screenMode', 'engine'];
const DEPRECATED_SHARE_KEYS = ['engine', 'screenMode', 'captureMethod', 'encoderPreference', 'rateControl', 'targetQuality', 'h264Profile'];

function migratePreferences(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const preferences = { ...source };
  let changed = false;

  for (const key of DEPRECATED_TOP_LEVEL_KEYS) {
    if (Object.hasOwn(preferences, key)) {
      delete preferences[key];
      changed = true;
    }
  }

  if (preferences.shareSettings && typeof preferences.shareSettings === 'object' && !Array.isArray(preferences.shareSettings)) {
    const shareSettings = { ...preferences.shareSettings };
    for (const key of DEPRECATED_SHARE_KEYS) {
      if (Object.hasOwn(shareSettings, key)) {
        delete shareSettings[key];
        changed = true;
      }
    }
    preferences.shareSettings = shareSettings;
  }

  return { preferences, changed };
}

module.exports = { migratePreferences };
