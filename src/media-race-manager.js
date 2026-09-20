export const MEDIA_RACE_TIE_WINDOW_MS = 250;
export const MEDIA_RACE_VDO_DELAY_MS = 3_000;
export const MEDIA_RACE_STABILITY_GUARD_MS = 1_000;
export const MEDIA_RACE_TIMEOUT_MS = 20_000;
export const MEDIA_RACE_BUILD_PROBE = true;

export const MEDIA_RACE_ROUTES = Object.freeze(['p2p', 'vdo']);

let nextGeneration = 1;

const monotonicNow = () => (
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
);

const safeCall = (fn, ...args) => {
  if (typeof fn !== 'function') return;
  try {
    return fn(...args);
  } catch (error) {
    console.warn('[Roomcast][MediaRace] callback failed:', error);
  }
};

const otherRoute = route => route === 'p2p' ? 'vdo' : 'p2p';

const routeRecord = () => ({
  status: 'idle',
  playableAt: null,
  failedAt: null,
  payload: null,
  error: null,
});

function normalizeRoute(route) {
  if (!MEDIA_RACE_ROUTES.includes(route)) {
    throw new TypeError(`Unknown media race route: ${route}`);
  }
  return route;
}

/**
 * Coordinates ONLY the direct media race:
 *
 *   Roomcast native P2P  ─┐
 *                         ├─ winner
 *   VDO direct-only      ─┘
 *
 * TURN is deliberately not a candidate here. onExhausted() is the only gate
 * that a later Roomcast TURN stage is allowed to observe.
 *
 * External transports own their PeerConnections/VDO sessions. The coordinator
 * owns only race state, timers, deterministic winner selection and cleanup
 * requests.
 */
