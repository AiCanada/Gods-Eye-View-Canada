import {
  DEFAULT_ALLOWED_HOSTS,
  originIs,
  resolvedAllowedHosts,
  servedRequestOrigin,
} from './common/allowed-hosts.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';
import { readRequestBodyCapped } from './common/request.js';
import { pruneAdsbLolPointCacheOutside } from './aircraft/opensky.js';
import { pruneMilitaryInstallationMemoryOutside } from './military-installations/cache.js';
import { pruneOverpassMemoryOutside } from './overpass/cache.js';
import { pruneWeatherEffectsCacheOutside } from './regional/weather-effects.js';
import { pruneRoadTileMemoryOutside } from './roads-tiles.js';
import { pruneTerrainMemoryOutside } from './terrain.js';
import { pruneTomTomMemoryOutside } from './traffic.js';

/** Area-keyed memory kept around the new place; anything farther is released. */
const LOCATION_SWITCH_RELEASE_RADIUS_KM = 300;

/** The body is two numbers, so anything past this is not a release request. */
const LOCATION_SWITCH_MAX_BODY_BYTES = 1024;

/**
 * Every in-memory, area-keyed server cache a location switch releases, by the
 * name it is reported under. Each prune deletes memory entries only: disk tiers
 * under .gev-cache are never touched. Worldwide data (the OpenSky snapshot,
 * AIS rows, FIRMS fires, satellites) is not area-keyed and is not listed.
 */
const LOCATION_SWITCH_RELEASES = Object.freeze({
  terrainHeights: pruneTerrainMemoryOutside,
  tomtomTiles: pruneTomTomMemoryOutside,
  roadTiles: pruneRoadTileMemoryOutside,
  overpass: pruneOverpassMemoryOutside,
  militaryInstallations: pruneMilitaryInstallationMemoryOutside,
  adsbLolPoints: pruneAdsbLolPointCacheOutside,
  weatherEffects: pruneWeatherEffectsCacheOutside,
});

/**
 * Hosts admitted when the server's own allowedHosts are not known, matching
 * build/vite.js. Without a list the guard fails closed rather than open. Vite
 * applies its own allowedHosts check only after plugin middleware, so a
 * DNS-rebinding page, whose Origin matches its own Host, would otherwise reach
 * this route; the Host rules are shared in common/allowed-hosts.js.
 */
const LOCATION_SWITCH_DEFAULT_ALLOWED_HOSTS = DEFAULT_ALLOWED_HOSTS;

/**
 * Admission for the release route. A switch is posted by the app's own page,
 * so the request must be a JSON POST to a Host this server serves, whose
 * Origin is exactly that Host, and whose Fetch Metadata, when the browser
 * sends it, says same-origin. Anything else is another site asking this server
 * to drop its caches.
 * @param {import('http').IncomingMessage} req
 * @param {{allowedHosts?: true | readonly string[]}} [options] The server's
 *   resolved allowedHosts; defaults to LOCATION_SWITCH_DEFAULT_ALLOWED_HOSTS.
 * @returns {{ok: true} | {ok: false, status: number, error: string}}
 */
function admitLocationSwitchRequest(
  req,
  { allowedHosts = LOCATION_SWITCH_DEFAULT_ALLOWED_HOSTS } = {},
) {
  const headers = req?.headers || {};
  if (req?.method !== 'POST')
    return { ok: false, status: 405, error: 'Method Not Allowed' };
  const refused = {
    ok: false,
    status: 403,
    error: 'Location switch release accepts only same-origin requests',
  };
  const served = servedRequestOrigin(req, allowedHosts);
  if (!served || !originIs(headers.origin, served.origin)) return refused;
  const site = headers['sec-fetch-site'];
  if (site !== undefined && String(site).toLowerCase() !== 'same-origin')
    return refused;
  if (
    !String(headers['content-type'] || '')
      .toLowerCase()
      .startsWith('application/json')
  ) {
    return {
      ok: false,
      status: 415,
      error: 'Content-Type must be application/json',
    };
  }
  return { ok: true };
}

/**
 * The release centre from a parsed body, or null unless both coordinates are
 * real numbers in range. Strings are refused rather than coerced.
 * @param {unknown} body
 * @returns {?{latitude: number, longitude: number}}
 */
