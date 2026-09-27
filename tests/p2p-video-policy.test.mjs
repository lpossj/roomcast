import assert from 'node:assert/strict';
import test from 'node:test';
import { createP2pVideoPolicy, recordP2pNetworkStats } from '../src/p2p-video-policy.js';

function createHarness({
  sourceWidth = 1920,
  sourceHeight = 1080,
  sourceFps = 60,
  targetFps = 60,
  bitrate = 6000,
  availableOutgoingBitrate = 3_000_000,
  qualityLimitationReason = 'bandwidth',
  sendDelayMs = 120,
} = {}) {
  let now = 0;
  let tick = 0;
  let bytesSent = 0;
  let packetsSent = 0;
  let framesEncoded = 0;
  let limitation = qualityLimitationReason;
  let available = availableOutgoingBitrate;
  let delay = sendDelayMs;
  let totalPacketSendDelay = 0;
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
      report.set('outbound:1', {
        id: 'outbound:1',
        type: 'outbound-rtp',
        kind: 'video',
        isRemote: false,
        timestamp: tick * 1000,
        bytesSent,
        packetsSent,
        framesEncoded,
        totalPacketSendDelay,
        frameWidth: sourceWidth,
        frameHeight: sourceHeight,
        framesPerSecond: sourceFps,
        qualityLimitationReason: limitation,
        transportId: 'transport:1',
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
  h.setDelay(0); h.setLimitation('none');
  h.advance(20_000);
  for (let index = 0; index < 8; index += 1) await h.poll();
  assert.equal(h.sender.calls.length, 2);
  assert.equal(h.lastEncoding().maxFramerate, 60);
  assert.equal(h.lastEncoding().scaleResolutionDownBy, 1);
});

test('P2P recovers at the selected bitrate after the existing healthy interval', async () => {
  const h = createHarness();
  for (let i = 0; i < 3; i++) await h.poll();
  h.setDelay(0); h.setLimitation('none');
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
    h.setDelay(0); h.setLimitation('none');
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
  h.setDelay(0); h.setLimitation('none'); h.setAvailable(6_000_000);
  for (let i = 0; i < 10; i++) await h.poll();
  assert.equal(h.lastEncoding().maxFramerate, 30);
  h.policy.stop(); h.advance(20_000);
  for (let i = 0; i < 10; i++) await h.poll();
  assert.equal(h.sender.calls.length, 1);
});

test('P2P retries a rejected recovery without skipping a tier', async () => {
  const h = createHarness();
  for (let i = 0; i < 3; i++) await h.poll();
  h.setDelay(0); h.setLimitation('none'); h.setAvailable(6_000_000); h.advance(20_000);
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
    const h = createHarness({ availableOutgoingBitrate: available, sendDelayMs: 5 });
    for (let i = 0; i < 12; i++) { h.advance(1000); await h.poll(); }
    assert.equal(h.sender.calls.length, 0, 'Chromium handles bandwidth-only changes');
    h.policy.stop();
  }
});

test('a single queue-pressure burst does not downgrade, and healthy peers remain isolated', async () => {
  const healthy = createHarness({ availableOutgoingBitrate: 15_000_000, sendDelayMs: 5 });
  const weak = createHarness({ sendDelayMs: 120 });
  await weak.poll(); await healthy.poll();
  await weak.poll(); await healthy.poll();
  weak.setDelay(0);
  await weak.poll(); await healthy.poll();
  assert.equal(weak.sender.calls.length, 0);
  weak.setDelay(120);
  await weak.poll(); await weak.poll(); await healthy.poll();
  assert.equal(weak.lastEncoding().maxFramerate, 30);
  assert.equal(healthy.sender.calls.length, 0);
  weak.policy.stop(); healthy.policy.stop();
});

test('QP and encoder cost use window deltas, preserve unavailable/reset values and identify the negotiated codec', () => {
  const pc = { connectionState: 'connected' };
  const row = (timestamp, framesEncoded, qpSum, totalEncodeTime) => new Map([
    ['out', { id: 'out', type: 'outbound-rtp', kind: 'video', timestamp, framesEncoded, qpSum, totalEncodeTime, codecId: 'codec' }],
    ['codec', { id: 'codec', type: 'codec', mimeType: 'video/VP8' }],
  ]);
  const first = recordP2pNetworkStats(pc, row(1000, 60, 1200, 0.6), 'publisher').streams[0];
  assert.equal(first.averageQp, null); assert.equal(first.encodeTimeMs, null);
  const current = recordP2pNetworkStats(pc, row(2000, 120, 3600, 1.8), 'publisher').streams[0];
  assert.equal(current.averageQp, 40); assert.ok(Math.abs(current.encodeTimeMs - 20) < 0.0001);
  assert.equal(current.codec, 'video/VP8');
  const reset = recordP2pNetworkStats(pc, row(3000, 10, 100, 0.1), 'publisher').streams[0];
  assert.equal(reset.averageQp, null); assert.equal(reset.encodeTimeMs, null);
  const missing = recordP2pNetworkStats(pc, row(4000, 20), 'publisher').streams[0];
  assert.equal(missing.averageQp, null); assert.equal(missing.encodeTimeMs, null);
});
