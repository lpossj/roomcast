import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const root = process.cwd();
const profile = path.join(root, 'test-results', 'preferences-profile');
await mkdir(profile, { recursive: true });

async function launch(index) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    executablePath: process.env.ROOMCAST_SMOKE_EXE || path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
    args: process.env.ROOMCAST_SMOKE_EXE ? [] : [root],
    env: {
      ...env, ROOMCAST_TEST_MODE: '1', ROOMCAST_PROFILE_DIR: profile,
      ROOMCAST_DATA_DIR: root, PORT: String(3290 + index),
    },
    timeout: 45000,
  });
  const page = await app.firstWindow();
  await page.waitForURL(`http://127.0.0.1:${3290 + index}/`);
  return { app, page };
}

const expected = { enabled: true, endpoint: 'https://roomcast-turn.example.workers.dev', accessKey: 'secret-test-value' };
const first = await launch(0);
assert.equal(await first.page.evaluate(() => { const pc = new RTCPeerConnection(); const policy = pc.getConfiguration().iceTransportPolicy; pc.close(); return policy; }), 'all');
assert.equal(await first.page.evaluate(() => RTCPeerConnection.roomcastIcePolicy), true);
assert.equal(await first.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.session.storagePath), null);
assert.deepEqual(await first.page.evaluate(() => ({ copy: typeof window.roomcast.copyText, read: typeof window.roomcast.readText })), { copy: 'function', read: 'undefined' });
assert.equal((await first.page.evaluate(() => window.roomcast.copyText('Roomcast native clipboard smoke'))).ok, true);
assert.equal(await first.app.evaluate(({ clipboard }) => clipboard.readText()), 'Roomcast native clipboard smoke');
await first.page.evaluate(() => { localStorage.setItem('chat-test', 'private draft'); sessionStorage.setItem('chat-test', 'private draft'); });
assert.equal(await first.page.evaluate(value => window.roomcast.setPreference('relaySettings', value), expected), true);
assert.equal(await first.page.evaluate(() => window.roomcast.setPreference('captureEngine', 'legacy-external')), false);
const clipboardProbe = `Roomcast clipboard ${Date.now()}`;
assert.deepEqual(await first.page.evaluate(value => window.roomcast.copyText(value), clipboardProbe), { ok: true });
assert.equal(await first.app.evaluate(({ clipboard }) => clipboard.readText()), clipboardProbe);
await first.app.close();

const second = await launch(1);
assert.equal(await second.page.evaluate(() => localStorage.getItem('chat-test')), null);
assert.equal(await second.page.evaluate(() => sessionStorage.getItem('chat-test')), null);
const relaySettings = await second.page.evaluate(() => window.roomcast.getPreference('relaySettings'));
assert.equal(relaySettings.enabled, expected.enabled);
assert.equal(relaySettings.endpoint, expected.endpoint);
assert.equal(relaySettings.accessKey, '');
assert.equal(relaySettings.hasAccessKey, true);
assert.equal(await second.page.evaluate(() => window.roomcast.getPreference('captureEngine')), undefined);
await second.app.close();
console.log(JSON.stringify({ ok: true, memoryOnlySession: true, chatStorageCleared: true, persistedAcrossDifferentOrigins: true, nativeClipboardWrite: true, encryptedFile: path.join(profile, 'preferences.bin') }));
