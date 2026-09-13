/** The Canadian pack (4,767 cameras) ships as the default catalogue, so a fresh
 * download shows every camera with no .env. CCTV_SOURCES_FILE overrides it. */
export const DEFAULT_CCTV_SOURCE_FILE = 'config/cctv_sources.canada.json';
/** Austin Open Data portal endpoint for traffic camera records. */
export const DEFAULT_AUSTIN_ROWS_URL =
  'https://data.austintexas.gov/api/views/b4k4-adkb/rows.json?accessType=DOWNLOAD';
/** Default cap on Austin cameras after distance-based prioritization. */
export const DEFAULT_AUSTIN_MAX_SOURCES = 250;
/** Hard ceiling on cameras served per country (CCTV_MAX_SOURCES); the health map is sized to it. */
export const CCTV_MAX_SOURCES_HARD_CAP = 5000;
/** Cameras served per country when CCTV_MAX_SOURCES is unset: already raised to
 * the ceiling, so the whole Canadian pack loads out of the box. The region cap
 * (below) is what limits a single province, territory or state. */
export const DEFAULT_CCTV_MAX_SOURCES = CCTV_MAX_SOURCES_HARD_CAP;
/** Hosts whose stills the viewer's browser loads itself when
 * CCTV_BROWSER_DIRECT_HOSTS is unset. Québec 511 refuses every server, so its
 * cameras need this to show a picture; set the variable empty to turn it off. */
export const DEFAULT_CCTV_BROWSER_DIRECT_HOSTS = 'quebec511.info';
/** Cameras served per region while the region cap is on: per Canadian province
 * or territory, per US state, and per country everywhere else (CCTV_REGION_CAP). */
export const DEFAULT_CCTV_REGION_CAP = 2500;
/** Countries whose cameras load when CCTV_COUNTRIES is unset. */
// Every country, so an install that sets nothing keeps the stock behaviour and
// the built-in Austin/Caltrans/TfL packs load exactly as before. Set
// CCTV_COUNTRIES in .env to narrow it (see .env.example).
export const DEFAULT_CCTV_COUNTRIES = '*';
/** Reference point for Austin camera prioritization (Congress & 6th). */
export const AUSTIN_DOWNTOWN = { lat: 30.2672, lon: -97.7431 };
/** Caltrans CCTV: one JSON feed per district, identical schema statewide. */
export const CALTRANS_CCTV_URL = (district) =>
  `https://cwwp2.dot.ca.gov/data/d${district}/cctv/cctvStatusD${String(district).padStart(2, '0')}.json`;
/** Districts fetched by default: SF Bay (4), LA (7), San Diego (11), Sacramento (3). */
export const DEFAULT_CALTRANS_DISTRICTS = '4,7,11,3';
export const DEFAULT_CALTRANS_MAX_SOURCES = 300;
/** Prioritization anchors: downtown cores of the four default metros. */
export const CALTRANS_ANCHORS = [
  { lat: 37.7793, lon: -122.4193 }, // San Francisco
  { lat: 34.0537, lon: -118.2428 }, // Los Angeles
  { lat: 32.7157, lon: -117.1611 }, // San Diego
  { lat: 38.5816, lon: -121.4944 }, // Sacramento
];
/** TfL JamCams: one keyless list endpoint; frames live on a public S3 bucket. */
export const TFL_JAMCAM_URL = 'https://api.tfl.gov.uk/Place/Type/JamCam';
export const TFL_IMAGE_ORIGIN =
  'https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/';
export const DEFAULT_TFL_MAX_SOURCES = 250;
export const LONDON_CENTER = { lat: 51.5074, lon: -0.1278 };
/** Camera CATALOGS change rarely; 15 min keeps multi-megabyte upstream list refetches (Austin rows.json + 4 Caltrans districts + TfL) infrequent. Frames are fetched per-request and are unaffected. */
export const CCTV_SOURCE_CACHE_MS = 15 * 60 * 1000;
/** Per-provider catalog-fetch timeout. Bounds the worst-case refresh so one
 * stalled upstream can't leave getCctvSources (and thus every CCTV route)
 * pending forever — a hung fetch aborts, the loader returns [], and
 * serve-stale/other packs take over. */
export const CCTV_SOURCE_FETCH_TIMEOUT_MS = 15 * 1000;
/** Individual CCTV image fetches must settle before the active 10-second
 * client refresh cadence. A bounded miss can fall through to Street View or
 * the synthetic frame instead of leaving the browser preview pending. */
export const CCTV_FRAME_FETCH_TIMEOUT_MS = 8 * 1000;

/** Maximum buffered snapshot size. */
export const CCTV_FRAME_MAX_BODY_BYTES = 16 * 1024 * 1024;

/** Deadline for upstream response headers; live bodies keep streaming afterward. */
export const CCTV_MEDIA_FETCH_TIMEOUT_MS = 15 * 1000;
/** Declared size ceiling for fixed media responses. */
export const CCTV_MEDIA_MAX_BODY_BYTES = 64 * 1024 * 1024;

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
