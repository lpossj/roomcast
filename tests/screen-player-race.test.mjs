import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { createMediaRaceCoordinator } from '../src/media-race-manager.js';
import { P2P_CONNECT_TIMEOUT_MS, watchPlayableFrame } from '../src/fallback-policy.js';
import { recordP2pNetworkStats } from '../src/p2p-video-policy.js';

// Run the actual connection effect; replace browser/network endpoints, not route logic.
const source = await readFile(new URL('../src/ScreenPlayer.jsx', import.meta.url), 'utf8');
const start = source.indexOf('    const generation = ++playbackGeneration.current;');
const end = source.indexOf('  }, [entered, stream.memberId, iceServers, retry, transport, playback.mode, own]);', start);
assert.ok(start >= 0 && end > start);
const effect = new vm.Script(`(function () { ${source.slice(start, end)} })()`);
const settle = () => new Promise(resolve => setImmediate(resolve));

class Video extends EventTarget {
  readyState = 0;
  videoWidth = 0;
  srcObject = null;
  play() { return Promise.resolve(); }
  pause() {}
}
class Stream {
  tracks = [];
  getTracks() { return this.tracks; }
  getVideoTracks() { return this.tracks.filter(track => track.kind === 'video'); }
  addTrack(track) { this.tracks.push(track); }
  removeTrack(track) { this.tracks = this.tracks.filter(value => value !== track); }
}
class Peer extends EventTarget {
  connectionState = 'connecting';
  addTransceiver() { return { receiver: {}, setCodecPreferences() {} }; }
  getReceivers() { return []; }
  getStats() { return Promise.resolve(new Map()); }
  close() { this.connectionState = 'closed'; }
}

function harness(t, { failOpen = false } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const candidates = [], peers = [], opened = [], vdoRequests = [], viewers = [], visibleRoutes = [];
  const intervals = new Map(), networkSamples = [];
  const transport = new EventEmitter();
  transport.mediaP2P = true;
  transport.openScreen = async (owner, pc, options) => {
    opened.push(options.route || 'p2p');
    if (failOpen && !options.route) throw new Error('P2P offer failed');
    return { session: `session-${opened.length}` };
  };
  transport.closeScreen = async () => {};
  transport.requestVdoScreen = async owner => { vdoRequests.push(owner); return {}; };
  transport.getTurnMediaIceServers = () => [{ urls: 'turn:test.invalid' }];
  const video = new Video();
  const context = vm.createContext({
    entered: true, playback: { mode: 'remote' }, playbackGeneration: { current: 0 },
    videoRef: { current: video }, stream: { memberId: 'owner' }, iceServers: [], transport,
    emptyMetrics: {}, MIN_PLAYOUT_BUFFER_MS: 0, P2P_CONNECT_TIMEOUT_MS,
    adaptivePlayoutTarget: (current, sample) => { networkSamples.push(sample); return current; },
    setState() {}, setSound() {}, setError() {}, setMetrics(value) { if (value.route) visibleRoutes.push(value.route); },
    createMediaRaceCoordinator, watchPlayableFrame, mediaIceServers: value => value,
    recordP2pNetworkStats,
    createRoomcastPeerConnection: () => { const pc = new Peer(); peers.push(pc); return pc; },
    createVdoScreenViewer: () => {
      const viewer = new EventTarget();
      viewer.pc = new Peer();
      viewer.start = async () => viewer.pc;
      viewer.close = async () => { viewer.pc.close(); };
      viewers.push(viewer);
      return viewer;
    },
    document: { createElement: () => { const candidate = new Video(); candidates.push(candidate); return candidate; } },
    MediaStream: Stream, AbortController, performance, console,
    setTimeout, clearTimeout,
    setInterval: callback => { intervals.set(1, callback); return 1; },
    clearInterval: id => intervals.delete(id),
  });
  let cleanup = effect.runInContext(context);
  t.after(() => cleanup());
  return {
    opened, vdoRequests, peers, candidates, viewers, video, visibleRoutes,
    networkSamples,
    sampleStats: () => { for (const callback of intervals.values()) callback(); },
    dispose: () => cleanup(),
    disconnect: () => transport.emit('disconnect'),
    retry() { cleanup(); cleanup = effect.runInContext(context); },
    failP2P() { peers[0].connectionState = 'failed'; peers[0].onconnectionstatechange(); },
    playable(route) {
      const track = { id: route, kind: 'video', getSettings: () => ({ width: 1920, height: 1080 }) };
      if (route === 'p2p') peers[0].ontrack({ track });
      else viewers[0].dispatchEvent(new CustomEvent('track', { detail: { track } }));
      const candidate = candidates[route === 'p2p' ? 0 : 1];
      candidate.readyState = 2; candidate.videoWidth = 1920;
      candidate.dispatchEvent(new Event('loadeddata'));
    },
  };
}

