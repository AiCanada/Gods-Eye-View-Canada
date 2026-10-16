import path from 'node:path';

/** Mapillary vector tile root; the path template is /{layer}/2/{z}/{x}/{y}. */
export const MAPILLARY_TILE_HOST = 'https://tiles.mapillary.com/maps/vtp';

/** Public tile layer names this proxy exposes, mapped to Mapillary's ids. */
export const TILE_LAYERS = Object.freeze({
  // Region-sized z6–10 tiles are refused; the app never asks for them. The
  // z14 `image` layer is ~98% of a tile and unused (positions come from the
  // graph API), so it is dropped in transit.
  coverage: Object.freeze({
    upstream: 'mly1_public',
    zoomRanges: Object.freeze([Object.freeze([0, 5]), Object.freeze([11, 14])]),
    dropLayers: Object.freeze(['image']),
  }),
});

/** Disk cache root, alongside the other providers' caches. */
export const MAPILLARY_CACHE_DIR = path.join(
  process.cwd(),
  '.gev-cache',
  'mapillary',
);
export const TILE_DISK_DIR = path.join(MAPILLARY_CACHE_DIR, 'tiles');

/**
 * Longer than the 15-minute upstream Cache-Control: tiles change only when new
 * imagery is processed, and a day avoids re-downloading a city per camera move.
 */
export const TILE_DISK_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * A tile write starts a background sweep at most this often: expired files go
 * first, then the oldest until the cache fits in TILE_DISK_MAX_BYTES.
 */
export const TILE_DISK_SWEEP_INTERVAL_MS = 15 * 60 * 1000;
export const TILE_DISK_MAX_BYTES = 1024 * 1024 * 1024;
/** Per-file cost on top of its size, so empty tiles still count. */
export const TILE_DISK_FILE_OVERHEAD_BYTES = 4096;

/** A z14 image tile over a dense city is ~11 MB; anything past this is wrong. */
export const TILE_MAX_BYTES = 48 * 1024 * 1024;

export const TILE_MEMORY_BUDGET_BYTES = 96 * 1024 * 1024;
/** Per-entry cost on top of its bytes, so empty tiles still count. */
export const TILE_MEMORY_ENTRY_OVERHEAD_BYTES = 1024;
export const TILE_FETCH_TIMEOUT_MS = 60_000;
/**
 * Upstream fetches at once; further misses queue. A view needs at most 25
 * tiles, and the cap stops a burst of misses opening thousands of requests.
 */
export const TILE_UPSTREAM_CONCURRENCY = 6;
/**
 * Tile requests per client IP per minute, cache hits included. 600 is 24 new
 * 25-tile views a minute, more than a person flying the camera reaches, but it
 * stops one page draining the shared token into a Mapillary rate limit.
 */
export const TILE_ROUTE_MAX_PER_MIN = 600;
/**
 * How long a 401/403 answers tile misses before asking Mapillary again. A
 * changed token is tried at once.
 */
export const TILE_KEY_REJECTED_HOLD_MS = 5 * 60 * 1000;
/** After a 429 without a usable Retry-After, hold tile misses this long. */
export const TILE_RATE_LIMIT_HOLD_MS = 60_000;
/** The longest Retry-After honoured, so a bad header cannot stall coverage. */
export const TILE_RATE_LIMIT_MAX_HOLD_MS = 10 * 60 * 1000;

/** Graph API root for image searches; the token rides in a header, never the URL. */
export const MAPILLARY_GRAPH_HOST = 'https://graph.mapillary.com';
/** Fields asked of an image search: no thumbnail links, which point off-host. */
export const IMAGES_FIELDS =
  'id,captured_at,compass_angle,computed_compass_angle,geometry,sequence,is_pano,camera_type';
/**
 * Mapillary answers bbox searches only under 0.01 square degrees; 0.05° a
 * side keeps a box at a quarter of that.
 */
export const IMAGES_MAX_SIDE_DEG = 0.05;
/** Images asked for per search: the API's own maximum (and default). */
export const IMAGES_LIMIT = 2000;
/** Searches are cached as long as coverage tiles. */
export const IMAGES_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Cached answers are kept as JSON text, charged by length. */
export const IMAGES_MEMORY_BUDGET_BYTES = 32 * 1024 * 1024;
/** Per-entry cost on top of its text, so empty answers still count. */
export const IMAGES_MEMORY_ENTRY_OVERHEAD_BYTES = 1024;
/** A full 2,000-image answer is ~600 KB; anything past this is wrong. */
export const IMAGES_MAX_BYTES = 4 * 1024 * 1024;
export const IMAGES_FETCH_TIMEOUT_MS = 30_000;
/** Upstream searches at once; up to IMAGES_QUEUE_MAX more wait their turn. */
export const IMAGES_UPSTREAM_CONCURRENCY = 4;
export const IMAGES_QUEUE_MAX = 32;
/**
 * Image searches per client IP per minute, cache hits included. A world tape
 * poll makes at most 256 (8 areas × 32), so it never trips this even all at
 * once; four clients at the cap stay near a tenth of Mapillary's 10,000
 * searches a minute per app.
 */
export const IMAGES_ROUTE_MAX_PER_MIN = 300;

/**
 * The client token lives in the browser by design; the server adds it to tile
 * URLs too, and to image searches as an `Authorization: OAuth` header.
 */
export function mapillaryToken() {
  return String(process.env.MAPILLARY_CLIENT_TOKEN || '').trim();
}
