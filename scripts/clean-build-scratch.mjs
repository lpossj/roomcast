// Removes abandoned packaging scratch directories from the system temp directory.
//
// electron-builder drives its portable/NSIS targets through an `ns<random>.tmp` working
// directory in %TEMP% that holds the whole app archive (`app-64.7z`, ~0.5-1.2 GB). It is
// cleaned up on success but survives when a build is interrupted, so repeated packaging
// silently fills the disk. Roomcast's own portable wrapper unpacks the app into a temp
// directory of the SAME shape, so layout alone cannot tell a dead build from a live app.
//
// Every guard below must pass before anything is deleted:
//   1. the entry sits directly in the temp root and its name matches `ns*.tmp`,
//   2. it contains an electron-builder artifact (`app-64.7z` or a `7z-out/` directory),
//   3. nothing inside it was written within `minAgeMs` (default 60 minutes),
//   4. it is not in use. Windows refuses to rename a directory that has a running
//      executable or a process working directory inside it, so a rename probe is a
//      reliable liveness test: if the probe fails, the directory is left alone.
//
// Dry run by default; pass --apply to actually delete.

import { existsSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRATCH_NAME = /^ns[A-Za-z0-9]+\.tmp$/;
const SCRATCH_MARKERS = ['app-64.7z', '7z-out'];
const CLAIM_SUFFIX = '.roomcast-claim';
const DEFAULT_MIN_AGE_MS = 60 * 60 * 1000;

function newestWriteTimeMs(target) {
  let newest = 0;
  try { newest = statSync(target).mtimeMs; } catch { return newest; }
  let entries;
  try { entries = readdirSync(target, { withFileTypes: true }); } catch { return newest; }
  for (const entry of entries) {
    try { newest = Math.max(newest, statSync(path.join(target, entry.name)).mtimeMs); } catch { }
  }
  return newest;
}

function directoryBytes(target) {
  let total = 0;
  const stack = [target];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(child);
      else { try { total += statSync(child).size; } catch { } }
    }
  }
  return total;
}

function isScratchDirectory(tempDir, entry) {
  if (!entry.isDirectory() || !SCRATCH_NAME.test(entry.name)) return false;
  const dir = path.join(tempDir, entry.name);
  return SCRATCH_MARKERS.some(marker => existsSync(path.join(dir, marker)));
}

// A successful rename proves nothing inside is mapped by a running process, so the
// directory can be treated as abandoned. A failed rename means a build or a portable
// Roomcast instance is still using it.
function claim(dir) {
  const claimed = `${dir}${CLAIM_SUFFIX}`;
  if (existsSync(claimed)) rmSync(claimed, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  try {
    renameSync(dir, claimed);
    return claimed;
  } catch {
    return '';
  }
}

export function inspectBuildScratch({ tempDir = os.tmpdir(), minAgeMs = DEFAULT_MIN_AGE_MS, now = Date.now() } = {}) {
  let entries;
  try { entries = readdirSync(tempDir, { withFileTypes: true }); } catch { return []; }
  const candidates = [];
  for (const entry of entries) {
    if (!isScratchDirectory(tempDir, entry)) continue;
    const dir = path.join(tempDir, entry.name);
    candidates.push({
      dir,
      name: entry.name,
      ageMs: now - newestWriteTimeMs(dir),
      bytes: directoryBytes(dir),
    });
  }
  return candidates;
}

export function cleanBuildScratch({ tempDir = os.tmpdir(), minAgeMs = DEFAULT_MIN_AGE_MS, now = Date.now(), apply = false, onLog = () => { } } = {}) {
  const candidates = inspectBuildScratch({ tempDir, minAgeMs, now });
  const stale = candidates.filter(item => item.ageMs >= minAgeMs);
  const recent = candidates.filter(item => item.ageMs < minAgeMs);
  const removed = [];
  const inUse = [];
  let bytes = 0;

  for (const item of stale) {
    const claimed = claim(item.dir);
    if (!claimed) {
      inUse.push(item);
      continue;
    }
    if (!apply) {
      try { renameSync(claimed, item.dir); } catch (error) { onLog(`未能还原 ${item.name}：${error.message}`); }
      removed.push(item);
      bytes += item.bytes;
      continue;
    }
    try {
      rmSync(claimed, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      removed.push(item);
      bytes += item.bytes;
    } catch (error) {
      onLog(`未能删除 ${item.name}：${error.message}`);
      try { renameSync(claimed, item.dir); } catch { onLog(`${item.name} 仍停留在 ${claimed}`); }
    }
  }

  return { candidates, removed, recent, inUse, bytes, applied: apply };
}

const megabytes = value => `${(value / 1024 / 1024).toFixed(1)} MB`;
const minutes = value => `${(value / 60000).toFixed(0)} min`;

function main() {
  const argv = process.argv.slice(2);
  const valueOf = flag => {
    const index = argv.indexOf(flag);
    return index === -1 ? '' : (argv[index + 1] || '');
  };
  const tempDir = valueOf('--temp') || os.tmpdir();
  const parsed = Number(valueOf('--min-age-minutes'));
  const result = cleanBuildScratch({
    tempDir,
    minAgeMs: (Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MIN_AGE_MS / 60000) * 60000,
    apply: argv.includes('--apply'),
    onLog: message => console.warn(`[build-scratch] ${message}`),
  });

  if (argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`[build-scratch] 临时目录：${tempDir}`);
  if (!result.candidates.length) {
    console.log('[build-scratch] 没有发现打包临时目录。');
    return;
  }
  for (const item of result.removed) {
    console.log(`  ${result.applied ? '删除' : '可删除'} ${item.name}  ${megabytes(item.bytes)}  最后写入 ${minutes(item.ageMs)} 前`);
  }
  for (const item of result.inUse) {
    console.log(`  保留 ${item.name}  ${megabytes(item.bytes)}  目录正被占用（打包中或便携版正在运行）`);
  }
  for (const item of result.recent) {
    console.log(`  保留 ${item.name}  ${megabytes(item.bytes)}  最后写入 ${minutes(item.ageMs)} 前（可能仍在打包）`);
  }
  const total = megabytes(result.bytes);
  console.log(result.applied
    ? `[build-scratch] 已释放 ${total}。`
    : `[build-scratch] 可释放 ${total}；加 --apply 执行删除。`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
