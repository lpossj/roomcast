// Local, bounded metadata only. Do not accept error text, invites or peer identifiers.
const operations = new Set(['join', 'create', 'leave', 'control', 'capture', 'playback']);
const phases = new Set(['started', 'completed', 'cancelled', 'failed', 'rejected']);
const entries = [];
let sequence = 0;

export function recordLifecycle(operation, phase, elapsedMs = 0) {
  if (!operations.has(operation) || !phases.has(phase)) return;
  entries.push({ sequence: ++sequence, at: new Date().toISOString(), operation, phase,
    elapsedMs: Number.isFinite(elapsedMs) ? Math.round(Math.max(0, Math.min(elapsedMs, 86_400_000))) : 0 });
  if (entries.length > 200) entries.shift();
}

export function getLifecycleDiagnostics(version = '') {
  return { schema: 1, version: /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version) ? version : '',
    exportedAt: new Date().toISOString(), entries: entries.map(entry => ({ ...entry })) };
}
