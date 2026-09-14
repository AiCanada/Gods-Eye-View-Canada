import {
  CCTV_FRAME_CACHE_MAX_BYTES,
  CCTV_FRAME_CACHE_MAX_ENTRIES,
  CCTV_IBI_LAST_GOOD_MAX_MS,
} from './constants.js';

/**
 * Least-recently-used cache of upstream stills, bounded by entry count and by
 * bytes. Each read names how old a still it accepts, so one cache serves the
 * 8-second reuse of ordinary hosts, the longer reuse of budgeted 511 hosts and
 * the last-good still served once a budget is spent. Nothing older than
 * `maxAgeMs` is ever returned.
 *
 * @param {{maxEntries?: number, maxBytes?: number, maxAgeMs?: number, now?: () => number}} [options]
 */
export function createFrameCache({
  maxEntries = CCTV_FRAME_CACHE_MAX_ENTRIES,
  maxBytes = CCTV_FRAME_CACHE_MAX_BYTES,
  maxAgeMs = CCTV_IBI_LAST_GOOD_MAX_MS,
  now = Date.now,
} = {}) {
  /** @type {Map<string, {body: Buffer, contentType: string, at: number}>} */
  const entries = new Map();
  let bytes = 0;

  const remove = (key) => {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    bytes -= entry.body.length;
  };

  return {
    /**
     * @param {string} key
     * @param {number} maxAge - Oldest still (ms) this caller accepts.
     * @returns {{body: Buffer, contentType: string, at: number}|null}
     */
    get(key, maxAge) {
      const entry = entries.get(key);
      if (!entry) return null;
      const age = now() - entry.at;
      if (age > maxAgeMs) {
        remove(key);
        return null;
      }
      if (!(age <= maxAge)) return null;
      entries.delete(key);
      entries.set(key, entry);
      return entry;
    },
    /** Store a still; one larger than the whole cache is not kept. */
    set(key, { body, contentType, at = now() }) {
      if (!Buffer.isBuffer(body) || body.length > maxBytes) return false;
      remove(key);
      entries.set(key, { body, contentType, at });
      bytes += body.length;
      while (entries.size > maxEntries || bytes > maxBytes) {
        remove(entries.keys().next().value);
      }
      return true;
    },
    delete: remove,
    get size() {
      return entries.size;
    },
    get bytes() {
      return bytes;
    },
  };
}
