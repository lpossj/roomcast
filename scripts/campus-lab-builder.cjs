// Build the isolated experiment using an existing Roomcast runtime cache.
// No preparation scripts run against the shared cache and no dependencies download.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const source = path.resolve(process.env.ROOMCAST_RUNTIME_SOURCE || root);
const sourceArchive = `Roomcast-${pkg.version}-EasyTier-sources.zip`;
const notice = path.join(root, 'runtime/campus-lab/SOURCE-NOTICE.txt');

module.exports = {
  ...pkg.build,
  npmRebuild: false,
  directories: { output: 'release/2026-11-14-beta10' },
  electronDist: path.join(root, 'node_modules/electron/dist'),
  extraResources: [
    ...pkg.build.extraResources.map(entry => ({
      ...entry,
      from: entry.from.startsWith('runtime/') ? path.join(source, entry.from) : entry.from,
      ...(entry.from === 'runtime/easytier'
        ? { filter: entry.filter.filter(name => name !== 'SOURCE-NOTICE.txt') } : {}),
    })),
    { from: notice, to: 'runtime/easytier/SOURCE-NOTICE.txt' },
  ],
  beforePack: async context => {
    for (const relative of [
      'runtime/easytier/easytier-core.exe', 'runtime/easytier/wintun.dll',
      'runtime/easytier/sources.zip', 'electron/campus-runtime-manifest.json',
      'runtime/native-media/RoomcastNativeMedia.exe', 'runtime/native-media/roomcast-native.dll',
      'runtime/obs-bundle/bin/64bit/obs64.exe',
      'runtime/loopback-capture/loopback_capture_addon.node',
    ]) fs.accessSync(path.join(source, relative));
    if (source !== root) fs.copyFileSync(path.join(source, 'electron/campus-runtime-manifest.json'),
      path.join(root, 'electron/campus-runtime-manifest.json'));
    fs.mkdirSync(context.outDir, { recursive: true });
    fs.copyFileSync(path.join(source, 'runtime/easytier/sources.zip'), path.join(context.outDir, sourceArchive));
    fs.mkdirSync(path.dirname(notice), { recursive: true });
    fs.writeFileSync(notice, [
      `Roomcast ${pkg.version}: unchanged Roomcast EasyTier runtime.`,
      `Corresponding source archive supplied beside this build: ${sourceArchive}`,
      'Upstream commit: 8428a89d2dabc94c97d370ec607c6ca142473626',
      'The archive includes Roomcast modifications, dependency sources and build instructions.',
      'Keep this source archive available without charge when sharing the experimental client.',
      '',
    ].join('\n'));
  },
};
