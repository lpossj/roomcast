import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cleanBuildScratch, inspectBuildScratch } from '../scripts/clean-build-scratch.mjs';

// The cleaner deletes directories, so its guards are the thing under test: it may only
// touch abandoned electron-builder scratch, never a running build, a live portable
// instance, or an unrelated folder.
const OLD = new Date(Date.now() - 3 * 60 * 60 * 1000);

function makeOld(target) {
  utimesSync(target, OLD, OLD);
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'roomcast-scratch-test-'));

  // 1. abandoned electron-builder scratch (app archive marker)
  mkdirSync(path.join(root, 'nsAAAA11.tmp'));
  writeFileSync(path.join(root, 'nsAAAA11.tmp', 'app-64.7z'), 'x'.repeat(1024));
  makeOld(path.join(root, 'nsAAAA11.tmp', 'app-64.7z'));
  makeOld(path.join(root, 'nsAAAA11.tmp'));

  // 2. abandoned scratch identified by the 7z-out staging directory
  mkdirSync(path.join(root, 'nsBBBB22.tmp', '7z-out'), { recursive: true });
  writeFileSync(path.join(root, 'nsBBBB22.tmp', '7z-out', 'Roomcast.exe'), 'y'.repeat(2048));
  makeOld(path.join(root, 'nsBBBB22.tmp', '7z-out', 'Roomcast.exe'));
  makeOld(path.join(root, 'nsBBBB22.tmp', '7z-out'));
  makeOld(path.join(root, 'nsBBBB22.tmp'));

  // 3. same name pattern but no electron-builder artifact -> must be left alone
  mkdirSync(path.join(root, 'nsCCCC33.tmp'));
  writeFileSync(path.join(root, 'nsCCCC33.tmp', 'notes.txt'), 'keep');
  makeOld(path.join(root, 'nsCCCC33.tmp'));

  // 4. looks like scratch but is still fresh -> a build may be running
  mkdirSync(path.join(root, 'nsDDDD44.tmp'));
  writeFileSync(path.join(root, 'nsDDDD44.tmp', 'app-64.7z'), 'z');
  makeOld(path.join(root, 'nsDDDD44.tmp', 'app-64.7z'));
  utimesSync(path.join(root, 'nsDDDD44.tmp'), new Date(), new Date());

  // 5. not an NSIS temp name -> must be left alone
  mkdirSync(path.join(root, 'someone-elses-work'));
  writeFileSync(path.join(root, 'someone-elses-work', 'app-64.7z'), 'q');
  makeOld(path.join(root, 'someone-elses-work', 'app-64.7z'));
  makeOld(path.join(root, 'someone-elses-work'));

  return root;
}

function removeTree(target) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try { rmSync(target, { recursive: true, force: true }); return; } catch { }
    const deadline = Date.now() + 100;
    while (Date.now() < deadline) { /* let a released handle settle */ }
  }
}

test('build scratch inspection only matches abandoned electron-builder temp directories', () => {
  const root = fixture();
  try {
    const found = inspectBuildScratch({ tempDir: root }).map(item => item.name).sort();
    assert.deepEqual(found, ['nsAAAA11.tmp', 'nsBBBB22.tmp', 'nsDDDD44.tmp']);
  } finally {
    removeTree(root);
  }
});

test('build scratch cleanup is a dry run without apply and keeps fresh directories', () => {
  const root = fixture();
  try {
    const mtimeBefore = statSync(path.join(root, 'nsAAAA11.tmp')).mtimeMs;
    const preview = cleanBuildScratch({ tempDir: root });
    assert.equal(preview.applied, false);
    assert.deepEqual(preview.removed.map(item => item.name).sort(), ['nsAAAA11.tmp', 'nsBBBB22.tmp']);
    assert.deepEqual(preview.recent.map(item => item.name), ['nsDDDD44.tmp']);
    assert.equal(preview.bytes, 1024 + 2048);
    // A dry run must not have removed or renamed anything, including the directory mtimes
    // the age guard depends on.
    assert.deepEqual(inspectBuildScratch({ tempDir: root }).map(item => item.name).sort(), ['nsAAAA11.tmp', 'nsBBBB22.tmp', 'nsDDDD44.tmp']);
    assert.equal(statSync(path.join(root, 'nsAAAA11.tmp')).mtimeMs, mtimeBefore);
    assert.equal(statSync(path.join(root, 'nsBBBB22.tmp')).mtimeMs, mtimeBefore);

    const applied = cleanBuildScratch({ tempDir: root, apply: true });
    assert.equal(applied.applied, true);
    assert.deepEqual(inspectBuildScratch({ tempDir: root }).map(item => item.name).sort(), ['nsDDDD44.tmp']);
  } finally {
    removeTree(root);
  }
});

test('build scratch cleanup never deletes a directory that is in use', async () => {
  const root = fixture();
  const target = path.join(root, 'nsAAAA11.tmp');
  // A process whose working directory is inside the candidate makes Windows refuse to
  // rename it, which is exactly how the live-instance guard detects a running app.
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { cwd: target, stdio: 'ignore', windowsHide: true });
  try {
    await new Promise(resolve => setTimeout(resolve, 600));
    const result = cleanBuildScratch({ tempDir: root, apply: true });
    assert.deepEqual(result.inUse.map(item => item.name), ['nsAAAA11.tmp'], '被占用的目录必须报告为 inUse');
    assert.deepEqual(result.removed.map(item => item.name), ['nsBBBB22.tmp'], '未被占用的目录仍应清理');
    assert.ok(existsSync(target), '被占用的目录必须保留');
    assert.ok(existsSync(path.join(target, 'app-64.7z')), '被占用目录的内容必须完好');
  } finally {
    holder.kill();
    await new Promise(resolve => setTimeout(resolve, 400));
    removeTree(root);
  }
});

test('build scratch cleanup reports nothing for a directory it cannot read', () => {
  const missing = path.join(tmpdir(), `roomcast-scratch-missing-${Date.now()}`);
  const result = cleanBuildScratch({ tempDir: missing, apply: true });
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.removed, []);
  assert.equal(result.bytes, 0);
});
