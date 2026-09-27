import assert from 'node:assert/strict';
import test from 'node:test';
import { getLifecycleDiagnostics, recordLifecycle } from '../src/lifecycle-diagnostics.js';

test('diagnostics are bounded metadata and return independent snapshots', () => {
  recordLifecycle('secret-invite-url', 'failed');
  recordLifecycle('join', 'secret-error-message');
  for (let i = 0; i < 250; i++) recordLifecycle('join', 'completed', i);
  const snapshot = getLifecycleDiagnostics('0.14.3-beta.8');
  assert.equal(snapshot.entries.length, 200);
  assert.equal(snapshot.entries[0].elapsedMs, 50);
  assert.equal(snapshot.entries.at(-1).elapsedMs, 249);
  assert.deepEqual(Object.keys(snapshot.entries[0]).sort(), ['at', 'elapsedMs', 'operation', 'phase', 'sequence']);
  snapshot.entries[0].phase = 'altered';
  assert.equal(getLifecycleDiagnostics().entries[0].phase, 'completed');
  assert.equal(getLifecycleDiagnostics('roomcast://secret').version, '');
});
