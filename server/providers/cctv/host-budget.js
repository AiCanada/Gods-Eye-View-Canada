import {
  CCTV_IBI_ACTIVE_RESERVE_PER_DAY,
  CCTV_IBI_ACTIVE_RESERVE_PER_MINUTE,
  CCTV_IBI_PER_DAY,
  CCTV_IBI_PER_MINUTE,
} from './constants.js';
import { readJsonFile, writeJsonFileAtomic } from './json-file.js';

const MINUTE_MS = 60 * 1000;
const BUDGET_FORMAT = 'gev-cctv-host-budget/1';

/**
 * Is this still on an IBI 511 site (the platform behind 511on.ca,
 * 511.alberta.ca and many US 511 sites)? Their stills live under /map/Cctv/,
 * and those hosts allow 20 requests a minute and 1,000 a day.
 *
 * @param {string} url
 * @returns {boolean}
 */
export function isBudgetedFrameUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(String(url));
    return (
      (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
      /\/map\/cctv\//i.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

/** UTC calendar day of an epoch-ms time, "2026-09-14". */
function utcDay(at) {
  return new Date(at).toISOString().slice(0, 10);
}

function msUntilNextUtcDay(at) {
  const next = new Date(at);
  next.setUTCHours(24, 0, 0, 0);
  return next.getTime() - at;
}

/**
 * Request budget per budgeted host: `perMinute` in any rolling minute and
 * `perDay` per UTC day. Cards stop short of both limits by the active
 * reserve, so the camera the user is watching can still refresh when cards
 * have used their share. Daily counts are written (debounced, atomically) to
 * `file` so a restart does not reset them.
 */
export function createHostBudget({
  file = '',
  perMinute = CCTV_IBI_PER_MINUTE,
  perDay = CCTV_IBI_PER_DAY,
  activeReservePerMinute = CCTV_IBI_ACTIVE_RESERVE_PER_MINUTE,
  activeReservePerDay = CCTV_IBI_ACTIVE_RESERVE_PER_DAY,
  flushDelayMs = 2000,
  maxHosts = 256,
  now = Date.now,
} = {}) {
  /** @type {Map<string, {minute: number[], day: string, dayCount: number}>} */
  const hosts = new Map();
  let loaded = null;
  let dirty = false;
  let flushTimer = null;
  let writing = null;

  const stateFor = (host) => {
    const today = utcDay(now());
    let state = hosts.get(host);
    if (!state) {
      state = { minute: [], day: today, dayCount: 0 };
      hosts.set(host, state);
      if (hosts.size > maxHosts) hosts.delete(hosts.keys().next().value);
    }
    if (state.day !== today) {
      state.day = today;
      state.dayCount = 0;
    }
    return state;
  };

  async function load() {
    if (!file) return;
    const parsed = await readJsonFile(file);
    const saved = parsed?.format === BUDGET_FORMAT ? parsed.hosts : null;
    if (!saved || typeof saved !== 'object') return;
    const today = utcDay(now());
    for (const [host, entry] of Object.entries(saved)) {
      if (entry?.day !== today || !Number.isFinite(entry?.count)) continue;
      const state = stateFor(host);
      state.dayCount = Math.max(state.dayCount, Math.floor(entry.count));
    }
  }

  /** Load the saved daily counts once; later calls share the same read. */
  function ready() {
    if (!loaded) loaded = load();
    return loaded;
  }

  async function flush() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    while (writing) await writing;
    if (!dirty || !file) return;
    dirty = false;
    const out = {};
    for (const [host, state] of hosts) {
      if (state.dayCount > 0)
        out[host] = { day: state.day, count: state.dayCount };
    }
    writing = writeJsonFileAtomic(file, { format: BUDGET_FORMAT, hosts: out })
      .then((ok) => {
        if (!ok) dirty = true;
      })
      .finally(() => {
        writing = null;
      });
    await writing;
  }

  function scheduleFlush() {
    dirty = true;
    if (flushTimer || !file) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, flushDelayMs);
    flushTimer.unref?.();
  }

  /**
   * Spend one request on `host` if its budget allows. Call `ready()` first so
   * the day's saved count is already in.
   *
   * @param {string} host
   * @param {{active?: boolean}} [options]
   * @returns {{ok: true}|{ok: false, reason: 'minute'|'day', retryAfterMs: number}}
   */
  function take(host, { active = false } = {}) {
    const at = now();
    const state = stateFor(host);
    state.minute = state.minute.filter((time) => at - time < MINUTE_MS);
    const dayLimit = active ? perDay : perDay - activeReservePerDay;
    const minuteLimit = active ? perMinute : perMinute - activeReservePerMinute;
    if (state.dayCount >= dayLimit) {
      return { ok: false, reason: 'day', retryAfterMs: msUntilNextUtcDay(at) };
    }
    if (state.minute.length >= minuteLimit) {
      return {
        ok: false,
        reason: 'minute',
        retryAfterMs: Math.max(0, MINUTE_MS - (at - state.minute[0])),
      };
    }
    state.minute.push(at);
    state.dayCount += 1;
    scheduleFlush();
    return { ok: true };
  }

  /** Requests spent on a host in the current minute and day. */
  function usage(host) {
    const at = now();
    const state = hosts.get(host);
    if (!state) return { minute: 0, day: 0 };
    return {
      minute: state.minute.filter((time) => at - time < MINUTE_MS).length,
      day: state.day === utcDay(at) ? state.dayCount : 0,
    };
  }

  return { ready, take, usage, flush };
}
