/**
 * @module mapTileRelease
 * @description Release the photoreal tiles of a place the user has left.
 * Cesium keeps loaded 3D tiles in a cache of up to 512 MB (the app sets no
 * budget), so the old city's buildings would otherwise stay in memory after a
 * location switch. Trimming waits until the new view has finished loading, so
 * the tiles on screen at the destination are never the ones dropped.
 */

/** Longest wait for the destination's tiles before giving up on the trim. */
export const TILE_RELEASE_TIMEOUT_MS = 30_000;

/**
 * The same through the renderer's ports, for a photoreal base this code holds
 * only an opaque handle to (the scene's map engine, src/maps/globeEngine.js):
 * once what is in view has loaded, the renderer frees what nothing in view
 * uses. A wait that times out or fails trims nothing, as with a tileset.
 * @param {object|null} renderer The bound renderer (whenSettled, releaseUnused).
 * @param {number} timeoutMs
 * @returns {() => void} Cancels a trim that has not run yet.
 */
function releaseUnusedAfterSettle(renderer, timeoutMs) {
  if (
    typeof renderer?.whenSettled !== 'function' ||
    typeof renderer.releaseUnused !== 'function'
  )
    return () => {};
  let cancelled = false;
  Promise.resolve()
    .then(() => renderer.whenSettled({ timeoutMs }))
    .then((result) => {
      if (!cancelled && result?.state === 'settled') renderer.releaseUnused();
    })
    .catch(() => {});
  return () => {
    cancelled = true;
  };
}

/**
 * Trim a tileset's cached tiles once its current view has loaded.
 * @param {object|null} tileset A Cesium3DTileset, or the map engine's handle
 *   to the photoreal base (trimmed through `options.renderer`).
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 * @param {() => void} [options.requestRender] Asks for a frame so the unload runs.
 * @param {(fn: Function, ms: number) => unknown} [options.setTimer]
 * @param {(id: unknown) => void} [options.clearTimer]
 * @param {object|null} [options.renderer] The scene's renderer, for a handle
 *   that is not a tileset.
 * @returns {() => void} Cancels a trim that has not run yet.
 */
export function releaseTilesAfterLoad(
  tileset,
  {
    timeoutMs = TILE_RELEASE_TIMEOUT_MS,
    requestRender = () => {},
    setTimer = (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimer = (id) => globalThis.clearTimeout(id),
    renderer = null,
  } = {},
) {
  if (!tileset || tileset.isDestroyed?.()) return () => {};
  if (typeof tileset.trimLoadedTiles !== 'function')
    return releaseUnusedAfterSettle(renderer, timeoutMs);
  let done = false;
  let timer = null;
  let removeListener = null;
  const finish = (trim) => {
    if (done) return;
    done = true;
    clearTimer(timer);
    removeListener?.();
    if (!trim || tileset.isDestroyed?.()) return;
    tileset.trimLoadedTiles();
    requestRender();
  };
  if (tileset.tilesLoaded === true) {
    finish(true);
    return () => {};
  }
  removeListener =
    tileset.allTilesLoaded?.addEventListener?.(() => finish(true)) || null;
  timer = setTimer(() => finish(false), timeoutMs);
  return () => finish(false);
}
