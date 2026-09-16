import { makeRateLimiter, clientKey } from '../common/rate-limit.js';
import { coalesceProxyRequest } from '../common/http.js';
import { fetchRegionalJson } from './http.js';
import { normalizeRegionalPlace } from '../../../src/data/regionalBrief.js';
import {
  nominatimToGeocodeResult,
  nominatimViewboxFromBounds,
} from '../../../src/nominatimGeocode.js';

const NOMINATIM_SPACING_MS = 1100;
const NOMINATIM_HEADERS = Object.freeze({
  'User-Agent':
    'gods-eye-view/0.1 (+https://github.com/AiCanada/Gods-Eye-View-Canada)',
  Referer: 'https://github.com/AiCanada/Gods-Eye-View-Canada',
});
const NOMINATIM_MAX_PENDING = 4;
const NOMINATIM_MAX_WAIT_MS = 10_000;
const NOMINATIM_SEARCH_CACHE_MS = 5 * 60_000;
const NOMINATIM_SEARCH_MAX_CACHE = 80;
const NOMINATIM_SEARCH_MAX_QUERY = 200;

let _nominatimQueue = Promise.resolve();

let _nominatimLastRequestAt = 0;

let _nominatimPending = 0;

function placeLookupAborted() {
  return new DOMException('Regional place lookup was aborted', 'AbortError');
}

/** Wait out the spacing, or stop early once the lookup is no longer wanted. */
function waitForNominatimTurn(waitMs, signal) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, waitMs);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * Reverse-geocode a point through Nominatim. Every lookup shares one queue
 * spaced NOMINATIM_SPACING_MS apart (the public usage policy). A lookup whose
 * `signal` has aborted by its turn, or during the spacing wait, rejects with an
 * AbortError without calling Nominatim, so superseded lookups do not hold up
 * the ones behind them. A lookup already sent to Nominatim is not cancelled.
 * @param {{latitude: number, longitude: number}} point
 * @param {{signal?: AbortSignal}} [options]
 */
function fetchRegionalPlace(point, { signal } = {}) {
  const task = _nominatimQueue.then(async () => {
    if (signal?.aborted) throw placeLookupAborted();
    const waitMs = Math.max(
      0,
      NOMINATIM_SPACING_MS - (Date.now() - _nominatimLastRequestAt),
    );
    if (waitMs) await waitForNominatimTurn(waitMs, signal);
    if (signal?.aborted) throw placeLookupAborted();
    _nominatimLastRequestAt = Date.now();
    const params = new URLSearchParams({
      format: 'jsonv2',
      lat: point.latitude.toFixed(5),
      lon: point.longitude.toFixed(5),
      zoom: '10',
      addressdetails: '1',
      'accept-language': 'en',
    });
    const payload = await fetchRegionalJson(
      `https://nominatim.openstreetmap.org/reverse?${params}`,
      {
        headers: NOMINATIM_HEADERS,
        redirect: 'error',
      },
    );
    return normalizeRegionalPlace(payload);
  });
  _nominatimQueue = task.catch(() => null);
  return task;
}

function queueFullError() {
  return Object.assign(new Error('Place search queue is full'), {
    code: 'NOMINATIM_QUEUE_FULL',
  });
}

function abandonedError() {
  return Object.assign(new Error('Place search was abandoned'), {
    code: 'NOMINATIM_ABANDONED',
  });
}

/**
 * Construct the forward search adapter. Reverse lookups and searches share the
 * one-request-per-second Nominatim budget.
 */
export function createNominatimSearchProvider({
  endpoint = 'https://nominatim.openstreetmap.org/search',
  requestJson = fetchRegionalJson,
} = {}) {
  const cache = new Map();
  const inFlight = new Map();

  const trimCache = () => {
    while (cache.size > NOMINATIM_SEARCH_MAX_CACHE) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  };

  return async function fetchNominatimSearch(query, bounds, { signal } = {}) {
    const cacheKey = `${query.toLowerCase()}|${bounds || ''}`;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.cachedAt <= NOMINATIM_SEARCH_CACHE_MS) {
      return { ...cached.payload, cached: true };
    }
    const { promise } = coalesceProxyRequest(inFlight, cacheKey, async () => {
      if (_nominatimPending >= NOMINATIM_MAX_PENDING) throw queueFullError();
      _nominatimPending += 1;
      const queuedAt = Date.now();
      const task = _nominatimQueue.then(async () => {
        try {
          const waitMs = Math.max(
            0,
            NOMINATIM_SPACING_MS - (Date.now() - _nominatimLastRequestAt),
          );
          if (waitMs) await waitForNominatimTurn(waitMs, signal);
          if (Date.now() - queuedAt > NOMINATIM_MAX_WAIT_MS)
            throw abandonedError();
          if (signal?.aborted) throw abandonedError();
          _nominatimLastRequestAt = Date.now();
          const params = new URLSearchParams({
            format: 'jsonv2',
            q: query,
            addressdetails: '1',
            limit: '1',
            'accept-language': 'en',
          });
          const viewbox = nominatimViewboxFromBounds(bounds);
          if (viewbox) params.set('viewbox', viewbox);
          const rows = await requestJson(`${endpoint}?${params}`, {
            headers: NOMINATIM_HEADERS,
            redirect: 'error',
          });
          const result = nominatimToGeocodeResult(
            Array.isArray(rows) ? rows[0] : null,
          );
          const payload = result
            ? { status: 'OK', results: [result] }
            : { status: 'ZERO_RESULTS', results: [] };
          cache.set(cacheKey, { payload, cachedAt: Date.now() });
          trimCache();
          return payload;
        } finally {
          _nominatimPending -= 1;
        }
      });
      _nominatimQueue = task.catch(() => null);
      return await task;
    });
    return await promise;
  };
}

export const fetchNominatimSearch = createNominatimSearchProvider();

/** Vite plugin: last-resort place search over the public Nominatim instance. */
export function geocodeProxy({ search = fetchNominatimSearch } = {}) {
  const limiter = makeRateLimiter({
    windowMs: 60_000,
    max: 30,
    globalMax: 90,
  });

  function install(middlewares) {
    middlewares.use('/api/geocode', async (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method Not Allowed' }));
        return;
      }
      if (!limiter(clientKey(req))) {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'Retry-After': '10',
        });
        res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
        return;
      }
      const url = new URL(req.url || '', 'http://localhost');
      const query = String(url.searchParams.get('q') || '').trim();
      if (!query || query.length > NOMINATIM_SEARCH_MAX_QUERY) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'A place query of 1-200 characters is required',
          }),
        );
        return;
      }
      const abandoned = new AbortController();
      req.on?.('aborted', () => abandoned.abort());
      res.on?.('close', () => abandoned.abort());
      try {
        const payload = await search(query, url.searchParams.get('bounds'), {
          signal: abandoned.signal,
        });
        if (res.writableEnded) return;
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': payload.cached ? 'public, max-age=60' : 'no-store',
        });
        res.end(
          JSON.stringify({ status: payload.status, results: payload.results }),
        );
      } catch (error) {
        if (res.writableEnded) return;
        const busy =
          error?.code === 'NOMINATIM_QUEUE_FULL' ||
          error?.code === 'NOMINATIM_ABANDONED';
        res.writeHead(busy ? 429 : 503, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          ...(busy ? { 'Retry-After': '5' } : {}),
        });
        res.end(
          JSON.stringify({
            error: busy
              ? 'Place search is busy'
              : 'Place search is temporarily unavailable',
          }),
        );
      }
    });
  }

  return {
    name: 'geocode-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

export { fetchRegionalPlace, NOMINATIM_MAX_PENDING };
