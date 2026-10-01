import assert from 'node:assert/strict';
import test from 'node:test';
import { createP2pVideoPolicy, recordP2pNetworkStats, readP2pDiagnostics } from '../src/p2p-video-policy.js';

function createHarness({
  sourceWidth = 1920,
  sourceHeight = 1080,
  sourceFps = 60,
  targetFps = 60,
  bitrate = 6000,
  availableOutgoingBitrate = 3_000_000,
  qualityLimitationReason = 'bandwidth',
  sendDelayMs = 120,
  lossRate = 0.08,
  encodeTimeMs = 0,
} = {}) {
  let now = 0;
  let tick = 0;
  let bytesSent = 0;
  let packetsSent = 0;
  let framesEncoded = 0;
  let limitation = qualityLimitationReason;
  let available = availableOutgoingBitrate;
  let delay = sendDelayMs;
  let loss = lossRate;
  let totalPacketSendDelay = 0;
  let totalEncodeTime = 0;
  const calls = [];
  const settings = {
    width: sourceWidth,
    height: sourceHeight,
    frameRate: sourceFps,
  };
  let parameters = {
    encodings: [{
      active: true,
      maxBitrate: bitrate * 1000,
      maxFramerate: targetFps,
      scaleResolutionDownBy: 1,
    }],
    degradationPreference: 'maintain-resolution',
  };
  const sender = {
    track: {
      readyState: 'live',
      getSettings: () => ({ ...settings }),
    },
    getParameters: () => structuredClone(parameters),
    setParameters: async value => {
      calls.push(structuredClone(value));
      parameters = structuredClone(value);
    },
    calls,
  };
  const pc = {
    connectionState: 'connected',
    getStats: async () => {
      tick += 1;
      bytesSent += 750000;
      packetsSent += 500;
      framesEncoded += sourceFps;
      totalEncodeTime += sourceFps * encodeTimeMs / 1000;
      totalPacketSendDelay += 500 * delay / 1000;
      const report = new Map();
      const pair = {
        id: 'pair:1',
        type: 'candidate-pair',
        availableOutgoingBitrate: available,
        currentRoundTripTime: 0.01,
      };
      report.set('pair:1', pair);
      report.set('transport:1', {
        id: 'transport:1',
        type: 'transport',
        selectedCandidatePairId: 'pair:1',
      });
      report.set('remote:1', { id: 'remote:1', type: 'remote-inbound-rtp',
        timestamp: tick * 1000, fractionLost: loss });
      report.set('outbound:1', {
        id: 'outbound:1',
        type: 'outbound-rtp',
        kind: 'video',
        isRemote: false,
        timestamp: tick * 1000,
        bytesSent,
        packetsSent,
        framesEncoded,
        totalEncodeTime,
        totalPacketSendDelay,
        frameWidth: sourceWidth,
        frameHeight: sourceHeight,
        framesPerSecond: sourceFps,
        qualityLimitationReason: limitation,
        transportId: 'transport:1',
        remoteId: 'remote:1',
      });
      return report;
    },
  };
  const quality = { width: sourceWidth, height: sourceHeight, fps: targetFps, bitrate };
  const policy = createP2pVideoPolicy({
    pc,
    sender,
    quality,
    now: () => now,
    schedule: () => 0,
    cancel: () => {},
  });
  return {
    policy,
    sender,
    quality,
    setAvailable: value => { available = value; },
    setDelay: value => { delay = value; },
    setLoss: value => { loss = value; },
    setLimitation: value => { limitation = value; },
    advance: ms => { now += ms; },
    poll: () => policy.poll(),
    lastEncoding: () => sender.calls.at(-1)?.encodings?.[0] || null,
  };
}

test('P2P 60fps drops to 30fps before lowering resolution, then reaches 720p60', async () => {
  const h = createHarness({ targetFps: 60, bitrate: 6000, availableOutgoingBitrate: 3_000_000 });
  await h.poll();
  await h.poll();
  await h.poll();
  assert.equal(h.sender.calls.length, 1);
  assert.equal(h.lastEncoding().maxFramerate, 30);
  assert.equal(h.lastEncoding().scaleResolutionDownBy, 1);

  await h.poll();
  await h.poll();
  await h.poll();
  assert.equal(h.sender.calls.length, 2);
  assert.equal(h.lastEncoding().maxFramerate, 60);
  assert.equal(h.lastEncoding().scaleResolutionDownBy, 1.5);
});

test('P2P encoder-load balance shares the parameter write with network tiers and retains the selected budget', async () => {
  const h = createHarness({ qualityLimitationReason: 'none', sendDelayMs: 0, lossRate: 0,
    availableOutgoingBitrate: 15000000, encodeTimeMs: 30 });
  for (let i = 0; i < 4; i++) { h.advance(1000); await h.poll(); }
  assert.equal(h.lastEncoding().maxFramerate, 45);
  assert.equal(h.lastEncoding().maxBitrate, 6000000);
  assert.equal(h.lastEncoding().scaleResolutionDownBy, 1);
  h.setDelay(1200);
  for (let i = 0; i < 2; i++) { h.advance(1000); await h.poll(); }
  assert.equal(h.lastEncoding().maxFramerate, 30);
  assert.equal(h.lastEncoding().scaleResolutionDownBy, 1);
  h.policy.stop();
});

