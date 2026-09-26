import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { compareVersions, createUpdateChecker, findChecksum, isPrereleaseVersion, RELEASES_PAGE, selectInstallAsset, selectLatestRelease, VERSION_MANIFEST_URL } from '../electron/update-check.mjs';

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

test('a rate-limited GitHub API falls back to the published version manifest', async () => {
  const requests = [];
  const checker = createUpdateChecker({
    currentVersion: '0.14.3-beta.1',
    fetchImpl: async url => {
      requests.push(url);
      if (url.startsWith('https://api.github.com/')) return { ok: false, status: 403 };
      if (url === VERSION_MANIFEST_URL) return { ok: true, status: 200, json: async () => ({ version: '0.14.3-beta.2', peerAuthProtocol: 2 }) };
      if (url.includes('/docs/RELEASE_NOTES-')) return { ok: true, status: 200, text: async () => '# Roomcast 0.14.3-beta.2\n\n## 修复\n\n固定网页入口。\n' };
      return { ok: false, status: 404 };
    },
  });
  const result = await checker.check();
  assert.equal(result.available, true);
  assert.equal(result.viaManifest, true);
  assert.equal(result.version, '0.14.3-beta.2');
  assert.equal(result.prerelease, true);
  assert.equal(result.pageUrl, 'https://github.com/lpossj/roomcast/releases/tag/v0.14.3-beta.2');
  // The checksum file stays mandatory, and the asset names follow the release workflow.
  assert.equal(result.checksumUrl, 'https://github.com/lpossj/roomcast/releases/download/v0.14.3-beta.2/SHA256.txt');
  assert.deepEqual(result.assets.map(asset => asset.name), [
    'Roomcast-0.14.3-beta.2-Windows.exe',
    'Roomcast-0.14.3-beta.2-Windows.zip',
  ]);
  assert.match(result.assets[1].url, /^https:\/\/github\.com\/lpossj\/roomcast\/releases\/download\/v0\.14\.3-beta\.2\//);
  // Notes are recovered from the tagged source, without the leading markdown title.
  assert.match(result.notes, /^## 修复/);
  assert.equal(result.notesUnavailable, false);
  assert.equal(selectInstallAsset(result.assets, 'directory').name, 'Roomcast-0.14.3-beta.2-Windows.zip');
  // The API is still tried first; the manifest is only the fallback.
  assert.match(requests[0], /^https:\/\/api\.github\.com\//);
  assert.equal(requests[1], VERSION_MANIFEST_URL);
});

test('the manifest fallback keeps the prerelease rule, the no-update result and honest errors', async () => {
  const manifestOnly = version => async url => {
    if (url.startsWith('https://api.github.com/')) return { ok: false, status: 429 };
    if (url === VERSION_MANIFEST_URL) return { ok: true, status: 200, json: async () => ({ version }) };
    return { ok: false, status: 404 };
  };
  // A stable install must not be offered a prerelease.
  const stable = createUpdateChecker({ currentVersion: '0.14.2', fetchImpl: manifestOnly('0.14.3-beta.2') });
  assert.deepEqual(await stable.check(), { available: false, current: '0.14.2' });

  // Already newer locally, or the manifest is older: nothing to offer.
  const older = createUpdateChecker({ currentVersion: '0.14.3-beta.2', fetchImpl: manifestOnly('0.14.3-beta.1') });
  assert.deepEqual(await older.check(), { available: false, current: '0.14.3-beta.2' });

  // Notes unavailable: the update is still offered, but the UI is told to say so.
  const noNotes = createUpdateChecker({ currentVersion: '0.14.3-beta.1', fetchImpl: manifestOnly('0.14.4') });
  const noNotesResult = await noNotes.check();
  assert.equal(noNotesResult.available, true);
  assert.equal(noNotesResult.notesUnavailable, true);
  assert.equal(noNotesResult.notes, '');

  // A broken manifest must not hide the original API error.
  const bothDown = createUpdateChecker({
    currentVersion: '0.14.3-beta.1',
    fetchImpl: async url => (url.startsWith('https://api.github.com/') ? { ok: false, status: 403 } : { ok: false, status: 500 }),
  });
  const failure = await bothDown.check().catch(error => error);
  assert.match(failure.message, /请求过于频繁/);
  assert.equal(failure.code, 'rate-limit');
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

test('install asset selection follows the install target, not the asset order', () => {
  const assets = [
    { name: 'Roomcast-0.14.3-beta.2-Windows.exe', size: 149_900_518, url: 'https://example.test/a.exe' },
    { name: 'Roomcast-0.14.3-beta.2-Windows.zip', size: 221_694_588, url: 'https://example.test/a.zip' },
  ];
  assert.equal(selectInstallAsset(assets, 'portable-exe').name, 'Roomcast-0.14.3-beta.2-Windows.exe');
  assert.equal(selectInstallAsset(assets, 'directory').name, 'Roomcast-0.14.3-beta.2-Windows.zip');
  assert.equal(selectInstallAsset([assets[0]], 'directory'), null);
  assert.equal(selectInstallAsset(null, 'directory'), null);
});

test('streaming download reports progress and only lands the verified file', async () => {
  const chunks = [Buffer.alloc(64 * 1024, 1), Buffer.alloc(64 * 1024, 2), Buffer.from('tail')];
  const payload = Buffer.concat(chunks);
  const digest = createHash('sha256').update(payload).digest('hex');
  const total = payload.length;
  const streamBody = () => new ReadableStream({
    start(controller) { for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk)); controller.close(); },
  });
  const response = () => ({ ok: true, status: 200, headers: { get: name => (name.toLowerCase() === 'content-length' ? String(total) : null) }, body: streamBody() });
  const responses = {
    'https://example.test/asset.zip': response(),
    'https://example.test/SHA256.txt': { ok: true, status: 200, text: async () => `${digest}  Roomcast-0.14.3-beta.2-Windows.zip\n` },
  };
  const checker = createUpdateChecker({ currentVersion: '0.14.3-beta.1', fetchImpl: async url => responses[url] || { ok: false, status: 404 } });
  const asset = { name: 'Roomcast-0.14.3-beta.2-Windows.zip', size: total, url: 'https://example.test/asset.zip' };
  const destination = fileURLToPath(new URL('./.update-stream-test.zip', import.meta.url));
  const progress = [];
  try {
    const result = await checker.download(asset, destination, 'https://example.test/SHA256.txt', update => progress.push(update));
    assert.equal(result.bytes, total);
    assert.equal(result.sha256, digest);
    assert.equal(result.verified, true);
    assert.deepEqual(await readFile(destination), payload);
    // No partial file may survive a successful download.
    await assert.rejects(() => readFile(`${destination}.part`));
    assert.equal(progress[0].phase, 'connecting');
    assert.equal(progress[0].total, total);
    assert.equal(progress.at(-1).phase, 'verifying');
    const lastDownload = progress.filter(item => item.phase === 'downloading').at(-1);
    assert.equal(lastDownload.received, total);
    assert.ok(progress.every(item => item.received <= total));
  } finally {
    await rm(destination, { force: true });
    await rm(`${destination}.part`, { force: true });
  }
});

test('a tampered streamed payload removes the partial file and keeps the destination', async () => {
  const good = Buffer.from('original-installed-archive');
  const destination = fileURLToPath(new URL('./.update-stream-reject.zip', import.meta.url));
  await writeFile(destination, good);
  const response = () => ({
    ok: true, status: 200,
    headers: { get: () => null },
    body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(Buffer.from('tampered'))); controller.close(); } }),
  });
  const responses = {
    'https://example.test/asset.zip': response(),
    'https://example.test/SHA256.txt': { ok: true, status: 200, text: async () => `${'0'.repeat(64)}  Roomcast-0.14.3-beta.2-Windows.zip\n` },
  };
  const checker = createUpdateChecker({ currentVersion: '0.14.3-beta.1', fetchImpl: async url => responses[url] || { ok: false, status: 404 } });
  try {
    await assert.rejects(
      () => checker.download({ name: 'Roomcast-0.14.3-beta.2-Windows.zip', size: 8, url: 'https://example.test/asset.zip' }, destination, 'https://example.test/SHA256.txt'),
      /SHA256 与发布页不一致/,
    );
    assert.deepEqual(await readFile(destination), good);
    await assert.rejects(() => readFile(`${destination}.part`));
  } finally {
    await rm(destination, { force: true });
    await rm(`${destination}.part`, { force: true });
  }
});
