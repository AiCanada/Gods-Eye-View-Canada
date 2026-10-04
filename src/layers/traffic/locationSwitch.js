import { greatCircleKm } from '../../data/trafficBounds.js';
import { tileToBBox } from '../../data/tomtomTiles.js';

/**
 * @file Location-switch and world-jump pauses for Street Traffic.
 *
 * A location switch (DataLayerManager `onLocationLeave` → `onLocationArrive`)
 * or an inter-city world jump (application shell `beginWorldJump` →
 * `endWorldJump`) pauses camera-driven loading for the flight: intermediate
 * views are not worth a fetch, and the old view's dots are dropped at once.
 * Both can cover one flight and finish in either order, so loading resumes
 * only once every owner is done. A watchdog resumes on its own if a flight
 * never reports its end.
 *
 * @module layers/traffic/locationSwitch
 */

/** @const {number} Km — parsed road sets whose fetch box centre lies within this of a switch destination are kept */
export const TILE_CACHE_KEEP_KM = 25;
/** @const {number} Ms — longest a switch or jump may pause loading before the layer resumes on its own */
export const FETCH_PAUSE_MAX_MS = 15000;
/** @const {number} Ms between arrival load-kick viewport re-checks */
const LOAD_KICK_MS = 1500;
/** @const {number} Load-kick re-checks after an arrival before giving up (the view may simply stay above 8 km) */
const ARRIVAL_KICK_MAX_TRIES = 8;
/** @const {string} Pause owner for a location switch */
export const PAUSE_LOCATION = 'location';
/** @const {string} Pause owner for an inter-city world jump */
export const PAUSE_WORLD_JUMP = 'world-jump';

/**
 * Pick the tile-cache keys a location switch should release.
 *
 * Plain keys are the "s,w,n,e" strings `loadRoadsForBounds` writes; footprint
 * keys are "z/x/y|z/x/y" tile lists, read as the centre of their tiles. A key
 * whose centre lies more than `radiusKm` from `point` is away from the
 * destination. A missing point, or a key that does not parse, also selects the
 * entry: releasing is the safe direction, since the tile sources' own caches
 * still answer a revisit.
 *
 * @param {Iterable<string>} keys - Tile-cache keys.
 * @param {{lat:number, lon:number}|null} point - Switch destination in degrees.
 * @param {number} radiusKm - Keep radius in kilometres.
 * @returns {string[]} Keys to evict.
 */
export function tileCacheKeysAwayFrom(keys, point, radiusKm) {
  const away = [];
  for (const key of keys) {
    const center = cacheKeyCenter(String(key));
    const near =
      Boolean(point) &&
      Boolean(center) &&
      greatCircleKm(center.lat, center.lon, point.lat, point.lon) <= radiusKm;
    if (!near) away.push(key);
  }
  return away;
}