export class MediaRaceCoordinator {
  #generation;
  #state = 'idle';
  #routes = {
    p2p: routeRecord(),
    vdo: routeRecord(),
  };

  #tieWindowMs;
  #stabilityGuardMs;
  #timeoutMs;

  #onSelected;
  #onStable;
  #onExhausted;
  #onWinnerFailed;
  #onStateChange;
  #startVdo;
  #cleanup;

  #selected = null;
  #provisional = null;
  #startedAt = null;
  #selectedAt = null;
  #stableAt = null;
  #deadlineTimer = null;
  #tieTimer = null;
  #stabilityTimer = null;
  #vdoDelayTimer = null;
  #closed = false;
  #exhausted = false;

  constructor({
    tieWindowMs = MEDIA_RACE_TIE_WINDOW_MS,
    stabilityGuardMs = MEDIA_RACE_STABILITY_GUARD_MS,
    timeoutMs = MEDIA_RACE_TIMEOUT_MS,
    onSelected,
    onStable,
    onExhausted,
    onWinnerFailed,
    onStateChange,
    startVdo,
    cleanup,
  } = {}) {
    this.#generation = nextGeneration++;
    this.#tieWindowMs = Math.max(0, Number(tieWindowMs) || 0);
    this.#stabilityGuardMs = Math.max(0, Number(stabilityGuardMs) || 0);
    this.#timeoutMs = Math.max(1, Number(timeoutMs) || MEDIA_RACE_TIMEOUT_MS);
    this.#onSelected = onSelected;
    this.#onStable = onStable;
    this.#onExhausted = onExhausted;
    this.#onWinnerFailed = onWinnerFailed;
    this.#onStateChange = onStateChange;
    this.#startVdo = startVdo;
    this.#cleanup = cleanup;
  }

  get generation() {
    return this.#generation;
  }

  get state() {
    return this.#state;
  }

  get selectedRoute() {
    return this.#selected;
  }

  get isClosed() {
    return this.#closed;
  }

  get snapshot() {
    return this.#snapshot();
  }

  #snapshot(extra = {}) {
    return {
      generation: this.#generation,
      state: this.#state,
      selectedRoute: this.#selected,
      provisionalRoute: this.#provisional,
      startedAt: this.#startedAt,
      selectedAt: this.#selectedAt,
      stableAt: this.#stableAt,
      routes: {
        p2p: { ...this.#routes.p2p },
        vdo: { ...this.#routes.vdo },
      },
      ...extra,
    };
  }

  #setState(state, extra = {}) {
    this.#state = state;
    safeCall(this.#onStateChange, this.#snapshot(extra));
  }

  #clearTieTimer() {
    if (this.#tieTimer) clearTimeout(this.#tieTimer);
    this.#tieTimer = null;
  }

  #clearStabilityTimer() {
    if (this.#stabilityTimer) clearTimeout(this.#stabilityTimer);
    this.#stabilityTimer = null;
  }

  #clearDeadlineTimer() {
    if (this.#deadlineTimer) clearTimeout(this.#deadlineTimer);
    this.#deadlineTimer = null;
  }

  #clearVdoDelayTimer() {
    if (this.#vdoDelayTimer !== null) clearTimeout(this.#vdoDelayTimer);
    this.#vdoDelayTimer = null;
  }

  #startWaitingVdo() {
    if (
      this.#closed || this.#exhausted || this.#state === 'stable'
      || this.#routes.vdo.status !== 'waiting'
      || this.#routes.p2p.status === 'playable'
    ) return;

    this.#clearVdoDelayTimer();
    this.#routes.vdo.status = 'connecting';
    try {
      Promise.resolve(this.#startVdo()).catch(error => this.markFailed('vdo', error));
    } catch (error) {
      this.markFailed('vdo', error);
    }
  }

  #requestCleanup(route, reason) {
    if (route === 'vdo') this.#clearVdoDelayTimer();
    const record = this.#routes[route];
    if (!record || record.status === 'cancelled') return;
    record.status = 'cancelled';
    safeCall(this.#cleanup, route, reason, this.#snapshot());
  }

  start(at = monotonicNow()) {
    if (this.#closed) throw new Error('Media race is closed.');
    if (this.#state !== 'idle') return this.#snapshot();

    this.#startedAt = at;
    this.#routes.p2p.status = 'connecting';
    this.#routes.vdo.status = typeof this.#startVdo === 'function' ? 'waiting' : 'connecting';
    this.#setState('racing');

    if (this.#routes.vdo.status === 'waiting') {
      this.#vdoDelayTimer = setTimeout(() => this.#startWaitingVdo(), MEDIA_RACE_VDO_DELAY_MS);
    }

    this.#deadlineTimer = setTimeout(() => {
      this.#deadlineTimer = null;

      // A selected winner is already serving media; let the short stability
      // guard finish rather than incorrectly opening the TURN gate.
      if (this.#closed || this.#selected || this.#state === 'stable') return;

      this.#exhaust('timeout');
    }, this.#timeoutMs);

    return this.#snapshot();
  }

  markConnecting(route) {
    route = normalizeRoute(route);
    if (this.#closed || this.#exhausted) return this.#snapshot();

    const record = this.#routes[route];
    if (!['playable', 'cancelled', 'failed'].includes(record.status)) {
      record.status = 'connecting';
      this.#setState(this.#selected ? 'selected' : 'racing', { route, event: 'connecting' });
    }
    return this.#snapshot();
  }

  markPlayable(route, payload = null, at = monotonicNow()) {
    route = normalizeRoute(route);
    if (this.#closed || this.#exhausted) return this.#snapshot();

    if (this.#state === 'idle') this.start(at);

    const record = this.#routes[route];
    if (record.status === 'cancelled') return this.#snapshot();

    // A decoded P2P frame cancels the delayed viewer before the stability guard.
    if (route === 'p2p') this.#clearVdoDelayTimer();

    record.status = 'playable';
    record.playableAt = at;
    record.payload = payload;
    record.error = null;

    // Once stable, late events from the loser must never steal the route.
    if (this.#state === 'stable') {
      return this.#snapshot({ route, event: 'late-playable-ignored' });
    }

    // A winner is already selected during the stability guard. Keep the other
    // route warm only as an emergency failover candidate.
    if (this.#selected) {
      this.#setState('selected', { route, event: 'warm-loser-playable' });
      return this.#snapshot();
    }

    const other = otherRoute(route);
    const otherRecord = this.#routes[other];

    if (route === 'p2p') {
      // P2P is the deterministic tie preference. If it becomes playable while
      // VDO is in its 250 ms provisional window, P2P wins immediately.
      this.#clearTieTimer();
      this.#provisional = null;
      this.#select('p2p', 'p2p-playable');
      return this.#snapshot();
    }

    // VDO is playable.
    if (otherRecord.status === 'failed' || otherRecord.status === 'cancelled') {
      // P2P can no longer tie; do not waste 250 ms.
      this.#select('vdo', 'p2p-unavailable');
      return this.#snapshot();
    }

    if (
      otherRecord.status === 'playable'
      && Number.isFinite(otherRecord.playableAt)
      && Math.abs(at - otherRecord.playableAt) <= this.#tieWindowMs
    ) {
      this.#select('p2p', 'near-simultaneous-tie');
      return this.#snapshot();
    }

    // VDO arrived first. Give native P2P one small deterministic tie window.
    this.#provisional = 'vdo';
    this.#setState('provisional', { route: 'vdo', event: 'vdo-first' });
    this.#clearTieTimer();
    this.#tieTimer = setTimeout(() => {
      this.#tieTimer = null;
      if (this.#closed || this.#selected || this.#exhausted) return;

      const p2p = this.#routes.p2p;
      if (
        p2p.status === 'playable'
        && Number.isFinite(p2p.playableAt)
        && Number.isFinite(record.playableAt)
        && Math.abs(p2p.playableAt - record.playableAt) <= this.#tieWindowMs
      ) {
        this.#select('p2p', 'near-simultaneous-tie');
      } else if (record.status === 'playable') {
        this.#select('vdo', 'vdo-ahead-of-tie-window');
      }
    }, this.#tieWindowMs);

    return this.#snapshot();
  }

  markFailed(route, error = null, at = monotonicNow()) {
    route = normalizeRoute(route);
    if (this.#closed || this.#exhausted) return this.#snapshot();

    const record = this.#routes[route];
    if (record.status === 'cancelled') return this.#snapshot();

    record.status = 'failed';
    record.failedAt = at;
    record.error = error || null;

    // A definite P2P failure need not wait out the three-second head start.
    if (route === 'p2p') this.#startWaitingVdo();
    if (this.#closed || this.#exhausted) return this.#snapshot();

    if (this.#state === 'stable' && this.#selected === route) {
      this.#setState('winner-failed', { route, event: 'stable-winner-failed', error });
      safeCall(this.#onWinnerFailed, this.#snapshot({ route, error }));
      return this.#snapshot();
    }

    if (this.#provisional === route) {
      this.#provisional = null;
      this.#clearTieTimer();
    }

    if (this.#selected === route) {
      const failedWinner = route;
      const alternative = otherRoute(route);

      this.#selected = null;
      this.#selectedAt = null;
      this.#clearStabilityTimer();

      if (this.#routes[alternative].status === 'playable') {
        this.#select(alternative, 'winner-failed-during-guard', failedWinner);
        return this.#snapshot();
      }

      if (this.#routes[alternative].status === 'failed') {
        this.#exhaust('both-failed');
        return this.#snapshot();
      }

      this.#setState('racing', {
        route,
        event: 'selected-route-failed-awaiting-alternative',
        error,
      });
      return this.#snapshot();
    }

    const other = otherRoute(route);
    if (this.#routes[other].status === 'failed') {
      this.#exhaust('both-failed');
    } else if (this.#routes[other].status === 'playable' && !this.#selected) {
      this.#select(other, 'only-playable-route');
    } else {
      this.#setState(this.#provisional ? 'provisional' : 'racing', {
        route,
        event: 'candidate-failed',
        error,
      });
    }

    return this.#snapshot();
  }

  #select(route, reason, replacedRoute = null) {
    if (this.#closed || this.#exhausted) return;
    route = normalizeRoute(route);

    const record = this.#routes[route];
    if (record.status !== 'playable') return;

    this.#clearTieTimer();
    this.#clearStabilityTimer();
    this.#provisional = null;
    this.#selected = route;
    this.#selectedAt = monotonicNow();
    this.#setState('selected', {
      route,
      reason,
      replacedRoute,
      payload: record.payload,
    });

    safeCall(this.#onSelected, this.#snapshot({
      route,
      reason,
      replacedRoute,
      payload: record.payload,
    }));

    this.#stabilityTimer = setTimeout(() => {
      this.#stabilityTimer = null;
      if (
        this.#closed
        || this.#exhausted
        || this.#selected !== route
        || this.#routes[route].status !== 'playable'
      ) {
        return;
      }

      this.#stableAt = monotonicNow();
      this.#clearDeadlineTimer();
      const loser = otherRoute(route);

      this.#setState('stable', {
        route,
        loser,
        payload: record.payload,
      });

      // The losing route is kept warm until this exact point, then torn down.
      this.#requestCleanup(loser, 'race-loser-after-stability-guard');

      safeCall(this.#onStable, this.#snapshot({
        route,
        loser,
        payload: record.payload,
      }));
    }, this.#stabilityGuardMs);
  }

  #exhaust(reason) {
    if (this.#closed || this.#exhausted || this.#state === 'stable') return;

    this.#exhausted = true;
    this.#selected = null;
    this.#provisional = null;
    this.#clearTieTimer();
    this.#clearStabilityTimer();
    this.#clearDeadlineTimer();
    this.#clearVdoDelayTimer();
    this.#setState('exhausted', { reason });

    // No direct route survived. This is the ONLY point at which the future
    // Roomcast TURN gate may be opened.
    this.#requestCleanup('p2p', `race-exhausted:${reason}`);
    this.#requestCleanup('vdo', `race-exhausted:${reason}`);
    safeCall(this.#onExhausted, this.#snapshot({ reason }));
  }

  close(reason = 'closed') {
    if (this.#closed) return;

    this.#closed = true;
    this.#clearTieTimer();
    this.#clearStabilityTimer();
    this.#clearDeadlineTimer();
    this.#clearVdoDelayTimer();
    this.#requestCleanup('p2p', reason);
    this.#requestCleanup('vdo', reason);
    this.#selected = null;
    this.#provisional = null;
    this.#setState('closed', { reason });
  }
}

export function createMediaRaceCoordinator(options) {
  return new MediaRaceCoordinator(options);
}
