/** Camera packs read when CCTV_SOURCES_FILE is unset (a comma list): the
 * Canadian pack and the US pack. A listed file that does not exist yet is
 * skipped quietly, so a fresh download shows whatever packs it ships with. */
export const DEFAULT_CCTV_SOURCE_FILES =
  'config/cctv_sources.canada.json,config/cctv_sources.us.json';
/** Envelope format written by the pack builders: shared defaults and provider
 * blocks, then one compact entry per camera. A plain array is still accepted. */
export const CCTV_PACK_FORMAT = 'gev-cctv-pack/1';
/** Pack files are stat-ed at most this often; the catalogue is rebuilt only
 * when a file's path, mtime or size (or the CCTV env) actually changes. */
export const CCTV_SOURCE_STAT_INTERVAL_MS = 10 * 1000;
/** Austin Open Data portal endpoint for traffic camera records. */
export const DEFAULT_AUSTIN_ROWS_URL =
  'https://data.austintexas.gov/api/views/b4k4-adkb/rows.json?accessType=DOWNLOAD';
/** Hosts whose stills the viewer's browser loads itself when
 * CCTV_BROWSER_DIRECT_HOSTS is unset. Québec 511 refuses every server, so its
 * cameras need this to show a picture; set the variable empty to turn it off. */
export const DEFAULT_CCTV_BROWSER_DIRECT_HOSTS = 'quebec511.info';
/** Most cameras one /sources area may load: the nearest ones win. A hard
 * ceiling with no setting, query parameter or off switch. The catalogue itself
 * keeps every camera; only what one selected area loads is capped. */
export const CCTV_LOAD_CAP_HARD_LIMIT = 2500;
/** Radius of a selected area, and the largest a request may ask for. */
export const CCTV_AREA_RADIUS_KM = 50;
/** Smallest area radius a request may ask for. */
export const CCTV_AREA_MIN_RADIUS_KM = 0.5;
/** Cell size of the catalogue's spatial grid, in degrees. */
export const CCTV_AREA_GRID_DEG = 0.5;
/** Countries whose cameras load when CCTV_COUNTRIES is unset. */
// Every country, so an install that sets nothing keeps the stock behaviour.
// Set CCTV_COUNTRIES in .env to narrow it (see .env.example).
export const DEFAULT_CCTV_COUNTRIES = '*';
/** Health entries kept (least recently updated evicted first). */
export const CCTV_HEALTH_MAX_ENTRIES = 5000;

/** Live packs download only when a /sources area overlaps their coverage, and
 * the downloaded list is kept in memory and on disk for a day. */
export const CCTV_LIVE_PACK_TTL_MS = 24 * 60 * 60 * 1000;
/** A live pack download that failed (or came back empty) is not retried for this long. */
export const CCTV_LIVE_PACK_RETRY_MS = 5 * 60 * 1000;
/** How long a /sources request waits for a live pack it just triggered before
 * answering with `area.pending` and letting the client ask again. */
export const CCTV_LIVE_PACK_WAIT_MS = 3 * 1000;
/** Austin open-data camera coverage (city and suburbs). */
export const AUSTIN_COVERAGE_BOX = {
  south: 29.9,
  north: 30.75,
  west: -98.15,
  east: -97.35,
};
/** California, for the Caltrans districts. */
export const CALIFORNIA_BOX = {
  south: 32.45,
  north: 42.05,
  west: -124.5,
  east: -114.1,
};
/** Greater London, for TfL JamCams. */
export const GREATER_LONDON_BOX = {
  south: 51.28,
  north: 51.7,
  west: -0.52,
  east: 0.34,
};
/** Plain sanity box for US coordinates (Alaska, Hawaii and territories included). */
export const US_COORDINATE_BOX = {
  south: 17.5,
  north: 71.5,
  west: -179.5,
  east: -64,
};
/** A Road511 listing camera this close to an Austin open-data camera is the
 * same pole; the Austin one has a still, so the listing entry is hidden. */
export const CCTV_AUSTIN_DEDUPE_M = 30;
/** Caltrans CCTV: one JSON feed per district, identical schema statewide. */
export const CALTRANS_CCTV_URL = (district) =>
  `https://cwwp2.dot.ca.gov/data/d${district}/cctv/cctvStatusD${String(district).padStart(2, '0')}.json`;
/** TfL JamCams: one keyless list endpoint; frames live on a public S3 bucket. */
export const TFL_JAMCAM_URL = 'https://api.tfl.gov.uk/Place/Type/JamCam';
export const TFL_IMAGE_ORIGIN =
  'https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/';
/** Per-provider catalog-fetch timeout. Bounds a live pack download so one
 * stalled upstream can't leave it pending forever — a hung fetch aborts, the
 * loader returns [], and the pack retries later. */
export const CCTV_SOURCE_FETCH_TIMEOUT_MS = 15 * 1000;
/** Individual CCTV image fetches must settle before the active 10-second
 * client refresh cadence. A bounded miss falls through to the synthetic frame
 * instead of leaving the browser preview pending. */
export const CCTV_FRAME_FETCH_TIMEOUT_MS = 8 * 1000;

/** Maximum buffered snapshot size. */
export const CCTV_FRAME_MAX_BODY_BYTES = 16 * 1024 * 1024;

