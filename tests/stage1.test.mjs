import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { adaptivePlayoutTarget, MAX_PLAYOUT_BUFFER_MS, MIN_PLAYOUT_BUFFER_MS } from '../src/playout.js';
import { nativeAudioSources } from '../src/lib.js';

const require = createRequire(import.meta.url);
const { AUDIO_SESSION_SCRIPT, normalizeAudioInventory, normalizeCaptureSources, windowsAudioSources } = require('../electron/windows-sources.cjs');

test('Windows audio inventory is based on Core Audio sessions and folds Electron-style process trees by executable', () => {
  assert.match(AUDIO_SESSION_SCRIPT, /IAudioSessionManager2/);
  assert.doesNotMatch(AUDIO_SESSION_SCRIPT, /MainWindowHandle/);
  const rows = normalizeAudioInventory({
    AudioProcessIds: [120, 121, 200, 300],
    Processes: [
      { Id: 100, Name: 'Chrome', Path: 'C:\\Apps\\Chrome\\chrome.exe', Title: 'Chrome', Description: 'Google Chrome' },
      { Id: 120, ParentId: 100, Name: 'Chrome', Path: 'C:\\Apps\\Chrome\\chrome.exe' },
      { Id: 121, ParentId: 100, Name: 'Chrome', Path: 'C:\\Apps\\Chrome\\chrome.exe' },
      { Id: 200, Name: 'MediaMTX', Path: 'C:\\Tools\\mediamtx.exe', Title: 'External relay' },
      { Id: 300, Name: 'Player', Path: 'C:\\Player\\player.exe', Title: 'Song' },
    ],
  });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].processId === '100' || rows[1].processId === '100', true);
  assert.equal(rows.find(item => item.processId === '100').sessionProcessIds.length, 2);
  assert.equal(rows.some(item => /mediamtx/i.test(item.processName)), true);
});

test('native capture source normalization keeps real top-level sources, deduplicates, and excludes Roomcast internals', () => {
  assert.deepEqual(normalizeCaptureSources([
    { id: 'screen:0', name: 'Screen 1' }, { id: 'window:1', name: 'Editor' },
    { id: 'window:1', name: 'Editor duplicate' }, { id: 'window:2', name: '同屏 Roomcast' }, { id: 'window:3', name: 'MediaMTX' },
  ]), [{ id: 'screen:0', name: 'Screen 1', type: 'monitor' }, { id: 'window:1', name: 'Editor', type: 'window' }, { id: 'window:3', name: 'MediaMTX', type: 'window' }]);
});

test('real native audio source conversion preserves process identity for application/exclusion capture', async t => {
  const previous = globalThis.window;
  t.after(() => { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; });
  const raw = { processId: '900', processName: 'chrome.exe', name: 'Chrome', sessionProcessIds: ['10', '11'] };
  globalThis.window = { roomcast: { audioSources: async () => [raw] } };
  const sources = await nativeAudioSources();
  assert.deepEqual(sources, [{ ...raw, id: '900' }]);
  globalThis.window.roomcast.audioSources = async () => { throw new Error('COM failure'); };
  await assert.rejects(nativeAudioSources(), /COM failure/);
});

test('audio grouping follows parents, not PID order or independent executable instances', () => {
  const rows = normalizeAudioInventory({ AudioProcessIds: [10, 11, 20], Processes: [
    { Id: 900, Name: 'Discord', Path: 'C:\\Discord\\Discord.exe' },
    { Id: 10, ParentId: 900, Name: 'Discord', Path: 'C:\\Discord\\Discord.exe' },
    { Id: 11, ParentId: 10, Name: 'helper', Path: 'C:\\Discord\\helper.exe' },
    { Id: 20, Name: 'Discord', Path: 'C:\\Discord\\Discord.exe' },
  ] });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.find(row => row.processId === '900').sessionProcessIds, ['10', '11']);
  assert.deepEqual(rows.find(row => row.processId === '20').sessionProcessIds, ['20']);
});

test('audio enumeration distinguishes empty sessions, command errors and malformed output', async () => {
  const run = (error, stdout, stderr) => windowsAudioSources((_exe, _args, _options, callback) => callback(error, stdout, stderr));
  assert.deepEqual(await run(null, '{"AudioProcessIds":[],"Processes":[]}'), []);
  await assert.rejects(run(new Error('failed'), '', 'Access denied'), /Access denied/);
  await assert.rejects(run(Object.assign(new Error('timeout'), { killed: true }), ''), /超时/);
  await assert.rejects(run(null, 'not json'), /枚举失败/);
});

test('adaptive playout adds bounded shared delay under loss and decays smoothly on recovery', () => {
  const impaired = adaptivePlayoutTarget(MIN_PLAYOUT_BUFFER_MS, { jitterMs: 35, decodeMs: 18, lossRate: 0.08 });
  assert.ok(impaired > 80 && impaired <= MAX_PLAYOUT_BUFFER_MS);
  const recovered = adaptivePlayoutTarget(impaired, { jitterMs: 0, decodeMs: 0, lossRate: 0 });
  assert.ok(recovered < impaired && recovered > MIN_PLAYOUT_BUFFER_MS);
});

test('stage-one UI wiring keeps 50 percent volume, bounded PCM, fullscreen restore, and one room-exit entry', async () => {
  const [player, app, lib, main] = await Promise.all([
    readFile(new URL('../src/ScreenPlayer.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/App.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib.js', import.meta.url), 'utf8'),
    readFile(new URL('../electron/main.cjs', import.meta.url), 'utf8'),
  ]);
  assert.match(player, /FULLSCREEN_UI_HIDE_DELAY = 2000/);
  assert.match(player, /loadPreference\('playbackVolume', 0\.5\)/);
  assert.match(lib, /audioWorklet\.addModule\('\/roomcast-pcm-worklet\.js'\)/);
  assert.doesNotMatch(lib, /createBufferSource\(\)|nextTime/);
  const worklet = await readFile(new URL('../public/roomcast-pcm-worklet.js', import.meta.url), 'utf8');
  assert.match(worklet, /maxQueuedFrames = 12000/);
  assert.match(worklet, /this\.count < this\.startFrames/);
  assert.match(main, /capture\.start\(mode === 'exclude' \? processId : process\.pid, false, onData\)/);
  assert.equal((app.match(/aria-label="离开房间"/g) || []).length, 1);
  assert.doesNotMatch(app, /className="people-section"|className="under-stage"/);
});
