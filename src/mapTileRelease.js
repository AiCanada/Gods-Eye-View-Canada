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
 * Trim a tileset's cached tiles once its current view has loaded.
 * @param {object|null} tileset A Cesium3DTileset.
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 * @param {() => void} [options.requestRender] Asks for a frame so the unload runs.
 * @param {(fn: Function, ms: number) => unknown} [options.setTimer]
 * @param {(id: unknown) => void} [options.clearTimer]
 * @returns {() => void} Cancels a trim that has not run yet.
 */
export function releaseTilesAfterLoad(
  tileset,
  {
    timeoutMs = TILE_RELEASE_TIMEOUT_MS,
    requestRender = () => {},
    setTimer = (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimer = (id) => globalThis.clearTimeout(id),
  } = {},
) {
  if (
    !tileset ||
    typeof tileset.trimLoadedTiles !== 'function' ||
    tileset.isDestroyed?.()
  )
    return () => {};
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
