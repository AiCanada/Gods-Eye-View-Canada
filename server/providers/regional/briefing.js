import { makeRateLimiter, clientKey } from '../common/rate-limit.js';
import { fetchRegionalPlace } from './place.js';
import { fetchRegionalWeather } from './weather.js';
import {
  fetchAlJazeeraCoverage,
  fetchGovCrimeNews,
  fetchRegionalNews,
  fetchRiskNews,
} from './news.js';
import { fetchCountryGroundTruth } from './country-ground-truth.js';
import { validRegionalPoint } from './query.js';
import { coalesceProxyRequest } from '../common/http.js';
import { locationRegionKey } from '../../../src/data/regionalBrief.js';

// ---------------------------------------------------------------------------
// Regional cockpit briefing proxy
// ---------------------------------------------------------------------------
const REGIONAL_BRIEF_CACHE_MS = 5 * 60_000;

const REGIONAL_BRIEF_STALE_MS = 60 * 60_000;

const REGIONAL_BRIEF_MAX_CACHE = 120;

const _regionalBriefCache = new Map();

const _regionalBriefInFlight = new Map();

const _groundTruthInFlight = new Map();

const _regionalBriefRateLimiter = makeRateLimiter({
  windowMs: 60_000,
  max: 30,
  globalMax: 90,
});

// Which province, state or country a point is in: the key a location switch
// compares. The answer for a spot does not change, so it is kept for a day.
const LOCATION_REGION_CACHE_MS = 24 * 60 * 60_000;

// Open water and other spots Nominatim cannot place ("Unable to geocode").
// Kept briefly, so repeat clicks there do not call upstream again.
const LOCATION_REGION_UNPLACED_CACHE_MS = 10 * 60_000;

const LOCATION_REGION_UNPLACED = Object.freeze({
  key: '',
  regionCode: null,
  region: null,
  countryCode: null,
  country: null,
});

const LOCATION_REGION_MAX_CACHE = 256;

const _locationRegionCache = new Map();

/**
 * One upstream lookup per ~1 km cell, shared by every request waiting on it.
 * When the last waiter disconnects the lookup is aborted, so a superseded
 * click does not keep its place in the Nominatim queue.
 * @type {Map<string, {promise: Promise<object>, controller: AbortController, waiters: number}>}
 */
const _locationRegionInFlight = new Map();

const _locationRegionRateLimiter = makeRateLimiter({
  windowMs: 60_000,
  max: 30,
  globalMax: 90,
});

const RISK_NEWS_CACHE_MS = 5 * 60_000;
const RISK_NEWS_MAX_CACHE = 120;
const _riskNewsCache = new Map();
const _riskNewsInFlight = new Map();
const _riskNewsRateLimiter = makeRateLimiter({
  windowMs: 60_000,
  max: 20,
  globalMax: 60,
});

function trimRegionalBriefCache() {
  while (_regionalBriefCache.size > REGIONAL_BRIEF_MAX_CACHE) {
    const oldest = _regionalBriefCache.keys().next().value;
    if (oldest === undefined) break;
    _regionalBriefCache.delete(oldest);
  }
}

function trimRiskNewsCache() {
  while (_riskNewsCache.size > RISK_NEWS_MAX_CACHE) {
    const oldest = _riskNewsCache.keys().next().value;
    if (oldest === undefined) break;
    _riskNewsCache.delete(oldest);
  }
}

/** True when at least one regional source produced usable data. */
function regionalBriefHasAnySource({ place, weather, news } = {}) {
  return Boolean(place || weather || (news && news.status !== 'unavailable'));
}

function cacheLocationRegion(key, payload, ttlMs) {
  _locationRegionCache.delete(key);
  _locationRegionCache.set(key, { payload, cachedAt: Date.now(), ttlMs });
  while (_locationRegionCache.size > LOCATION_REGION_MAX_CACHE) {
    _locationRegionCache.delete(_locationRegionCache.keys().next().value);
  }
}

/** Start the shared, abortable upstream lookup for one cell. */
function startLocationRegionLookup(point, key) {
  const controller = new AbortController();
  const flight = { promise: null, controller, waiters: 0 };
  flight.promise = fetchRegionalPlace(point, { signal: controller.signal })
    .then((place) => {
      if (!place) {
        cacheLocationRegion(
          key,
          LOCATION_REGION_UNPLACED,
          LOCATION_REGION_UNPLACED_CACHE_MS,
        );
        return LOCATION_REGION_UNPLACED;
      }
      const payload = {
        key: locationRegionKey(place),
        regionCode: place.regionCode,
        region: place.region,
        countryCode: place.countryCode,
        country: place.country,
      };
      cacheLocationRegion(key, payload, LOCATION_REGION_CACHE_MS);
      return payload;
    })
    .finally(() => {
      if (_locationRegionInFlight.get(key) === flight)
        _locationRegionInFlight.delete(key);
    });
  _locationRegionInFlight.set(key, flight);
  return flight;
}

