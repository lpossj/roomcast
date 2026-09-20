export const MIN_PLAYOUT_BUFFER_MS = 35;
export const MAX_PLAYOUT_BUFFER_MS = 200;

export function adaptivePlayoutTarget(current = MIN_PLAYOUT_BUFFER_MS, { jitterMs = 0, decodeMs = 0, lossRate = 0 } = {}) {
  const jitter = Math.max(0, Number(jitterMs) || 0);
  const decode = Math.max(0, Number(decodeMs) || 0);
  const loss = Math.min(1, Math.max(0, Number(lossRate) || 0));
  const desired = Math.min(MAX_PLAYOUT_BUFFER_MS, MIN_PLAYOUT_BUFFER_MS + jitter * 1.8 + decode * 0.7 + loss * 650 + (loss > 0.02 ? 25 : 0));
  const value = Math.min(MAX_PLAYOUT_BUFFER_MS, Math.max(MIN_PLAYOUT_BUFFER_MS, Number(current) || MIN_PLAYOUT_BUFFER_MS));
  return value + (desired - value) * (desired > value ? 0.45 : 0.08);
}
