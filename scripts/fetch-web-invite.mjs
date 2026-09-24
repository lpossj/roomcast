import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

const version = '2026.9.2';
const expected = '214f5d74f66941d147d054f6cc9d821c60ff6a9b2d5355f6c854c6bee217c548';
const destination = path.join(process.cwd(), 'runtime', 'web-invite', 'cloudflared.exe');
const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');
if (existsSync(destination) && digest(destination) === expected) {
  console.log('[web-invite] 已有校验通过的 cloudflared。');
  process.exit(0);
}
mkdirSync(path.dirname(destination), { recursive: true });
const temporary = `${destination}.download`;
try {
  const response = await fetch(`https://github.com/cloudflare/cloudflared/releases/download/${version}/cloudflared-windows-amd64.exe`, { signal: AbortSignal.timeout(120000) });
  if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
  if (digest(temporary) !== expected) throw new Error('cloudflared 官方 SHA256 校验失败');
  renameSync(temporary, destination);
  console.log('[web-invite] cloudflared 下载并校验通过。');
} finally {
  rmSync(temporary, { force: true });
}
