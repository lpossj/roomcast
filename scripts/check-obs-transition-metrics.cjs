'use strict';
const assert = require('node:assert/strict');
const { summarizePhase, rollingRate, recoveryMs, bitratePhase, summarizeObsHealth } = require('./obs-transition-metrics.cjs');

const samples = [];
for (let t = 0; t <= 4000; t += 250) {
  samples.push({
    elapsedMs: t,
    framesEncoded: Math.round(t / 1000 * 60),
    framesDecoded: Math.round(t / 1000 * 60),
    totalVideoFrames: Math.round(t / 1000 * 60),
    bytesSent: t < 2000 ? Math.round(t / 1000 * 12000) : 24000 + Math.round((t - 2000) / 1000 * 120000),
  });
}
const phase = summarizePhase(samples, 'framesEncoded', 0, 2000);
assert.ok(phase.averageFps >= 59 && phase.averageFps <= 61);
assert.ok(rollingRate(samples, 'framesEncoded', 2000, 500) >= 59);
assert.equal(recoveryMs(samples, 'framesEncoded', 2000, 60, 500, 0.85), 0);
const staticBits = bitratePhase(samples, 500, 1800);
const motionBits = bitratePhase(samples, 2000, 4000);
assert.ok(motionBits.averageBps > staticBits.averageBps * 2);
console.log('[OBS static-motion metrics self-test] PASS');


// OBS counters are cumulative: startup skips must not fail a stable measurement window.
const startupSkipRows = [];
for (let i = 0; i <= 60; i += 1) {
  startupSkipRows.push({
    activeFps: 60,
    renderSkippedFrames: 2,
    renderTotalFrames: 100 + i * 30,
    outputSkippedFrames: 0,
    outputTotalFrames: 80 + i * 30,
  });
}
const startupSkipHealth = summarizeObsHealth(startupSkipRows, 60);
assert.equal(startupSkipHealth.clockStable, true);
assert.equal(startupSkipHealth.renderSkippedDelta, 0);
assert.equal(startupSkipHealth.skipHealth, true);

// A tiny amount of measured-window loss is reported but remains healthy when the
// end-to-end FPS/no-stall checks also pass. 0.5% is the explicit ceiling.
const tinyLossRows = [
  { activeFps: 60, renderSkippedFrames: 2, renderTotalFrames: 100, outputSkippedFrames: 0, outputTotalFrames: 100 },
  { activeFps: 60, renderSkippedFrames: 4, renderTotalFrames: 1300, outputSkippedFrames: 0, outputTotalFrames: 1300 },
];
const tinyLossHealth = summarizeObsHealth(tinyLossRows, 60);
assert.equal(tinyLossHealth.renderSkippedDelta, 2);
assert.ok(tinyLossHealth.renderSkipRate < 0.005);
assert.equal(tinyLossHealth.skipHealth, true);

const unhealthyRows = [
  { activeFps: 60, renderSkippedFrames: 0, renderTotalFrames: 0, outputSkippedFrames: 0, outputTotalFrames: 0 },
  { activeFps: 60, renderSkippedFrames: 20, renderTotalFrames: 1000, outputSkippedFrames: 0, outputTotalFrames: 1000 },
];
assert.equal(summarizeObsHealth(unhealthyRows, 60).skipHealth, false);