function regionalBriefProxy() {
  async function refresh(point, key) {
    const [placeResult, weatherResult] = await Promise.allSettled([
      fetchRegionalPlace(point),
      fetchRegionalWeather(point),
    ]);
    const place = placeResult.status === 'fulfilled' ? placeResult.value : null;
    const weather =
      weatherResult.status === 'fulfilled' ? weatherResult.value : null;
    const news = await fetchRegionalNews(place);
    if (!regionalBriefHasAnySource({ place, weather, news })) {
      throw new Error('All regional briefing sources unavailable');
    }
    const payload = {
      status:
        place && weather && news.status !== 'unavailable' ? 'ready' : 'partial',
      retrievedAt: new Date().toISOString(),
      coordinates: point,
      place,
      placeStatus: place ? 'ready' : 'unavailable',
      weather,
      weatherStatus: weather ? 'ready' : 'unavailable',
      newsStatus: news.status,
      newsQuery: news.query,
      newsSource: news.source,
      articles: news.articles,
    };
    _regionalBriefCache.set(key, { payload, cachedAt: Date.now() });
    trimRegionalBriefCache();
    return payload;
  }

  function install(middlewares) {
    middlewares.use('/api/regional-brief', async (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method Not Allowed' }));
        return;
      }
      if (!_regionalBriefRateLimiter(clientKey(req))) {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'Retry-After': '10',
        });
        res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
        return;
      }
      const url = new URL(req.url || '', 'http://localhost');
      const point = validRegionalPoint(url.searchParams);
      if (!point) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'Valid latitude and longitude are required',
          }),
        );
        return;
      }
      const key = `${(Math.round(point.latitude * 10) / 10).toFixed(1)},${(Math.round(point.longitude * 10) / 10).toFixed(1)}`;
      const now = Date.now();
      const cached = _regionalBriefCache.get(key);
      if (cached && now - cached.cachedAt <= REGIONAL_BRIEF_CACHE_MS) {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=60',
          'X-Regional-Brief': 'HIT',
        });
        res.end(JSON.stringify({ ...cached.payload, status: 'cached' }));
        return;
      }
      const request = coalesceProxyRequest(_regionalBriefInFlight, key, () =>
        refresh(point, key),
      );
      try {
        const payload = await request.promise;
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=60',
          'X-Regional-Brief': request.shared ? 'INFLIGHT' : 'MISS',
        });
        res.end(JSON.stringify(payload));
      } catch {
        if (cached && now - cached.cachedAt <= REGIONAL_BRIEF_STALE_MS) {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'X-Regional-Brief': 'STALE',
          });
          res.end(JSON.stringify({ ...cached.payload, status: 'stale' }));
          return;
        }
        res.writeHead(503, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(
          JSON.stringify({
            error: 'Regional briefing is temporarily unavailable',
          }),
        );
      }
    });

    middlewares.use('/api/regional-risk-news', async (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method Not Allowed' }));
        return;
      }
      if (!_riskNewsRateLimiter(clientKey(req))) {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'Retry-After': '10',
        });
        res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
        return;
      }
      const url = new URL(req.url || '', 'http://localhost');
      const point = validRegionalPoint(url.searchParams);
      if (!point) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'Valid latitude and longitude are required',
          }),
        );
        return;
      }
      const query = String(url.searchParams.get('q') || '');
      const place = String(url.searchParams.get('place') || '');
      const region = String(url.searchParams.get('region') || '');
      const key = `${(Math.round(point.latitude * 10) / 10).toFixed(1)},${(Math.round(point.longitude * 10) / 10).toFixed(1)}|${query}|${region}|${place}`;
      const now = Date.now();
      const cached = _riskNewsCache.get(key);
      if (cached && now - cached.cachedAt <= RISK_NEWS_CACHE_MS) {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=60',
          'X-Regional-Risk-News': 'HIT',
        });
        res.end(JSON.stringify(cached.payload));
        return;
      }
      const request = coalesceProxyRequest(_riskNewsInFlight, key, async () => {
        const [news, gov, alJazeera] = await Promise.all([
          fetchRiskNews({
            query,
            latitude: point.latitude,
            longitude: point.longitude,
          }),
          fetchGovCrimeNews({ place, region }),
          fetchAlJazeeraCoverage({ place }),
        ]);
        const payload = {
          ...news,
          govArticles: gov.articles,
          govSource: gov.source,
          govStatus: gov.status,
          govQuery: gov.query,
          alJazeera,
        };
        _riskNewsCache.set(key, { payload, cachedAt: Date.now() });
        trimRiskNewsCache();
        return payload;
      });
      try {
        const payload = await request.promise;
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=60',
          'X-Regional-Risk-News': request.shared ? 'INFLIGHT' : 'MISS',
        });
        res.end(JSON.stringify(payload));
      } catch {
        if (cached && now - cached.cachedAt <= RISK_NEWS_CACHE_MS) {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'X-Regional-Risk-News': 'STALE',
          });
          res.end(JSON.stringify(cached.payload));
          return;
        }
        res.writeHead(503, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(
          JSON.stringify({
            error: 'Regional risk news is temporarily unavailable',
          }),
        );
      }
    });

    // Country Ground Truth Assessment: checks computed from a country's own
    // published statistics table. One upstream sweep a day (the table is
    // annual); every press after that is answered from memory.
    middlewares.use('/api/country-ground-truth', async (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method Not Allowed' }));
        return;
      }
      if (!_riskNewsRateLimiter(clientKey(req))) {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'Retry-After': '10',
        });
        res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
        return;
      }
      const url = new URL(req.url || '', 'http://localhost');
      const country = String(url.searchParams.get('country') || '').trim();
      if (!/^[A-Za-z]{2}$/.test(country)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ error: 'A two-letter country code is required' }),
        );
        return;
      }
      const request = coalesceProxyRequest(
        _groundTruthInFlight,
        country.toUpperCase(),
        () =>
          fetchCountryGroundTruth(
            country,
            String(url.searchParams.get('name') || ''),
          ),
      );
      try {
        const payload = await request.promise;
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=300',
        });
        res.end(JSON.stringify(payload));
      } catch {
        res.writeHead(503, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(
          JSON.stringify({
            error: 'The country statistics table is temporarily unavailable',
          }),
        );
      }
    });

    middlewares.use('/api/location-region', async (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method Not Allowed' }));
        return;
      }
      const url = new URL(req.url || '', 'http://localhost');
      const point = validRegionalPoint(url.searchParams);
      if (!point) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'Valid latitude and longitude are required',
          }),
        );
        return;
      }
      // Cells of about 1 km, small enough that a border rarely splits one.
      const key = `${point.latitude.toFixed(2)},${point.longitude.toFixed(2)}`;
      const cached = _locationRegionCache.get(key);
      if (cached && Date.now() - cached.cachedAt <= cached.ttlMs) {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'X-Location-Region': 'HIT',
        });
        res.end(JSON.stringify(cached.payload));
        return;
      }
      // Only a request that starts upstream work is charged: cache hits and
      // joins of a lookup already running cost nothing, so repeat clicks never
      // spend the quota a real switch needs.
      let flight = _locationRegionInFlight.get(key);
      const shared = Boolean(flight);
      if (!flight) {
        if (!_locationRegionRateLimiter(clientKey(req))) {
          res.writeHead(429, {
            'Content-Type': 'application/json',
            'Retry-After': '10',
          });
          res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
          return;
        }
        flight = startLocationRegionLookup(point, key);
      }
      flight.waiters += 1;
      let waiting = true;
      req.on?.('close', () => {
        if (!waiting || res.writableEnded) return;
        waiting = false;
        flight.waiters -= 1;
        if (flight.waiters > 0) return;
        // Nobody is waiting any more: a newer request for this cell starts
        // its own lookup instead of joining the aborted one.
        if (_locationRegionInFlight.get(key) === flight)
          _locationRegionInFlight.delete(key);
        flight.controller.abort();
      });
      try {
        const payload = await flight.promise;
        waiting = false;
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'X-Location-Region': shared ? 'INFLIGHT' : 'MISS',
        });
        res.end(JSON.stringify(payload));
      } catch {
        waiting = false;
        res.writeHead(503, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(
          JSON.stringify({
            error: 'Location region is temporarily unavailable',
          }),
        );
      }
    });
  }

  return {
    name: 'regional-brief-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

export { regionalBriefHasAnySource, regionalBriefProxy };
