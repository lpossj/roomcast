import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createVdoPublisherDiagnostics } from '../src/transports/vdo-publisher-diagnostics.js';

const turn = () => new Promise(resolve => setImmediate(resolve));
const track = (width = 1920, height = 1080) => ({
  kind: 'video', readyState: 'live', contentHint: '',
  getSettings: () => ({ width, height, frameRate: 60, deviceId: 'private-device' }),
  applyConstraints() { assert.fail('diagnostics must not change capture'); },
  stop() { assert.fail('diagnostics must not stop capture'); },
});
const stream = video => ({ getVideoTracks: () => [video] });

function fixture() {
  const original = track(), cloned = track();
  const parameters = { degradationPreference: 'balanced', encodings: [{ scaleResolutionDownBy: 2, maxBitrate: 8000000, maxFramerate: 60, active: true }] };
  const outbound = { id: 'out', type: 'outbound-rtp', kind: 'video', timestamp: 1000, bytesSent: 0, transportId: 'transport', frameWidth: 960, frameHeight: 540, framesPerSecond: 60, targetBitrate: 4000000, qualityLimitationReason: 'none', qualityLimitationDurations: { none: 10, bandwidth: 5, cpu: 0, other: 0 } };
  const report = new Map([
    ['out', outbound],
    ['transport', { selectedCandidatePairId: 'selected' }],
    ['selected', { availableOutgoingBitrate: 9000000, currentRoundTripTime: 0.04, remoteCandidateId: 'private-ip' }],
    ['unselected', { availableOutgoingBitrate: 1 }],
    ['private-ip', { address: '192.0.2.1', usernameFragment: 'private-secret' }],
  ]);
  const pc = {
    connectionState: 'connected',
    getStats: async () => report,
    getSenders: () => [{ track: cloned, getParameters: () => parameters, setParameters: () => assert.fail('diagnostics must not tune encoding') }],
  };
  const monitor = createVdoPublisherDiagnostics({ getConnections: () => [pc], sourceStream: stream(original), isolatedStream: stream(cloned), now: () => outbound.timestamp });
  return { monitor, pc, original, cloned, outbound, parameters, report };
}

test('records bitrate recovery separately from a stuck lower resolution without changing tracks or parameters', async () => {
  const { monitor, outbound, parameters } = fixture();
  const before = structuredClone(parameters);
  await monitor.sample();
  outbound.timestamp += 2000; outbound.bytesSent += 50000;
  outbound.qualityLimitationReason = 'bandwidth';
  await monitor.sample();
  outbound.timestamp += 2000; outbound.bytesSent += 1000000;
  outbound.qualityLimitationReason = 'none';
  await monitor.sample();
  const history = monitor.snapshot();
  const video = history.samples.map(sample => sample.connections[0].outbound[0]);
  assert.deepEqual(video.map(sample => sample.bitrate), [null, 200000, 4000000]);
  assert.equal(video[2].frameWidth, 960);
  assert.equal(video[2].qualityLimitationReason, 'none');
  assert.equal(video[2].targetBitrate, 4000000);
  assert.equal(video[2].availableOutgoingBitrate, 9000000);
  assert.equal(video[2].qualityLimitationDurations.bandwidth, 5);
  assert.equal(history.samples[2].source[0].width, 1920);
  assert.equal(history.samples[2].isolated[0].width, 1920);
  assert.equal(history.samples[2].connections[0].senders[0].encodings[0].scaleResolutionDownBy, 2);
  assert.deepEqual(parameters, before);
  assert.doesNotMatch(JSON.stringify(history), /private-|192\.0\.2\.1|deviceId|usernameFragment/);
  monitor.stop();
});

test('unknown stats and counter resets remain unknown, and a failed viewer does not hide other viewers', async () => {
  const { pc, outbound, report, original, cloned } = fixture();
  const failed = { connectionState: 'failed', getStats: async () => { throw new Error('private endpoint'); } };
  const monitor = createVdoPublisherDiagnostics({ getConnections: () => [failed, pc], sourceStream: stream(original), isolatedStream: stream(cloned) });
  await monitor.sample();
  outbound.timestamp += 2000; outbound.bytesSent = 100000;
  await monitor.sample();
  outbound.timestamp += 2000; outbound.bytesSent = 0;
  delete outbound.targetBitrate;
  report.delete('selected');
  pc.getSenders = () => [{ track: cloned, getParameters: () => { throw new Error('unsupported'); } }];
  await monitor.sample();
  const [broken, healthy] = monitor.snapshot().samples.at(-1).connections;
  assert.equal(broken.status, 'unavailable');
  assert.equal(healthy.status, 'ok');
  assert.equal(healthy.connection, 2);
  assert.equal(healthy.outbound[0].bitrate, null);
  assert.equal(healthy.outbound[0].targetBitrate, null);
  assert.equal(healthy.outbound[0].availableOutgoingBitrate, null);
  assert.equal(healthy.senders[0].encodings, null);
  monitor.stop();
});

test('retains at most 300 independent samples and returns copies', async () => {
  const { monitor, outbound, parameters } = fixture();
  for (let i = 0; i < 305; i++) { outbound.timestamp = i * 2000; await monitor.sample(); }
  parameters.encodings[0].scaleResolutionDownBy = 1;
  const history = monitor.snapshot();
  assert.equal(history.samples.length, 300);
  assert.equal(history.samples[0].at, 10000);
  assert.equal(history.samples[0].connections[0].senders[0].encodings[0].scaleResolutionDownBy, 2);
  history.samples.length = 0;
  assert.equal(monitor.snapshot().samples.length, 300);
  monitor.stop();
});

