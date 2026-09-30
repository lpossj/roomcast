import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Keep the unique control-channel wiring check; relay behavior is tested in relay.test.mjs.
test('invite TURN reaches the PeerJS control connection before the room join', async () => {
  const source = await readFile(new URL('../src/p2p.js', import.meta.url), 'utf8');
  assert.match(source, /searchParams\s*\.\s*get\(\s*['"]relay['"]\s*\)/);
  assert.match(source, /optionalRelayIce\s*\(\s*\{[\s\S]*?encoded:\s*relayValue[\s\S]*?\}\s*\)/);
  assert.match(source, /this\.controlIceServers\s*=\s*\[\s*\.\.\.P2P_ICE,\s*\.\.\.relay,\s*\]/);
  assert.match(source, /config:\s*\{[\s\S]*?iceServers:\s*this\.controlIceServers[\s\S]*?iceTransportPolicy:\s*['"]all['"]/);
  const connectAt = source.indexOf('await this.connectRemote()');
  assert.ok(connectAt >= 0);
  assert.ok(source.indexOf("'room:join'", connectAt) > connectAt);
});
