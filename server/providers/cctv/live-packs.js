import path from 'node:path';
import { areaOverlapsBox } from './area.js';
import {
  AUSTIN_COVERAGE_BOX,
  CALIFORNIA_BOX,
  CCTV_LIVE_PACK_RETRY_MS,
  CCTV_LIVE_PACK_TTL_MS,
  CCTV_LIVE_PACK_WAIT_MS,
  DEFAULT_AUSTIN_ROWS_URL,
  GREATER_LONDON_BOX,
} from './constants.js';
import { readJsonFile, writeJsonFileAtomic } from './json-file.js';
import { withoutSchoolCameras } from './school-filter.js';
import {
  caltransDistricts,
  loadAustinSourcesFromOpenData,
  loadCaltransSourcesFromOpenData,
  loadTflSourcesFromOpenData,
} from './sources.js';

const LIVE_PACK_FORMAT = 'gev-cctv-live/1';

/**
 * The keyless open-data packs downloaded while the server runs. None has a
 * default size or cap: each returns every camera its feed lists. None
 * downloads at startup either: a pack loads only when a /sources area overlaps
 * its coverage box, its country is enabled, and (Caltrans) it is configured.
 * `key` names what the download depends on, so a changed setting refetches.
 */
export const CCTV_LIVE_PACKS = Object.freeze([
  {
    name: 'austin',
    country: 'US',
    box: AUSTIN_COVERAGE_BOX,
    enabled: () => true,
    key: (env) => String(env.CCTV_AUSTIN_ROWS_URL || DEFAULT_AUSTIN_ROWS_URL),
    load: loadAustinSourcesFromOpenData,
  },
  {
    name: 'caltrans',
    country: 'US',
    box: CALIFORNIA_BOX,
    enabled: (env) => caltransDistricts(env).length > 0,
    key: (env) => caltransDistricts(env).join(','),
    load: loadCaltransSourcesFromOpenData,
  },
  {
    name: 'tfl',
    country: 'GB',
    box: GREATER_LONDON_BOX,
    enabled: (env) => String(env.CCTV_TFL_ENABLED ?? '').trim() !== '0',
    key: () => 'jamcam',
    load: loadTflSourcesFromOpenData,
  },
]);

/**
 * Area-triggered live packs with a memory and disk cache (`cctv-<name>.json`
 * under `cacheDir`, written atomically) that stays fresh for `ttlMs`.
 * Concurrent triggers share one download; a failed or empty download is not
 * retried for `retryMs`. A partial download (a loader marks its list
 * `partial`, e.g. a Caltrans district that failed) is served from memory only
 * and retried after `retryMs`, never saved as the day's list. Past its day a
 * list keeps being served until an area asks for it again and the refresh
 * lands.
 */
