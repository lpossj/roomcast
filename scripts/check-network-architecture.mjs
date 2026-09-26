import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();

function read(relative) {
  const path = resolve(root, relative);
  assert.ok(existsSync(path), `缺少文件: ${relative}`);
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

function mustContain(text, needle, message) {
  assert.ok(text.includes(needle), message || `缺少关键实现: ${needle}`);
}

function mustNotContain(text, needle, message) {
  assert.ok(!text.includes(needle), message || `发现不应存在的内容: ${needle}`);
}

const files = {
  pkg: read('package.json'),
  app: read('src/App.jsx'),
  screen: read('src/ScreenPlayer.jsx'),
  p2p: read('src/p2p.js'),
  relay: read('src/relay.js'),
  ice: read('src/ice-policy.js'),
  race: read('src/media-race-manager.js'),
  rooms: read('server/rooms.mjs'),
  vdo: read('src/transports/vdo-transport.js'),
  publisher: read('src/transports/vdo-screen-publisher.js'),
  viewer: read('src/transports/vdo-screen-viewer.js'),
  fallback: read('src/fallback-policy.js'),
  webInvite: read('electron/web-invite.cjs'),
  fetchWebInvite: read('scripts/fetch-web-invite.mjs'),
  licenseCheck: read('scripts/check-licenses.mjs'),
};

const packageJson = JSON.parse(files.pkg);

assert.equal(
  existsSync(resolve(root, 'server/media.mjs')),
  false,
  'legacy MediaMTX server/media.mjs must stay removed',
);

assert.equal(
  (packageJson.build?.extraResources || []).some(resource =>
    /mediamtx/i.test(JSON.stringify(resource))
  ),
  false,
  'MediaMTX must not return to packaged extraResources',
);

assert.equal(
  packageJson.dependencies?.['@vdoninja/sdk'],
  '1.6.1',
  '@vdoninja/sdk 必须锁定为 1.6.1',
);

mustNotContain(
  packageJson.description || '',
  'Quick Tunnel',
  'package.json description 仍残留 Quick Tunnel',
);

for (const relative of [
  'worker-code.txt',
  'docs/Cloudflare-Quick-Tunnel.md',
  'docs/quick-tunnel-unverified-changes.md',
  'docs/第三方组件与源码.md',
]) {
  assert.equal(
    existsSync(resolve(root, relative)),
    false,
    `obsolete maintenance artifact must stay removed: ${relative}`,
  );
}

const gitignore = read('.gitignore');
mustNotContain(
  gitignore,
  'runtime/cloudflared',
  '.gitignore must not preserve the retired cloudflared runtime',
);

// No temporary development probes should remain in the final tree.
for (const relative of [
  'src/transports/vdo-publisher-probe.js',
  'src/transports/vdo-viewer-probe.js',
]) {
  assert.equal(
    existsSync(resolve(root, relative)),
    false,
    `实验文件仍存在，请删除: ${relative}`,
  );
}

const runtimeCombined = [
  files.app,
  files.screen,
  files.p2p,
  files.relay,
  files.ice,
  files.race,
  files.rooms,
  files.vdo,
  files.publisher,
  files.viewer,
].join('\n');

for (const residue of [
  'startVdoPublisherProbe',
  'startVdoViewerProbe',
  '__roomcastVdoPublisherProbe',
  '__roomcastVdoViewerProbe',
  'VDO Publisher 测试',
  'VDO Viewer 解码测试',
  'DirectRoom',
  'connectMediaRelay',
  'tunnel-playback',
  'mediaBaseUrl',
  'publishToken',
  'authorizeMedia',
  'onStreamEnd',
  'onMemberLeave',
  'pendingCleanup',
  'room.cleanup',
]) {
  mustNotContain(
    runtimeCombined,
    residue,
    `正式运行时代码残留: ${residue}`,
  );
}

// The retired Quick Tunnel / MediaMTX MEDIA chain must never come back. cloudflared itself
// is a supported component since 0.14.2-beta.4 (the temporary web entry), so the media
// path is checked on its own instead of by a repository-wide token ban.
mustNotContain(
  [files.p2p, files.screen, files.vdo, files.publisher, files.viewer, files.race].join('\n'),
  'trycloudflare',
  '媒体路径不得引用临时网页入口地址',
);

mustNotContain(
  [files.p2p, files.screen, files.vdo, files.publisher, files.viewer, files.race].join('\n'),
  'cloudflared',
  '媒体路径不得依赖 cloudflared',
);

// The default entry is fixed HTTPS; legacy shipped binary stays pinned for this minimal release.
mustContain(
  JSON.stringify(packageJson.build?.extraResources || []),
  'runtime/web-invite/cloudflared.exe',
  '打包资源必须显式包含 web-invite 的 cloudflared',
);

mustContain(files.fetchWebInvite, "const version = '2026.9.2'", 'web-invite 必须固定 cloudflared 版本');
mustContain(files.webInvite, "https://lpossj.github.io/roomcast/", '固定网页入口必须配置完整 HTTPS 路径');
mustNotContain(files.webInvite, "require('node:child_process')", '生成网页入口不得启动隧道进程');
mustContain(files.webInvite, 'const PUBLIC_FILE =', '本地静态测试服务必须使用显式文件白名单');
mustContain(files.webInvite, "['GET', 'HEAD']", 'web-invite 只允许只读请求');
mustContain(files.webInvite, "frame-ancestors 'none'", 'web-invite 必须禁止被嵌入');

const pinnedCloudflared = files.fetchWebInvite.match(/const expected = '([0-9a-f]{64})'/)?.[1] || '';
const checkedCloudflared = files.licenseCheck.match(/\['runtime\/web-invite\/cloudflared\.exe', '([0-9a-f]{64})'\]/)?.[1] || '';

assert.ok(pinnedCloudflared.length === 64, 'web-invite 缺少 cloudflared SHA256 固定值');

assert.equal(
  pinnedCloudflared,
  checkedCloudflared,
  'fetch-web-invite 与 check-licenses 的 cloudflared SHA256 必须一致',
);

// VDO direct lane must never silently become relay.
mustContain(files.vdo, 'turnServers: false', 'VDO TURN 未明确关闭');
mustContain(files.vdo, 'forceTURN: false', 'VDO forceTURN 未明确关闭');
mustContain(files.vdo, 'autoRelay: false', 'VDO autoRelay 未明确关闭');
mustContain(files.vdo, 'autoRecover: false', 'VDO autoRecover 未交给 Roomcast 管理');

// The formal VDO transport must be used.
mustContain(
  files.p2p,
  "'./transports/vdo-screen-publisher.js'",
  '正式 VDO Publisher 未接入 p2p.js',
);
mustContain(
  files.screen,
  "'./transports/vdo-screen-viewer.js'",
  '正式 VDO Viewer 未接入 ScreenPlayer',
);

// Pair-level direct race.
mustContain(
  files.screen,
  'createMediaRaceCoordinator',
  'ScreenPlayer 尚未接入 MediaRaceCoordinator',
);
mustContain(files.screen, 'void connectP2P().catch(', 'P2P direct attempt 未立即启动');
mustContain(files.screen, 'startVdo: () =>', '缺少 VDO 延迟启动入口');
mustContain(files.screen, 'return connectVdo().catch(', 'VDO direct attempt 未接入延迟入口');
mustNotContain(files.screen, 'void connectVdo();', 'VDO 不应与 P2P 同时直接启动');
mustContain(files.race, 'MEDIA_RACE_VDO_DELAY_MS = 3_000', 'VDO viewer 必须延后 3 秒');
mustContain(
  files.race,
  "const otherRoute = route => route === 'p2p' ? 'vdo' : 'p2p';",
  'MediaRace 不是 P2P/VDO 双赛道',
);

// TURN must be gated after direct race exhaustion and be relay-only.
mustContain(files.screen, 'onExhausted:', '缺少 direct race exhausted 闸门');
mustContain(files.screen, 'connectTurn(', '缺少最终 TURN attempt');
mustContain(
  files.screen,
  "iceTransportPolicy:\n              'relay'",
  'Viewer TURN attempt 不是 relay-only',
);
mustContain(
  files.p2p,
  "iceTransportPolicy:\n              'relay'",
  'Publisher TURN answer 不是 relay-only',
);
mustContain(
  files.ice,
  'export function turnIceServers',
  '缺少 TURN-only ICE server 过滤',
);
mustContain(
  files.relay,
  'if (encoded)',
  '房间邀请中的 TURN 凭据未优先处理',
);
mustContain(
  files.relay,
  'decodeRelayInvite(encoded)',
  '房间邀请中的 TURN 凭据未被解码使用',
);
mustContain(
  files.relay,
  'settings?.enabled !== true',
  '无房间 TURN 凭据时，本机 TURN OFF 未阻止主动获取凭据',
);

// Control protocol must support VDO descriptor and explicit TURN route.
mustContain(files.rooms, "'vdo-request'", 'Server 未允许 vdo-request');
mustContain(files.rooms, "'vdo-descriptor'", 'Server 未允许 vdo-descriptor');
mustContain(files.rooms, "'turn'", 'Server 未允许显式 TURN 媒体 route');

// Success must be based on a decoded playable frame, not merely ICE connected.
mustContain(
  files.screen,
  'watchPlayableFrame',
  'ScreenPlayer 未使用真实可播放帧判定',
);
mustContain(files.fallback, 'video.readyState >= 2', '可播放判定缺少 readyState 检查');
mustContain(files.fallback, 'video.videoWidth > 0', '可播放判定缺少实际视频尺寸检查');
mustContain(files.fallback, "addEventListener('loadeddata'", '可播放判定缺少 loadeddata 事件');
mustContain(files.fallback, "addEventListener('canplay'", '可播放判定缺少 canplay 事件');

console.log('✓ Roomcast 网络架构静态自检通过');
console.log('  P2P + VDO direct race');
console.log('  VDO TURN disabled');
console.log('  TURN gated after direct race exhaustion');
console.log('  TURN media relay-only');
console.log('  temporary VDO probes removed');
console.log('  legacy Quick Tunnel / MediaMTX media chain residue absent');
console.log('  MediaMTX runtime/package residue absent');
console.log('  legacy MediaMTX room authorization/cleanup residue absent');
console.log('  legacy Quick Tunnel maintenance artifacts absent');
console.log('  fixed HTTPS web entry has no tunnel startup dependency');
