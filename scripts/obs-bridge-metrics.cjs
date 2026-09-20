'use strict';

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function monotonicDelta(start, end) {
  const a = finiteNumber(start, 0);
  const b = finiteNumber(end, a);
  return Math.max(0, b - a);
}

function rateFromEndpoints(startValue, endValue, elapsedMs) {
  const seconds = finiteNumber(elapsedMs, 0) / 1000;
  if (!(seconds > 0)) return 0;
  return monotonicDelta(startValue, endValue) / seconds;
}

function intervalRates(samples, key) {
  if (!Array.isArray(samples) || samples.length < 2) return [];
  const rates = [];
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1] || {};
    const current = samples[index] || {};
    const elapsedMs = finiteNumber(current.elapsedMs) - finiteNumber(previous.elapsedMs);
    if (!(elapsedMs > 0)) continue;
    rates.push(rateFromEndpoints(previous[key], current[key], elapsedMs));
  }
  return rates;
}

function average(values) {
  const finite = (Array.isArray(values) ? values : []).map(Number).filter(Number.isFinite);
  if (!finite.length) return 0;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function summarizeCounter(samples, key) {
  const list = Array.isArray(samples) ? samples : [];
  if (list.length < 2) {
    return { start: 0, end: 0, delta: 0, averageFps: 0, perIntervalFps: [] };
  }
  const first = list[0] || {};
  const last = list[list.length - 1] || {};
  const perIntervalFps = intervalRates(list, key);
  return {
    start: finiteNumber(first[key]),
    end: finiteNumber(last[key]),
    delta: monotonicDelta(first[key], last[key]),
    averageFps: rateFromEndpoints(first[key], last[key], finiteNumber(last.elapsedMs) - finiteNumber(first.elapsedMs)),
    perIntervalFps,
  };
}

function withinTarget(value, target, ratio = 0.85) {
  const measured = finiteNumber(value, 0);
  const desired = finiteNumber(target, 0);
  if (!(desired > 0)) return false;
  return measured >= desired * ratio && measured <= desired * 1.15;
}

module.exports = {
  finiteNumber,
  monotonicDelta,
  rateFromEndpoints,
  intervalRates,
  average,
  summarizeCounter,
  withinTarget,
};
