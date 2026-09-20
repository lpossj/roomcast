import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { clientIceServers } from '../server/ice.mjs';

test('TURN credentials are per-member, expiring HMACs and contain no shared secret', () => {
  const config = { turnSharedSecret: 'test-private-secret', turnUrls: ['turn:turn.example.org:3478?transport=udp'], iceServers: [] };
  const [a] = clientIceServers(config, 'alice', 1000);
  const [b] = clientIceServers(config, 'bob', 1000);
  assert.equal(a.username, '86401:alice');
  assert.equal(a.credential, createHmac('sha1', config.turnSharedSecret).update(a.username).digest('base64'));
  assert.notEqual(a.credential, b.credential);
  assert.equal(JSON.stringify(a).includes(config.turnSharedSecret), false);
});
