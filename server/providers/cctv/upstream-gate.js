import {
  CCTV_HOST_BLOCK_MAX_MS,
  CCTV_HOST_BLOCK_MIN_MS,
  CCTV_HOST_MAX_CONCURRENT,
  CCTV_HOST_QUEUE_MAX,
  CCTV_HOST_QUEUE_WAIT_MS,
  CCTV_HOST_SPACING_MS,
} from './constants.js';

/** Lower-cased hostname of a URL, or '' when it is not one. */
export function upstreamHostOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Retry-After in milliseconds: delta-seconds or an HTTP date. NaN when absent
 * or unreadable.
 */
export function parseRetryAfterMs(value, now = Date.now()) {
  const raw = String(value ?? '').trim();
  if (!raw) return NaN;
  if (/^\d+(\.\d+)?$/.test(raw)) return Number(raw) * 1000;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - now) : NaN;
}

/**
 * Per-host gate for upstream still requests: at most `maxConcurrent` at once,
 * starts spaced `spacingMs` apart, and a bounded queue whose waiters give up
 * after `queueWaitMs`. A 429 (or a 503 carrying Retry-After) blocks the host
 * for Retry-After, kept between `blockMinMs` and `blockMaxMs`; while blocked,
 * nothing is sent to it.
 *
 * `run` answers `{status:'ok', value}`, `{status:'throttled'}` (queue full or
 * the wait ran out) or `{status:'blocked', retryAfterMs}`.
 */
export function createUpstreamGate({
  maxConcurrent = CCTV_HOST_MAX_CONCURRENT,
  spacingMs = CCTV_HOST_SPACING_MS,
  queueMax = CCTV_HOST_QUEUE_MAX,
  queueWaitMs = CCTV_HOST_QUEUE_WAIT_MS,
  blockMinMs = CCTV_HOST_BLOCK_MIN_MS,
  blockMaxMs = CCTV_HOST_BLOCK_MAX_MS,
  maxHosts = 1024,
  now = Date.now,
} = {}) {
  /** @type {Map<string, {active: number, lastStartAt: number, queue: Array<object>, timer: any, blockedUntil: number}>} */
  const hosts = new Map();

  const idle = (state) =>
    state.active === 0 &&
    state.queue.length === 0 &&
    state.blockedUntil <= now();

  const stateFor = (host) => {
    let state = hosts.get(host);
    if (state) return state;
    state = {
      active: 0,
      lastStartAt: -Infinity,
      queue: [],
      timer: null,
      blockedUntil: 0,
    };
    hosts.set(host, state);
    if (hosts.size > maxHosts) {
      for (const [name, other] of hosts) {
        if (hosts.size <= maxHosts) break;
        if (other !== state && idle(other)) hosts.delete(name);
      }
    }
    return state;
  };

  const settle = (waiter, outcome) => {
    clearTimeout(waiter.timer);
    waiter.resolve(outcome);
  };

  const pump = (state) => {
    if (state.blockedUntil > now()) {
      for (const waiter of state.queue.splice(0)) settle(waiter, 'blocked');
      return;
    }
    if (state.timer) return;
    while (state.queue.length && state.active < maxConcurrent) {
      const wait = state.lastStartAt + spacingMs - now();
      if (wait > 0) {
        state.timer = setTimeout(() => {
          state.timer = null;
          pump(state);
        }, wait);
        return;
      }
      const waiter = state.queue.shift();
      state.active += 1;
      state.lastStartAt = now();
      settle(waiter, 'ok');
    }
  };

  const acquire = (state) =>
    new Promise((resolve) => {
      if (state.queue.length >= queueMax) {
        resolve('throttled');
        return;
      }
      const waiter = { resolve, timer: null };
      waiter.timer = setTimeout(() => {
        const index = state.queue.indexOf(waiter);
        if (index < 0) return;
        state.queue.splice(index, 1);
        resolve('throttled');
      }, queueWaitMs);
      state.queue.push(waiter);
      pump(state);
    });

  /** Milliseconds this URL's host stays blocked (0 when it is not). */
  function blockedFor(url) {
    const state = hosts.get(upstreamHostOf(url));
    return state ? Math.max(0, state.blockedUntil - now()) : 0;
  }

  /**
   * Run `task` once a slot on the URL's host is free.
   *
   * @template T
   * @param {string} url
   * @param {() => Promise<T>} task
   */
  async function run(url, task) {
    const state = stateFor(upstreamHostOf(url));
    const blocked = state.blockedUntil - now();
    if (blocked > 0) return { status: 'blocked', retryAfterMs: blocked };
    const outcome = await acquire(state);
    if (outcome === 'blocked') {
      return {
        status: 'blocked',
        retryAfterMs: Math.max(0, state.blockedUntil - now()),
      };
    }
    if (outcome !== 'ok') return { status: 'throttled' };
    try {
      return { status: 'ok', value: await task() };
    } finally {
      state.active -= 1;
      pump(state);
    }
  }

  /**
   * Read an upstream answer's status. A 429, or a 503 with Retry-After, blocks
   * the host. Returns the block length in ms (0 when the host stays open).
   *
   * @param {string} url
   * @param {{status: number, headers?: {get?: (name: string) => string|null}}} response
   */
  function noteResponse(url, { status, headers } = {}) {
    if (status !== 429 && status !== 503) return 0;
    const retry = parseRetryAfterMs(headers?.get?.('retry-after'), now());
    if (status === 503 && !Number.isFinite(retry)) return 0;
    const blockMs = Math.min(
      blockMaxMs,
      Math.max(blockMinMs, Number.isFinite(retry) ? retry : blockMinMs),
    );
    const state = stateFor(upstreamHostOf(url));
    state.blockedUntil = Math.max(state.blockedUntil, now() + blockMs);
    pump(state);
    return blockMs;
  }

  return {
    run,
    blockedFor,
    noteResponse,
    get hostCount() {
      return hosts.size;
    },
  };
}
