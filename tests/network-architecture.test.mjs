import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = path =>
  readFile(
    new URL(path, import.meta.url),
    'utf8'
  );

test(
  'network invariants remain explicit in renderer, service and Electron boundaries',
  async () => {
    const [
      p2p,
      player,
      rooms,
      main,
      preload,
      config,
    ] = await Promise.all([
      read('../src/p2p.js'),
      read('../src/ScreenPlayer.jsx'),
      read('../server/rooms.mjs'),
      read('../electron/main.cjs'),
      read('../electron/preload.cjs'),
      read('../server/config.mjs'),
    ]);

    assert.doesNotMatch(
      p2p,
      /fallback:bridge|ensureFallbackBridge/
    );

    assert.match(
      p2p,
      /mediaIceServers/
    );

    const currentScreenPlayer = await (
      await import('node:fs/promises')
    ).readFile(
      new URL('../src/ScreenPlayer.jsx', import.meta.url),
      'utf8',
    );

    assert.match(
      currentScreenPlayer,
      /iceServers:\s*mediaIceServers\s*\(\s*iceServers\s*,?\s*\)/,
    );

    await assert.rejects(
      read('../server/media.mjs'),
      error => error?.code === 'ENOENT'
    );

    assert.doesNotMatch(
      config,
      /MEDIA_(?:HTTP|HLS|ICE)_PORT|MEDIA_MTX_EXE|mediamtx/i
    );

    assert.match(
      main,
      /createChromiumSessionFetch\(privateSession\)/
    );

    assert.doesNotMatch(
      main,
      /setProxy\(|127\.0\.0\.1:7890|disable-accelerated-video-decode|disable-webrtc-hw-decoding|disable-webrtc-mdns/
    );

    assert.match(
      main,
      /contextIsolation: true, sandbox: true/
    );

    assert.match(
      main,
      /nodeIntegration: false/
    );

    assert.match(
      main,
      /safeStorage/
    );

    assert.match(
      preload,
      /contextBridge\.exposeInMainWorld/
    );

    assert.match(
      main,
      /host: '127\.0\.0\.1'/
    );

    assert.match(
      main,
      /trustedLocalToken:\s*localCoordinatorToken/
    );

    assert.match(
      main,
      /privateSession\.cookies\.set\(/
    );

    const serverIndex = await read('../server/index.mjs');

    assert.match(
      serverIndex,
      /roomcast_internal_auth=/
    );

    assert.doesNotMatch(
      serverIndex,
      /isLoopbackHost\(url\.host\)/
    );
  }
);

test(
  'packaged Electron enables minimal production fuses',
  async () => {
    const pkg = JSON.parse(
      await readFile(
        new URL('../package.json', import.meta.url),
        'utf8',
      ),
    );

    assert.deepEqual(
      pkg.build.electronFuses,
      {
        runAsNode: false,
        enableCookieEncryption: true,
        enableNodeOptionsEnvironmentVariable: false,
        enableNodeCliInspectArguments: false,
        enableEmbeddedAsarIntegrityValidation: true,
        onlyLoadAppFromAsar: true,
        grantFileProtocolExtraPrivileges: false,
      },
    );
  }
);
