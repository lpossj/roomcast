import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Server } from 'socket.io';
import {
  addresses,
  isLoopback,
  isLoopbackHost,
  loadConfig,
} from './config.mjs';
import { clientIceServers } from './ice.mjs';
import { attachRooms } from './rooms.mjs';

const requireFromHere = createRequire(import.meta.url);
const { version: APP_VERSION } = requireFromHere('../package.json');

export async function startServer(overrides = {}) {
  const config = loadConfig(overrides);
  const trustedLocalToken =
    typeof overrides.trustedLocalToken === 'string'
      ? overrides.trustedLocalToken
      : '';
  const app = express();

  app.disable('x-powered-by');

  const server =
    config.tlsCert && config.tlsKey
      ? https.createServer(
        {
          cert: await readFile(config.tlsCert),
          key: await readFile(config.tlsKey),
        },
        app,
      )
      : http.createServer(app);

  const isLocalRequest = req =>
    isLoopback(req.socket.remoteAddress)
    && isLoopbackHost(req.get('host'));

  const originAllowed = (
    origin,
    request,
  ) => {
    if (!origin) return true;

    try {
      const url = new URL(origin);

      return (
        (
          ['http:', 'https:'].includes(
            url.protocol,
          )
          && url.host
          === request.headers.host
        )
        || config.allowedOrigins.includes(
          origin,
        )
      );
    } catch {
      return false;
    }
  };

  const io = new Server(
    server,
    {
      maxHttpBufferSize:
        64 * 1024,

      cors: {
        origin: (
          origin,
          callback,
        ) =>
          callback(
            null,
            origin || false,
          ),

        credentials: false,
      },

      allowRequest: (
        request,
        callback,
      ) =>
        callback(
          null,
          originAllowed(
            request.headers.origin,
            request,
          ),
        ),
    },
  );

  const rooms =
    attachRooms(io, {
      createKey:
        config.createKey,

      getIceServers:
        memberId =>
          clientIceServers(
            config,
            memberId,
          ),

      onRoomClosed:
        roomId =>
          overrides
            .onRoomClosed
            ?.(roomId),

      isTrustedLocalSocket:
        socket => {
          const cookieHeader =
            String(
              socket.handshake
                .headers.cookie
              || '',
            );

          const localToken =
            cookieHeader
              .split(';')
              .map(value => value.trim())
              .find(
                value =>
                  value.startsWith(
                    'roomcast_internal_auth=',
                  ),
              )
              ?.slice(
                'roomcast_internal_auth='.length,
              )
            || '';

          const expected =
            Buffer.from(
              trustedLocalToken,
              'utf8',
            );

          const actual =
            Buffer.from(
              localToken,
              'utf8',
            );

          return (
            isLoopback(
              socket.handshake
                .address,
            )
            && isLoopbackHost(
              socket.handshake
                .headers.host
              || '',
            )
            && expected.length >= 32
            && expected.length
            === actual.length
            && timingSafeEqual(
              expected,
              actual,
            )
          );
        },
    });

  app.use(
    (
      req,
      res,
      next,
    ) => {
      if (
        req.headers.origin
        && originAllowed(
          req.headers.origin,
          req,
        )
      ) {
        res.set(
          'Access-Control-Allow-Origin',
          req.headers.origin,
        );

        res.set(
          'Vary',
          'Origin',
        );

        res.set(
          'Access-Control-Allow-Methods',
          'GET, POST, PATCH, DELETE, OPTIONS',
        );

        res.set(
          'Access-Control-Allow-Headers',
          'Content-Type, Authorization, If-Match',
        );

        res.set(
          'Access-Control-Expose-Headers',
          'Location, ETag, Link',
        );
      }

      res.set(
        'X-Content-Type-Options',
        'nosniff',
      );

      res.set(
        'Referrer-Policy',
        'no-referrer',
      );

      res.set(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self' http: https: ws: wss:; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      );

      if (
        req.method
        === 'OPTIONS'
      ) {
        return res.sendStatus(
          204,
        );
      }

      next();
    },
  );

  app.use(
    express.json({
      limit: '32kb',
    }),
  );

  app.get(
    '/api/config',
    async (
      req,
      res,
    ) => {
      const local =
        isLocalRequest(req);

      res
        .set(
          'Cache-Control',
          'no-store',
        )
        .json({
          version:
            APP_VERSION,

          port:
            config.port,

          addresses:
            isLoopbackHost(
              config.host,
            )
              ? []
              : addresses(
                config.port,
                server
                instanceof
                https.Server,
              ),

          iceServers: [],

          peerServer:
            local
              ? config.peerServer
              : '',

          requiresCreateKey:
            Boolean(
              config.createKey,
            ),

          desktop:
            local
            && Boolean(
              process
                .versions
                .electron,
            ),

          publicEntry:
            false,
        });
    },
  );

  app.get(
    '/api/health',
    (
      req,
      res,
    ) =>
      res.json({
        ok: true,

        version:
          APP_VERSION,

        rooms:
          rooms.summary(),
      }),
  );

  app.use(
    express.static(
      config.staticDir,
    ),
  );

  app.get(
    '/{*path}',
    (
      req,
      res,
    ) =>
      res.sendFile(
        path.join(
          config.staticDir,
          'index.html',
        ),
      ),
  );

  app.use(
    (
      err,
      req,
      res,
      next,
    ) => {
      if (
        !res.headersSent
      ) {
        res
          .status(
            err.status
            || 500,
          )
          .json({
            error:
              err.status
                === 413
                ? '请求内容过大'
                : '请求失败',
          });
      }
    },
  );

  await new Promise(
    (
      resolve,
      reject,
    ) => {
      server.once(
        'error',
        reject,
      );

      server.listen(
        config.port,
        config.host,
        resolve,
      );
    },
  );

  config.port =
    server.address().port;

  let closing;

  async function close() {
    if (closing) {
      return closing;
    }

    closing =
      (async () => {
        await rooms.close();

        await new Promise(
          resolve =>
            io.close(
              resolve,
            ),
        );

        if (
          server.listening
        ) {
          await new Promise(
            resolve =>
              server.close(
                resolve,
              ),
          );
        }
      })();

    return closing;
  }

  const url =
    `${server
      instanceof
      https.Server
      ? 'https'
      : 'http'
    }://127.0.0.1:${config.port}`;

  return {
    server,
    app,
    io,
    rooms,
    config,
    close,
    url,
  };
}

if (
  process.argv[1]
  && import.meta.url
  === pathToFileURL(
    path.resolve(
      process.argv[1],
    ),
  ).href
) {
  const service =
    await startServer();

  console.log(
    `\n同屏 Roomcast 正在运行：${service.url}\n桌面客户端可创建 P2P 房间并复制 roomcast:// 邀请链接。`,
  );

  if (!isLoopbackHost(service.config.host)) {
    for (
      const address
      of addresses(
        service.config.port,
      )
    ) {
      console.log(
        `  ${address}`,
      );
    }
  }

  for (
    const signal
    of [
      'SIGINT',
      'SIGTERM',
    ]
  ) {
    process.once(
      signal,
      async () => {
        await service.close();

        process.exit(0);
      },
    );
  }
}
