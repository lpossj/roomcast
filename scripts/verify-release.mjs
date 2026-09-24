import { extractFile } from '@electron/asar';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const packageInfo = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const version = packageInfo.version;
const output = path.join(root, `.test/release-${version}`);
const profile = path.join(output, 'portable-profile');
await mkdir(profile, { recursive: true });
await rm(path.join(profile, 'DevToolsActivePort'), { force: true });

const executablePath = path.join(root, `release/Roomcast-${version}-Windows.exe`);
const resourcesDir = path.join(root, 'release/win-unpacked/resources');

const env = {
  ...process.env,
  ROOMCAST_TEST_MODE: '1',
  ROOMCAST_PROFILE_DIR: profile,
  ROOMCAST_DATA_DIR: path.join(output, 'portable-data'),
};

delete env.ELECTRON_RUN_AS_NODE;

let child, browser;

const report = {
  scope: 'portable EXE welcome screen; build archive/resources; no external connectivity',
  previousAttempt: 'Electron launcher timed out attaching through portable wrapper',
};

const expectedHashes = new Map([
  ['loopback-capture/loopback_capture_addon.node', '23acf5f229c8e1fc5a70e4519def9d39e8ccd43b47912f364d8b81d93be5a50c'],
  ['loopback-capture/LICENSE', '30085cfcb641f0712d2453402257cfa4d9badef164933954c35e4f6675801e1a'],
  ['obs-source/OBS-Studio-32.1.2-Sources.tar.gz', 'c6532380c68a75327fe8b551461adeca8f184dcbe4015096251a6de76362a554'],
  // The integrated web entry shells out to this binary, so a tampered or missing copy
  // must fail release verification instead of only failing when a user opens 分享房间.
  ['web-invite/cloudflared.exe', '214f5d74f66941d147d054f6cc9d821c60ff6a9b2d5355f6c854c6bee217c548'],
]);

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

try {
  child = spawn(
    executablePath,
    ['--remote-debugging-port=0'],
    {
      env,
      windowsHide: true,
      stdio: 'ignore',
    },
  );

  let launchError;

  child.on('error', error => {
    launchError = error;
  });

  const deadline = Date.now() + 90000;
  let port = 0;

  while (!port && Date.now() < deadline) {
    if (launchError) throw launchError;

    port = Number(
      (
        await readFile(
          path.join(profile, 'DevToolsActivePort'),
          'utf8',
        ).catch(() => '')
      ).split('\n')[0],
    );

    if (!port) {
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }

  assert.ok(port, 'portable executable did not expose Chromium debugging endpoint');

  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);

  let page;
  const pageDeadline = Date.now() + 90000;

  while (!page && Date.now() < pageDeadline) {
    const pages = browser.contexts().flatMap(context => context.pages());
    page = pages.find(candidate => /^https?:\/\/127\.0\.0\.1:\d+(?:\/|$)/.test(candidate.url()));

    if (!page && pages.length) {
      const fallback = pages[0];
      const text = await fallback
        .locator('body')
        .innerText({ timeout: 1000 })
        .catch(() => '');
      if (text.includes('同屏 Roomcast') && text.includes('创建房间')) page = fallback;
    }

    if (!page) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  if (!page) {
    page = browser.contexts()[0]?.pages()[0];
  }

  assert.ok(page, 'portable executable did not open an application page');

  page.on('pageerror', error => {
    (report.pageErrors ??= []).push(error.message);
  });

  page.on('console', message => {
    if (message.type() === 'error') {
      (report.consoleErrors ??= []).push(message.text());
    }
  });

  await page
    .waitForFunction(
      () => {
        const text = document.body?.innerText || '';
        return text.includes('同屏 Roomcast') && text.includes('创建房间');
      },
      null,
      { timeout: 90000 },
    )
    .catch(async error => {
      report.pageUrl = page.url();
      report.bodyText = await page
        .locator('body')
        .innerText()
        .catch(() => '');
      report.screenshot = path.join(output, 'portable-failure.png');
      await page
        .screenshot({ path: report.screenshot, fullPage: true })
        .catch(() => { });
      throw error;
    });

  assert.equal(await page.evaluate(() => window.roomcast?.desktop), true);

  report.welcomeScreen = true;

  const asar = path.join(resourcesDir, 'app.asar');

  report.version = JSON.parse(
    extractFile(asar, 'package.json').toString(),
  ).version;

  assert.equal(report.version, version);

  report.resources = [];
  report.hashes = {};

  for (const [relative, expected] of expectedHashes) {
    const file = path.join(resourcesDir, 'runtime', relative);
    const bytes = (await stat(file)).size;
    assert.ok(bytes > 0, `${relative} 为空`);
    const actual = await sha256(file);
    assert.equal(actual, expected, `${relative} SHA256 不匹配`);
    report.resources.push({ file: relative, bytes });
    report.hashes[relative] = actual;
  }

  for (const relative of [
    'LICENSE',
    'NOTICE',
    'THIRD-PARTY-NOTICES.txt',
    'PRIVACY.md',
    'SECURITY.md',
    'TRADEMARKS.md',
    'ACCEPTABLE_USE.md',
    'CODE_OF_CONDUCT.md',
    'CONTRIBUTING.md',
  ]) {
    assert.ok((await stat(path.join(resourcesDir, relative))).size > 0, `${relative} 缺失`);
  }

  await access(path.join(resourcesDir, 'runtime', 'obs-bundle', 'data', 'obs-studio', 'license', 'gplv2.txt'));

  await assert.rejects(
    access(path.join(resourcesDir, 'runtime', 'mediamtx', 'mediamtx.exe')),
    { code: 'ENOENT' },
    'MediaMTX must not be packaged in the release',
  );

  for (const legacyDoc of [
    'Cloudflare-Quick-Tunnel.md',
    'quick-tunnel-unverified-changes.md',
  ]) {
    await assert.rejects(
      access(path.join(resourcesDir, 'docs', legacyDoc)),
      { code: 'ENOENT' },
      `legacy Quick Tunnel document must not be packaged: ${legacyDoc}`,
    );
  }

  report.ok = true;
} catch (error) {
  report.ok = false;
  report.error = error.stack;
  process.exitCode = 1;
} finally {
  if (browser) {
    for (const page of browser.contexts()[0].pages()) {
      await page.evaluate(() => window.close()).catch(() => { });
    }

    await browser.close().catch(() => { });
  }

  if (child && child.exitCode === null) {
    child.kill();
  }

  await writeFile(
    path.join(output, 'report.json'),
    JSON.stringify(report, null, 2),
  );

  console.log(JSON.stringify(report, null, 2));
}