test('ScreenPlayer requests P2P at t=0 and makes no VDO request before 3000ms', async t => {
  const h = harness(t);
  assert.deepEqual(h.opened, ['p2p']);
  assert.equal(h.vdoRequests.length, 0);
  t.mock.timers.tick(2999); await settle();
  assert.equal(h.vdoRequests.length, 0);
  t.mock.timers.tick(1); await settle();
  assert.equal(h.vdoRequests.length, 1);
  assert.equal(h.viewers.length, 1);
  assert.deepEqual(h.opened, ['p2p']);
});

test('ScreenPlayer skips VDO entirely when P2P decodes a frame before three seconds', async t => {
  const h = harness(t);
  t.mock.timers.tick(2500);
  h.playable('p2p');
  t.mock.timers.tick(3000); await settle();
  assert.equal(h.vdoRequests.length, 0);
  assert.equal(h.viewers.length, 0);
  assert.deepEqual(h.visibleRoutes, ['P2P']);
  assert.equal(h.video.srcObject.getVideoTracks()[0].id, 'p2p');
});

test('ScreenPlayer starts VDO on early failed P2P and opens TURN only after VDO also fails', async t => {
  const h = harness(t);
  t.mock.timers.tick(100);
  h.failP2P(); await settle();
  assert.equal(h.vdoRequests.length, 1);
  assert.deepEqual(h.opened, ['p2p']);
  h.viewers[0].dispatchEvent(new CustomEvent('connectionfailed', { detail: { reason: 'failed' } }));
  await settle();
  assert.deepEqual(h.opened, ['p2p', 'turn']);
  t.mock.timers.tick(3000); await settle();
  assert.equal(h.vdoRequests.length, 1);
});

test('a rejected P2P offer also starts VDO without waiting three seconds', async t => {
  const h = harness(t, { failOpen: true });
  await settle();
  assert.equal(h.vdoRequests.length, 1);
  assert.equal(h.peers[0].connectionState, 'closed');
});

for (const action of ['dispose', 'disconnect']) test(`ScreenPlayer ${action} cancels the pending VDO viewer`, async t => {
  const h = harness(t);
  h[action]();
  t.mock.timers.tick(5000); await settle();
  assert.equal(h.vdoRequests.length, 0);
  assert.equal(h.peers[0].connectionState, 'closed');
});

test('ScreenPlayer retry cancels the old delay and gives the new attempt its own three seconds', async t => {
  const h = harness(t);
  t.mock.timers.tick(2000);
  h.retry();
  t.mock.timers.tick(1000); await settle();
  assert.equal(h.vdoRequests.length, 0);
  t.mock.timers.tick(2000); await settle();
  assert.equal(h.vdoRequests.length, 1);
  assert.deepEqual(h.opened, ['p2p', 'p2p']);
});

test('near-simultaneous decoded VDO/P2P frames select P2P once without double playback', async t => {
  const h = harness(t);
  t.mock.timers.tick(3000); await settle();
  h.playable('vdo'); h.playable('p2p');
  assert.deepEqual(h.visibleRoutes, ['P2P']);
  assert.ok(h.candidates.every(candidate => candidate.muted));
  t.mock.timers.tick(1000); await settle();
  assert.deepEqual(h.visibleRoutes, ['P2P']);
  assert.equal(h.viewers[0].pc.connectionState, 'closed');
  assert.equal(h.video.srcObject.getVideoTracks()[0].id, 'p2p');
});

test('ScreenPlayer counts the first loss after a zero baseline and reports recovery from deltas', async t => {
  const h = harness(t);
  const video = { type: 'inbound-rtp', kind: 'video', packetsReceived: 0, packetsLost: 0, timestamp: 1000, bytesReceived: 0 };
  h.peers[0].getStats = async () => new Map([['video', { ...video }]]);
  h.playable('p2p'); await settle();
  assert.equal(h.networkSamples.at(-1).lossRate, 0);
  Object.assign(video, { packetsReceived: 90, packetsLost: 10, timestamp: 2000 });
  h.sampleStats(); await settle();
  assert.equal(h.networkSamples.at(-1).lossRate, 0.1);
  Object.assign(video, { packetsReceived: 190, packetsLost: 10, timestamp: 3000 });
  h.sampleStats(); await settle();
  assert.equal(h.networkSamples.at(-1).lossRate, 0);
  Object.assign(video, { packetsReceived: 2, packetsLost: 0, timestamp: 4000 });
  h.sampleStats(); await settle();
  assert.equal(h.networkSamples.at(-1).lossRate, 0);
});
