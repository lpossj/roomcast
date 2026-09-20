import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ObsFixedFpsEngine, REQUIRED_EMBEDDED_OBS_PATHS } = require('../electron/obs-fixed-fps.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roomcast-prepare-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bundle = path.join(root, 'runtime/obs-bundle');
  for (const relative of REQUIRED_EMBEDDED_OBS_PATHS) {
    const file = path.join(bundle, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    if (relative.endsWith('win-capture')) await fs.mkdir(file, { recursive: true });
    else await fs.writeFile(file, 'fixture');
  }
  await fs.writeFile(path.join(bundle, 'roomcast-embedded-obs.json'), JSON.stringify({ version: '32.1.2' }));
  const engine = new ObsFixedFpsEngine({ runtimeRoot: root, dataRoot: path.join(root, 'data'), allowBundleOverride: false });
  engine.bundleCandidates = [bundle];
  return { root, engine };
}

test('failed first OBS copy can be retried without an unrecognized work directory', { skip: process.platform !== 'win32' }, async t => {
  const { engine } = await fixture(t);
  const copy = fs.cp;
  let failed = false;
  t.mock.method(fs, 'cp', async (...args) => {
    if (!failed) { failed = true; throw new Error('simulated interrupted copy'); }
    return copy(...args);
  });
  await assert.rejects(engine.prepare(), /simulated interrupted copy/);
  const result = await engine.prepare();
  assert.equal(result.prepared, true);
  for (const relative of REQUIRED_EMBEDDED_OBS_PATHS) await fs.access(path.join(engine.obsDir, relative));
});

test('OBS repairs a managed cache whose required plugin disappeared', { skip: process.platform !== 'win32' }, async t => {
  const { engine } = await fixture(t);
  await engine.prepare();
  const plugin = path.join(engine.obsDir, 'obs-plugins/64bit/obs-websocket.dll');
  await fs.unlink(plugin);
  assert.equal((await engine.prepare()).copied, true);
  await fs.access(plugin);
});

test('OBS does not overwrite an unknown existing directory', { skip: process.platform !== 'win32' }, async t => {
  const { engine } = await fixture(t);
  await fs.mkdir(engine.obsDir, { recursive: true });
  const file = path.join(engine.obsDir, 'personal.txt');
  await fs.writeFile(file, 'keep');
  await assert.rejects(engine.prepare(), /拒绝覆盖未识别/);
  assert.equal(await fs.readFile(file, 'utf8'), 'keep');
});


test('OBS probe cleanup detaches scene references before removing the input', async () => {
  const engine = new ObsFixedFpsEngine({ rootDir: os.tmpdir() });
  const name = 'Roomcast Probe monitors pending-removal';
  let sceneReference = true;
  let inputExists = true;
  engine.probes.add(name);
  engine.client = { ready: true, request: async type => {
    if (type === 'GetInputList') return { inputs: inputExists ? [{ inputName: name }] : [] };
    if (type === 'GetSceneItemId') return { sceneItemId: 7 };
    if (type === 'RemoveSceneItem') { sceneReference = false; return {}; }
    if (type === 'RemoveInput') { if (!sceneReference) inputExists = false; return {}; }
    throw new Error(type);
  } };
  const cleanup = await engine.cleanupProbeInputs({ timeoutMs: 20, pollMs: 0, settleMs: 0, delayFn: async () => {} });
  assert.deepEqual(cleanup.remaining, []);
  assert.equal(sceneReference, false);
});

test('an input OBS already accepted RemoveInput for never blocks the next enumeration', async () => {
  // Real OBS behavior: obs_source_remove() only marks the source removed.
  // GetInputList keeps listing it until libobs frees the object, which happens
  // on a separate destruction task thread. Enumerating the source list must not
  // treat that lingering name as a live probe.
  const engine = new ObsFixedFpsEngine({ rootDir: os.tmpdir() });
  const ghost = 'Roomcast Probe monitors ghost';
  const liveInputs = new Set([ghost]);
  engine.probes.add(ghost);
  engine.client = {
    ready: true,
    request: async (type, data = {}) => {
      if (type === 'GetInputList') return { inputs: [...liveInputs].map(inputName => ({ inputName })) };
      if (type === 'GetSceneItemId') {
        // The ghost source has no scene item left, so detaching is a no-op and
        // RemoveInput reports 600 (already gone) for it.
        if (String(data.sourceName || '') === ghost) { const error = new Error('not found'); error.code = 600; throw error; }
        return { sceneItemId: 1 };
      }
      if (type === 'RemoveSceneItem') return {};
      if (type === 'RemoveInput') {
        // Simulate OBS/WGC: the very first removal is acknowledged but the
        // source stays enumerable because libobs has not freed it yet.
        if (String(data.inputName || '') !== ghost) liveInputs.delete(String(data.inputName || ''));
        return {};
      }
      if (type === 'CreateInput') { liveInputs.add(String(data.inputName || '')); return {}; }
      if (type === 'GetInputPropertiesListPropertyItems') {
        return { propertyItems: [{
          itemEnabled: true,
          itemName: String(data.propertyName || '') === 'monitor_id' ? 'Display 1' : 'Window 1',
          itemValue: String(data.propertyName || '') === 'monitor_id' ? 'display-1' : 'window-1',
        }] };
      }
      throw new Error(type);
    },
  };

  const sources = await engine.sources();
  assert.deepEqual(sources.monitors, [{ id: 'display-1', name: 'Display 1' }]);
  assert.deepEqual(sources.windows, [{ id: 'window-1', name: 'Window 1' }]);
  assert.equal(engine.probes.has(ghost), false, 'an acknowledged removal must not stay tracked as a live probe');
  assert.equal(engine.probes.size, 0, 'a successful enumeration must not leave any probe tracked');
  // The ghost is still enumerable, so it stays in the acknowledged-removal set
  // and must keep being ignored on every later enumeration.
  assert.equal(liveInputs.has(ghost), true);
  const again = await engine.sources();
  assert.ok(again.monitors.length > 0);
});
