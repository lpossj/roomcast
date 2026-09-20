'use strict';

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function delta(a, b) {
  return Math.max(0, finiteNumber(b) - finiteNumber(a));
}

function intervals(samples, key) {
  const rows = [];
  for (let i = 1; i < samples.length; i += 1) {
    const previous = samples[i - 1];
    const current = samples[i];
    const elapsedMs = finiteNumber(current.elapsedMs) - finiteNumber(previous.elapsedMs);
    if (!(elapsedMs > 0)) continue;
    rows.push({
      startMs: finiteNumber(previous.elapsedMs),
      endMs: finiteNumber(current.elapsedMs),
      elapsedMs,
      rate: delta(previous[key], current[key]) / (elapsedMs / 1000),
      delta: delta(previous[key], current[key]),
    });
  }
  return rows;
}

function average(values) {
  const list = values.map(Number).filter(Number.isFinite);
  if (!list.length) return 0;
  return list.reduce((sum, value) => sum + value, 0) / list.length;
}

function median(values) {
  const list = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!list.length) return 0;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}

function phaseIntervals(samples, key, startMs, endMs) {
  return intervals(samples, key).filter(row => row.endMs > startMs && row.startMs < endMs);
}

function summarizePhase(samples, key, startMs, endMs) {
  const rows = phaseIntervals(samples, key, startMs, endMs);
  const rates = rows.map(row => row.rate);
  return {
    averageFps: average(rates),
    minFps: rates.length ? Math.min(...rates) : 0,
    maxFps: rates.length ? Math.max(...rates) : 0,
    zeroIntervals: rows.filter(row => row.delta === 0).length,
    intervals: rows.length,
  };
}

function rollingRate(samples, key, startMs, windowMs) {
  const endMs = startMs + windowMs;
  let first = null;
  let last = null;
  for (const sample of samples) {
    const t = finiteNumber(sample.elapsedMs);
    if (t <= startMs) first = sample;
    if (!last && t >= endMs) last = sample;
  }
  if (!first) first = samples.find(sample => finiteNumber(sample.elapsedMs) >= startMs) || samples[0];
  if (!last) last = samples.at(-1);
  if (!first || !last) return 0;
  const elapsedMs = finiteNumber(last.elapsedMs) - finiteNumber(first.elapsedMs);
  if (!(elapsedMs > 0)) return 0;
  return delta(first[key], last[key]) / (elapsedMs / 1000);
}

function recoveryMs(samples, key, transitionMs, targetFps, windowMs = 500, ratio = 0.85, maxSearchMs = 2500) {
  const threshold = targetFps * ratio;
  const stepMs = 100;
  for (let offset = 0; offset <= maxSearchMs; offset += stepMs) {
    const rate = rollingRate(samples, key, transitionMs + offset, windowMs);
    if (rate >= threshold) return offset;
  }
  return null;
}


function summarizeObsHealth(samples, targetFps, maxSkipRate = 0.005) {
  const rows = Array.isArray(samples) ? samples.filter(Boolean) : [];
  if (rows.length < 2) {
    return {
      clockStable: false,
      skipHealth: false,
      samples: rows.length,
      minActiveFps: 0,
      maxActiveFps: 0,
      renderSkippedStart: 0,
      renderSkippedEnd: 0,
      renderSkippedDelta: 0,
      renderTotalDelta: 0,
      renderSkipRate: 0,
      outputSkippedStart: 0,
      outputSkippedEnd: 0,
      outputSkippedDelta: 0,
      outputTotalDelta: 0,
      outputSkipRate: 0,
      maxSkipRate,
    };
  }

  const first = rows[0];
  const last = rows.at(-1);
  const minAllowed = targetFps * 0.85;
  const maxAllowed = targetFps * 1.15;
  const active = rows.map(row => finiteNumber(row.activeFps));
  const clockStable = active.every(value => value >= minAllowed && value <= maxAllowed);

  // OBS counters are cumulative for the process lifetime. Judge only the delta inside
  // the measured window; startup skips before the first relevant sample must not poison
  // the entire run.
  const renderSkippedStart = finiteNumber(first.renderSkippedFrames);
  const renderSkippedEnd = finiteNumber(last.renderSkippedFrames);
  const renderSkippedDelta = delta(renderSkippedStart, renderSkippedEnd);
  const renderTotalDelta = delta(first.renderTotalFrames, last.renderTotalFrames);
  const renderSkipRate = renderTotalDelta > 0 ? renderSkippedDelta / renderTotalDelta : 0;

  const outputSkippedStart = finiteNumber(first.outputSkippedFrames);
  const outputSkippedEnd = finiteNumber(last.outputSkippedFrames);
  const outputSkippedDelta = delta(outputSkippedStart, outputSkippedEnd);
  const outputTotalDelta = delta(first.outputTotalFrames, last.outputTotalFrames);
  const outputSkipRate = outputTotalDelta > 0 ? outputSkippedDelta / outputTotalDelta : 0;

  const skipHealth = renderSkipRate <= maxSkipRate && outputSkipRate <= maxSkipRate;

  return {
    clockStable,
    skipHealth,
    samples: rows.length,
    minActiveFps: Math.min(...active),
    maxActiveFps: Math.max(...active),
    renderSkippedStart,
    renderSkippedEnd,
    renderSkippedDelta,
    renderTotalDelta,
    renderSkipRate,
    outputSkippedStart,
    outputSkippedEnd,
    outputSkippedDelta,
    outputTotalDelta,
    outputSkipRate,
    maxSkipRate,
  };
}
function bitratePhase(samples, startMs, endMs) {
  const rows = phaseIntervals(samples, 'bytesSent', startMs, endMs);
  const bitrates = rows.map(row => row.rate * 8);
  return {
    averageBps: average(bitrates),
    medianBps: median(bitrates),
    maxBps: bitrates.length ? Math.max(...bitrates) : 0,
  };
}

module.exports = {
  finiteNumber,
  delta,
  intervals,
  average,
  median,
  summarizePhase,
  rollingRate,
  recoveryMs,
  bitratePhase,
  summarizeObsHealth,
};
