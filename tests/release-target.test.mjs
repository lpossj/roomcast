import assert from 'node:assert/strict';
import test from 'node:test';
import { assertReleaseWritable } from '../scripts/check-release-target.mjs';

test('release guard rejects public releases and uncertainty, allows new tags and drafts', () => {
  assert.doesNotThrow(() => assertReleaseWritable(404));
  assert.doesNotThrow(() => assertReleaseWritable(200, { draft: true }));
  assert.throws(() => assertReleaseWritable(200, { draft: false }), /已公开/);
  assert.throws(() => assertReleaseWritable(200, {}), /已公开/);
  for (const status of [401, 403, 429, 500]) assert.throws(() => assertReleaseWritable(status), /停止发布/);
});