/** Centre of a tile-cache key, or null when it does not parse. */
function cacheKeyCenter(key) {
  if (key.includes('/')) {
    let south = Infinity,
      west = Infinity,
      north = -Infinity,
      east = -Infinity;
    for (const part of key.split('|')) {
      const [z, x, y] = part.split('/').map(Number);
      if (![z, x, y].every(Number.isInteger)) return null;
      const box = tileToBBox(z, x, y);
      south = Math.min(south, box.south);
      west = Math.min(west, box.west);
      north = Math.max(north, box.north);
      east = Math.max(east, box.east);
    }
    return { lat: (south + north) / 2, lon: (west + east) / 2 };
  }
  const [south, west, north, east] = key.split(',').map(Number);
  const lat = (south + north) / 2;
  const lon = (west + east) / 2;
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

export function createLocationSwitch({
  state: layerState,
  services,
  parts,
  source,
}) {
  const { holdContinuousRender, releaseContinuousRender } = services.render;
  layerState._fetchPauses = new Set();
  layerState._fetchPauseWatchdog = null;
  layerState._arrivalKickTimer = null;

  function stopArrivalKick() {
    clearInterval(layerState._arrivalKickTimer);
    layerState._arrivalKickTimer = null;
  }

  /**
   * Re-check the viewport every LOAD_KICK_MS until a newer load renders, the
   * layer is disabled, or the tries run out. Covers a camera that parks
   * without firing camera.changed after the flight.
   */
  function armArrivalKick() {
    stopArrivalKick();
    const baseline = layerState._lastUpdate;
    let tries = 0;
    layerState._arrivalKickTimer = setInterval(() => {
      if (
        !layerState._enabled ||
        layerState._fetchPauses.size > 0 ||
        (layerState._lastUpdate && layerState._lastUpdate !== baseline) ||
        tries >= ARRIVAL_KICK_MAX_TRIES
      ) {
        stopArrivalKick();
        return;
      }
      tries += 1;
      if (!layerState._fetching && !layerState._retryTimer)
        parts.viewport.onCameraChanged({ immediate: true });
    }, LOAD_KICK_MS);
  }

  /**
   * Pause camera-driven loading for `reason` and drop the old view: cancels
   * the pending debounce, retry and load kicks, and every in-flight road and
   * flow request, then bumps the load generation so continuations already
   * past their await discard their results. The last-fetch gate is forgotten
   * so the destination always loads fresh. The layer stays enabled. Idempotent.
   * @param {string} reason - Pause owner (PAUSE_LOCATION or PAUSE_WORLD_JUMP).
   */
  function pauseCameraFetching(reason) {
    layerState._fetchPauses.add(reason);
    clearTimeout(layerState._fetchTimeout);
    layerState._fetchTimeout = null;
    clearTimeout(layerState._retryTimer);
    layerState._retryTimer = null;
    clearInterval(layerState._enableKickTimer);
    layerState._enableKickTimer = null;
    stopArrivalKick();
    parts.ingestion.cancelActiveFetch();
    layerState._loadGeneration++;
    // The superseded load's finally only settles its own generation.
    layerState._fetching = false;
    layerState._flowPending = 0;
    layerState._lastBounds = null;
    layerState._lastViewCenter = null;
    layerState._flowError = null;
    // A new place (or a jump) starts without the old view's road failure.
    layerState._roadError = null;
    layerState._roadPartial = false;
    layerState._detailError = null;
    layerState._retryDelayMs = 1500;
    layerState._retryAttempts = 0;
    layerState._roadRetryKey = null;
    layerState._roadRetryBounds = null;
    layerState._roadRetryAt = 0;
    layerState._roadRetryStopped = false;
    parts.animation.clearDots();
    releaseContinuousRender('traffic');
    clearTimeout(layerState._fetchPauseWatchdog);
    layerState._fetchPauseWatchdog = setTimeout(() => {
      layerState._fetchPauseWatchdog = null;
      resumeCameraFetching(null);
    }, FETCH_PAUSE_MAX_MS);
  }

  /**
   * Release a pause owner (null releases every owner, for the watchdog). Once
   * none remain on an enabled layer, restore the render hold and check the
   * current view right away, with a bounded kick for a camera still settling.
   * @param {string|null} reason - Pause owner to release, or null for all.
   */
  function resumeCameraFetching(reason) {
    if (reason) layerState._fetchPauses.delete(reason);
    else layerState._fetchPauses.clear();
    if (layerState._fetchPauses.size > 0) return;
    clearTimeout(layerState._fetchPauseWatchdog);
    layerState._fetchPauseWatchdog = null;
    if (!layerState._enabled) return;
    holdContinuousRender('traffic');
    layerState._lastAnimTime = 0;
    armArrivalKick();
    parts.viewport.onCameraChanged({ immediate: true });
  }

  /** Clear every pause; a disabled layer receives no arrival or jump end. */
  function clearPauses() {
    layerState._fetchPauses.clear();
    clearTimeout(layerState._fetchPauseWatchdog);
    layerState._fetchPauseWatchdog = null;
    stopArrivalKick();
  }

  /**
   * Release client memory held for places away from a switch destination:
   * parsed road sets whose fetch box centre lies more than TILE_CACHE_KEEP_KM
   * from `to` (all of them when `to` carries no coordinates), and the decoded
   * flow and map tiles (the server proxies and HTTP caches refill them).
   * Memory only: nothing on disk is touched.
   * @param {{lat?:number, lon?:number}|null|undefined} to - Switch destination.
   */
  function releaseAreaCachesAwayFrom(to) {
    const keep =
      Number.isFinite(to?.lat) && Number.isFinite(to?.lon)
        ? { lat: to.lat, lon: to.lon }
        : null;
    for (const key of tileCacheKeysAwayFrom(
      layerState._tileCache.keys(),
      keep,
      TILE_CACHE_KEEP_KM,
    ))
      layerState._tileCache.delete(key);
    source.resetFlowTileCache?.();
  }

  const methods = {
    /**
     * Location-switch leave hook (DataLayerManager contract). When enabled,
     * camera-driven loading pauses until `onLocationArrive`. Enabled or not,
     * parsed roads away from `to` and the decoded flow tiles are released.
     * Synchronous, network-free, idempotent; never throws.
     * @param {{to?: {lat:number, lon:number}|null}} [context]
     */
    onLocationLeave(context) {
      try {
        if (layerState._enabled) pauseCameraFetching(PAUSE_LOCATION);
        releaseAreaCachesAwayFrom(context?.to);
      } catch (e) {
        console.warn(
          '[Data:Traffic] Location leave cleanup failed:',
          e?.message || e,
        );
      }
    },

    /**
     * Location-switch arrive hook. Lifts the leave pause and loads the current
     * view right away. An aborted signal means a newer switch now owns the
     * pause, so it stays.
     * @param {{signal?: AbortSignal}} [context]
     */
    onLocationArrive(context) {
      try {
        if (context?.signal?.aborted) return;
        resumeCameraFetching(PAUSE_LOCATION);
      } catch (e) {
        console.warn(
          '[Data:Traffic] Location arrive reload failed:',
          e?.message || e,
        );
      }
    },

    /**
     * Inter-city jump start (application shell). Pauses loading and drops the
     * old view's dots for the flight, like `onLocationLeave`, but keeps every
     * cache: a same-region jump can come straight back.
     */
    beginWorldJump() {
      try {
        if (layerState._enabled) pauseCameraFetching(PAUSE_WORLD_JUMP);
      } catch (e) {
        console.warn(
          '[Data:Traffic] World jump pause failed:',
          e?.message || e,
        );
      }
    },

    /** Inter-city jump end: lift the jump pause and load the current view. */
    endWorldJump() {
      try {
        resumeCameraFetching(PAUSE_WORLD_JUMP);
      } catch (e) {
        console.warn(
          '[Data:Traffic] World jump resume failed:',
          e?.message || e,
        );
      }
    },
  };

  return {
    methods,
    pauseCameraFetching,
    resumeCameraFetching,
    clearPauses,
    releaseAreaCachesAwayFrom,
  };
}
