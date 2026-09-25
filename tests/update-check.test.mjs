import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { compareVersions, createUpdateChecker, findChecksum, isPrereleaseVersion, RELEASES_PAGE, selectLatestRelease } from '../electron/update-check.mjs';

const release = (tag, overrides = {}) => ({
  tag_name: `v${tag}`,
  name: `Roomcast ${tag} Beta`,
  body: `notes for ${tag}`,
  html_url: `https://example.test/releases/tag/v${tag}`,
  draft: false,
  prerelease: tag.includes('-'),
  assets: [
    { name: `Roomcast-${tag}-Windows.exe`, size: 149_000_000, browser_download_url: `https://example.test/Roomcast-${tag}-Windows.exe` },
    { name: `Roomcast-${tag}-Windows.zip`, size: 211_000_000, browser_download_url: `https://example.test/Roomcast-${tag}-Windows.zip` },
    { name: `Roomcast-${tag}-source.zip`, size: 700_000, browser_download_url: `https://example.test/Roomcast-${tag}-source.zip` },
    { name: 'SHA256.txt', size: 900, browser_download_url: 'https://example.test/SHA256.txt' },
  ],
  ...overrides,
});

test('version comparison follows semver ordering including prereleases', () => {
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('0.14.2-beta.8', '0.14.2-beta.7'), 1);
  assert.equal(compareVersions('0.14.2-beta.2', '0.14.2-beta.10'), -1);
  assert.equal(compareVersions('0.14.2', '0.14.2-beta.9'), 1);
  assert.equal(compareVersions('0.15.0', '0.14.99'), 1);
  assert.equal(compareVersions('v0.14.2-beta.8', '0.14.2-beta.8'), 0);
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0-beta.2'), 1);
  assert.throws(() => compareVersions('not-a-version', '1.0.0'));
  assert.equal(isPrereleaseVersion('0.14.2-beta.8'), true);
  assert.equal(isPrereleaseVersion('0.14.2'), false);
});

test('release selection ignores drafts, downgrades and stable-only rules', () => {
  const releases = [
    release('0.14.2-beta.7'),
    release('0.14.2-beta.8'),
    release('0.14.2-beta.9', { draft: true }),
    release('0.14.1'),
  ];
  // The newest non-draft release is the version already installed, so nothing to offer.
  assert.equal(selectLatestRelease(releases, '0.14.2-beta.8'), null);

  assert.equal(selectLatestRelease(releases, '0.14.2-beta.7').version, '0.14.2-beta.8');
  // A stable install must not be offered a prerelease, even a newer one.
  assert.equal(selectLatestRelease([release('0.14.3-beta.1')], '0.14.2'), null);
  assert.equal(selectLatestRelease([release('0.14.3-beta.1'), release('0.15.0')], '0.14.2').version, '0.15.0');
  assert.equal(selectLatestRelease([], '0.14.2-beta.8'), null);
  assert.equal(selectLatestRelease([releases[0], release('bad-tag')], '0.14.2-beta.6').version, '0.14.2-beta.7');
});

test('checksum parsing matches the release file format', () => {
  const text = [
    '1FCCE2C905140F2105269E0AA876444908CA7115BABCFB9D10F35015AE8B147E  Roomcast-0.14.2-beta.8-Windows.exe',
    '995a21bb61d011fe8e9ce307e94e534abae66f715f5b49f0fd07dfc847882aec *Roomcast-0.14.2-beta.8-Windows.zip',
    '',
  ].join('\n');
  assert.equal(findChecksum(text, 'Roomcast-0.14.2-beta.8-Windows.exe'), '1fcce2c905140f2105269e0aa876444908ca7115babcfb9d10f35015ae8b147e');
  assert.equal(findChecksum(text, 'Roomcast-0.14.2-beta.8-Windows.zip'), '995a21bb61d011fe8e9ce307e94e534abae66f715f5b49f0fd07dfc847882aec');
  assert.equal(findChecksum(text, 'other.exe'), '');
  assert.equal(findChecksum('', 'anything'), '');
});

