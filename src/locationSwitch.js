/**
 * @module locationSwitch
 * @description Location switch. When the user selects a place in a different
 * first-level region (a province, state or territory, or the country where
 * there is none), the data layers stop feeding the old place and release the
 * memory they hold for it, then load the new place. Layers stay on throughout.
 *
 * A selection is a search result, a LOCATION or security-site pill, or a click
 * on the map. Moving around inside one region changes nothing, and a point that
 * cannot be placed (open ocean, a failed lookup) never drops a feed.
 *
 * Pure orchestration: no Cesium, no DOM. The caller supplies the region lookup
 * and the leave/arrive work.
 */
import { fetchLocationRegion, locationRegionKey } from './data/regionalBrief.js';

/** Longest wait for the camera to arrive before the new place loads anyway. */
export const LOCATION_ARRIVAL_TIMEOUT_MS = 10_000;

/**
 * Whether a value is a usable `{lat, lon}` point.
 * @param {unknown} point
 * @returns {boolean}
 */
export function isLocationPoint(point) {
  return (
    Number.isFinite(point?.lat) &&
    Number.isFinite(point?.lon) &&
    Math.abs(point.lat) <= 90 &&
    Math.abs(point.lon) <= 180
  );
}

/**
 * Ask the local server to drop in-memory cache entries far from the new place.
 * Memory only: disk caches stay. A failure is ignored, since the server's
 * caches are bounded anyway.
 * @param {{lat:number, lon:number}} to
 * @param {{fetchImpl?: typeof fetch}} [options]
 * @returns {Promise<?object>} The server's `{ released }` report, or null.
 */
export async function releaseServerLocationMemory(
  to,
  { fetchImpl = globalThis.fetch } = {},
) {
  if (!isLocationPoint(to) || typeof fetchImpl !== 'function') return null;
  try {
    const response = await fetchImpl('/api/location-switch/release', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ latitude: to.lat, longitude: to.lon }),
    });
    if (response.ok) return await response.json();
    console.debug?.('[LocationSwitch] server release answered', response.status);
    return null;
  } catch {
    return null;
  }
}

/**
 * Create the location-switch controller.
 *
 * @param {object} options
 * @param {(point: {lat:number, lon:number}, init: {signal?: AbortSignal}) => Promise<object>} [options.lookupRegion]
 *   Region of a point, shaped like `/api/location-region`: `{ key, region, country }`.
 * @param {(change: {from: ?object, to: object, signal: AbortSignal}) => (void|Promise<void>)} [options.leave]
 *   Stop the old place's feeds and release its memory. Runs as soon as the
 *   destination is known to be in another region, usually while the camera flies.
 * @param {(change: {from: ?object, to: object, signal: AbortSignal}) => (void|Promise<void>)} [options.arrive]
 *   Load the new place once the camera has arrived.
 * @param {(error: unknown) => void} [options.onError]
 * @param {number} [options.arrivalTimeoutMs]
 * @param {(fn: Function, ms: number) => unknown} [options.setTimer]
 * @param {(id: unknown) => void} [options.clearTimer]
 */
