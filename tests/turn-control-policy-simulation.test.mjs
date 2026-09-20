import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Browser helpers used by src/relay.js.
globalThis.btoa ||= value => Buffer.from(value, 'binary').toString('base64');
globalThis.atob ||= value => Buffer.from(value, 'base64').toString('binary');

const {
  decodeRelayInvite,
  encodeRelayInvite,
  optionalRelayIce,
} = await import('../src/relay.js');

const ROOM_TURN = [
  {
    urls: 'turn:turn.cloudflare.com:3478?transport=udp',
    username: 'roomcast-temporary-user',
    credential: 'roomcast-temporary-secret',
  },
  {
    urls: 'turns:turn.cloudflare.com:5349?transport=tcp',
    username: 'roomcast-temporary-user',
    credential: 'roomcast-temporary-secret',
  },
];

test('TURN simulation: host TURN ON -> invite relay -> guest TURN OFF still receives room TURN', async () => {
  const owner = await optionalRelayIce({
    settings: {
      enabled: true,
      endpoint: 'https://roomcast.example.com',
      accessKey: 'owner-only-key',
    },
    fetcher: async () => ({
      ok: true,
      json: async () => ({ iceServers: ROOM_TURN }),
    }),
  });

  assert.equal(owner.unavailable, false);
  assert.deepEqual(owner.iceServers, ROOM_TURN);

  const inviteRelay = encodeRelayInvite(owner.iceServers);
  assert.ok(inviteRelay.length > 0);

  let guestFetchedOwnWorker = false;
  const guest = await optionalRelayIce({
    settings: {
      enabled: false,
      endpoint: '',
      accessKey: '',
    },
    encoded: inviteRelay,
    fetcher: async () => {
      guestFetchedOwnWorker = true;
      throw new Error('Guest must not need its own Worker');
    },
  });

  assert.equal(guestFetchedOwnWorker, false);
  assert.equal(guest.unavailable, false);
  assert.deepEqual(guest.iceServers, ROOM_TURN);

  const urls = guest.iceServers.flatMap(item =>
    Array.isArray(item.urls) ? item.urls : [item.urls],
  );

  assert.ok(urls.some(url => /^turn:/i.test(url)));
  assert.ok(urls.some(url => /^turns:/i.test(url)));
});

test('TURN simulation: no relay in invite + guest TURN OFF does not fetch TURN', async () => {
  let fetched = false;

  const result = await optionalRelayIce({
    settings: { enabled: false },
    encoded: '',
    fetcher: async () => {
      fetched = true;
      throw new Error('unexpected fetch');
    },
  });

  assert.equal(fetched, false);
  assert.deepEqual(result, {
    iceServers: [],
    unavailable: false,
  });
});

test('TURN simulation: corrupt relay fails explicitly instead of silently becoming a valid relay', async () => {
  const result = await optionalRelayIce({
    settings: { enabled: false },
    encoded: 'not_a_valid_roomcast_turn_payload',
  });

  assert.equal(result.unavailable, true);
  assert.deepEqual(result.iceServers, []);
  assert.match(result.reason, /(损坏|版本|TURN|中继)/);
});

test('TURN simulation: current p2p join path feeds invite TURN into PeerJS CONTROL before connectRemote', async () => {
  const source = await readFile(
    new URL('../src/p2p.js', import.meta.url),
    'utf8',
  );

  // Invite parser must read room-provided relay credentials.
  assert.match(
    source,
    /searchParams\s*\.\s*get\(\s*['"]relay['"]\s*\)/,
  );

  // Joining path must pass the invite relay into optionalRelayIce().
  assert.match(
    source,
    /optionalRelayIce\s*\(\s*\{[\s\S]*?encoded:\s*relayValue[\s\S]*?\}\s*\)/,
  );

  // Returned room relay must be added to CONTROL ICE.
  assert.match(
    source,
    /this\.controlIceServers\s*=\s*\[\s*\.\.\.P2P_ICE,\s*\.\.\.relay,\s*\]/,
  );

  // openPeer() must give CONTROL PeerJS those exact ICE servers.
  assert.match(
    source,
    /config:\s*\{[\s\S]*?iceServers:\s*this\.controlIceServers[\s\S]*?iceTransportPolicy:\s*['"]all['"]/,
  );

  // CONTROL DataChannel is established before room:join.
  const connectRemoteAt = source.indexOf('await this.connectRemote()');
  const roomJoinAt = source.indexOf("'room:join'", connectRemoteAt);

  assert.ok(connectRemoteAt >= 0, 'connectRemote() missing');
  assert.ok(roomJoinAt > connectRemoteAt, 'room:join should happen after CONTROL connection');
});

test('TURN simulation: relay invitation round-trips without leaking owner Worker access key', () => {
  const encoded = encodeRelayInvite(ROOM_TURN);
  const decoded = decodeRelayInvite(encoded);

  assert.deepEqual(decoded, ROOM_TURN);

  const plain = Buffer.from(
    encoded.replace(/-/g, '+').replace(/_/g, '/') +
      '='.repeat((4 - encoded.length % 4) % 4),
    'base64',
  ).toString('utf8');

  assert.equal(plain.includes('owner-only-key'), false);
  assert.equal(plain.includes('roomcast.example.com'), false);
});