/** Redirect hops a still on a host no catalogue vouches for (a Road511
 * lookup, a page's og:image) may take. Each hop is followed by hand and its
 * Location checked like the first URL; one more is a failed fetch. */
export const CCTV_FRAME_MAX_REDIRECTS = 2;

/** Deadline for upstream response headers; live bodies keep streaming afterward. */
export const CCTV_MEDIA_FETCH_TIMEOUT_MS = 15 * 1000;
/** Declared size ceiling for fixed media responses. */
export const CCTV_MEDIA_MAX_BODY_BYTES = 64 * 1024 * 1024;

/** A still fetched moments ago is served again instead of re-fetched, so a card
 * and the active plane asking for the same camera cost one upstream request. */
export const CCTV_FRAME_CACHE_TTL_MS = 8 * 1000;
/** Frame cache bounds. Sized past the plan's 64 entries so budgeted 511 stills
 * can be reused for their full card window without being evicted early. */
export const CCTV_FRAME_CACHE_MAX_ENTRIES = 256;
export const CCTV_FRAME_CACHE_MAX_BYTES = 24 * 1024 * 1024;
/** Per-host upstream gate: concurrent requests, spacing between starts, and
 * how many requests may wait (and for how long) before a throttled placeholder. */
export const CCTV_HOST_MAX_CONCURRENT = 2;
export const CCTV_HOST_SPACING_MS = 250;
export const CCTV_HOST_QUEUE_MAX = 32;
export const CCTV_HOST_QUEUE_WAIT_MS = 4 * 1000;
/** A 429 (or a 503 with Retry-After) blocks the host for Retry-After, kept
 * between one minute and ten minutes. */
export const CCTV_HOST_BLOCK_MIN_MS = 60 * 1000;
export const CCTV_HOST_BLOCK_MAX_MS = 10 * 60 * 1000;
/** Per-camera failure entries kept (least recently failed evicted first). */
export const CCTV_FRAME_FAILURES_MAX = 5000;

/** IBI 511 sites (stills under /map/Cctv/) allow 20 requests a minute and
 * 1,000 a day per host. The last few of each are held for the active camera. */
export const CCTV_IBI_PER_MINUTE = 20;
export const CCTV_IBI_PER_DAY = 1000;
export const CCTV_IBI_ACTIVE_RESERVE_PER_MINUTE = 5;
export const CCTV_IBI_ACTIVE_RESERVE_PER_DAY = 100;
/** A budgeted still is reused for a minute on the active camera and for fifteen
 * minutes on cards; the client refreshes at the same cadence. */
export const CCTV_IBI_ACTIVE_REFRESH_MS = 60 * 1000;
export const CCTV_IBI_CARD_REFRESH_MS = 15 * 60 * 1000;
/** Once the budget is spent, the last good still is served for up to an hour. */
export const CCTV_IBI_LAST_GOOD_MAX_MS = 60 * 60 * 1000;
/** Daily counters survive a restart here, under the cache directory. */
export const CCTV_HOST_BUDGET_FILE = 'cctv-host-budget.json';

/** Road511 lookups: one request per camera the user explicitly opens. */
export const ROAD511_API_BASE = 'https://api.road511.com/api/v1';
export const ROAD511_FETCH_TIMEOUT_MS = 8 * 1000;
/** At least a second between Road511 requests; a caller waits up to five
 * seconds for its turn before the lookup answers `busy`. */
export const ROAD511_SPACING_MS = 1000;
export const ROAD511_SPACING_WAIT_MS = 5 * 1000;
export const ROAD511_POSITIVE_TTL_MS = 24 * 60 * 60 * 1000;
export const ROAD511_NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000;
export const ROAD511_MAX_BODY_BYTES = 256 * 1024;
export const ROAD511_CACHE_FILE = 'road511-lookups.json';
export const ROAD511_CACHE_MAX_ENTRIES = 20000;
/** A 5xx or timeout backs one camera off: 30 s doubling, capped at ten minutes. */
export const ROAD511_BACKOFF_MIN_MS = 30 * 1000;
export const ROAD511_BACKOFF_MAX_MS = 10 * 60 * 1000;
/** A 429 pauses every lookup for Retry-After, kept between a minute and ten minutes. */
export const ROAD511_PAUSE_MIN_MS = 60 * 1000;
export const ROAD511_PAUSE_MAX_MS = 10 * 60 * 1000;

/** Frames advance on the order of minutes; re-reading the page more often than
 * this buys nothing and only adds load to the operator's site. A page that just
 * failed is not re-read within the same window either. */
export const FRAME_RESOLVE_CACHE_MS = 90 * 1000;
/** Longest a last-good URL is reused while the page stays unreachable. Past
 * this the frame is more likely frozen than live, and the synthetic card is
 * the honest picture. */
export const FRAME_RESOLVE_STALE_MAX_MS = 30 * 60 * 1000;
/** The page read is a serial stage ahead of the image fetch on the frame
 * route, so it gets a shorter budget than the image itself. */
export const FRAME_RESOLVE_TIMEOUT_MS = 4 * 1000;
/** Largest camera page read while looking for its advertised frame. */
export const FRAME_RESOLVE_MAX_PAGE_BYTES = 2 * 1024 * 1024;
