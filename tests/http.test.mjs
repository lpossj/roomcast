import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { io as clientIo } from 'socket.io-client';
import { loadConfig } from '../server/config.mjs';
import { startServer } from '../server/index.mjs';

const packageJson = JSON.parse(
  await readFile(
    new URL('../package.json', import.meta.url),
    'utf8',
  ),
);

function request(
  socket,
  event,
  payload = {},
) {
  return new Promise(
    (resolve, reject) => {
      socket.timeout(3000).emit(
        event,
        payload,
        (error, response) =>
          error
            ? reject(error)
            : resolve(response),
      );
    },
  );
}

async function setup(
  t,
  overrides = {}
) {
  const server =
    await startServer({
      port: 0,
      host: '127.0.0.1',
      tlsCert: '',
      tlsKey: '',
      allowedOrigins: [],
      ...overrides
    });

  const sockets = [];

  t.after(
    async () => {
      for (
        const socket
        of sockets
      ) {
        socket.disconnect();
      }

      await server.close();
    }
  );

  return {
    server,

    async connect(
      options = {}
    ) {
      const socket =
        clientIo(
          server.url,
          {
            transports: [
              'websocket'
            ],
            forceNew: true,
            reconnection: false,
            ...options
          }
        );

      sockets.push(socket);

      await new Promise(
        (
          resolve,
          reject
        ) => {
          const timeout =
            setTimeout(
              () =>
                reject(
                  new Error(
                    'Socket connect timeout'
                  )
                ),
              3000
            );

          socket.once(
            'connect',
            () => {
              clearTimeout(
                timeout
              );

              resolve();
            }
          );

          socket.once(
            'connect_error',
            error => {
              clearTimeout(
                timeout
              );

              reject(error);
            }
          );
        }
      );

      return socket;
    }
  };
}

test(
  'standalone server config defaults to loopback',
  async () => {
    const previousHost = process.env.HOST;
    delete process.env.HOST;
    const rootDir = mkdtempSync(path.join(os.tmpdir(), 'roomcast-config-'));
    try {
      const config = loadConfig({ rootDir });
      assert.equal(config.host, '127.0.0.1');
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
      if (previousHost === undefined) delete process.env.HOST;
      else process.env.HOST = previousHost;
    }
  }
);

test(
  'room socket handshakes reject unrelated browser origins',
  async t => {
    const {
      server,
      connect
    } = await setup(t);

    await assert.rejects(
      connect({
        extraHeaders: {
          Origin:
            'https://attacker.example'
        }
      })
    );

    await assert.rejects(
      connect({
        extraHeaders: {
          Origin:
            'http://127.0.0.1:1'
        }
      })
    );

    const own =
      await connect({
        extraHeaders: {
          Origin:
            server.url
        }
      });

    assert.equal(
      own.connected,
      true
    );
  }
);

test(
  'privileged local migration requires the Electron session token',
  async t => {
    const trustedLocalToken =
      '0123456789abcdef0123456789abcdef';

    const {
      connect
    } = await setup(
      t,
      { trustedLocalToken }
    );

    const untrusted =
      await connect();

    const denied =
      await request(
        untrusted,
        'room:migration-create',
        {}
      );

    assert.equal(
      denied.ok,
      false
    );

    assert.match(
      denied.error,
      /本机协调器/
    );

    const wrongToken =
      await connect({
        extraHeaders: {
          Cookie:
            'roomcast_internal_auth=ffffffffffffffffffffffffffffffff'
        }
      });

    const wrongDenied =
      await request(
        wrongToken,
        'room:migration-create',
        {}
      );

    assert.match(
      wrongDenied.error,
      /本机协调器/
    );

    const trusted =
      await connect({
        extraHeaders: {
          Cookie:
            `roomcast_internal_auth=${trustedLocalToken}`
        }
      });

    const acceptedBoundary =
      await request(
        trusted,
        'room:migration-create',
        {}
      );

    assert.equal(
      acceptedBoundary.ok,
      false
    );

    assert.doesNotMatch(
      acceptedBoundary.error,
      /本机协调器/
    );

    assert.match(
      acceptedBoundary.error,
      /迁移数据/
    );
  }
);

test(
  'legacy MediaMTX HTTP surfaces are not exposed',
  async t => {
    const {
      server
    } = await setup(t);

    const [
      configResponse,
      healthResponse,
      mediaResponse,
      localMediaResponse
    ] = await Promise.all([
      fetch(
        `${server.url}/api/config`
      ),
      fetch(
        `${server.url}/api/health`
      ),
      fetch(
        `${server.url}/media/room-TEST1234/whip`,
        {
          method: 'POST',
          headers: {
            'content-type':
              'application/sdp'
          },
          body: 'v=0\r\n'
        }
      ),
      fetch(
        `${server.url}/api/local/media-warm`,
        {
          method: 'POST',
          headers: {
            'content-type':
              'application/json'
          },
          body: '{}'
        }
      )
    ]);

    assert.equal(
      configResponse.status,
      200
    );

    assert.equal(
      healthResponse.status,
      200
    );

    const config =
      await configResponse.json();

    const health =
      await healthResponse.json();

    assert.equal(
      config.version,
      packageJson.version
    );

    assert.equal(
      health.version,
      packageJson.version
    );

    assert.equal(
      Object.hasOwn(
        config,
        'media'
      ),
      false
    );

    assert.equal(
      Object.hasOwn(
        health,
        'media'
      ),
      false
    );

    assert.equal(
      mediaResponse.status,
      404
    );

    assert.equal(
      localMediaResponse.status,
      404
    );
  }
);
