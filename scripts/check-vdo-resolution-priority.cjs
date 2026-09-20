const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const publisherPath = path.join(root, 'src', 'transports', 'vdo-screen-publisher.js');
const transportPath = path.join(root, 'src', 'transports', 'vdo-transport.js');
const p2pPath = path.join(root, 'src', 'p2p.js');

const publisher = fs.readFileSync(publisherPath, 'utf8');
const transport = fs.readFileSync(transportPath, 'utf8');
const p2p = fs.readFileSync(p2pPath, 'utf8');

assert.match(publisher, /const clonedTrack\s*=\s*\n?\s*track\.clone\(\)/, 'VDO publisher must tune only cloned tracks.');
assert.match(publisher, /clonedTrack\.contentHint\s*=\s*\n?\s*'detail'/, 'VDO cloned video track must prefer detail/resolution.');
assert.doesNotMatch(publisher, /sourceStream[^\n]*contentHint|source[^\n]*contentHint/, 'Original Roomcast source track must not be mutated.');
assert.match(transport, /turnServers:\s*false/, 'VDO TURN must remain disabled.');
assert.match(transport, /forceTURN:\s*false/, 'VDO forceTURN must remain disabled.');
assert.match(transport, /autoRelay:\s*false/, 'VDO autoRelay must remain disabled.');
assert.match(p2p, /createVdoScreenPublisher/, 'P2P/VDO race wiring must remain present.');

console.log('[VDO resolution priority] cloned video track contentHint=detail: PASS');
console.log('[VDO resolution priority] original Roomcast stream untouched: PASS');
console.log('[VDO resolution priority] VDO direct-only invariants preserved: PASS');
