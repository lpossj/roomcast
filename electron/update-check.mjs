// Update check for the Windows desktop build.
//
// Roomcast ships a portable EXE plus a ZIP and an NSIS installer, and the builds are not
// code signed yet. Silently downloading and executing an unsigned binary would be a
// security downgrade, and a portable EXE cannot replace itself while it is running, so
// this module deliberately stops at: detect a newer release, show its notes, then let the
// user download the official asset and verify it against the release's SHA256.txt.
//
// The release listing is unauthenticated (60 requests/hour per IP), so callers are
// expected to cache the result instead of polling.

import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const RELEASE_API = 'https://api.github.com/repos/lpossj/roomcast/releases?per_page=30';
// Always reachable fallback: even when the API check or the download times out, the user
// must be able to open the release page and download by hand.
export const RELEASES_PAGE = 'https://github.com/lpossj/roomcast/releases';
const CHECK_TIMEOUT_MS = 15000;
const DOWNLOAD_TIMEOUT_MS = 600000;

function friendlyError(error, action) {
  const name = String(error?.name || '');
  const message = String(error?.message || '');
  if (name === 'TimeoutError' || name === 'AbortError' || /aborted|timeout/i.test(message)) {
    return Object.assign(new Error(`${action}超时（网络不稳定或代理受限）。可以用"打开发布页"在浏览器里手动下载。`), { code: 'timeout' });
  }
  return Object.assign(new Error(`${action}失败：${message || '网络错误'}`), { code: 'network' });
}

function parseVersion(value) {
  const match = String(value || '').trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function comparePrerelease(left, right) {
  // A version with a prerelease sorts below the same version without one.
  if (!left.length && !right.length) return 0;
  if (!left.length) return 1;
  if (!right.length) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const numericA = /^\d+$/.test(a);
    const numericB = /^\d+$/.test(b);
    if (numericA && numericB) {
      const difference = Number(a) - Number(b);
      if (difference) return difference < 0 ? -1 : 1;
      continue;
    }
    if (numericA !== numericB) return numericA ? -1 : 1;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) throw new Error(`无法比较版本号：${left} / ${right}`);
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

export const isPrereleaseVersion = value => Boolean(parseVersion(value)?.prerelease.length);

export function selectLatestRelease(releases, currentVersion) {
  const currentIsPrerelease = isPrereleaseVersion(currentVersion);
  const candidates = [];
  for (const release of Array.isArray(releases) ? releases : []) {
    if (!release || release.draft) continue;
    // A stable install is never pushed onto a prerelease.
    if (release.prerelease && !currentIsPrerelease) continue;
    const version = String(release.tag_name || '').replace(/^v/i, '');
    if (!parseVersion(version)) continue;
    candidates.push({ release, version });
  }
  candidates.sort((a, b) => compareVersions(a.version, b.version));
  const newest = candidates.at(-1);
  if (!newest) return null;
  if (compareVersions(newest.version, currentVersion) <= 0) return null;
  return newest;
}

export function findChecksum(text, assetName) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (match && match[2].trim() === assetName) return match[1].toLowerCase();
  }
  return '';
}

function describeRelease(release, version) {
  const assets = (release.assets || [])
    .filter(asset => asset && typeof asset.name === 'string' && typeof asset.browser_download_url === 'string')
    .map(asset => ({ name: asset.name, size: Number(asset.size) || 0, url: asset.browser_download_url }));
  const checksum = assets.find(asset => /^SHA256\.txt$/i.test(asset.name));
  return {
    version,
    tag: String(release.tag_name || ''),
    name: String(release.name || release.tag_name || ''),
    notes: String(release.body || '').trim(),
    publishedAt: String(release.published_at || ''),
    pageUrl: String(release.html_url || ''),
    prerelease: Boolean(release.prerelease),
    checksumUrl: checksum ? checksum.url : '',
    // The Windows desktop artifacts a user can actually run, newest-named first.
    assets: assets.filter(asset => /^Roomcast-.*-Windows\.(?:exe|zip)$/i.test(asset.name)).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export function createUpdateChecker({ currentVersion, fetchImpl, apiUrl = RELEASE_API, timeoutMs = CHECK_TIMEOUT_MS }) {
  if (typeof fetchImpl !== 'function') throw new Error('更新检查缺少网络实现。');

  async function request(url, { timeoutMs: limit = timeoutMs, action = '更新检查', ...options } = {}) {
    let response;
    try {
      response = await fetchImpl(url, {
        redirect: 'follow',
        ...options,
        signal: AbortSignal.timeout(limit),
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(options.headers || {}) },
      });
    } catch (error) {
      throw friendlyError(error, action);
    }
    if (response.status === 403 || response.status === 429) {
      throw Object.assign(new Error('GitHub 接口请求过于频繁，请稍后再试，或直接用"打开发布页"手动下载。'), { code: 'rate-limit' });
    }
    if (!response.ok) throw Object.assign(new Error(`更新检查失败：HTTP ${response.status}`), { code: 'http' });
    return response;
  }

  async function check() {
    const releases = await (await request(apiUrl)).json();
    const newest = selectLatestRelease(releases, currentVersion);
    if (!newest) return { available: false, current: currentVersion };
    return { available: true, current: currentVersion, ...describeRelease(newest.release, newest.version) };
  }

  async function download(asset, destination, checksumUrl = '') {
    const response = await request(asset.url, { timeoutMs: DOWNLOAD_TIMEOUT_MS, action: '下载更新包' });
    let bytes;
    try {
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      throw friendlyError(error, '下载更新包');
    }
    let expected = '';
    if (checksumUrl) {
      try { expected = findChecksum(await (await request(checksumUrl)).text(), asset.name); } catch { expected = ''; }
    }
    const actual = createHash('sha256').update(bytes).digest('hex');
    // A published checksum that does not match is a hard failure; a release without one
    // still downloads, but the result is reported as unverified.
    if (expected && actual !== expected) {
      throw Object.assign(new Error(`下载校验失败：${asset.name} 的 SHA256 与发布页不一致，文件未保存。`), { code: 'checksum' });
    }
    try {
      await writeFile(destination, bytes);
    } catch (error) {
      throw Object.assign(new Error(`无法写入下载目录：${error.message}。可以用"打开发布页"手动下载。`), { code: 'write' });
    }
    return { path: destination, bytes: bytes.length, sha256: actual, verified: Boolean(expected), expected };
  }

  return { check, download };
}
