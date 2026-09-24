import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const strict = process.argv.includes('--strict');
const packageInfo = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const version = packageInfo.version;
const releaseDir = path.join(rootDir, 'release');

const candidates = [
  path.join(releaseDir, `Roomcast-${version}-Windows.exe`),
  path.join(releaseDir, `Roomcast-${version}-Windows.zip`),
  path.join(releaseDir, `Roomcast-${version}-source.zip`),
  path.join(releaseDir, `Roomcast-${version}-loopback-capture.zip`),
  path.join(rootDir, 'runtime', 'obs-source', 'OBS-Studio-32.1.2-Sources.tar.gz'),
  path.join(rootDir, 'runtime', 'loopback-capture', 'loopback_capture_addon.node'),
  path.join(rootDir, 'runtime', 'loopback-capture', 'LICENSE'),
  path.join(rootDir, 'runtime', 'web-invite', 'cloudflared.exe'),
];

const records = [];
for (const file of candidates) {
  if (!existsSync(file)) {
    const message = `[checksums] 缺少 ${path.relative(rootDir, file)}`;
    if (strict) throw new Error(message);
    console.warn(`${message}，已跳过`);
    continue;
  }
  const digest = createHash('sha256').update(readFileSync(file)).digest('hex').toUpperCase();
  records.push(`${digest}  ${path.basename(file)}`);
}

if (!records.length) throw new Error('没有可生成校验值的文件');
mkdirSync(releaseDir, { recursive: true });
const output = path.join(releaseDir, 'SHA256.txt');
writeFileSync(output, `${records.join('\n')}\n`, 'utf8');
console.log(`[checksums] 已生成：${output}`);
for (const record of records) console.log(record);
