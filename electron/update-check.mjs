// Update check for the Windows desktop build.
//
// Roomcast ships a portable EXE plus a ZIP and an NSIS installer, and the builds are not
// code signed yet. This module owns the network side of the update: find a newer release,
// describe its notes and Windows assets, then download one asset while hashing it against
// the release's SHA256.txt. Deciding whether the result may be installed, and replacing
// the running program, is deliberately kept in update-install.mjs so that verification can
// never be skipped by the installer.
//
// The release listing is unauthenticated (60 requests/hour per IP), so callers are
// expected to cache the result instead of polling.

import { createHash } from 'node:crypto';
import { open, rename, unlink, writeFile } from 'node:fs/promises';

const RELEASE_API = 'https://api.github.com/repos/lpossj/roomcast/releases?per_page=30';
// Always reachable fallback: even when the API check or the download times out, the user
// must be able to open the release page and download by hand.
export const RELEASES_PAGE = 'https://github.com/lpossj/roomcast/releases';
// GitHub's unauthenticated API allows 60 requests per hour per IP address, which a shared,
// proxied or VPN address can exhaust with nothing the user can do about it. Roomcast already
// publishes a static version manifest for the fixed web entry (no quota, no API), and the
// release workflow always uploads artifacts under predictable names, so the check can
// continue without the API. Verification never changes: SHA256.txt is still required.
export const VERSION_MANIFEST_URL = 'https://lpossj.github.io/roomcast/version.json';
const RELEASE_DOWNLOAD_BASE = 'https://github.com/lpossj/roomcast/releases/download';
const RELEASE_NOTES_BASE = 'https://raw.githubusercontent.com/lpossj/roomcast';
const CHECK_TIMEOUT_MS = 15000;
const DOWNLOAD_TIMEOUT_MS = 600000;
// Progress callbacks feed an IPC channel and a progress bar; one report per 200 ms is
// smooth enough and keeps a 220 MB download from flooding the renderer.
const PROGRESS_INTERVAL_MS = 200;

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

