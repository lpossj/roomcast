import assert from 'node:assert/strict';
import test from 'node:test';
import { createVideoFrameBalance, applyVideoFrameBalance } from '../src/video-frame-balance.js';

const row = (cost = 4, reason = 'none') => ({ delta: { framesEncoded: 60 }, encodeTimeMs: cost,
  qualityLimitationReason: reason, averageQp: 51, framesPerSecond: 8 });
function fixture() {
  let clock = 0;
  const balance = createVideoFrameBalance(60, () => clock);
  let parameters = { encodings: [{ maxFramerate: 60, maxBitrate: 6500000, scaleResolutionDownBy: 1.5 }],
    degradationPreference: 'maintain-resolution' };
  const calls = [];
  const sender = { track: { readyState: 'live' }, getParameters: () => structuredClone(parameters),
    setParameters: async value => { parameters = structuredClone(value); calls.push(parameters); } };
  return { balance, sender, calls, advance: ms => { clock += ms; }, read: () => parameters };
}

test('high QP, low FPS, bandwidth limits, stale/missing stats and a two-sample CPU burst cannot reduce FPS', async () => {
  const h = fixture();
  for (const value of [row(), row(4, 'bandwidth'), { delta: { framesEncoded: null }, qualityLimitationReason: 'cpu' },
    { delta: { framesEncoded: 60 }, encodeTimeMs: null, qualityLimitationReason: 'none' }]) {
    for (let i = 0; i < 10; i++) { h.advance(1000); await applyVideoFrameBalance(h.sender, value, h.balance); }
  }
  for (let i = 0; i < 2; i++) await applyVideoFrameBalance(h.sender, row(30), h.balance);
  await applyVideoFrameBalance(h.sender, row(), h.balance);
  assert.equal(h.calls.length, 0);
});

test('sustained encoding cost reduces only FPS, cooldown prevents cascades, then recovers gradually', async () => {
  const h = fixture();
  for (let i = 0; i < 3; i++) { h.advance(1000); await applyVideoFrameBalance(h.sender, row(30), h.balance); }
  assert.equal(h.balance.fps, 45);
  assert.deepEqual(h.read().encodings[0], { maxFramerate: 45, maxBitrate: 6500000, scaleResolutionDownBy: 1.5 });
  for (let i = 0; i < 6; i++) await applyVideoFrameBalance(h.sender, row(30), h.balance);
  assert.equal(h.calls.length, 1);
  h.advance(3000); await applyVideoFrameBalance(h.sender, row(30), h.balance);
  assert.equal(h.balance.fps, 30);
  for (let i = 0; i < 8; i++) { h.advance(1000); await applyVideoFrameBalance(h.sender, row(), h.balance); }
  assert.equal(h.balance.fps, 30);
  h.advance(2000); await applyVideoFrameBalance(h.sender, row(), h.balance);
  assert.equal(h.balance.fps, 45);
  for (let i = 0; i < 10; i++) { h.advance(1000); await applyVideoFrameBalance(h.sender, row(), h.balance); }
  assert.equal(h.balance.fps, 60);
  assert.equal(h.calls.length, 4);
});

test('CPU-reported overload can protect a viewer without codec-dependent QP thresholds; other viewers stay at 60', async () => {
  const weak = fixture(), healthy = fixture();
  for (let i = 0; i < 3; i++) {
    weak.advance(1000); healthy.advance(1000);
    await applyVideoFrameBalance(weak.sender, row(null, 'cpu'), weak.balance);
    await applyVideoFrameBalance(healthy.sender, row(), healthy.balance);
  }
  assert.equal(weak.balance.fps, 45);
  assert.equal(healthy.calls.length, 0);
});

test('a rejected change is retried without advancing the state; stopping prevents writes', async () => {
  const h = fixture(), apply = h.sender.setParameters;
  h.sender.setParameters = async () => { throw Error('busy'); };
  for (let i = 0; i < 3; i++) await applyVideoFrameBalance(h.sender, row(30), h.balance);
  assert.equal(h.balance.fps, 60);
  h.sender.setParameters = apply;
  for (let i = 0; i < 3; i++) await applyVideoFrameBalance(h.sender, row(30), h.balance);
  assert.equal(h.balance.fps, 45);
  h.advance(10000);
  for (let i = 0; i < 10; i++) await applyVideoFrameBalance(h.sender, row(), h.balance, () => true);
  assert.equal(h.calls.length, 1);
});

test('preserves another controller lower FPS cap, and never reduces a 30 FPS selection on encoder load', async () => {
  const h = fixture();
  const params = h.sender.getParameters(); params.encodings[0].maxFramerate = 24;
  await h.sender.setParameters(params);
  for (let i = 0; i < 10; i++) { h.advance(1000); await applyVideoFrameBalance(h.sender, row(100), h.balance); }
  assert.equal(h.calls.length, 1);
  assert.equal(h.balance.fps, 60);
  const balance = createVideoFrameBalance(30);
  for (let i = 0; i < 20; i++) balance.commit(balance.inspect(row(100, 'cpu')));
  assert.equal(balance.fps, 30);
});
