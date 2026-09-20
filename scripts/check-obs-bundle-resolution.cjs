const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  ObsFixedFpsEngine,
  EMBEDDED_OBS_VERSION,
  embeddedObsBundleCandidates,
  inspectEmbeddedObsBundle,
  resolveEmbeddedObsBundle,
} = require('../electron/obs-fixed-fps.cjs');

async function write(file, text = 'x') {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, text);
}

async function makeBundle(root, { markerName = '.roomcast-embedded-obs.json', markerVersion = EMBEDDED_OBS_VERSION } = {}) {
  for (const relative of [
    'bin/64bit/obs64.exe',
    'obs-plugins/64bit/obs-websocket.dll',
    'obs-plugins/64bit/win-dshow.dll',
    'data/obs-plugins/win-capture/.keep',
    'data/obs-plugins/win-dshow/obs-virtualcam-module64.dll',
  ]) {
    await write(path.join(root, ...relative.split('/')));
  }
  await write(path.join(root, markerName), JSON.stringify({
    schema: 1,
    version: markerVersion,
    platform: 'windows-x64',
  }));
}

(async () => {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'roomcast-obs-bundle-resolution-'));
  try {
    const runtimeRoot = path.join(temp, 'resources');
    const validBundle = path.join(runtimeRoot, 'runtime', 'obs-bundle');
    const invalidOverride = path.join(temp, 'stale-env-override');
    await fsp.mkdir(invalidOverride, { recursive: true });
    await makeBundle(validBundle);

    const candidates = embeddedObsBundleCandidates({
      runtimeRoot,
      envBundle: invalidOverride,
      resourcesPath: runtimeRoot,
      execPath: path.join(temp, 'Roomcast.exe'),
    });

    assert.equal(candidates[0], path.resolve(invalidOverride), 'explicit env override should be inspected first');
    const resolved = await resolveEmbeddedObsBundle({ candidates });
    assert.equal(resolved.bundleDir, path.resolve(validBundle), 'invalid env override must not mask the packaged bundle');
    assert.ok(resolved.diagnostics.length >= 1, 'fallback should retain diagnostics for rejected candidates');

    const savedOverride = process.env.ROOMCAST_OBS_BUNDLE;
    process.env.ROOMCAST_OBS_BUNDLE = invalidOverride;
    try {
      const packagedEngine = new ObsFixedFpsEngine({
        runtimeRoot,
        dataRoot: path.join(temp, 'data'),
        allowBundleOverride: false,
      });
      assert.ok(
        !packagedEngine.bundleCandidates.some(item => item === path.resolve(invalidOverride)),
        'packaged mode must not trust ROOMCAST_OBS_BUNDLE',
      );
    } finally {
      if (savedOverride === undefined) delete process.env.ROOMCAST_OBS_BUNDLE;
      else process.env.ROOMCAST_OBS_BUNDLE = savedOverride;
    }

    const plainMarkerBundle = path.join(temp, 'plain-marker-bundle');
    await makeBundle(plainMarkerBundle, { markerName: 'roomcast-embedded-obs.json' });
    const plain = await inspectEmbeddedObsBundle(plainMarkerBundle);
    assert.equal(plain.ok, true, 'non-dot marker must be accepted');

    const broken = path.join(temp, 'broken-bundle');
    await fsp.mkdir(broken, { recursive: true });
    let error = null;
    try {
      await resolveEmbeddedObsBundle({ candidates: [broken] });
    } catch (caught) {
      error = caught;
    }
    assert.ok(error, 'incomplete bundle must fail');
    assert.equal(error.code, 'OBS_EMBEDDED_RUNTIME_MISSING');
    assert.match(error.message, /obs64\.exe/);
    assert.doesNotMatch(error.message, /npm run prepare:obs/);

    const wrongVersion = path.join(temp, 'wrong-version');
    await makeBundle(wrongVersion, { markerVersion: '0.0.0' });
    const wrong = await inspectEmbeddedObsBundle(wrongVersion);
    assert.equal(wrong.ok, false);
    assert.ok(wrong.missing.some(item => item.includes('marker version=')));

    console.log('[OBS bundle resolution] invalid env fallback: PASS');
    console.log('[OBS bundle resolution] packaged env override hardening: PASS');
    console.log('[OBS bundle resolution] plain marker fallback: PASS');
    console.log('[OBS bundle resolution] actionable missing-file diagnostics: PASS');
    console.log('[OBS bundle resolution] marker version validation: PASS');
    console.log('[OBS bundle resolution] PASS');
  } finally {
    await fsp.rm(temp, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(`[OBS bundle resolution] FAIL: ${error?.stack || error}`);
  process.exitCode = 1;
});
