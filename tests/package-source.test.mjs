import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repository = fileURLToPath(new URL('../', import.meta.url));
const script = path.join(repository, 'scripts', 'package-source.mjs');
const fixtureParent = path.join(repository, '.test');
const version = '0.14.3-beta.6';
const archiveName = `Roomcast-${version}-source.zip`;
const previous = Buffer.from('previous source release archive');

function fixture(t, { committed = true } = {}) {
  mkdirSync(fixtureParent, { recursive: true });
  const dir = mkdtempSync(path.join(fixtureParent, 'package-source-'));
  t.after(() => {
    const resolved = path.resolve(dir);
    assert.equal(path.dirname(resolved), path.resolve(fixtureParent));
    assert.ok(path.basename(resolved).startsWith('package-source-'));
    rmSync(resolved, { recursive: true, force: true });
  });
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr || String(result.error || 'git failed'));
    return result.stdout.trim();
  };
  git('init', '--quiet');
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'roomcast-fixture', version }));
  writeFileSync(path.join(dir, '.gitignore'), 'release/\n');
  writeFileSync(path.join(dir, 'fixture.txt'), 'committed content\n');
  if (committed) {
    git('add', 'package.json', '.gitignore', 'fixture.txt');
    git('-c', 'user.name=Roomcast Test', '-c', 'user.email=test@roomcast.invalid', 'commit', '--quiet', '-m', 'fixture');
  }
  const release = path.join(dir, 'release');
  mkdirSync(release);
  const archive = path.join(release, archiveName);
  writeFileSync(archive, previous);
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: 'utf8', windowsHide: true });
  return { dir, release, archive, git, run };
}

for (const kind of ['tracked', 'untracked']) {
  test(`source packaging preserves the prior archive when ${kind} changes are rejected`, t => {
    const current = fixture(t);
    writeFileSync(path.join(current.dir, kind === 'tracked' ? 'fixture.txt' : 'untracked.txt'), 'uncommitted content\n');
    const result = current.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /发布源码包要求工作区干净/);
    assert.deepEqual(readFileSync(current.archive), previous);
    assert.deepEqual(readdirSync(current.release), [archiveName]);
  });
}

test('source packaging replaces the prior archive with committed HEAD on success', t => {
  const current = fixture(t);
  const head = current.git('rev-parse', 'HEAD');
  const result = current.run();
  assert.equal(result.status, 0, result.stderr);
  const archive = readFileSync(current.archive);
  assert.equal(archive.subarray(0, 4).toString('hex'), '504b0304');
  assert.ok(archive.includes(Buffer.from(`Roomcast-${version}/fixture.txt`)));
  assert.ok(archive.includes(Buffer.from(head)));
  assert.deepEqual(readdirSync(current.release), [archiveName]);
});

test('source packaging preserves the prior archive and removes scratch output when git archive fails', t => {
  const current = fixture(t, { committed: false });
  const result = current.run('--allow-dirty');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /git archive 失败/);
  assert.deepEqual(readFileSync(current.archive), previous);
  assert.deepEqual(readdirSync(current.release), [archiveName]);
});
