import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeWorkerOrigin, trustedWorkerOrigin, validPublicInviteLink } from '../electron/worker-origin.mjs';

test('custom HTTPS Worker root origins are normalized and legacy workers.dev remains compatible', () => {
  assert.equal(normalizeWorkerOrigin(' https://roomcast.example.com/ '), 'https://roomcast.example.com');
  assert.equal(trustedWorkerOrigin('https://roomcast.example.com', 'https://roomcast.example.com/'), 'https://roomcast.example.com');
  assert.equal(trustedWorkerOrigin('https://legacy.account.workers.dev'), 'https://legacy.account.workers.dev');
  assert.equal(trustedWorkerOrigin('https://unconfigured.example.com', 'https://roomcast.example.com'), '');
});

test('Worker origins reject HTTP, credentials, ports, paths, query, hash, IP and local names', () => {
  for (const value of [
    'http://roomcast.example.com', 'https://user:pass@roomcast.example.com', 'https://roomcast.example.com:8443',
    'https://roomcast.example.com/api', 'https://roomcast.example.com?x=1', 'https://roomcast.example.com/#x',
    'https://127.0.0.1', 'https://localhost', 'https://roomcast.local',
  ]) assert.equal(normalizeWorkerOrigin(value), '', value);
});

test('public invite links must use the configured or legacy Worker origin and exact shape', () => {
  const token = 'j'.repeat(43);
  assert.equal(validPublicInviteLink(`https://roomcast.example.com/join/A1B2C3D4#j=${token}`, 'https://roomcast.example.com'), true);
  assert.equal(validPublicInviteLink(`https://legacy.account.workers.dev/join/A1B2C3D4#j=${token}`), true);
  assert.equal(validPublicInviteLink(`https://other.example.com/join/A1B2C3D4#j=${token}`, 'https://roomcast.example.com'), false);
  assert.equal(validPublicInviteLink(`https://roomcast.example.com/join/A1B2C3D4?x=1#j=${token}`, 'https://roomcast.example.com'), false);
});