// The installer needs exactly one artifact: the portable EXE replaces a single file, the
// ZIP replaces a directory. Picking it here keeps the renderer from naming a file it could
// get wrong, and keeps the "which asset" rule next to the "which assets exist" rule.
export function selectInstallAsset(assets, kind) {
  const pattern = kind === 'portable-exe' ? /\.exe$/i : /\.zip$/i;
  for (const asset of Array.isArray(assets) ? assets : []) {
    if (asset && pattern.test(String(asset.name || ''))) return asset;
  }
  return null;
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
    try {
      const releases = await (await request(apiUrl)).json();
      const newest = selectLatestRelease(releases, currentVersion);
      if (!newest) return { available: false, current: currentVersion };
      return { available: true, current: currentVersion, ...describeRelease(newest.release, newest.version) };
    } catch (error) {
      // Rate limits and transient API failures must not disable updates. Fall back to the
      // published manifest; if that fails too, report the original API problem.
      const fallback = await checkViaManifest().catch(() => null);
      if (fallback) return fallback;
      throw error;
    }
  }

  // Version + asset URLs without the GitHub API. Release notes are fetched from the tagged
  // source (also quota free); if that fails the UI says the notes are unavailable instead of
  // pretending the release has none.
  async function checkViaManifest() {
    const manifest = await (await request(VERSION_MANIFEST_URL, { action: '读取版本清单' })).json();
    const version = String(manifest?.version || '').trim().replace(/^v/i, '');
    if (!parseVersion(version)) {
      throw Object.assign(new Error('版本清单格式无法识别。'), { code: 'manifest' });
    }
    // Same rule as the API path: a stable install is never pushed onto a prerelease.
    if (isPrereleaseVersion(version) && !isPrereleaseVersion(currentVersion)) return { available: false, current: currentVersion };
    if (compareVersions(version, currentVersion) <= 0) return { available: false, current: currentVersion };
    const base = `${RELEASE_DOWNLOAD_BASE}/v${version}`;
    let notes = '';
    try {
      notes = String(await (await request(`${RELEASE_NOTES_BASE}/v${version}/docs/RELEASE_NOTES-${version}.md`, { action: '读取更新说明' })).text())
        .replace(/^#\s+.*\r?\n+/, '')
        .trim();
    } catch { notes = ''; }
    return {
      available: true,
      current: currentVersion,
      version,
      tag: `v${version}`,
      name: `Roomcast ${version}`,
      notes,
      notesUnavailable: !notes,
      publishedAt: '',
      pageUrl: `${RELEASES_PAGE}/tag/v${version}`,
      prerelease: isPrereleaseVersion(version),
      checksumUrl: `${base}/SHA256.txt`,
      // Sizes are unknown here; the download reports progress from content-length instead.
      assets: [`Roomcast-${version}-Windows.exe`, `Roomcast-${version}-Windows.zip`]
        .map(name => ({ name, size: 0, url: `${base}/${name}` })),
      viaManifest: true,
    };
  }

  // Streams the asset to `${destination}.part` while hashing it, so a failed or tampered
  // download never touches the real destination path. `onProgress` receives
  // `{ phase, received, total }` and may throw freely: it is a UI concern.
  async function download(asset, destination, checksumUrl = '', onProgress) {
    let lastReport = 0;
    const report = (phase, received, total, force = false) => {
      if (typeof onProgress !== 'function') return;
      const now = Date.now();
      if (!force && now - lastReport < PROGRESS_INTERVAL_MS) return;
      lastReport = now;
      try { onProgress({ phase, received, total }); } catch { }
    };
    const writeError = error => Object.assign(new Error(`无法写入下载目录：${error.message}。可以用"打开发布页"手动下载。`), { code: 'write' });
    const declaredSize = Number(asset?.size) || 0;
    report('connecting', 0, declaredSize, true);
    const response = await request(asset.url, { timeoutMs: DOWNLOAD_TIMEOUT_MS, action: '下载更新包' });
    const headerSize = Number(response.headers?.get?.('content-length'));
    const total = Number.isFinite(headerSize) && headerSize > 0 ? headerSize : declaredSize;
    const digest = createHash('sha256');
    let bytes = 0;
    const staging = `${destination}.part`;
    let reader = null;
    try { reader = response.body?.getReader?.() ?? null; } catch { reader = null; }
    try {
      if (reader) {
        let handle;
        try { handle = await open(staging, 'w'); } catch (error) { throw writeError(error); }
        try {
          for (;;) {
            let step;
            try { step = await reader.read(); } catch (error) { throw friendlyError(error, '下载更新包'); }
            if (step.done) break;
            const chunk = Buffer.from(step.value.buffer, step.value.byteOffset, step.value.byteLength);
            digest.update(chunk);
            bytes += chunk.length;
            try { await handle.write(chunk); } catch (error) { throw writeError(error); }
            report('downloading', bytes, total);
          }
        } finally { await handle.close().catch(() => { }); }
      } else {
        // Electrons/undici responses without a stream body still have to work.
        let payload;
        try { payload = Buffer.from(await response.arrayBuffer()); } catch (error) { throw friendlyError(error, '下载更新包'); }
        digest.update(payload);
        bytes = payload.length;
        try { await writeFile(staging, payload); } catch (error) { throw writeError(error); }
      }
      report('downloading', bytes, total, true);
    } catch (error) {
      await unlink(staging).catch(() => { });
      throw error;
    }
    let expected = '';
    if (checksumUrl) {
      try { expected = findChecksum(await (await request(checksumUrl)).text(), asset.name); } catch { expected = ''; }
    }
    const actual = digest.digest('hex');
    // A published checksum that does not match is a hard failure; a release without one
    // still downloads, but the result is reported as unverified (and cannot be installed).
    if (expected && actual !== expected) {
      await unlink(staging).catch(() => { });
      throw Object.assign(new Error(`下载校验失败：${asset.name} 的 SHA256 与发布页不一致，文件未保存。`), { code: 'checksum' });
    }
    report('verifying', bytes, total, true);
    try {
      await rename(staging, destination);
    } catch (error) {
      await unlink(staging).catch(() => { });
      throw writeError(error);
    }
    return { path: destination, bytes, sha256: actual, verified: Boolean(expected), expected };
  }

  return { check, download };
}
