import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { createStaticViewer, createWebInvite, DEFAULT_WEB_VIEWER_URL } = require('../electron/web-invite.cjs');

// `npm run check` runs the unit tests before it builds dist/, and dist/ is gitignored,
// so this test must never depend on a previous Vite build. It builds its own fixture
// that mirrors the real output layout.
const fixture = mkdtempSync(path.join(tmpdir(), 'roomcast-web-invite-'));
mkdirSync(path.join(fixture, 'assets'));
writeFileSync(path.join(fixture, 'index.html'), '<!doctype html><html><body><div id="root"></div><script type="module" src="/assets/index-test.js"></script></body></html>');
writeFileSync(path.join(fixture, 'roomcast-pcm-worklet.js'), '// roomcast pcm worklet');
writeFileSync(path.join(fixture, 'favicon.ico'), 'ico');
writeFileSync(path.join(fixture, 'assets', 'index-test.js'), 'console.log("viewer");');
writeFileSync(path.join(fixture, 'assets', 'index-test.css'), 'body{}');

const server = createStaticViewer(fixture);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
// fetch() keeps sockets alive; without this the close() below waits for the keep-alive timeout.
const stop = async instance => {
  instance.closeAllConnections();
  await new Promise(resolve => instance.close(resolve));
};
after(async () => {
  await stop(server);
  rmSync(fixture, { recursive: true, force: true });
});
const base = `http://127.0.0.1:${server.address().port}`;

test('public viewer serves built assets but rejects desktop APIs and writes', async () => {
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<div id="root"><\/div>/);
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const asset = (await (await fetch(base)).text()).match(/src="([^"]+\.js)"/)?.[1];
  assert.ok(asset);
  const assetResponse = await fetch(new URL(asset, base + '/'));
  assert.equal(assetResponse.status, 200);
  assert.match(assetResponse.headers.get('content-type'), /javascript/);
  for (const route of ['/api/config', '/api/local/token', '/socket.io/', '/server/index.mjs', '/assets/../package.json']) {
    assert.equal((await fetch(base + route)).status, 404, route);
  }
  assert.equal((await fetch(base, { method: 'POST' })).status, 405);
});

test('public viewer serves root-level build output such as the worklet and favicon', async () => {
  assert.equal((await fetch(`${base}/roomcast-pcm-worklet.js`)).status, 200);
  assert.equal((await fetch(`${base}/favicon.ico`)).status, 200);
  const head = await fetch(base, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal((await fetch(`${base}/assets/index-test.css`)).status, 200);
  assert.equal((await fetch(`${base}/assets/missing.js`)).status, 404);
});

test('public viewer still starts when the build has no assets directory', async () => {
  const bare = mkdtempSync(path.join(tmpdir(), 'roomcast-web-invite-bare-'));
  writeFileSync(path.join(bare, 'index.html'), '<!doctype html><html><body><div id="root"></div></body></html>');
  const bareServer = createStaticViewer(bare);
  await new Promise(resolve => bareServer.listen(0, '127.0.0.1', resolve));
  try {
    const bareBase = `http://127.0.0.1:${bareServer.address().port}`;
    assert.equal((await fetch(bareBase)).status, 200);
    assert.equal((await fetch(`${bareBase}/assets/index.js`)).status, 404);
  } finally {
    await stop(bareServer);
    rmSync(bare, { recursive: true, force: true });
  }
});

const builtIndex = fileURLToPath(new URL('../dist/index.html', import.meta.url));

test('real Vite build is servable when it is present', { skip: !existsSync(builtIndex) }, async () => {
  const built = createStaticViewer(path.dirname(builtIndex));
  await new Promise(resolve => built.listen(0, '127.0.0.1', resolve));
  try {
    const builtBase = `http://127.0.0.1:${built.address().port}`;
    const page = await fetch(builtBase);
    assert.equal(page.status, 200);
    const html = await page.text();
    const asset = html.match(/src="([^"]+\.js)"/)?.[1];
    assert.ok(asset, '构建产物 index.html 应引用打包后的入口 JS');
    assert.equal((await fetch(new URL(asset, builtBase + '/'))).status, 200);
    assert.equal((await fetch(`${builtBase}/api/config`)).status, 404);
  } finally {
    await stop(built);
  }
});

test('fixed web entry works with no local build or tunnel component', async () => {
  const states = [];
  const entry = createWebInvite({ distDir: 'missing-build', executablePath: 'missing-cloudflared', onState: state => states.push(state) });
  const results = await Promise.all([entry.start(), entry.start()]);
  assert.deepEqual(results, [{ url: DEFAULT_WEB_VIEWER_URL }, { url: DEFAULT_WEB_VIEWER_URL }]);
  await entry.stop();
  assert.deepEqual(states.at(-1), { url: '' });
  assert.deepEqual(await entry.start(), { url: DEFAULT_WEB_VIEWER_URL });
});

test('fixed entry preserves its deployment path and rejects credentials or unsafe schemes', async () => {
  const custom = createWebInvite({ viewerUrl: 'https://viewer.example.org/roomcast/' });
  assert.equal((await custom.start()).url, 'https://viewer.example.org/roomcast/');
  for (const viewerUrl of ['http://viewer.example.org', 'https://name:secret@viewer.example.org', 'https://viewer.example.org:8443', 'https://viewer.example.org/?secret=x', 'https://viewer.example.org/#room=x', 'invalid']) {
    await assert.rejects(createWebInvite({ viewerUrl }).start(), /网页入口/);
  }
});
