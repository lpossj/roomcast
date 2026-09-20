'use strict';

const assert = require('node:assert/strict');
const {
  monotonicDelta,
  rateFromEndpoints,
  intervalRates,
  summarizeCounter,
  withinTarget,
} = require('./obs-bridge-metrics.cjs');

assert.equal(monotonicDelta(3, 603), 600);
assert.equal(monotonicDelta(10, 8), 0);
assert.equal(rateFromEndpoints(3, 603, 10_000), 60);
assert.deepEqual(intervalRates([
  { elapsedMs: 0, frames: 0 },
  { elapsedMs: 1000, frames: 60 },
  { elapsedMs: 2000, frames: 120 },
], 'frames'), [60, 60]);
const summary = summarizeCounter([
  { elapsedMs: 0, framesEncoded: 100 },
  { elapsedMs: 1000, framesEncoded: 160 },
  { elapsedMs: 2500, framesEncoded: 250 },
], 'framesEncoded');
assert.equal(summary.delta, 150);
assert.equal(summary.averageFps, 60);
assert.equal(withinTarget(59.4, 60), true);
assert.equal(withinTarget(8, 60), false);

// Regression for Probe 2: ten callback invocations can still represent ~600
// presented frames. Never infer media FPS from callback count in a hidden window.
const callbackCount = 10;
const presentedFrames = rateFromEndpoints(3, 603, 10_000);
assert.equal(callbackCount / 10, 1);
assert.equal(presentedFrames, 60);

console.log('[OBS bridge metrics self-test] PASS');
