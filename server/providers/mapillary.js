import { sameSiteGated } from './common/same-site.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';
import {
  fetchTile,
  mapillaryToken,
  parseTilePath,
  retryAfterWait,
  TileUpstreamError,
} from './mapillary/tiles.js';
import {
  fetchImages,
  normalizeImagesBbox,
  IMAGES_ROUTE_MAX_PER_MIN,
  ImagesRequestError,
  ImagesUpstreamError,
} from './mapillary/images.js';

/**
 * Tile requests per client IP per minute, cache hits included: over 60 new
 * 9-tile views a minute, more than a person flying the camera reaches.
 */
export const TILE_ROUTE_MAX_PER_MIN = 600;

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

/** GET /api/mapillary/status — whether a token is configured, never its value. */
function handleStatus(req, res) {
  if (req.method !== 'GET')
    return sendJson(res, 405, { error: 'Method not allowed' });
  sendJson(res, 200, { configured: Boolean(mapillaryToken()) });
}

/** GET /api/mapillary/tiles/coverage/{z}/{x}/{y} — trimmed protobuf tile. */
async function handleTile(req, res, allow) {
  if (req.method !== 'GET')
    return sendJson(res, 405, { error: 'Method not allowed' });
  if (!allow(clientKey(req))) {
    res.setHeader('Retry-After', '5');
    return sendJson(res, 429, {
      error: 'Too many tile requests',
      retryAfter: 5,
    });
  }
  const address = parseTilePath((req.url || '').split('?')[0]);
  if (!address)
    return sendJson(res, 400, {
      error: 'Tile path must be /coverage/{z}/{x}/{y} with z 11–14',
    });
  if (!mapillaryToken())
    return sendJson(res, 503, { error: 'no_key', keyRequired: true });
  // A client that leaves (a tile the camera moved past) cancels its fetch.
  const left = new AbortController();
  res.on?.('close', () => {
    if (!res.writableEnded) left.abort();
  });
  try {
    const { bytes, source } = await fetchTile(address, { signal: left.signal });
    res.statusCode = bytes.length ? 200 : 204;
    res.setHeader('Content-Type', 'application/x-protobuf');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('X-Gev-Cache', source);
    res.end(bytes.length ? bytes : undefined);
  } catch (error) {
    if (left.signal.aborted) return;
    const status = error instanceof TileUpstreamError ? error.status : 0;
    // A rejected token is a key problem the panel can name, not a fault.
    if (status === 401 || status === 403)
      return sendJson(res, 403, {
        error: 'Mapillary rejected the access token',
        keyRejected: true,
      });
    if (status === 429) {
      const retryAfter = retryAfterWait(error.retryAfter);
      res.setHeader('Retry-After', String(retryAfter));
      return sendJson(res, 429, {
        error: 'Mapillary is rate-limiting tile requests',
        retryAfter,
      });
    }
    // An upstream 400 must not read as a malformed request to this proxy.
    sendJson(res, 502, { error: error?.message || 'Tile fetch failed' });
  }
}

/**
 * GET /api/mapillary/images?bbox=west,south,east,north — image metadata in a
 * box at most 0.05° a side, cached 24 h: `{ images: [{ id, capturedAt, lat,
 * lon, compass, sequence, isPano, cameraType }], truncated }`. The world tape
 * reads it; the panel does not.
 */
async function handleImages(req, res, allow) {
  if (req.method !== 'GET')
    return sendJson(res, 405, { error: 'Method not allowed' });
  if (!allow(clientKey(req))) {
    res.setHeader('Retry-After', '5');
    return sendJson(res, 429, {
      error: 'Too many image requests',
      retryAfter: 5,
    });
  }
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname !== '/')
    return sendJson(res, 400, {
      error: 'Image search is /api/mapillary/images?bbox=west,south,east,north',
    });
  let bbox;
  try {
    bbox = normalizeImagesBbox(url.searchParams.get('bbox'));
  } catch (error) {
    return sendJson(res, error.status || 400, { error: error.message });
  }
  if (!mapillaryToken())
    return sendJson(res, 503, { error: 'no_key', keyRequired: true });
  const abandoned = new AbortController();
  req.on?.('aborted', () => abandoned.abort());
  res.on?.('close', () => abandoned.abort());
  try {
    const { body, source } = await fetchImages(bbox, {
      signal: abandoned.signal,
    });
    if (res.writableEnded) return;
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Gev-Cache', source);
    res.end(body);
  } catch (error) {
    if (res.writableEnded || abandoned.signal.aborted) return;
    if (error instanceof ImagesRequestError) {
      if (!error.retryAfterSec)
        return sendJson(res, error.status, { error: error.message });
      res.setHeader('Retry-After', String(error.retryAfterSec));
      return sendJson(res, error.status, {
        error: error.message,
        retryAfter: error.retryAfterSec,
      });
    }
    if (error instanceof ImagesUpstreamError) {
      if (error.keyRejected)
        return sendJson(res, 403, {
          error: 'Mapillary rejected the access token',
          keyRejected: true,
        });
      if (error.status === 429) {
        const retryAfter = error.retryAfterSec || 60;
        res.setHeader('Retry-After', String(retryAfter));
        return sendJson(res, 429, {
          error: 'Mapillary is rate-limiting image searches',
          retryAfter,
        });
      }
      // An upstream 400 must not read as a malformed request to this proxy.
      return sendJson(res, 502, { error: error.message });
    }
    sendJson(res, 502, { error: error?.message || 'Image search failed' });
  }
}

/**
 * Vite plugin: Mapillary coverage tiles and small-box image metadata searches
 * with the token added server-side, and a status route. All refuse
 * cross-site requests so another page cannot spend the token.
 */
export function mapillaryProxy() {
  const install = (middlewares) => {
    const allow = makeRateLimiter({
      windowMs: 60_000,
      max: TILE_ROUTE_MAX_PER_MIN,
      globalMax: TILE_ROUTE_MAX_PER_MIN * 4,
    });
    middlewares.use('/api/mapillary/status', sameSiteGated(handleStatus));
    middlewares.use(
      '/api/mapillary/tiles',
      sameSiteGated((req, res) => handleTile(req, res, allow)),
    );
    const allowImages = makeRateLimiter({
      windowMs: 60_000,
      max: IMAGES_ROUTE_MAX_PER_MIN,
      globalMax: IMAGES_ROUTE_MAX_PER_MIN * 4,
    });
    middlewares.use(
      '/api/mapillary/images',
      sameSiteGated((req, res) => handleImages(req, res, allowImages)),
    );
  };
  return {
    name: 'mapillary-proxy',
    configureServer: (server) => install(server.middlewares),
    configurePreviewServer: (server) => install(server.middlewares),
  };
}
