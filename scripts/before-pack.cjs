const { spawn } = require('node:child_process');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const { VIRTUALCAM_HASHES } = require('../electron/obs-virtualcam-trust.cjs');

function verifyNativeMedia(root, version) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'electron/native-media/manifest.json'), 'utf8'));
  if (manifest.schema !== 1 || manifest.version !== version) throw new Error('Native media manifest/version mismatch');
  for (const required of [
    'runtime/native-media/RoomcastNativeMedia.exe',
    'runtime/native-media/roomcast-native.dll',
    'runtime/obs-bundle/bin/64bit/datachannel.dll',
    'electron/native-media/roomcast-native-rtc.c',
    'electron/native-media/roomcast-native.c',
    'electron/native-media/build-obs-plugin.ps1',
    'electron/native-media/GPL-2.0.txt',
    'electron/native-media/MPL-2.0.txt',
  ]) {
    if (!manifest.files?.[required]) throw new Error(`Native media manifest entry missing: ${required}`);
  }
  for (const [relative, expected] of Object.entries(manifest.files)) {
    const absolute = path.resolve(root, relative);
    if (!absolute.startsWith(root + path.sep) || !/^[a-f0-9]{64}$/.test(expected)) {
      throw new Error(`Invalid native media manifest entry: ${relative}`);
    }
    const actual = createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
    if (actual !== expected) throw new Error(`Native media source/runtime digest mismatch: ${relative}`);
  }
  console.log(`[native-media] Verified ${Object.keys(manifest.files).length} pinned source/runtime files.`);
}

// Packaging leaves an `ns<random>.tmp` working directory (~0.5-1.2 GB) in %TEMP% whenever a
// build is interrupted. Clear the abandoned ones before starting another build so repeated
// packaging cannot quietly fill the disk. Cleanup must never fail the build.
async function cleanAbandonedBuildScratch() {
  try {
    const { cleanBuildScratch } = await import(pathToFileURL(path.join(__dirname, 'clean-build-scratch.mjs')).href);
    const result = cleanBuildScratch({ apply: true });
    if (result.removed.length) {
      console.log(`[build-scratch] 已清理 ${result.removed.length} 个残留打包临时目录，释放 ${(result.bytes / 1024 / 1024).toFixed(1)} MB。`);
    }
  } catch (error) {
    console.warn(`[build-scratch] 清理跳过：${error.message}`);
  }
}

exports.default = async function beforePack(context) {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('Roomcast 当前发布目标仅支持 Windows x64；无法准备内置 OBS Runtime。');
  }
  await cleanAbandonedBuildScratch();
  require('./build-update-launcher.cjs');
  for (const [name, args] of [
    ['prepare-easytier.mjs', []],
    ['prepare-embedded-obs.mjs', ['--release']],
  ]) {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(__dirname, name), ...args], {
        cwd: path.resolve(__dirname, '..'),
        stdio: 'inherit',
        windowsHide: true,
      });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${name} 准备失败：${code}`)));
    });
  }
  // Keep complete corresponding sources beside the distributables, not inside
  // every installed client. The runtime cache and its trust manifest stay intact.
  const root = path.resolve(__dirname, '..');
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  verifyNativeMedia(root, version);
  const sourceName = `Roomcast-${version}-EasyTier-sources.zip`;
  const source = path.join(root, 'runtime/easytier/sources.zip');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'electron/campus-runtime-manifest.json'), 'utf8'));
  const sourceHash = createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  if (sourceHash !== manifest.files['sources.zip']) throw new Error('EasyTier corresponding source digest mismatch');
  fs.mkdirSync(context.outDir, { recursive: true });
  const destination = path.join(context.outDir, sourceName);
  fs.copyFileSync(source, destination);
  if (createHash('sha256').update(fs.readFileSync(destination)).digest('hex') !== sourceHash) {
    throw new Error('EasyTier source attachment copy failed');
  }
  fs.writeFileSync(path.join(root, 'runtime/easytier/SOURCE-NOTICE.txt'), [
    `Roomcast ${version}: EasyTier ${manifest.version}`,
    `Corresponding source archive: ${sourceName}`,
    `SHA256: ${sourceHash}`,
    `Upstream commit: ${manifest.commit}`,
    'The archive includes Roomcast modifications, dependency sources, Cargo.lock and ROOMCAST-BUILD.txt.',
    'For local/offline distribution, supply this archive alongside the EXE or ZIP.',
    'For public distribution, provide this archive without charge next to the client download at:',
    `https://github.com/lpossj/roomcast/releases/tag/v${version}`,
    'Do not distribute the client without providing access to its corresponding source archive.',
    'Keep source access available for as long as this binary is distributed.',
    '',
  ].join('\n'), 'utf8');
  for (const bit of [32, 64]) {
    const dll = path.join(__dirname, '..', 'runtime/obs-bundle/data/obs-plugins/win-dshow', `obs-virtualcam-module${bit}.dll`);
    const hash = createHash('sha256').update(fs.readFileSync(dll)).digest('hex');
    if (hash !== VIRTUALCAM_HASHES[bit]) throw new Error(`OBS ${bit}-bit Virtual Camera trust check failed before packaging`);
  }
};
