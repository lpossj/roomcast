import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createChromiumSessionFetch, workerRequest } = require('../electron/worker-client.cjs');

const active = {
  workerUrl: 'https://roomcast.example.com',
  accessKey: 'secret',
};

const timeoutError = () => Object.assign(
  new Error('The operation was aborted due to timeout'),
  { name: 'TimeoutError' },
);

test('Worker request retries one timeout once and can then succeed', async () => {
  let calls = 0;

  const result = await workerRequest(
    active,
    '/',
    { ttl: 3600 },
    {
      fetchImpl: async () => {
        calls += 1;

        if (calls === 1) {
          throw timeoutError();
        }

        return new Response(
          JSON.stringify({ ok: true }),
          {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
            },
          },
        );
      },
    },
  );

  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 2);
});

test('Worker request exposes a clear timeout after at most one retry', async () => {
  let calls = 0;

  await assert.rejects(
    workerRequest(
      active,
      '/',
      {},
      {
        retries: 99,
        fetchImpl: async () => {
          calls += 1;
          throw timeoutError();
        },
      },
    ),
    error => {
      assert.match(
        error.message,
        /Cloudflare Worker 请求超时/,
      );

      assert.match(
        error.message,
        /已重试 1 次/,
      );

      assert.equal(
        error.message.includes('TimeoutError'),
        false,
      );

      return true;
    },
  );

  assert.equal(calls, 2);
});

test('Worker request does not retry a deterministic 4xx response', async () => {
  let calls = 0;

  await assert.rejects(
    workerRequest(
      active,
      '/',
      {},
      {
        fetchImpl: async () => {
          calls += 1;

          return new Response(
            '{}',
            {
              status: 400,
            },
          );
        },
      },
    ),
    /HTTP 400/,
  );

  assert.equal(calls, 1);
});

for (const proxy of [
  'DIRECT',
  'PROXY 127.0.0.1:7890',
]) {
  test(
    `Worker HTTP uses the refreshed Chromium system proxy route: ${proxy}`,
    async () => {
      const calls = [];

      const electronSession = {
        forceReloadProxyConfig: async () => {
          calls.push('reload');
        },

        resolveProxy: async url => {
          calls.push([
            'resolve',
            url,
          ]);

          return proxy;
        },

        fetch: async (url, init) => {
          calls.push([
            'fetch',
            url,
            init.method,
          ]);

          return new Response('{}');
        },
      };

      const chromiumFetch = createChromiumSessionFetch(
        electronSession,
      );

      await chromiumFetch(
        'https://roomcast.example.com/',
        {
          method: 'POST',
        },
      );

      assert.deepEqual(
        calls,
        [
          'reload',
          [
            'resolve',
            'https://roomcast.example.com/',
          ],
          [
            'fetch',
            'https://roomcast.example.com/',
            'POST',
          ],
        ],
      );

      assert.equal(
        'setProxy' in electronSession,
        false,
      );
    },
  );
}
