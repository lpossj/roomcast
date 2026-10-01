import { createVdoTransport } from './vdo-transport.js';
import { createVdoPublisherDiagnostics } from './vdo-publisher-diagnostics.js';
import { createVideoFrameBalance, applyVideoFrameBalance } from '../video-frame-balance.js';

const VDO_DESCRIPTOR_VERSION = 1;

function randomHex(bytes = 32) {
  const values = crypto.getRandomValues(
    new Uint8Array(bytes),
  );

  return Array.from(
    values,
    value => value
      .toString(16)
      .padStart(2, '0'),
  ).join('');
}

function randomId(prefix) {
  return `${prefix}_${randomHex(16)}`;
}

function cloneMediaStream(source) {
  if (
    !source
    || typeof source.getTracks
    !== 'function'
    || !source.active
  ) {
    throw new TypeError(
      'Roomcast VDO Publisher 需要有效的 MediaStream。',
    );
  }

  const tracks = [];

  try {
    for (
      const track
      of source.getTracks()
    ) {
      if (
        track.readyState
        === 'ended'
      ) {
        continue;
      }

      tracks.push(
        track.clone(),
      );
    }
  } catch (error) {
    for (
      const track
      of tracks
    ) {
      try {
        track.stop();
      } catch {
        // best effort
      }
    }

    throw error;
  }

  if (
    !tracks.some(
      track => (
        track.kind
        === 'video'
      ),
    )
  ) {
    for (
      const track
      of tracks
    ) {
      try {
        track.stop();
      } catch {
        // best effort
      }
    }

    throw new Error(
      'Roomcast 屏幕流没有可用的视频轨。',
    );
  }

  return new MediaStream(
    tracks,
  );
}

/**
 * Formal Roomcast VDO publisher.
 *
 * One sharing session owns one publisher and all VDO viewers reuse it.
 * Source tracks are cloned so VDO cleanup or future media tuning cannot stop
 * or mutate Roomcast's native P2P capture tracks.
 *
 * VDO TURN remains disabled by VdoTransport.
 */
export function createVdoScreenPublisher(
  sourceStream,
  {
    label = 'Roomcast',
    quality = {},
  } = {},
) {
  const descriptor =
    Object.freeze({
      version:
        VDO_DESCRIPTOR_VERSION,
      room:
        randomId('roomcast'),
      streamId:
        randomId('screen'),
      password:
        randomHex(32),
    });

  const isolatedStream =
    cloneMediaStream(
      sourceStream,
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
  const frameBalances = new WeakMap();
  const diagnostics = createVdoPublisherDiagnostics({
    getConnections: () => transport.getPublisherConnections(),
    sourceStream,
    isolatedStream,
    // Reuse the existing bounded stats poll; no extra timers or source constraints.
    onVideoStats: async (pc, outbound) => {
      const senders = pc.getSenders().filter(sender => sender.track?.kind === 'video');
      if (senders.length !== 1 || outbound.length !== 1) return { status: 'ambiguous' };
      const sender = senders[0];
      let balance = frameBalances.get(sender);
      if (!balance) { balance = createVideoFrameBalance(quality.fps); frameBalances.set(sender, balance); }
      return applyVideoFrameBalance(sender, outbound[0], balance, () => closed);
    },
  });
  // A copied history of allowlisted measurements remains available after sharing stops.
  // In sender DevTools: copy(JSON.stringify(window.roomcastVdoDiagnostics(), null, 2))
  if (typeof window !== 'undefined') window.roomcastVdoDiagnostics = diagnostics.snapshot;

  const ready = (async () => {
    try {
      await transport.publish(
        isolatedStream,
        {
          streamId:
            descriptor.streamId,
          label,
          // SDK 1.6.1 applies frameRate as a soft constraint on the clone,
          // and maxBitrate as an RTP ceiling in bits/s. It does not expose
          // maxFramerate or degradationPreference through publish options.
          media: {
            video: {
              codec: 'H264',
              frameRate: Math.max(1, Math.min(120, Number(quality.fps) || 30)),
              ...(Number(quality.bitrate) > 0 && Number.isFinite(Number(quality.bitrate))
                ? { maxBitrate: Number(quality.bitrate) * 1000 } : {}),
            },
          },
        },
      );

      if (closed) {
        throw new DOMException(
          'VDO Publisher 已关闭。',
          'AbortError',
        );
      }

      diagnostics.start();
      return descriptor;
    } catch (error) {
      diagnostics.stop();
      for (
        const track
        of isolatedStream
          .getTracks()
      ) {
        try {
          track.stop();
        } catch {
          // best effort
        }
      }

      throw error;
    }
  })();

  const close = () => {
    if (closePromise) {
      return closePromise;
    }

    closed = true;
    diagnostics.stop();
    // Revoke live media immediately even if SDK signaling cleanup is delayed.
    for (const track of isolatedStream.getTracks()) {
      try { track.stop(); } catch { }
    }

    closePromise =
      (async () => {
        try {
          await transport
            .close();
        } finally {
          for (
            const track
            of isolatedStream
              .getTracks()
          ) {
            try {
              track.stop();
            } catch {
              // best effort
            }
          }
        }
      })();

    return closePromise;
  };

  return {
    descriptor,
    isolatedStream,
    transport,
    ready,
    close,
  };
}