export function createLocationSwitch({
  lookupRegion = (point, { signal } = {}) =>
    fetchLocationRegion(point.lat, point.lon, { signal }),
  leave = () => {},
  arrive = () => {},
  onError = (error) =>
    console.warn('[LocationSwitch]', error?.message || error),
  arrivalTimeoutMs = LOCATION_ARRIVAL_TIMEOUT_MS,
  setTimer = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimer = (id) => globalThis.clearTimeout(id),
} = {}) {
  /** The region the layers are loaded for: `{key, region, country, lat, lon}`. */
  let current = null;
  /** A switch whose leave ran and whose arrival has not: `{from, to, controller}`. */
  let pending = null;
  /** A switch whose arrive is still running; a newer switch aborts it. */
  let arriving = null;
  /** Cancels the newest selection's region lookup when a newer one starts. */
  let lookup = null;
  /** The starting-region lookup in flight, which a selection waits for. */
  let seeding = null;
  /** The starting region could not be told (lookup failed or unplaced). */
  let seedFailed = false;
  let selections = 0;
  let destroyed = false;

  async function regionOf(point, signal) {
    const payload = await lookupRegion(point, { signal });
    return {
      key: String(payload?.key || locationRegionKey(payload) || ''),
      region: payload?.region || null,
      country: payload?.country || null,
      lat: point.lat,
      lon: point.lon,
    };
  }

  function waitForArrival(arrival, signal) {
    if (!arrival) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      let timer = null;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimer(timer);
        signal.removeEventListener('abort', finish);
        resolve();
      };
      timer = setTimer(finish, arrivalTimeoutMs);
      signal.addEventListener('abort', finish, { once: true });
      Promise.resolve(arrival).then(finish, finish);
    });
  }

  /**
   * Remember the region the view starts in, without switching anything. A
   * seed that fails can be tried again; a selection made meanwhile waits for it.
   * @param {{lat:number, lon:number}} point
   * @returns {Promise<?object>} The current region.
   */
  function seed(point) {
    if (destroyed || current || pending || !isLocationPoint(point))
      return Promise.resolve(current);
    if (seeding) return seeding;
    seeding = (async () => {
      try {
        const region = await regionOf(point, undefined);
        if (!destroyed && !current && !pending) {
          if (region.key) current = region;
          seedFailed = !region.key;
        }
      } catch (error) {
        if (!current) seedFailed = true;
        onError(error);
      } finally {
        seeding = null;
      }
      return current;
    })();
    return seeding;
  }

  /**
   * The user selected a place. Switch the layers over when it lies in another
   * region than the one they are loaded for.
   * @param {{lat:number, lon:number}} point Where the selection is.
   * @param {{arrival?: ?Promise<unknown>, details?: ?object}} [options]
   *   `arrival` settles when the camera gets there; omit it when the camera is
   *   already there (a map click). `details` are extra fields for the layers on
   *   the destination, such as `selectCamera` for a security-site pill.
   * @returns {Promise<{switched: boolean, reason?: string, from?: ?object, to?: object}>}
   */
  async function select(point, { arrival = null, details = null } = {}) {
    if (destroyed || !isLocationPoint(point))
      return { switched: false, reason: 'invalid' };
    const id = ++selections;
    lookup?.abort();
    const controller = new AbortController();
    lookup = controller;
    let to;
    try {
      to = { ...details, ...(await regionOf(point, controller.signal)) };
    } catch (error) {
      if (!controller.signal.aborted) onError(error);
      return {
        switched: false,
        reason: controller.signal.aborted ? 'superseded' : 'lookup-failed',
      };
    } finally {
      if (lookup === controller) lookup = null;
    }
    if (!destroyed && id === selections && !pending && !current && seeding) {
      // The starting region is still being looked up; it is what the layers
      // hold, so it is the region this selection is compared against.
      await seeding;
    }
    if (destroyed || id !== selections)
      return { switched: false, reason: 'superseded' };
    if (!to.key) return { switched: false, reason: 'unplaced' };
    const base = pending?.to || current;
    if (!base && !seedFailed) {
      current = to;
      return { switched: false, reason: 'first-region', to };
    }
    // With no known starting region (its lookup failed) the layers still hold
    // wherever the view has been, so the first selection switches from nowhere.
    if (base && to.key === base.key)
      return { switched: false, reason: 'same-region', to };

    // A newer destination in yet another region replaces a switch still in
    // flight, or one still loading after arrival; the old one never finishes,
    // and the layers leave again for this one.
    pending?.controller.abort();
    arriving?.controller.abort();
    arriving = null;
    const record = { from: current, to, controller: new AbortController() };
    pending = record;
    const change = { from: record.from, to, signal: record.controller.signal };
    try {
      await leave(change);
    } catch (error) {
      onError(error);
    }
    if (change.signal.aborted) return { switched: false, reason: 'superseded' };
    await waitForArrival(arrival, change.signal);
    if (change.signal.aborted || pending !== record || destroyed)
      return { switched: false, reason: 'superseded' };
    pending = null;
    current = to;
    seedFailed = false;
    arriving = record;
    try {
      await arrive(change);
    } catch (error) {
      onError(error);
    } finally {
      if (arriving === record) arriving = null;
    }
    if (change.signal.aborted) return { switched: false, reason: 'superseded', to };
    return { switched: true, from: record.from, to };
  }

  function destroy() {
    destroyed = true;
    lookup?.abort();
    lookup = null;
    pending?.controller.abort();
    pending = null;
    arriving?.controller.abort();
    arriving = null;
  }

  return {
    seed,
    select,
    destroy,
    getCurrent: () => current,
    getPending: () => (pending ? { from: pending.from, to: pending.to } : null),
  };
}