function locationSwitchPoint(body) {
  const latitude = body?.latitude;
  const longitude = body?.longitude;
  if (typeof latitude !== 'number' || typeof longitude !== 'number')
    return null;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return { latitude, longitude };
}

/**
 * Run every release around a point. One failing prune reports 0 and does not
 * stop the others.
 * @param {{latitude: number, longitude: number}} point
 * @param {number} [radiusKm]
 * @param {Object<string, Function>} [releases]
 * @returns {Object<string, number>} Entries removed, by cache name.
 */
function releaseLocationSwitchMemory(
  point,
  radiusKm = LOCATION_SWITCH_RELEASE_RADIUS_KM,
  releases = LOCATION_SWITCH_RELEASES,
) {
  const released = {};
  for (const [name, prune] of Object.entries(releases)) {
    try {
      released[name] = prune(point, radiusKm);
    } catch (error) {
      released[name] = 0;
      console.warn(
        `[location-switch] ${name} release failed:`,
        error?.message || error,
      );
    }
  }
  return released;
}

/**
 * Vite plugin: POST /api/location-switch/release.
 *
 * The client posts `{ latitude, longitude }` after the user selects a place in
 * a different region. The server then drops in-memory cache entries whose area
 * lies more than LOCATION_SWITCH_RELEASE_RADIUS_KM from that point and answers
 * `{ released: { cacheName: count } }`. Memory only: disk caches stay, so a
 * return to the old place reads from disk rather than from upstream.
 *
 * @returns {import('vite').Plugin}
 */
function locationSwitchReleaseEndpoint() {
  const allow = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 120 });
  const respond = (res, status, payload, headers = {}) => {
    if (res.headersSent) return;
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(JSON.stringify(payload));
  };

  function install(middlewares, allowedHosts) {
    middlewares.use('/api/location-switch/release', async (req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://localhost');
        if (url.pathname !== '/')
          return respond(res, 404, { error: 'Unknown API route' });
        const admission = admitLocationSwitchRequest(req, { allowedHosts });
        if (!admission.ok) {
          return respond(
            res,
            admission.status,
            { error: admission.error },
            admission.status === 405 ? { Allow: 'POST' } : {},
          );
        }
        if (!allow(clientKey(req))) {
          return respond(
            res,
            429,
            { error: 'Rate limit exceeded' },
            { 'Retry-After': '10' },
          );
        }
        const declared = Number(req.headers?.['content-length']);
        if (
          Number.isFinite(declared) &&
          declared > LOCATION_SWITCH_MAX_BODY_BYTES
        )
          return respond(res, 413, { error: 'Request body too large' });
        let body;
        try {
          body = await readRequestBodyCapped(
            req,
            LOCATION_SWITCH_MAX_BODY_BYTES,
          );
        } catch (error) {
          if (error?.code === 'BODY_TOO_LARGE')
            return respond(res, 413, { error: 'Request body too large' });
          throw error;
        }
        let parsed;
        try {
          parsed = JSON.parse(body.toString('utf8'));
        } catch {
          return respond(res, 400, { error: 'A JSON body is required' });
        }
        const point = locationSwitchPoint(parsed);
        if (!point) {
          return respond(res, 400, {
            error: 'Valid latitude and longitude are required',
          });
        }
        respond(res, 200, { released: releaseLocationSwitchMemory(point) });
      } catch (error) {
        console.warn(
          '[location-switch] release request failed:',
          error?.code || error?.name || 'error',
        );
        respond(res, 500, { error: 'Location switch release failed' });
      }
    });
  }

  return {
    name: 'location-switch-release',
    configureServer(server) {
      install(
        server.middlewares,
        resolvedAllowedHosts(server.config, 'server'),
      );
    },
    configurePreviewServer(server) {
      install(
        server.middlewares,
        resolvedAllowedHosts(server.config, 'preview'),
      );
    },
  };
}

export {
  LOCATION_SWITCH_DEFAULT_ALLOWED_HOSTS,
  LOCATION_SWITCH_RELEASE_RADIUS_KM,
  admitLocationSwitchRequest,
  locationSwitchReleaseEndpoint,
  releaseLocationSwitchMemory,
};
