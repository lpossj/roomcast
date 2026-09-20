import { _electron as electron } from 'playwright';
import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const output = path.join(root, 'test-results', 'port-conflict');
await mkdir(output, { recursive: true });
const blocker = createServer((_req, res) => res.end('occupied'));
await new Promise((resolve, reject) => blocker.once('error', reject).listen(3210, '127.0.0.1', resolve));

let desktop;
try {
  const env = { ...process.env };
  delete env.PORT;
  delete env.ELECTRON_RUN_AS_NODE;
  desktop = await electron.launch({
    executablePath: path.join(root, 'release', 'win-unpacked', 'Roomcast.exe'),
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    env: {
      ...env,
      ROOMCAST_TEST_MODE: '1',
      ROOMCAST_PROFILE_DIR: path.join(output, 'profile'),
      ROOMCAST_DATA_DIR: path.join(output, 'data'),
    },
    timeout: 45000,
  });
  const page = await desktop.firstWindow();
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/$/, { timeout: 25000 });
  const url = new URL(page.url());
  assert.notEqual(url.port, '3210');
  const health = await page.evaluate(() => fetch('/api/health').then(response => response.json()));
  assert.equal(health.ok, true);
  console.log(JSON.stringify({ ok: true, occupiedPort: 3210, selectedPort: Number(url.port), version: health.version }));
} finally {
  await desktop?.close().catch(() => {});
  await new Promise(resolve => blocker.close(resolve));
}
