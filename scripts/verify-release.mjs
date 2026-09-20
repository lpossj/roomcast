import { extractFile } from '@electron/asar';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const packageInfo = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const version = packageInfo.version;
const output = path.join(root, `.test/release-${version}`);
const profile = path.join(output, 'portable-profile');
await mkdir(profile, { recursive: true });

const executablePath = path.join(root, `release/Roomcast-${version}-Windows.exe`);

const env = {
  ...process.env,
  ROOMCAST_TEST_MODE: '1',
  ROOMCAST_PROFILE_DIR: profile,
  ROOMCAST_DATA_DIR: path.join(output, 'portable-data')
};

delete env.ELECTRON_RUN_AS_NODE;

let child, browser;

const report = {
  scope: 'portable EXE welcome screen; build archive/resources; no external connectivity',
  previousAttempt: 'Electron launcher timed out attaching through portable wrapper'
};

try {
  child = spawn(
    executablePath,
    ['--remote-debugging-port=0'],
    {
      env,
      windowsHide: true,
      stdio: 'ignore'
    }
  );

  let launchError;

  child.on('error', error => {
    launchError = error;
  });

  const deadline = Date.now() + 45000;
  let port = 0;

  while (!port && Date.now() < deadline) {
    if (launchError) throw launchError;

    port = Number(
      (
        await readFile(
          path.join(profile, 'DevToolsActivePort'),
          'utf8'
        ).catch(() => '')
      ).split('\n')[0]
    );

    if (!port) {
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }

  assert.ok(
    port,
    'portable executable did not expose Chromium debugging endpoint'
  );

  browser = await chromium.connectOverCDP(
    `http://127.0.0.1:${port}`
  );

  let page = browser.contexts()[0].pages()[0];

  if (!page) {
    page = await browser
      .contexts()[0]
      .waitForEvent('page', {
        timeout: 15000
      });
  }

  await page
    .getByRole('heading', {
      name: '欢迎来到同屏'
    })
    .waitFor({
      timeout: 30000
    });

  assert.equal(
    await page.evaluate(() => window.roomcast?.desktop),
    true
  );

  report.welcomeScreen = true;

  const asar = path.join(
    root,
    'release/win-unpacked/resources/app.asar'
  );

  report.version = JSON.parse(
    extractFile(asar, 'package.json').toString()
  ).version;

  assert.equal(
    report.version,
    version
  );

  report.resources = [];

  for (
    const file of [
      'loopback-capture/loopback_capture_addon.node'
    ]
  ) {
    const bytes = (
      await stat(
        path.join(
          root,
          'release/win-unpacked/resources/runtime',
          file
        )
      )
    ).size;

    assert.ok(bytes > 0);

    report.resources.push({
      file,
      bytes
    });
  }

  await assert.rejects(
    access(
      path.join(
        root,
        'release/win-unpacked/resources/runtime/mediamtx/mediamtx.exe'
      )
    ),
    { code: 'ENOENT' },
    'MediaMTX must not be packaged in the release'
  );

  for (const legacyDoc of [
    'Cloudflare-Quick-Tunnel.md',
    'quick-tunnel-unverified-changes.md',
  ]) {
    await assert.rejects(
      access(
        path.join(
          root,
          'release/win-unpacked/resources/docs',
          legacyDoc
        )
      ),
      { code: 'ENOENT' },
      `legacy Quick Tunnel document must not be packaged: ${legacyDoc}`
    );
  }

  report.ok = true;
} catch (error) {
  report.ok = false;
  report.error = error.stack;
  process.exitCode = 1;
} finally {
  if (browser) {
    for (
      const page
      of browser.contexts()[0].pages()
    ) {
      await page
        .evaluate(() => window.close())
        .catch(() => { });
    }

    await browser
      .close()
      .catch(() => { });
  }

  if (
    child
    && child.exitCode === null
  ) {
    child.kill();
  }

  await writeFile(
    path.join(output, 'report.json'),
    JSON.stringify(
      report,
      null,
      2
    )
  );

  console.log(
    JSON.stringify(
      report,
      null,
      2
    )
  );
}
