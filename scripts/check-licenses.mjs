import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const releaseMode = process.argv.includes('--release');
const packageInfo = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8'));

const requiredRootFiles = [
  'LICENSE',
  'NOTICE',
  'THIRD-PARTY-NOTICES.txt',
  'PRIVACY.md',
  'SECURITY.md',
  'TRADEMARKS.md',
  'ACCEPTABLE_USE.md',
  'CODE_OF_CONDUCT.md',
  'CONTRIBUTING.md',
];
for (const file of requiredRootFiles) {
  if (!existsSync(path.join(rootDir, file))) throw new Error(`缺少许可证/合规文件：${file}`);
}
if (packageInfo.license !== 'Apache-2.0') {
  throw new Error(`package.json license 应为 Apache-2.0，实际为 ${packageInfo.license}`);
}

const notices = readFileSync(path.join(rootDir, 'THIRD-PARTY-NOTICES.txt'), 'utf8');
for (const needle of [
  'OBS Studio',
  'loopback_capture_addon.node',
  '@vdoninja/sdk',
  'peerjs',
  'Electron',
  'Chromium',
  'Socket.IO',
  'React',
  'cloudflared',
]) {
  if (!notices.toLowerCase().includes(needle.toLowerCase())) throw new Error(`THIRD-PARTY-NOTICES.txt 缺少：${needle}`);
}

const expectedHashes = new Map([
  ['runtime/obs-source/OBS-Studio-32.1.2-Sources.tar.gz', 'c6532380c68a75327fe8b551461adeca8f184dcbe4015096251a6de76362a554'],
  ['runtime/loopback-capture/loopback_capture_addon.node', '23acf5f229c8e1fc5a70e4519def9d39e8ccd43b47912f364d8b81d93be5a50c'],
  ['runtime/loopback-capture/LICENSE', '30085cfcb641f0712d2453402257cfa4d9badef164933954c35e4f6675801e1a'],
  ['runtime/web-invite/cloudflared.exe', '214f5d74f66941d147d054f6cc9d821c60ff6a9b2d5355f6c854c6bee217c548'],
]);

for (const [relative, expected] of expectedHashes) {
  const file = path.join(rootDir, relative);
  if (!existsSync(file)) {
    if (releaseMode) throw new Error(`发布模式缺少运行时组件：${relative}`);
    console.warn(`[licenses] 跳过未下载运行时组件：${relative}`);
    continue;
  }
  const actual = createHash('sha256').update(readFileSync(file)).digest('hex');
  if (actual !== expected) throw new Error(`${relative} SHA256 不匹配`);
}

if (releaseMode) {
  const gpl = path.join(rootDir, 'runtime', 'obs-bundle', 'data', 'obs-studio', 'license', 'gplv2.txt');
  if (!existsSync(gpl)) throw new Error('发布模式缺少 OBS GPL 许可证文本');
}

console.log(`[licenses] 合规文件与${releaseMode ? '发布运行时' : '已存在的运行时'}校验通过。`);
