import { createVdoTransport } from './vdo-transport.js';

function requiredText(
  value,
  name,
) {
  const text =
    String(
      value
      ?? '',
    ).trim();

  if (!text) {
    throw new TypeError(
      `${name} is required`,
    );
  }

  return text;
}

function validateDescriptor(
  descriptor,
) {
  if (
    !descriptor
    || descriptor.version !== 1
  ) {
    throw new TypeError(
      'VDO descriptor version is invalid.',
    );
  }

  const room =
    requiredText(
      descriptor.room,
      'descriptor.room',
    );

  const streamId =
    requiredText(
      descriptor.streamId,
      'descriptor.streamId',
    );

  const password =
    requiredText(
      descriptor.password,
      'descriptor.password',
    );

  if (
    !/^[A-Za-z0-9_]{8,128}$/
      .test(room)
    || !/^[A-Za-z0-9_]{8,128}$/
      .test(streamId)
    || !/^[a-f0-9]{64}$/
      .test(password)
  ) {
    throw new TypeError(
      'VDO descriptor format is invalid.',
    );
  }

  return {
    version: 1,
    room,
    streamId,
    password,
  };
}

function abortError() {
  return new DOMException(
    '操作已取消。',
    'AbortError',
  );
}

function withAbort(
  promise,
  signal,
  onAbort,
) {
  if (!signal) {
    return Promise.resolve(
      promise,
    );
  }

  if (signal.aborted) {
    onAbort?.();
    return Promise.reject(
      abortError(),
    );
  }

  return new Promise(
    (resolve, reject) => {
      let settled = false;

      const finish =
        callback => value => {
          if (settled) return;
          settled = true;

          signal.removeEventListener(
            'abort',
            aborted,
          );

          callback(value);
        };

      const aborted = () => {
        if (settled) return;
        settled = true;

        signal.removeEventListener(
          'abort',
          aborted,
        );

        try {
          onAbort?.();
        } catch {
          // Best effort.
        }

        reject(
          abortError(),
        );
      };

      signal.addEventListener(
        'abort',
        aborted,
        {
          once: true,
        },
      );

      Promise.resolve(
        promise,
      ).then(
        finish(resolve),
        finish(reject),
      );
    },
  );
}

/**
 * Formal Roomcast VDO viewer adapter.
 *
 * It does not create UI and it does not decide the winning route.
 * ScreenPlayer/MediaRaceCoordinator own decoded-frame probing and route choice.
 *
 * VDO TURN/auto-relay remain disabled in VdoTransport.
 */
export function createVdoScreenViewer(
  input,
  {
    label = 'Roomcast',
  } = {},
) {
  const descriptor =
    validateDescriptor(
      input,
    );

  const transport =
    createVdoTransport({
      room:
        descriptor.room,

      password:
        descriptor.password,

      label,
      debug: false,
    });

  let closed = false;
  let closePromise = null;
  let pc = null;

  const close = () => {
    if (closePromise) {
      return closePromise;
    }

    closed = true;

    closePromise =
      transport.close();

    return closePromise;
  };

  const warmup =
    async ({
      signal,
    } = {}) => {
      if (closed) {
        throw abortError();
      }

      await withAbort(
        transport.connect(),
        signal,
        () => {
          void close();
        },
      );

      if (
        closed
        || signal?.aborted
      ) {
        throw abortError();
      }

      return true;
    };

  const start =
    async ({
      signal,
    } = {}) => {
      await warmup({
        signal,
      });

      pc =
        await withAbort(
          transport.view(
            descriptor.streamId,
            {
              audio: true,
              video: true,
              label,
            },
          ),
          signal,
          () => {
            void close();
          },
        );

      if (
        closed
        || signal?.aborted
      ) {
        throw abortError();
      }

      if (
        !pc
        || typeof pc.getStats
        !== 'function'
      ) {
        throw new Error(
          'VDO 未返回有效的媒体 PeerConnection。',
        );
      }

      return pc;
    };

  return {
    descriptor,

    get pc() {
      return pc;
    },

    get remoteStream() {
      return transport
        .remoteStream;
    },

    addEventListener(
      ...args
    ) {
      return transport
        .addEventListener(
          ...args,
        );
    },

    removeEventListener(
      ...args
    ) {
      return transport
        .removeEventListener(
          ...args,
        );
    },

    warmup,
    start,
    close,
  };
}
