import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import VDONinjaSDK from '@vdoninja/sdk/browser';
import { createVideoFrameBalance, applyVideoFrameBalance } from '../src/video-frame-balance.js';

const publisherSource = (await readFile(new URL('../src/transports/vdo-screen-publisher.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\r?\n/gm, '').replace('export function createVdoScreenPublisher', 'function createVdoScreenPublisher');

test('VDO user FPS and bitrate reach SDK constraints and RTP parameters without touching source tracks', async () => {
  const sdk = Object.create(VDONinjaSDK.prototype);
  sdk._log = () => {};
  for (const quality of [{ fps: 60, bitrate: 6500 }, { fps: 30, bitrate: 12000 }, { fps: 60, bitrate: 0 }]) {
    let media, constraints, parameters = { encodings: [{}] }, sourceStops = 0, cloneStops = 0;
    const clone = { kind: 'video', readyState: 'live',
      applyConstraints: async value => { constraints = value; }, stop: () => cloneStops++ };
    const capture = { active: true, getTracks: () => [{ kind: 'video', readyState: 'live',
      clone: () => clone, stop: () => sourceStops++,
      applyConstraints: () => assert.fail('original capture must not be constrained by VDO') }] };
    const create = vm.runInNewContext(publisherSource + ';createVdoScreenPublisher;', {
      crypto, DOMException,
      MediaStream: class {
        constructor(tracks) { this.tracks = tracks; }
        getTracks() { return this.tracks; }
        getVideoTracks() { return this.tracks.filter(track => track.kind === 'video'); }
      },
      createVdoPublisherDiagnostics: () => ({ start() {}, stop() {}, snapshot() {} }),
      createVdoTransport: () => ({ close: async () => {}, publish: async (stream, options) => {
        media = structuredClone(options.media);
        const config = await sdk._extractPublisherMediaOptions(options);
        await sdk._applyLocalMediaPreferences(stream, config);
        await sdk._applyEncodingPreferencesToConnection({ type: 'publisher', pc: {
          getTransceivers: () => [], getSenders: () => [{ track: clone,
            getParameters: () => structuredClone(parameters), setParameters: async value => { parameters = value; } }],
        } }, config);
      } }),
    });
    const publisher = create(capture, { quality });
    await publisher.ready;
    assert.equal(media.video.codec, 'H264');
    assert.equal(media.video.frameRate, quality.fps);
    assert.deepEqual(constraints, { frameRate: { ideal: quality.fps } });
    assert.equal(parameters.encodings[0].maxBitrate, quality.bitrate > 0 ? quality.bitrate * 1000 : undefined);
    assert.equal(parameters.encodings[0].minBitrate, undefined);
    // SDK publish options do not promise a hard RTP frame-rate cap.
    assert.equal(parameters.encodings[0].maxFramerate, undefined);
    await publisher.close();
    assert.equal(sourceStops, 0);
    assert.ok(cloneStops > 0);
  }
});

test('share settings reach VDO prewarm through the actual room entry point', async t => {
  const observed = [];
  const stub = `export function createVdoScreenPublisher(stream, options) {
    globalThis.__roomcastQualityTest.push(structuredClone(options.quality));
    return { ready: Promise.resolve({ version: 1 }), close: async () => {} };
  }`;
  const source = (await readFile(new URL('../src/p2p.js', import.meta.url), 'utf8'))
    .replace("import { Peer } from 'peerjs';", 'const Peer = null;')
    .replace("from 'socket.io-client'", `from '${import.meta.resolve('socket.io-client')}'`)
    .replace(/from '(\.\/[^']+)'/g, (_, relative) => `from '${new URL(relative, new URL('../src/p2p.js', import.meta.url)).href}'`)
    .replace("'./transports/vdo-screen-publisher.js'", `'data:text/javascript;base64,${Buffer.from(stub).toString('base64')}'`);
  globalThis.__roomcastQualityTest = observed;
  t.after(() => { delete globalThis.__roomcastQualityTest; });
  const { P2PRoom } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const room = new P2PRoom();
  const capture = { active: true, getTracks: () => [] };
  t.after(() => room.stopScreenStream());
  room.setScreenStream(capture, { fps: 60, bitrate: 16000, width: 1920, height: 1080 });
  await room.vdoPublisherReady;
  assert.equal(observed.length, 1);
  assert.deepEqual(observed[0], { width: 1920, height: 1080, fps: 60, bitrate: 16000, performanceMode: 'quality' });
});

test('VDO reuses diagnostics for per-viewer FPS balance and closing prevents further parameter writes', async () => {
  let onVideoStats, sourceStops = 0;
  const clone = { kind: 'video', readyState: 'live', stop() { this.readyState = 'ended'; } };
  const source = { active: true, getTracks: () => [{ kind: 'video', readyState: 'live', clone: () => clone,
    stop: () => sourceStops++ }] };
  const create = vm.runInNewContext(publisherSource + ';createVdoScreenPublisher;', {
    crypto, DOMException, createVideoFrameBalance, applyVideoFrameBalance,
    MediaStream: class { constructor(tracks) { this.tracks = tracks; } getTracks() { return this.tracks; }
      getVideoTracks() { return this.tracks; } },
    createVdoPublisherDiagnostics: options => { onVideoStats = options.onVideoStats; return { start() {}, stop() {}, snapshot() {} }; },
    createVdoTransport: () => ({ publish: async () => {}, close: async () => {} }),
  });
  const publisher = create(source, { quality: { fps: 60, bitrate: 6500 } });
  await publisher.ready;
  const viewer = () => {
    let parameters = { encodings: [{ maxBitrate: 6500000, maxFramerate: 60, scaleResolutionDownBy: 1 }] }, writes = 0;
    const sender = { track: clone, getParameters: () => structuredClone(parameters),
      setParameters: async value => { parameters = structuredClone(value); writes++; } };
    return { pc: { getSenders: () => [sender] }, read: () => parameters.encodings[0], writes: () => writes };
  };
  const weak = viewer(), healthy = viewer();
  for (let i = 0; i < 3; i++) {
    await onVideoStats(weak.pc, [{ delta: { framesEncoded: 120 }, encodeTimeMs: 30, qualityLimitationReason: 'cpu' }]);
    await onVideoStats(healthy.pc, [{ delta: { framesEncoded: 120 }, encodeTimeMs: 4, qualityLimitationReason: 'none' }]);
  }
  assert.equal(weak.read().maxFramerate, 45);
  assert.equal(weak.read().maxBitrate, 6500000);
  assert.equal(weak.read().scaleResolutionDownBy, 1);
  assert.equal(healthy.writes(), 0);
  await publisher.close();
  await onVideoStats(weak.pc, [{ delta: { framesEncoded: 120 }, encodeTimeMs: 30, qualityLimitationReason: 'cpu' }]);
  assert.equal(weak.writes(), 1);
  assert.equal(sourceStops, 0);
});
