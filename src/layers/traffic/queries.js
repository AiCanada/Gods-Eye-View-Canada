/**
 * @file Read-only views onto a live traffic layer for other scene owners:
 * the CCTV picture projector draws the vehicles a camera can see, CCTV
 * thumbnails turn along the nearest loaded road, and detection shows only the
 * vehicles it has tagged.
 *
 * @module layers/traffic/queries
 */

/** Main roads pull harder than side streets: a road camera watches the big road it stands by. */
const ROAD_BEARING_TYPE_BONUS_M = Object.freeze({
  motorway: 25,
  trunk: 20,
  primary: 12,
  secondary: 6,
});

/**
 * The road nearest a point: where it runs, and the nearest point on it. Pure.
 * A road has two directions; `bearingDeg` is one of them (0 to 180).
 * @param {Array<{coords:number[][], type?:string}>} roads `coords` are [lon, lat].
 * @param {number} lat
 * @param {number} lon
 * @param {number} [maxM=80] Roads farther than this are ignored.
 * @returns {{bearingDeg:number, lat:number, lon:number, distanceM:number, type:string}|null}
 */
export function nearestRoadBearing(roads, lat, lon, maxM = 80) {
  if (!Array.isArray(roads) || !Number.isFinite(lat) || !Number.isFinite(lon))
    return null;
  const mPerLat = 111_320;
  const mPerLon = 111_320 * Math.cos((lat * Math.PI) / 180);
  const latSpan = maxM / mPerLat;
  const lonSpan = maxM / Math.max(1, mPerLon);
  let best = null;
  let bestScore = Infinity;
  for (let r = 0; r < roads.length; r += 1) {
    const coords = roads[r]?.coords;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const bonus = ROAD_BEARING_TYPE_BONUS_M[roads[r].type] || 0;
    for (let i = 1; i < coords.length; i += 1) {
      const a = coords[i - 1];
      const b = coords[i];
      if (
        (a[1] < lat - latSpan && b[1] < lat - latSpan) ||
        (a[1] > lat + latSpan && b[1] > lat + latSpan) ||
        (a[0] < lon - lonSpan && b[0] < lon - lonSpan) ||
        (a[0] > lon + lonSpan && b[0] > lon + lonSpan)
      )
        continue;
      const ax = (a[0] - lon) * mPerLon;
      const ay = (a[1] - lat) * mPerLat;
      const bx = (b[0] - lon) * mPerLon;
      const by = (b[1] - lat) * mPerLat;
      const dx = bx - ax;
      const dy = by - ay;
      const lengthSq = dx * dx + dy * dy;
      if (lengthSq < 1e-6) continue;
      const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSq));
      const px = ax + dx * t;
      const py = ay + dy * t;
      const distanceM = Math.sqrt(px * px + py * py);
      if (distanceM > maxM) continue;
      const score = distanceM - bonus;
      if (score >= bestScore) continue;
      bestScore = score;
      let bearingDeg = (Math.atan2(dx, dy) * 180) / Math.PI;
      bearingDeg = ((bearingDeg % 180) + 180) % 180;
      best = {
        bearingDeg,
        lat: lat + py / mPerLat,
        lon: lon + px / mPerLon,
        distanceM,
        type: roads[r].type || '',
      };
    }
  }
  return best;
}

export function createQueries({ state: layerState }) {
  const methods = {
    /**
     * Visit every live traffic dot's point primitive (position, color,
     * pixelSize, show) without allocating. Read-only. The index is the dot's
     * slot this frame, the same one detection uses for its `VEH-0000` tag.
     * @param {(point: object, index: number) => void} visit
     */
    forEachTrafficDot(visit) {
      if (!layerState._enabled || typeof visit !== 'function') return;
      for (let i = 0; i < layerState._dots.length; i += 1) {
        const point = layerState._dots[i]?.point;
        if (point?.position) visit(point, i);
      }
    },

    /** The loaded road nearest a point (see nearestRoadBearing). */
    roadBearingNear(lat, lon, maxM = 80) {
      return layerState._enabled && layerState._roads.length
        ? nearestRoadBearing(layerState._roads, lat, lon, maxM)
        : null;
    },

    /** Changes whenever the loaded roads are replaced; -1 while disabled. */
    getRoadsRevision() {
      return layerState._enabled ? layerState._roadsRevision || 0 : -1;
    },

    /**
     * Show only the vehicles whose slot is in `indices` (the ones detection
     * has given a `VEH-0000` tag), or every vehicle when `indices` is null. A
     * vehicle on a closed road, or retiring, stays hidden either way. Writes
     * only on change, so calling it every frame is cheap.
     * @param {Set<number>|null} indices
     */
    setTrafficTagFilter(indices) {
      for (let i = 0; i < layerState._dots.length; i += 1) {
        const dot = layerState._dots[i];
        if (!dot?.point) continue;
        const flow = dot.road?.flow;
        const hidden =
          flow?.closure ||
          (layerState._liveMode &&
            !flow &&
            layerState._uncoveredMode === 'hide');
        const wanted = !hidden && (!indices || indices.has(i));
        if (dot.point.show !== wanted) dot.point.show = wanted;
      }
    },
  };
  return { methods };
}
