import test from 'node:test';
import assert from 'node:assert/strict';

// Browser helpers used by the renderer module.
globalThis.btoa ||= value => Buffer.from(value, 'binary').toString('base64');
globalThis.atob ||= value => Buffer.from(value, 'base64').toString('binary');

const { decodeRelayInvite, encodeRelayInvite, fetchRelayIce, optionalRelayIce } = await import('../src/relay.js');

const ice = [
  { urls: 'turn:turn.cloudflare.com:3478?transport=udp', username: 'temporary-user', credential: 'temporary-secret' },
  { urls: 'turns:turn.cloudflare.com:5349?transport=tcp', username: 'temporary-user', credential: 'temporary-secret' },
];

test('relay invite contains only sanitized short-lived ICE credentials', () => {
  const value = encodeRelayInvite(ice);
  assert.match(value, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeRelayInvite(value), ice);
  assert.throws(() => decodeRelayInvite('bad!value'), /无效/);
  assert.throws(() => encodeRelayInvite([{ urls: 'https://internal.example' }]), /TURN/);
});

test('relay credentials accept custom HTTPS Worker origins and reject unsafe URLs', async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ iceServers: ice }) };
  };
  const result = await fetchRelayIce({ enabled: true, endpoint: 'https://roomcast.example.com', accessKey: 'local-secret' }, fetcher);
  assert.deepEqual(result, ice);
  assert.equal(calls[0].url, 'https://roomcast.example.com');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer local-secret');
  for (const endpoint of ['http://roomcast.example.com', 'https://user@roomcast.example.com', 'https://roomcast.example.com/api', 'https://roomcast.example.com?x=1', 'https://roomcast.example.com/#x', 'https://127.0.0.1']) {
    await assert.rejects(() => fetchRelayIce({ enabled: true, endpoint, accessKey: 'x' }, fetcher), /HTTPS/);
  }
});

test('TURN Worker timeout, 401 and 500 degrade to an empty optional relay list', async () => {
  const settings = { enabled: true, endpoint: 'https://roomcast.example.com', accessKey: 'local-secret' };
  const failures = [
    async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); },
    async () => new Response('{}', { status: 401 }),
    async () => new Response('{}', { status: 500 }),
  ];
  for (const fetcher of failures) {
    const result = await optionalRelayIce({ settings, fetcher });
    assert.deepEqual(result.iceServers, []);
    assert.equal(result.unavailable, true);
  }
});


test('room-provided TURN credentials work even when the joining client has local TURN disabled', async () => {
  const encoded = encodeRelayInvite(ice);

  const joined = await optionalRelayIce({
    settings: { enabled: false },
    encoded,
  });

  assert.deepEqual(joined, {
    iceServers: ice,
    unavailable: false,
  });
});

test('local TURN OFF does not fetch TURN when the invite carries no relay credentials', async () => {
  let fetched = false;

  const result = await optionalRelayIce({
    settings: { enabled: false },
    fetcher: async () => {
      fetched = true;
      throw new Error('should not fetch');
    },
  });

  assert.equal(fetched, false);
  assert.deepEqual(result, {
    iceServers: [],
    unavailable: false,
  });
});
