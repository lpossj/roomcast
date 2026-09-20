import test from 'node:test';
import assert from 'node:assert/strict';
import { selectScreenPlayback } from '../src/local-preview.js';

test('self playback reuses the publishing MediaStream only after member identity matches', () => {
  const localStream = { active: true };
  assert.deepEqual(selectScreenPlayback({ viewerMemberId: 'owner', publisherMemberId: 'owner', localStream }), { isSelf: true, mode: 'local-stream' });
  assert.deepEqual(selectScreenPlayback({ viewerMemberId: 'guest', publisherMemberId: 'owner', localStream }), { isSelf: false, mode: 'remote' });
});

test('self playback never opens a remote media path when the local stream is unavailable', () => {
  assert.deepEqual(selectScreenPlayback({ viewerMemberId: 'owner', publisherMemberId: 'owner', localStream: null }), { isSelf: true, mode: 'unavailable' });
  assert.deepEqual(selectScreenPlayback({ viewerMemberId: 'guest', publisherMemberId: 'owner', localStream: null }), { isSelf: false, mode: 'remote' });
});
