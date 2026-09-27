import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeWorkerOrigin, normalizeRelaySettings } from '../electron/worker-origin.mjs';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('actual settings IPC never forwards a hidden saved Worker key to a different origin', async () => {
  const source = await readFile(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  const start = source.indexOf("      ipcMain.on('roomcast:preference-set',");
  const end = source.indexOf("      ipcMain.handle('roomcast:capture-sources',", start);
  const preferences = { relaySettings: { enabled: true, endpoint: 'https://trusted.example.com', accessKey: 'secret-not-exposed-to-renderer' } };
  let handler;
  vm.runInNewContext(source.slice(start, end), {
    ipcMain: { on: (_, callback) => { handler = callback; } }, window: {}, owns: () => true,
    preferenceKeys: new Set(['relaySettings']), preferences, normalizeRelaySettings, savePreferences: () => true,
  });
  const write = (endpoint, accessKey = '') => {
    const event = {};
    handler(event, { key: 'relaySettings', value: { enabled: true, endpoint, accessKey } });
    assert.equal(event.returnValue, true);
    return preferences.relaySettings.accessKey;
  };
  assert.equal(write('https://TRUSTED.example.com/'), 'secret-not-exposed-to-renderer');
  assert.equal(write('https://other.example.com'), '');
  assert.equal(write('https://other.example.com', 'explicit-new-key'), 'explicit-new-key');
  assert.equal(write('invalid'), '');
  assert.equal(normalizeRelaySettings({ enabled: false, endpoint: 'https://other.example.com' }, { endpoint: 'https://other.example.com', accessKey: 'keep-on-toggle' }).accessKey, 'keep-on-toggle');
});

test('custom HTTPS Worker root origins are normalized and legacy workers.dev remains compatible', () => {
  assert.equal(normalizeWorkerOrigin(' https://roomcast.example.com/ '), 'https://roomcast.example.com');
  assert.equal(normalizeWorkerOrigin('https://ROOMCAST.example.com/'), 'https://roomcast.example.com');
  assert.equal(normalizeWorkerOrigin('https://legacy.account.workers.dev'), 'https://legacy.account.workers.dev');

});

test('Worker origins reject HTTP, credentials, ports, paths, query, hash, IP and local names', () => {
  for (const value of [
    'http://roomcast.example.com', 'https://user:pass@roomcast.example.com', 'https://roomcast.example.com:8443',
    'https://roomcast.example.com/api', 'https://roomcast.example.com?x=1', 'https://roomcast.example.com/#x',
    'https://127.0.0.1', 'https://localhost', 'https://roomcast.local',
  ]) assert.equal(normalizeWorkerOrigin(value), '', value);
});

test('retired Worker join URLs are not accepted as TURN root endpoints', () => {
  const token = 'j'.repeat(43);
  for (const value of [
    `https://roomcast.example.com/join/A1B2C3D4#j=${token}`,
    `https://legacy.account.workers.dev/join/A1B2C3D4#j=${token}`,
    `https://other.example.com/join/A1B2C3D4#j=${token}`,
    `https://roomcast.example.com/join/A1B2C3D4?x=1#j=${token}`,
  ]) assert.equal(normalizeWorkerOrigin(value), '', value);
});
