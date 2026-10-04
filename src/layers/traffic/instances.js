/**
 * @file Live Street Traffic instances, for scene owners that are not handed
 * the layer (CCTV pictures and road bearings, detection tag filtering, the
 * application shell's world jump). Each query checks its own instance is
 * enabled, so asking every instance reaches whichever one is live.
 *
 * @module layers/traffic/instances
 */

const instances = new Set();

/** Record one constructed layer's read-only queries and jump hooks. */
export function registerTrafficInstance(api) {
  instances.add(api);
  return () => instances.delete(api);
}

/** Visit every live dot of every enabled instance. */
export function forEachTrafficDot(visit) {
  for (const api of instances) api.forEachTrafficDot(visit);
}

/** The loaded road nearest a point, from the first enabled instance with roads. */
export function roadBearingNear(lat, lon, maxM = 80) {
  for (const api of instances) {
    const road = api.roadBearingNear(lat, lon, maxM);
    if (road) return road;
  }
  return null;
}

/** The enabled instance's road-list revision, or -1 when none is enabled. */
export function getRoadsRevision() {
  for (const api of instances) {
    const revision = api.getRoadsRevision();
    if (revision >= 0) return revision;
  }
  return -1;
}

/** Apply detection's vehicle tag filter to every instance. */
export function setTrafficTagFilter(indices) {
  for (const api of instances) api.setTrafficTagFilter(indices);
}

/** Pause every instance for an inter-city world jump. */
export function beginWorldJump() {
  for (const api of instances) api.beginWorldJump();
}

/** End an inter-city world jump on every instance. */
export function endWorldJump() {
  for (const api of instances) api.endWorldJump();
}
