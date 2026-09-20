import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { migratePreferences } = require('../electron/preferences-migration.cjs');

test('legacy capture-engine preferences are removed without touching current settings', () => {
  const original = {
    captureEngine: 'legacy-external',
    screenMode: 'legacy-external',
    engine: 'legacy-external',
    nickname: 'Alice',
    playbackVolume: 0.7,
    shareSettings: {
      engine: 'legacy-external',
      screenMode: 'legacy-external',
      captureMethod: 'legacy',
      encoderPreference: 'hardware',
      rateControl: 'constant',
      targetQuality: 21,
      h264Profile: 'high',
      width: 1920,
      height: 1080,
      fps: 60,
      bitrate: 12000,
      audioMode: 'system',
    },
  };
  const { preferences, changed } = migratePreferences(original);
  assert.equal(changed, true);
  assert.deepEqual(preferences, {
    nickname: 'Alice',
    playbackVolume: 0.7,
    shareSettings: {
      width: 1920,
      height: 1080,
      fps: 60,
      bitrate: 12000,
      audioMode: 'system',
    },
  });
  assert.equal(original.shareSettings.width, 1920);
  assert.equal(original.shareSettings.engine, 'legacy-external');
});

test('current preferences pass migration unchanged', () => {
  const input = { nickname: 'Bob', shareSettings: { width: 1280, height: 720, fps: 30 } };
  const { preferences, changed } = migratePreferences(input);
  assert.equal(changed, false);
  assert.deepEqual(preferences, input);
});
