import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { preferH264High } from '../src/video-codec-policy.js';

test('High preference retains codec objects, baseline-only compatibility and repair codecs', () => {
  const baseline = { mimeType: 'video/H264', sdpFmtpLine: 'profile-level-id=42001f' };
  const high = { mimeType: 'video/H264', sdpFmtpLine: 'packetization-mode=1;profile-level-id=64001f' };
  const vp8 = { mimeType: 'video/VP8' }, repair = { mimeType: 'video/rtx', sdpFmtpLine: 'apt=96' };
  const input = [vp8, baseline, repair, high];
  assert.deepEqual(preferH264High(input), [high, baseline, vp8, repair]);
  assert.deepEqual(input, [vp8, baseline, repair, high]);
  assert.deepEqual(preferH264High([vp8, baseline, repair]), [baseline, vp8, repair]);
  assert.deepEqual(preferH264High([vp8, repair]), [vp8, repair]);
});

test('balanced 1080p60 preset removes the forced beta.5 budget and preserves custom/auto selections', async () => {
  const source = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const settingsCode = source.slice(source.indexOf('const presets = ['), source.indexOf('\nconst params ='));
  const read = saved => vm.runInNewContext(settingsCode + ';({presets, settings:loadShareSettings()});', {
    window: { roomcast: { desktop: true } }, loadPreference: () => saved,
  });
  const legacy = { preset: '1080p60', width: 1920, height: 1080, fps: 60, bitrate: 16000 };
  assert.equal(read(legacy).settings.bitrate, 6500);
  assert.equal(read(legacy).presets.find(item => item.id === '1080p60').bitrate, 6500);
  for (const changed of [{ preset: 'custom' }, { bitrate: 0 }, { bitrate: 6500 }, { bitrate: 12000 }, { fps: 30 }, { width: 1280 }]) {
    const saved = { ...legacy, ...changed };
    assert.equal(read(saved).settings.bitrate, saved.bitrate);
  }
});
