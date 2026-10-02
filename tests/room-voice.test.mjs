import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanAvatar, MAX_AVATAR_LENGTH } from '../server/avatar-policy.mjs';
import { createSpeakingDetector, preferVoicePlayout, monitorMicrophone, normalizeVoiceSettings, RoomVoice } from '../src/room-voice.js';

test('avatars accept bounded inline raster data and reject remote/SVG/oversized content', () => {
  assert.equal(cleanAvatar(), '');
  assert.equal(cleanAvatar('data:image/jpeg;base64,/9j/'), 'data:image/jpeg;base64,/9j/');
  for (const bad of ['https://example.com/avatar.jpg', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,<>', 4,
    `data:image/png;base64,${'A'.repeat(MAX_AVATAR_LENGTH)}`]) assert.throws(() => cleanAvatar(bad));
});

test('voice starts muted with 50 percent gains, and only explicit defaults are enabled', () => {
  assert.deepEqual(normalizeVoiceSettings(), { microphoneVolume: 0.5, outputVolume: 0.5, defaultMicrophone: false, defaultOutput: false });
  assert.deepEqual(normalizeVoiceSettings({ microphoneVolume: 2, outputVolume: -1, defaultMicrophone: 'true', defaultOutput: true }),
    { microphoneVolume: 1, outputVolume: 0, defaultMicrophone: false, defaultOutput: true });
  assert.equal(normalizeVoiceSettings(null).outputVolume, 0.5);
});

test('speaking ring ignores silence, holds between syllables, and ends after 400 ms', () => {
  const detect = createSpeakingDetector();
  assert.equal(detect(new Float32Array(32), 0).speaking, false);
  assert.equal(detect(new Float32Array(32).fill(0.03), 100).speaking, true);
  assert.equal(detect(new Float32Array(32), 450).speaking, true);
  assert.equal(detect(new Float32Array(32), 501).speaking, false);
  assert.equal(detect(new Float32Array(32).fill(0.002), 600).speaking, false);
});

test('member listening gains stay independent of other members, screen volume, and master mute', () => {
  const voice = new RoomVoice({ socket: { on() {} }, selfId: 'self', onError: assert.fail });
  const first = { memberId: 'first', audio: { play: async () => {} } }, second = { memberId: 'second', audio: { play: async () => {} } };
  const screen = { volume: 0.37 };
  voice.connections.set('first', first); voice.connections.set('second', second);
  voice.setOutput({ enabled: true, volume: 0.5 });
  voice.setMemberVolumes({ first: 0.2 });
  assert.equal(first.audio.volume, 0.1); assert.equal(second.audio.volume, 0.5); assert.equal(screen.volume, 0.37);
  voice.setOutput({ enabled: false, volume: 0.23 });
  assert.equal(first.audio.muted, true); assert.equal(second.audio.muted, true);
  assert.equal(first.audio.volume, 0.23 * 0.2); assert.equal(second.audio.volume, 0.23);
  const replacement = { memberId: 'first', audio: { play: async () => {} } };
  voice.applyOutput(replacement); assert.equal(replacement.audio.volume, 0.23 * 0.2);
});

test('local microphone monitor follows sink, detaches on stop and never owns capture tracks', async t => {
  let plays = 0, pauses = 0, stoppedTracks = 0, sink;
  const audio = { setSinkId: async id => { sink = id; }, play: async () => { plays++; }, pause() { pauses++; } };
  const previous = globalThis.document;
  globalThis.document = { createElement: () => audio };
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  const stream = { getTracks: () => [{ stop: () => stoppedTracks++ }] };
  const stop = monitorMicrophone(stream, 'headphones', assert.fail);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sink, 'headphones'); assert.equal(plays, 1); assert.equal(audio.srcObject, stream);
  assert.equal(audio.muted, false); assert.equal(audio.volume, 1);
  stop(); assert.equal(audio.srcObject, null); assert.equal(audio.muted, true); assert.equal(pauses, 1); assert.equal(stoppedTracks, 0);
  let release;
  audio.setSinkId = () => new Promise(resolve => { release = resolve; });
  const stopPending = monitorMicrophone(stream, '', assert.fail); stopPending(); release();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(plays, 1);
});

test('voice playout uses millisecond targets, legacy seconds and safe unsupported fallback', () => {
  const modern = { jitterBufferTarget: null, playoutDelayHint: null };
  preferVoicePlayout(modern); assert.equal(modern.jitterBufferTarget, 20); assert.equal(modern.playoutDelayHint, null);
  const legacy = { playoutDelayHint: null }; preferVoicePlayout(legacy); assert.equal(legacy.playoutDelayHint, 0.02);
  const unsupported = {}; preferVoicePlayout(unsupported); assert.deepEqual(unsupported, {});
  assert.doesNotThrow(() => preferVoicePlayout({ set jitterBufferTarget(value) { throw new Error('read only'); } }));
});

test('direct ear return follows the chosen sink, detaches only its graph and cancels pending start', async () => {
  let sink, resumes = 0, disconnects = 0, captureDisconnects = 0;
  const monitor = { gain: { value: 0 }, connect() {}, disconnect() { disconnects++; } };
  const context = { destination: {}, createGain: () => monitor, setSinkId: async id => { sink = id; }, resume: async () => { resumes++; } };
  const node = { connect(target) { assert.equal(target, monitor); }, disconnect(target) { assert.equal(target, monitor); captureDisconnects++; } };
  const stop = monitorMicrophone({}, 'headphones', assert.fail, { context, node });
  assert.equal(monitor.gain.value, 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sink, 'headphones'); assert.equal(resumes, 1); assert.equal(monitor.gain.value, 1);
  stop(); assert.equal(monitor.gain.value, 0); assert.equal(disconnects, 1); assert.equal(captureDisconnects, 1);
  let release; context.setSinkId = () => new Promise(resolve => { release = resolve; });
  const cancel = monitorMicrophone({}, '', assert.fail, { context, node }); cancel(); release();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(resumes, 1); assert.equal(monitor.gain.value, 0);
});
