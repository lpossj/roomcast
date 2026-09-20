import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = relativePath =>
  readFile(
    new URL(`../${relativePath}`, import.meta.url),
    'utf8',
  );

test(
  'package.json is the single Roomcast application version source',
  async () => {
    const [
      packageText,
      packageLockText,
      appText,
      serverText,
    ] = await Promise.all([
      read('package.json'),
      read('package-lock.json'),
      read('src/App.jsx'),
      read('server/index.mjs'),
    ]);

    const packageJson =
      JSON.parse(packageText);
    const packageLock =
      JSON.parse(packageLockText);

    // Roomcast uses npm-compatible SemVer, including prerelease/build suffixes
    // such as 0.13.1-rc or 0.13.1-rc.1.
    assert.match(
      packageJson.version,
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
    );

    assert.equal(
      packageLock.version,
      packageJson.version,
    );

    assert.equal(
      packageLock.packages?.['']?.version,
      packageJson.version,
    );

    assert.doesNotMatch(
      appText,
      /0\.11\.4/,
    );

    assert.match(
      appText,
      /localConfig\?\.version/,
    );

    assert.doesNotMatch(
      serverText,
      /0\.11\.4/,
    );

    assert.match(
      serverText,
      /version:\s*APP_VERSION/g,
    );

    assert.match(
      serverText,
      /requireFromHere\(\s*['"]\.\.\/package\.json['"]\s*\)/,
    );
  },
);