test('start is idempotent, polls every two seconds and stop cancels the timer', async () => {
  const tasks = new Map();
  const video = track();
  const monitor = createVdoPublisherDiagnostics({
    getConnections: () => [], sourceStream: stream(video), isolatedStream: stream(video),
    schedule: (callback, delay) => { assert.equal(delay, 2000); tasks.set(1, callback); return 1; },
    cancel: id => tasks.delete(id),
  });
  monitor.start(); monitor.start();
  await turn();
  assert.equal(tasks.size, 1);
  assert.equal(monitor.snapshot().samples.length, 1);
  monitor.stop(); monitor.start();
  await monitor.sample();
  assert.equal(tasks.size, 0);
  assert.equal(monitor.snapshot().samples.length, 1);
  assert.equal(monitor.snapshot().stopped, true);
});

test('stop during getStats discards the late result and does not schedule a ghost poll', async () => {
  let finish, reads = 0;
  const video = track();
  const monitor = createVdoPublisherDiagnostics({
    getConnections: () => [{ connectionState: 'connected', getStats: () => { reads++; return new Promise(resolve => { finish = resolve; }); } }],
    sourceStream: stream(video), isolatedStream: stream(video),
    schedule: () => assert.fail('must not schedule after stop'),
  });
  monitor.start();
  const pending = monitor.sample();
  assert.equal(reads, 1);
  monitor.stop();
  finish(new Map());
  await pending; await turn();
  assert.equal(monitor.snapshot().samples.length, 0);
});

test('transport exposes only active publisher connections and never starts SDK for diagnostics', async () => {
  const source = (await readFile(new URL('../src/transports/vdo-transport.js', import.meta.url), 'utf8'))
    .replace("import VDONinjaSDK from '@vdoninja/sdk/browser';", `
      class VDONinjaSDK extends EventTarget {
        connections = new Map([['private-peer', { publisher: { pc: { connectionState: 'connected', lane: 'publisher' } }, viewer: { pc: { lane: 'viewer' } } }], ['closed-peer', { publisher: { pc: { connectionState: 'closed' } } }]]);
        async connect() {} async joinRoom() {} async publish() { return 'published'; }
        stopPublishing() {} async disconnect() {}
      }
    `);
  const { VdoTransport } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const transport = new VdoTransport({ room: 'test', password: 'test' });
  assert.deepEqual(transport.getPublisherConnections(), []);
  assert.equal(transport.state, 'idle');
  const video = track();
  await transport.publish({ ...stream(video), getTracks: () => [video], getAudioTracks: () => [] }, { streamId: 'test' });
  assert.deepEqual(transport.getPublisherConnections(), [{ connectionState: 'connected', lane: 'publisher' }]);
  transport.stopPublishing();
  assert.deepEqual(transport.getPublisherConnections(), []);
  await transport.close();
  assert.deepEqual(transport.getPublisherConnections(), []);
});

test('publisher wiring exports diagnostics and stops sampling on close, failed publish or late publish', async t => {
  const saved = { window: globalThis.window, MediaStream: globalThis.MediaStream };
  t.after(() => {
    if (saved.window === undefined) delete globalThis.window; else globalThis.window = saved.window;
    if (saved.MediaStream === undefined) delete globalThis.MediaStream; else globalThis.MediaStream = saved.MediaStream;
    delete globalThis.__vdoDiagnosticTestTransport;
  });
  globalThis.window = {};
  globalThis.MediaStream = class {
    constructor(tracks) { this.tracks = tracks; this.active = true; }
    getTracks() { return this.tracks; }
    getVideoTracks() { return this.tracks.filter(item => item.kind === 'video'); }
  };
  const source = (await readFile(new URL('../src/transports/vdo-screen-publisher.js', import.meta.url), 'utf8'))
    .replace("import { createVdoTransport } from './vdo-transport.js';", 'const createVdoTransport = () => globalThis.__vdoDiagnosticTestTransport;')
    .replace("from './vdo-publisher-diagnostics.js'", `from '${new URL('../src/transports/vdo-publisher-diagnostics.js', import.meta.url).href}'`);
  const { createVdoScreenPublisher } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  for (const mode of ['ready', 'failed', 'late']) {
    const original = track(), cloned = track();
    let stoppedClones = 0, finishPublish;
    cloned.stop = () => { stoppedClones++; };
    original.clone = () => cloned;
    const input = new MediaStream([original]);
    globalThis.__vdoDiagnosticTestTransport = {
      publish: async () => {
        if (mode === 'failed') throw new Error('publish failed');
        if (mode === 'late') await new Promise(resolve => { finishPublish = resolve; });
      },
      getPublisherConnections: () => [],
      close: async () => {},
    };
    const publisher = createVdoScreenPublisher(input);
    if (mode === 'ready') {
      await publisher.ready; await turn();
      assert.equal(window.roomcastVdoDiagnostics().samples.length, 1);
      await publisher.close();
    } else {
      const rejected = assert.rejects(publisher.ready, mode === 'failed' ? /publish failed/ : /已关闭/);
      if (mode === 'late') { await publisher.close(); finishPublish(); }
      await rejected;
      assert.equal(window.roomcastVdoDiagnostics().samples.length, 0);
    }
    assert.equal(window.roomcastVdoDiagnostics().stopped, true);
    assert.ok(stoppedClones >= 1);
    assert.equal(original.contentHint, '');
  }
});