test('P2P 30fps setting keeps 30fps and lowers resolution when bitrate remains insufficient', async () => {
  const h = createHarness({ targetFps: 30, bitrate: 4500, availableOutgoingBitrate: 2_500_000 });
  await h.poll();
  await h.poll();
  await h.poll();
  assert.equal(h.sender.calls.length, 1);
  assert.equal(h.lastEncoding().maxFramerate, 30);
  assert.equal(h.lastEncoding().scaleResolutionDownBy, 1.5);

  await h.poll();
  await h.poll();
  await h.poll();
  assert.equal(h.sender.calls.length, 2);
  assert.equal(h.lastEncoding().maxFramerate, 30);
  assert.equal(h.lastEncoding().scaleResolutionDownBy, 2.25);
  assert.ok(h.sender.calls.every(call => call.encodings?.[0]?.maxFramerate === 30));
});

test('P2P 60fps restores 60fps after sustained healthy bitrate', async () => {
  const h = createHarness({ targetFps: 60, bitrate: 6000, availableOutgoingBitrate: 3_000_000 });
  await h.poll();
  await h.poll();
  await h.poll();
  assert.equal(h.lastEncoding().maxFramerate, 30);
  assert.equal(h.lastEncoding().scaleResolutionDownBy, 1);

  h.setAvailable(15_000_000);
  h.setDelay(0); h.setLoss(0); h.setLimitation('none');
  h.advance(20_000);
  for (let index = 0; index < 8; index += 1) await h.poll();
  assert.equal(h.sender.calls.length, 2);
  assert.equal(h.lastEncoding().maxFramerate, 60);
  assert.equal(h.lastEncoding().scaleResolutionDownBy, 1);
});

test('P2P recovers at the selected bitrate after the existing healthy interval', async () => {
  const h = createHarness();
  for (let i = 0; i < 3; i++) await h.poll();
  h.setDelay(0); h.setLoss(0); h.setLimitation('none');
  h.setAvailable(6_000_000);
  h.advance(20_000);
  for (let i = 0; i < 7; i++) await h.poll();
  assert.equal(h.lastEncoding().maxFramerate, 30);
  await h.poll();
  assert.equal(h.lastEncoding().maxFramerate, 60);
  assert.equal(h.lastEncoding().scaleResolutionDownBy, 1);
});

test('P2P does not upgrade on insufficient or unknown bandwidth', async () => {
  for (const available of [5_900_000, null]) {
    const h = createHarness();
    for (let i = 0; i < 3; i++) await h.poll();
    h.setDelay(0); h.setLoss(0); h.setLimitation('none');
    h.setAvailable(available);
    h.advance(20_000);
    for (let i = 0; i < 12; i++) await h.poll();
    assert.equal(h.lastEncoding().maxFramerate, 30);
    assert.equal(h.sender.calls.length, 1);
  }
});

test('P2P preserves the recovery cooldown and stops changing a closed policy', async () => {
  const h = createHarness();
  for (let i = 0; i < 3; i++) await h.poll();
  h.setDelay(0); h.setLoss(0); h.setLimitation('none'); h.setAvailable(6_000_000);
  for (let i = 0; i < 10; i++) await h.poll();
  assert.equal(h.lastEncoding().maxFramerate, 30);
  h.policy.stop(); h.advance(20_000);
  for (let i = 0; i < 10; i++) await h.poll();
  assert.equal(h.sender.calls.length, 1);
});

test('P2P retries a rejected recovery without skipping a tier', async () => {
  const h = createHarness();
  for (let i = 0; i < 3; i++) await h.poll();
  h.setDelay(0); h.setLoss(0); h.setLimitation('none'); h.setAvailable(6_000_000); h.advance(20_000);
  const apply = h.sender.setParameters;
  h.sender.setParameters = async () => { throw new Error('temporary rejection'); };
  for (let i = 0; i < 8; i++) await h.poll();
  assert.equal(h.lastEncoding().maxFramerate, 30);
  h.sender.setParameters = apply;
  for (let i = 0; i < 8; i++) await h.poll();
  assert.equal(h.lastEncoding().maxFramerate, 60);
  assert.equal(h.lastEncoding().scaleResolutionDownBy, 1);
});

test('motion bandwidth limitation alone cannot reduce FPS/resolution even after multiple samples', async () => {
  for (const available of [15_000_000, 3_000_000, null]) {
    const h = createHarness({ availableOutgoingBitrate: available, sendDelayMs: 5, lossRate: 0 });
    for (let i = 0; i < 12; i++) { h.advance(1000); await h.poll(); }
    assert.equal(h.sender.calls.length, 0, 'Chromium handles bandwidth-only changes');
    h.policy.stop();
  }
});

