import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('portable launches use separate extraction directories', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  // The pinned builder checks !unpackDirName: false still selects a shared
  // build ID. true leaves UNPACK_DIR_NAME unset and uses per-launch PLUGINSDIR.
  assert.equal(pkg.build.portable.unpackDirName, true);
});
