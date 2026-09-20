import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

const rootDir = process.cwd();
const packageInfo = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8'));

export const LOOPBACK_FILES = Object.freeze({
  'loopback_capture_addon.node': '23acf5f229c8e1fc5a70e4519def9d39e8ccd43b47912f364d8b81d93be5a50c',
  LICENSE: '30085cfcb641f0712d2453402257cfa4d9badef164933954c35e4f6675801e1a',
});

export const LOOPBACK_DIR = path.join(rootDir, 'runtime', 'loopback-capture');
// 固定指向已发布的 runtime 资产，避免主版本 tag 和运行时组件版本绑定。
export const DEFAULT_LOOPBACK_ARCHIVE_URL =
  'https://github.com/lpossj/roomcast/releases/download/runtime-2026.09/Roomcast-0.14.2-beta.1-loopback-capture.zip';

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function findFile(directory, filename) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = findFile(fullPath, filename);
      if (nested) return nested;
    } else if (entry.name === filename) {
      return fullPath;
    }
  }
  return '';
}

export function verifyLoopback(directory = LOOPBACK_DIR) {
  const result = {};
  for (const [name, expected] of Object.entries(LOOPBACK_FILES)) {
    const filePath = path.join(directory, name);
    if (!existsSync(filePath)) {
      return { ok: false, reason: `缺少 ${name}` };
    }
    const actual = sha256(filePath);
    if (actual !== expected) {
      return { ok: false, reason: `${name} SHA256 不匹配` };
    }
    result[name] = actual;
  }
  return { ok: true, files: result };
}

function powershellQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function extractZip(zipPath, destination) {
  if (process.platform !== 'win32') {
    throw new Error('自动解压 loopback ZIP 目前仅支持 Windows；请改用 ROOMCAST_LOOPBACK_ARCHIVE 指向已解压目录。');
  }
  const command = `Expand-Archive -LiteralPath ${powershellQuote(zipPath)} -DestinationPath ${powershellQuote(destination)} -Force`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Expand-Archive 失败：${result.status}`);
}

async function download(url, destination) {
  const response = await fetch(url, {
    headers: { 'user-agent': `Roomcast runtime fetch/${packageInfo.version}` },
  });
  if (!response.ok || !response.body) {
    throw new Error(`下载失败：HTTP ${response.status}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
}

function copyExpectedFiles(sourceDirectory, destinationDirectory) {
  const addon = findFile(sourceDirectory, 'loopback_capture_addon.node');
  if (!addon) throw new Error('归档中找不到 loopback_capture_addon.node');
  const license = [
    path.join(path.dirname(addon), 'LICENSE'),
    path.join(sourceDirectory, 'LICENSE'),
    path.join(sourceDirectory, 'resources', 'runtime', 'loopback-capture', 'LICENSE'),
    path.join(sourceDirectory, 'runtime', 'loopback-capture', 'LICENSE'),
    findFile(sourceDirectory, 'LICENSE'),
  ].find(candidate => candidate && existsSync(candidate));
  if (!license) throw new Error('归档中找不到 loopback capture LICENSE');
  mkdirSync(destinationDirectory, { recursive: true });
  for (const [name, from] of [
    ['loopback_capture_addon.node', addon],
    ['LICENSE', license],
  ]) {
    const to = path.join(destinationDirectory, name);
    if (path.resolve(from) !== path.resolve(to)) copyFileSync(from, to);
  }
}

function importArchive(archivePath, destinationDirectory) {
  const absolute = path.resolve(archivePath);
  const stat = statSync(absolute);
  if (stat.isDirectory()) {
    copyExpectedFiles(absolute, destinationDirectory);
    return;
  }
  if (path.extname(absolute).toLowerCase() !== '.zip') {
    throw new Error('ROOMCAST_LOOPBACK_ARCHIVE 必须是目录或 ZIP');
  }
  const temporary = path.join(tmpdir(), `roomcast-loopback-${Date.now()}`);
  mkdirSync(temporary, { recursive: true });
  try {
    extractZip(absolute, temporary);
    copyExpectedFiles(temporary, destinationDirectory);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export async function ensureLoopback({ checkOnly = false } = {}) {
  const current = verifyLoopback();
  if (current.ok) {
    console.log('[loopback] 组件已就绪，SHA256 校验通过。');
    return current;
  }

  if (checkOnly) {
    throw new Error(`[loopback] ${current.reason}。请先运行 npm run fetch:runtime。`);
  }

  const localArchive = String(process.env.ROOMCAST_LOOPBACK_ARCHIVE || '').trim();
  const archiveUrl = String(process.env.ROOMCAST_LOOPBACK_ARCHIVE_URL || '').trim();
  const fallbackUrl = DEFAULT_LOOPBACK_ARCHIVE_URL;

  if (localArchive) {
    console.log(`[loopback] 使用本地归档：${localArchive}`);
    importArchive(localArchive, LOOPBACK_DIR);
  } else {
    const url = archiveUrl || fallbackUrl;
    const temporaryZip = path.join(tmpdir(), `roomcast-loopback-${Date.now()}.zip`);
    try {
      console.log(`[loopback] 下载：${url}`);
      await download(url, temporaryZip);
      importArchive(temporaryZip, LOOPBACK_DIR);
    } finally {
      rmSync(temporaryZip, { force: true });
    }
  }

  const verified = verifyLoopback();
  if (!verified.ok) {
    throw new Error(`[loopback] 组件校验失败：${verified.reason}`);
  }
  console.log('[loopback] 组件已准备完成。');
  return verified;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await ensureLoopback({ checkOnly: process.argv.includes('--check-only') });
  } catch (error) {
    console.error(error.message);
    console.error(`可设置 ROOMCAST_LOOPBACK_ARCHIVE=<目录或 ZIP> 或 ROOMCAST_LOOPBACK_ARCHIVE_URL=<下载地址> 后重试。`);
    process.exitCode = 1;
  }
}