export function createCctvLivePacks({
  cacheDir = '',
  env,
  fetchImpl,
  now = Date.now,
  packs = CCTV_LIVE_PACKS,
  ttlMs = CCTV_LIVE_PACK_TTL_MS,
  retryMs = CCTV_LIVE_PACK_RETRY_MS,
  waitMs = CCTV_LIVE_PACK_WAIT_MS,
} = {}) {
  const envNow = () => env || process.env;
  /** @type {Map<string, {key: string, at: number, sources: Array<object>|null, partial: boolean, loading: Promise<void>|null, failedKey: string, failedAt: number, diskKey: string|null}>} */
  const states = new Map();
  let warmed = null;

  const stateOf = (pack) => {
    let state = states.get(pack.name);
    if (!state) {
      state = {
        key: '',
        at: 0,
        sources: null,
        partial: false,
        loading: null,
        failedKey: '',
        failedAt: -Infinity,
        diskKey: null,
      };
      states.set(pack.name, state);
    }
    return state;
  };
  const cacheFile = (pack) =>
    cacheDir ? path.join(cacheDir, `cctv-${pack.name}.json`) : '';
  const turnedOn = (pack, countries) =>
    (countries === null || countries.has(pack.country)) &&
    pack.enabled(envNow());
  const isFresh = (state, key) =>
    Boolean(state.sources) &&
    !state.partial &&
    state.key === key &&
    now() - state.at < ttlMs;
  const hasData = (pack) => {
    const state = states.get(pack.name);
    return Boolean(state?.sources) && state.key === pack.key(envNow());
  };

  /** Adopt the disk copy when it is for this key and newer than memory. */
  async function readDisk(pack, key) {
    const file = cacheFile(pack);
    if (!file) return false;
    const saved = await readJsonFile(file);
    if (
      saved?.format !== LIVE_PACK_FORMAT ||
      saved.pack !== pack.name ||
      saved.key !== key ||
      !Number.isFinite(saved.at) ||
      !Array.isArray(saved.sources) ||
      !saved.sources.length
    )
      return false;
    const state = stateOf(pack);
    if (state.sources && state.key === key && state.at >= saved.at)
      return false;
    // A copy saved before the school filter existed is cleaned on the way in.
    const { kept } = withoutSchoolCameras(saved.sources);
    if (!kept.length) return false;
    Object.assign(state, { key, at: saved.at, sources: kept, partial: false });
    return true;
  }

  async function download(pack, key) {
    const state = stateOf(pack);
    if (state.diskKey !== key) {
      state.diskKey = key;
      await readDisk(pack, key);
      if (isFresh(state, key)) return;
    }
    const loaded = await pack.load({ fetchImpl, env: envNow() });
    const partial = Boolean(loaded?.partial);
    // School cameras never reach memory, the disk copy or a response.
    const { kept: sources, removed } = withoutSchoolCameras(loaded);
    if (removed) {
      console.log(
        `[CCTV] ${pack.name} live pack: left out ${removed} school camera${removed === 1 ? '' : 's'}`,
      );
    }
    if (sources.length) {
      const at = now();
      Object.assign(state, { key, at, sources, partial });
      if (partial) {
        // Part of the feed failed: serve what arrived, retry after retryMs,
        // and never save it (a restart would adopt it as the day's list).
        state.failedKey = key;
        state.failedAt = at;
        console.warn(
          `[CCTV] ${pack.name} live pack is incomplete; serving ${sources.length} camera${sources.length === 1 ? '' : 's'} and retrying in ${Math.round(retryMs / 1000)} s`,
        );
        return;
      }
      const file = cacheFile(pack);
      if (file) {
        await writeJsonFileAtomic(file, {
          format: LIVE_PACK_FORMAT,
          pack: pack.name,
          key,
          at,
          sources,
        });
      }
      return;
    }
    state.failedKey = key;
    state.failedAt = now();
  }

  /** Start (or join) a pack's refresh; null when nothing needs to run. */
  function ensure(pack) {
    const state = stateOf(pack);
    const key = pack.key(envNow());
    if (isFresh(state, key)) return null;
    if (state.loading) return state.loading;
    if (state.failedKey === key && now() - state.failedAt < retryMs)
      return null;
    const loading = download(pack, key)
      .catch((error) => {
        state.failedKey = key;
        state.failedAt = now();
        console.warn(
          `[CCTV] ${pack.name} live pack failed:`,
          error?.message || error,
        );
      })
      .finally(() => {
        if (state.loading === loading) state.loading = null;
      });
    state.loading = loading;
    return loading;
  }

  /**
   * Load the packs a selected area needs. Waits up to `waitMs` for them; a
   * pack still downloading with nothing to show yet is listed in `pending`.
   *
   * @param {{lat: number, lon: number, radiusKm: number}} area
   * @param {Set<string>|null} countries - Enabled countries (null: all).
   * @returns {Promise<{pending: string[]}>}
   */
  async function ensureArea(area, countries) {
    const loads = [];
    for (const pack of packs) {
      if (!turnedOn(pack, countries) || !areaOverlapsBox(area, pack.box))
        continue;
      const loading = ensure(pack);
      if (loading) loads.push({ pack, loading, done: false });
    }
    if (!loads.length) return { pending: [] };
    for (const entry of loads) {
      entry.loading.then(() => {
        entry.done = true;
      });
    }
    let timer = null;
    await Promise.race([
      Promise.all(loads.map((entry) => entry.loading)),
      new Promise((resolve) => {
        timer = setTimeout(resolve, waitMs);
      }),
    ]);
    clearTimeout(timer);
    return {
      pending: loads
        .filter((entry) => !entry.done && !hasData(entry.pack))
        .map((entry) => entry.pack.name),
    };
  }

  /**
   * Cameras of every turned-on pack that holds a list for its current key,
   * plus a signature that changes whenever that set changes.
   *
   * @param {Set<string>|null} countries
   */
  function sources(countries) {
    const out = [];
    for (const pack of packs) {
      if (!turnedOn(pack, countries) || !hasData(pack)) continue;
      for (const source of states.get(pack.name).sources) out.push(source);
    }
    return { sources: out, signature: signature(countries) };
  }

  /** @param {Set<string>|null} countries */
  function signature(countries) {
    const parts = [];
    for (const pack of packs) {
      if (!turnedOn(pack, countries) || !hasData(pack)) continue;
      const state = states.get(pack.name);
      parts.push(`${pack.name}@${state.at}@${state.key}`);
    }
    return parts.join('|');
  }

  /**
   * Adopt lists already saved on disk, once, without any download: a frame or
   * lookup request for a live-pack camera right after a restart still finds
   * it. Resolves true when something was adopted.
   *
   * @param {Set<string>|null} countries
   */
  function warmFromDisk(countries) {
    if (!warmed) {
      warmed = (async () => {
        let adopted = false;
        for (const pack of packs) {
          if (!turnedOn(pack, countries) || hasData(pack)) continue;
          if (await readDisk(pack, pack.key(envNow()))) adopted = true;
        }
        return adopted;
      })();
    }
    return warmed;
  }

  /** Pack names with a download in progress. */
  function loading() {
    return packs
      .filter((pack) => states.get(pack.name)?.loading)
      .map((pack) => pack.name);
  }

  return { ensureArea, sources, signature, warmFromDisk, loading };
}
