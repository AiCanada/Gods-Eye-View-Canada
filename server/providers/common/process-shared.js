/**
 * One instance per process of a module-level cache.
 *
 * Vite restarts the dev server in-process whenever a server file changes,
 * and a restart loads a fresh copy of every server module. Node never unloads
 * the old copy: a cache held in a module's own scope stays pinned by that
 * copy for the life of the process while the new copy fills another. Thirty
 * such restarts in a day (`.gev-logs/dev-server.log`, 2026-10-23 to 29) left
 * the server holding 8 to 15 GB before the supervisor recycled it, and a
 * heap that size is what the probe time-outs in the same log were: the
 * collector stopping the event loop for seconds at a time.
 *
 * Held on `globalThis` under a name, the second copy finds the first copy's
 * cache and goes on with it: a restart costs no memory and loses no warm
 * cache. The terrain proxy has done this since its first restart leak
 * (`globalThis.__GEV_TERRAIN_CACHE`); this is the same pattern for the rest.
 * Only caches go here, never a copy's own in-flight work, timers or sockets,
 * which belong to the copy that made them and end with its server.
 *
 * @template T
 * @param {string} name Unique across the server; prefix with the module.
 * @param {() => T} make Builds the instance the first time.
 * @returns {T}
 */
export function processShared(name, make) {
  const bag = (globalThis.__GEV_PROCESS_SHARED ??= Object.create(null));
  if (!(name in bag)) bag[name] = make();
  return bag[name];
}