test('update check reports the newest release with its Windows assets', async () => {
  const seen = [];
  const checker = createUpdateChecker({
    currentVersion: '0.14.2-beta.8',
    fetchImpl: async (url, options) => {
      seen.push({ url, accept: options.headers.Accept });
      return { ok: true, status: 200, json: async () => [release('0.14.2-beta.7'), release('0.14.2-beta.9')] };
    },
  });
  const result = await checker.check();
  assert.equal(result.available, true);
  assert.equal(result.version, '0.14.2-beta.9');
  assert.equal(result.current, '0.14.2-beta.8');
  assert.equal(result.checksumUrl, 'https://example.test/SHA256.txt');
  assert.deepEqual(result.assets.map(asset => asset.name), [
    'Roomcast-0.14.2-beta.9-Windows.exe',
    'Roomcast-0.14.2-beta.9-Windows.zip',
  ]);
  assert.match(seen[0].url, /api\.github\.com\/repos\/lpossj\/roomcast\/releases/);
  assert.equal(seen[0].accept, 'application/vnd.github+json');
});

test('update check surfaces rate limits and stays quiet when up to date', async () => {
  const limited = createUpdateChecker({ currentVersion: '0.14.2-beta.8', fetchImpl: async () => ({ ok: false, status: 403 }) });
  await assert.rejects(() => limited.check(), /请求过于频繁/);

  const failing = createUpdateChecker({ currentVersion: '0.14.2-beta.8', fetchImpl: async () => ({ ok: false, status: 500 }) });
  await assert.rejects(() => failing.check(), /HTTP 500/);

  const current = createUpdateChecker({ currentVersion: '0.14.2-beta.8', fetchImpl: async () => ({ ok: true, status: 200, json: async () => [release('0.14.2-beta.8')] }) });
  assert.deepEqual(await current.check(), { available: false, current: '0.14.2-beta.8' });
});

test('a timeout points the user at the manual release page', async () => {
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const checker = createUpdateChecker({ currentVersion: '0.14.2-beta.8', fetchImpl: async () => { throw timeout; } });
  const checkError = await checker.check().catch(error => error);
  assert.equal(checkError.code, 'timeout');
  assert.match(checkError.message, /打开发布页/);

  const downloadChecker = createUpdateChecker({
    currentVersion: '0.14.2-beta.8',
    fetchImpl: async () => { throw timeout; },
  });
  const downloadError = await downloadChecker.download({ name: 'a.exe', url: 'https://example.test/a.exe' }, 'ignored.bin', '').catch(error => error);
  assert.equal(downloadError.code, 'timeout');
  assert.match(downloadError.message, /下载更新包超时/);
  assert.match(downloadError.message, /打开发布页/);
  assert.match(RELEASES_PAGE, /^https:\/\/github\.com\/lpossj\/roomcast\/releases$/);
});

test('download verifies the published checksum before writing the file', async () => {
  const payload = Buffer.from('roomcast-archive-bytes');
  const digest = createHash('sha256').update(payload).digest('hex');
  const destination = fileURLToPath(new URL('./.update-download-test.bin', import.meta.url));
  const responses = {
    'https://example.test/asset.exe': { ok: true, status: 200, arrayBuffer: async () => payload },
    'https://example.test/SHA256.txt': { ok: true, status: 200, text: async () => `${digest}  Roomcast-0.14.2-beta.9-Windows.exe\n` },
  };
  const checker = createUpdateChecker({
    currentVersion: '0.14.2-beta.8',
    fetchImpl: async url => responses[url] || { ok: false, status: 404 },
  });
  const asset = { name: 'Roomcast-0.14.2-beta.9-Windows.exe', url: 'https://example.test/asset.exe' };
  try {
    const result = await checker.download(asset, destination, 'https://example.test/SHA256.txt');
    assert.equal(result.verified, true);
    assert.equal(result.sha256, digest);
    assert.equal(result.bytes, payload.length);
    assert.equal((await readFile(destination)).toString(), 'roomcast-archive-bytes');

    // A tampered payload must not be written.
    responses['https://example.test/asset.exe'] = { ok: true, status: 200, arrayBuffer: async () => Buffer.from('tampered') };
    await assert.rejects(() => checker.download(asset, destination, 'https://example.test/SHA256.txt'), /SHA256 与发布页不一致/);
    assert.equal((await readFile(destination)).toString(), 'roomcast-archive-bytes');

    // A release without a published checksum still downloads, reported as unverified.
    const unverified = await checker.download(asset, destination, '');
    assert.equal(unverified.verified, false);
  } finally {
    await rm(destination, { force: true });
  }
});