test('a four-sample queue-only burst does not downgrade; sustained pressure still protects its viewer', async () => {
  const healthy = createHarness({ availableOutgoingBitrate: 15_000_000, sendDelayMs: 5, lossRate: 0 });
  const weak = createHarness({ sendDelayMs: 550, lossRate: 0 });
  await weak.poll(); await healthy.poll();
  for (let i = 0; i < 4; i++) { await weak.poll(); await healthy.poll(); }
  weak.setDelay(0);
  await weak.poll(); await healthy.poll();
  assert.equal(weak.sender.calls.length, 0);
  weak.setDelay(120);
  for (let i = 0; i < 5; i++) { await weak.poll(); await healthy.poll(); }
  assert.equal(weak.lastEncoding().maxFramerate, 30);
  assert.equal(healthy.sender.calls.length, 0);
  weak.policy.stop(); healthy.policy.stop();
});

test('a queue over one second retains fast protection even without reported loss', async () => {
  const h = createHarness({ sendDelayMs: 1200, lossRate: 0 });
  for (let i = 0; i < 3; i++) await h.poll();
  assert.equal(h.lastEncoding().maxFramerate, 30);
  h.policy.stop();
});

test('QP and encoder cost use window deltas, preserve unavailable/reset values and identify the negotiated codec', () => {
  const pc = { connectionState: 'connected' };
  const row = (timestamp, framesEncoded, qpSum, totalEncodeTime, keyFramesEncoded) => new Map([
    ['out', { id: 'out', type: 'outbound-rtp', kind: 'video', timestamp, framesEncoded, qpSum, totalEncodeTime, keyFramesEncoded, codecId: 'codec', encoderImplementation: 'libvpx' }],
    ['codec', { id: 'codec', type: 'codec', mimeType: 'video/VP8' }],
  ]);
  const first = recordP2pNetworkStats(pc, row(1000, 60, 1200, 0.6, 1), 'publisher').streams[0];
  assert.equal(first.averageQp, null); assert.equal(first.encodeTimeMs, null);
  assert.equal(first.delta.keyFramesEncoded, null);
  const current = recordP2pNetworkStats(pc, row(2000, 120, 3600, 1.8, 3), 'publisher').streams[0];
  assert.equal(current.averageQp, 40); assert.ok(Math.abs(current.encodeTimeMs - 20) < 0.0001);
  assert.equal(current.codec, 'video/VP8');
  assert.equal(current.encoderImplementation, 'libvpx');
  assert.equal(current.delta.keyFramesEncoded, 2);
  const reset = recordP2pNetworkStats(pc, row(3000, 10, 100, 0.1, 1), 'publisher').streams[0];
  assert.equal(reset.averageQp, null); assert.equal(reset.encodeTimeMs, null);
  assert.equal(reset.delta.keyFramesEncoded, null);
  const missing = recordP2pNetworkStats(pc, row(4000, 20), 'publisher').streams[0];
  assert.equal(missing.averageQp, null); assert.equal(missing.encodeTimeMs, null);
  assert.equal(missing.delta.keyFramesEncoded, null);
});

test('TURN observes congestion without adjusting the sender and stops its existing poll timer', async () => {
  let timestamp = 0, reads = 0;
  const tasks = new Map();
  const pc = { connectionState: 'connected', getStats: async () => {
    reads++;
    timestamp += 1000;
    return new Map([['out', { id: 'out', type: 'outbound-rtp', kind: 'video', timestamp,
      packetsSent: timestamp, bytesSent: timestamp * 100, totalPacketSendDelay: timestamp / 2,
      qualityLimitationReason: 'bandwidth', codecId: 'codec' }], ['codec', { mimeType: 'video/H264' }]]);
  } };
  const policy = createP2pVideoPolicy({ pc, route: 'turn', adapt: false,
    quality: { width: 1920, height: 1080, fps: 60, bitrate: 6500 },
    sender: { track: { readyState: 'live' }, getParameters: () => ({ encodings: [{ maxBitrate: 6500000, maxFramerate: 60 }] }),
      setParameters: () => assert.fail('observing TURN must not run the P2P adaptation') },
    schedule: (callback, delay) => { assert.equal(delay, 1000); tasks.set(1, callback); return 1; },
    cancel: id => tasks.delete(id),
  });
  policy.start();
  await policy.poll(); await policy.poll(); await policy.poll();
  const history = readP2pDiagnostics().connections.findLast(item => item.route === 'turn');
  assert.equal(history.direction, 'publisher');
  assert.equal(history.samples.at(-1).streams[0].packetSendDelayMs, 500);
  assert.equal(history.samples.at(-1).policy.status, 'observe-only');
  assert.equal(history.samples.at(-1).policy.maxBitrate, 6500000);
  assert.equal(tasks.size, 1);
  const count = reads;
  policy.stop(); await policy.poll();
  assert.equal(tasks.size, 0);
  assert.equal(reads, count);
  history.samples.length = 0;
  assert.ok(readP2pDiagnostics().connections.findLast(item => item.route === 'turn').samples.length > 0);
});
