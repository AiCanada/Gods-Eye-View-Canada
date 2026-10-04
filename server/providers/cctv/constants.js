/** Camera packs read when CCTV_SOURCES_FILE is unset, in priority order: the
 * Canadian pack, the US pack, the international pack, then the inventory pack
 * (cameras from the operators' own lists that the others lack). The order decides
 * which entry stays when two packs list the same still (see catalog.js). A
 * listed file that does not exist yet is skipped quietly, so a fresh download
 * shows whatever packs it ships with. Add a pack by appending its path. */
export const CCTV_DEFAULT_PACK_FILES = Object.freeze([
  'config/cctv_sources.canada.json',
  'config/cctv_sources.us.json',
  'config/cctv_sources.intl.json',
  'config/cctv_sources.inventory.json',
]);
/** The same list as the comma string CCTV_SOURCES_FILE takes. */
export const DEFAULT_CCTV_SOURCE_FILES = CCTV_DEFAULT_PACK_FILES.join(',');
/** Query parameters that only defeat caches (Windy's `v=2`, `t=<epoch>`,
 * `rand=<n>`). Two still URLs that differ only by these, each empty or
 * numeric, are the same still. Every other parameter, and the fragment, keeps
 * two URLs apart: `?v=<video id>` and `#camera-2` name different cameras. */
export const CCTV_CACHE_BUSTER_PARAMS = Object.freeze([
  '_',
  'cache',
  'cachebust',
  'cachebuster',
  'cb',
  'dummy',
  'nocache',
  'r',
  'rand',
  'random',
  'rnd',
  't',
  'time',
  'timestamp',
  'ts',
  'v',
]);
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
 * CCTV_BROWSER_DIRECT_HOSTS is unset: none. A browser-loaded still carries no
 * CORS header: it shows in the panel and as a map thumbnail, but can never
 * become the 3D monitor plane. Québec 511 used to be listed here because it refuses Node's
 * fetch; the proxy now reaches it through node:https (see media.js), so its
 * cameras are proxied like every other. */
export const DEFAULT_CCTV_BROWSER_DIRECT_HOSTS = '';
/** Hosts whose cameras get ROAD-MATCHED map thumbnails when
 * CCTV_ROAD_MATCH_HOSTS is unset: the thumbnail stands on the road nearest the
 * camera (the widest road in its picture, along the bottom edge) and is drawn as
 * wide as that stretch of road. Québec 511's autoroute cameras are all road
 * cameras with a plain forward view, which is what the match assumes. `*` means
 * every camera; empty (the default) means none: thumbnails stay upright where
 * their picture opens, and the owner lines them up by hand instead (right-click
 * a thumbnail; saved in config/cctv_thumbnail_alignments.json). */
export const DEFAULT_CCTV_ROAD_MATCH_HOSTS = '';
/** Most cameras one /sources area may load: the nearest ones win. A hard
 * ceiling with no setting, query parameter or off switch. The catalogue itself
 * keeps every camera; only what one selected area loads is capped. */
export const CCTV_LOAD_CAP_HARD_LIMIT = 1000;
/** Radius of a selected area, and the largest a request may ask for. */
export const CCTV_AREA_RADIUS_KM = 50;
/** Smallest area radius a request may ask for. */
export const CCTV_AREA_MIN_RADIUS_KM = 0.5;
/** Cell size of the catalogue's spatial grid, in degrees. */
export const CCTV_AREA_GRID_DEG = 0.5;
/** Countries whose cameras load when CCTV_COUNTRIES is unset. */
// Every country, so an install that sets nothing keeps the stock behaviour.
// Set CCTV_COUNTRIES in .env to narrow it (see .env.example). The international
// pack's cameras carry their own ISO codes (FR, JP, TW, ...): a list such as
// "CA,US" leaves every one of them out, so name those countries too or use "*".
// A camera with no country (blank, or the listing's "XX") is always served.
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
/** Coverage boxes of the other live packs: each downloads only when a
 * selected area overlaps its box (see live-packs.js). */
/** Ontario, for Ontario 511. */
export const ONTARIO_BOX = {
  south: 41.6,
  north: 56.9,
  west: -95.2,
  east: -74.3,
};
/** Finland, for Fintraffic weathercams. */
export const FINLAND_BOX = { south: 59.5, north: 70.5, west: 19, east: 32 };
/** British Columbia (with its border crossings), for DriveBC. */
export const BRITISH_COLUMBIA_BOX = {
  south: 48,
  north: 60.5,
  west: -139.5,
  east: -114,
};
/** Texas, for TxDOT ITS. */
export const TEXAS_BOX = { south: 25.5, north: 36.7, west: -107, east: -93.4 };
/** Tallinn, for its intersection cameras. */
export const TALLINN_BOX = {
  south: 59.33,
  north: 59.53,
  west: 24.5,
  east: 25.0,
};
/** Estonia, for Transpordiamet (Tarktee) road cameras. */
export const ESTONIA_BOX = { south: 57.5, north: 59.8, west: 21.7, east: 28.3 };
/** Warendorf district (Germany), for its municipal webcam. */
export const WARENDORF_BOX = {
  south: 51.8,
  north: 52.1,
  west: 7.75,
  east: 8.3,
};
/** New South Wales (with the ACT and Lord Howe Island), for Live Traffic NSW. */
export const NSW_BOX = { south: -38, north: -28, west: 140.9, east: 159.2 };
/** Calgary, for Open Calgary traffic cameras. */
export const CALGARY_BOX = {
  south: 50.8,
  north: 51.25,
  west: -114.4,
  east: -113.8,
};
/** Delaware, for DelDOT. */
export const DELAWARE_BOX = {
  south: 38.4,
  north: 39.9,
  west: -75.8,
  east: -75.0,
};
/** A Road511 listing camera this close to an Austin open-data camera is the
 * same pole; the Austin one has a still, so the listing entry is hidden. */
export const CCTV_AUSTIN_DEDUPE_M = 30;
/** Caltrans CCTV: one JSON feed per district, identical schema statewide. */
/** TxDOT ITS: one keyless JSON catalog per district (25 districts statewide). */
export const TXDOT_ORIGIN = 'https://its.txdot.gov';
export const TXDOT_CCTV_STATUS_URL = (district) =>
  `${TXDOT_ORIGIN}/its/DistrictIts/GetCctvStatusListByDistrict?districtCode=${encodeURIComponent(district)}`;
/** Per-camera frame. Returns JSON `{snippet:<base64 jpeg>}`, not an image body;
 * media.js decodes it (fetchTxdotSnapshot) and only for this origin. */
export const TXDOT_CCTV_SNAPSHOT_URL = `${TXDOT_ORIGIN}/its/DistrictIts/GetCctvSnapshotByIcdId`;
/** Valid TxDOT district codes (the ITS map's own districtCodes list). */
export const TXDOT_DISTRICTS = new Set([
  'ABL',
  'AMA',
  'ATL',
  'AUS',
  'BMT',
  'BWD',
  'BRY',
  'CHS',
  'CRP',
  'DAL',
  'ELP',
  'FTW',
  'HOU',
  'LRD',
  'LBB',
  'LFK',
  'ODA',
  'PAR',
  'PHR',
  'SJT',
  'SAT',
  'TYL',
  'WAC',
  'WFS',
  'YKM',
]);
/** Districts fetched when CCTV_TXDOT_DISTRICTS is unset: Austin and San
 * Antonio. CCTV_TXDOT_DISTRICTS opens up the rest ("AUS,SAT,HOU,DAL,FTW" for
 * the five big metros, or any of the 25 codes); an empty value turns the pack
 * off. Each listed district returns every online camera (no cap). */
export const DEFAULT_TXDOT_DISTRICTS = 'AUS,SAT';
/** Ground-elevation priors in metres, by district. The TxDOT payload carries
 * no elevation, and on a keyless (no-tileset) stack the client's ground snap
 * never fires, so this prior is the only height a camera gets there. Texas
 * spans sea level (Houston) to ~1,140 m (El Paso). */
export const TXDOT_DISTRICT_ELEVATION_M = Object.freeze({
  ABL: 520,
  AMA: 1099,
  ATL: 105,
  AUS: 149,
  BMT: 5,
  BWD: 425,
  BRY: 111,
  CHS: 250,
  CRP: 7,
  DAL: 131,
  ELP: 1140,
  FTW: 199,
  HOU: 15,
  LRD: 132,
  LBB: 992,
  LFK: 91,
  ODA: 890,
  PAR: 185,
  PHR: 30,
  SJT: 585,
  SAT: 198,
  TYL: 165,
  WAC: 143,
  WFS: 289,
  YKM: 70,
});
export const TXDOT_DEFAULT_ELEVATION_M = 150;
export const CALTRANS_CCTV_URL = (district) =>
  `https://cwwp2.dot.ca.gov/data/d${district}/cctv/cctvStatusD${String(district).padStart(2, '0')}.json`;
/** TfL JamCams: one keyless list endpoint; frames live on a public S3 bucket. */
export const TFL_JAMCAM_URL = 'https://api.tfl.gov.uk/Place/Type/JamCam';
export const TFL_IMAGE_ORIGIN =
  'https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/';
/** Ontario 511: keyless CARS/511 camera catalog; frame URLs are still images. */
export const ONTARIO_511_CAMERAS_URL =
  'https://511on.ca/api/v2/get/cameras?format=json&lang=en';
export const ONTARIO_511_IMAGE_ORIGIN = 'https://511on.ca/map/Cctv/';
/** Fintraffic road weather cameras (Digitraffic): one keyless GeoJSON list
 * covering all of Finland. Each STATION carries N presets (fixed camera views)
 * that share the station position; one preset is one camera here. */
export const FINTRAFFIC_STATIONS_URL =
  'https://tie.digitraffic.fi/api/weathercam/v1/stations';
/** Frames: `<origin><presetId>.jpg`. Preset ids are synthesized into this
 * origin rather than read from the payload, so no upstream field can steer the
 * frame proxy off-host. */
export const FINTRAFFIC_IMAGE_ORIGIN = 'https://weathercam.digitraffic.fi/';
/** Digitraffic asks every client to identify itself on API calls. */
export const DIGITRAFFIC_USER = 'gods-eye-view';
/** Ground-elevation prior, in metres, for stations that report no altitude.
 * 228 of 809 stations carry a real metre value (median 94 m); the rest report
 * 0, which means "not reported" rather than sea level — Kouvola (~80 m of real
 * elevation) reports 0. The observed median stands in for those. */
export const FINTRAFFIC_GROUND_ELEVATION_M = 90;
/** DriveBC highway cameras (British Columbia): the keyless camera list served by
 * the DriveBC.ca site (github.com/bcgov/DriveBC.ca). The DataBC HighwayCams CSV
 * lists the same cameras but still carries retired images.drivebc.ca frame URLs,
 * so frames are built from the numeric camera id on the current image host. */
export const DRIVEBC_WEBCAMS_URL = 'https://www.drivebc.ca/api/webcams/';
export const DRIVEBC_IMAGE_URL = (id) =>
  `https://www.drivebc.ca/images/${id}.jpg`;
/** Tallinn intersection cameras: curated catalog + public stills on ristmikud.tallinn.ee. */
export const DEFAULT_TALLINN_SOURCE_FILE = 'config/cctv_sources.tallinn.json';
export const TALLINN_IMAGE_ORIGIN = 'https://ristmikud.tallinn.ee/';
/** Transpordiamet / Tarktee road-weather cameras: keyless DATEX2 feeds. */
export const TARKTEE_LOCATIONS_URL =
  'https://tarktee.transpordiamet.ee/api/v1/datex/roadCameraLocations';
export const TARKTEE_IMAGES_URL =
  'https://tarktee.transpordiamet.ee/api/v1/datex/roadCameraImages';
export const TARKTEE_IMAGE_ORIGIN = 'https://tarktee.transpordiamet.ee/images/';
/** Warendorf (Germany): the Marktplatz municipal webcam from a curated catalog file. */
export const DEFAULT_WARENDORF_SOURCE_FILE =
  'config/cctv_sources.warendorf.json';
export const WARENDORF_IMAGE_ORIGINS = Object.freeze([
  'http://webcam.warendorf.de/',
  'https://www.kreis-warendorf.de/',
]);
/** Live Traffic NSW (Transport for NSW): keyless public camera catalog. */
export const NSW_CAMERAS_URL =
  'https://data.livetraffic.com/cameras/traffic-cam.json';
export const NSW_IMAGE_ORIGIN = 'https://webcams.transport.nsw.gov.au/';
/**
 * The NSW webcam host answers non-browser clients with HTTP 200 and a short
 * HTML body instead of the frame (verified 2026-09-13), so the proxy
 * identifies as a browser for that one host. See media.js.
 */
export const NSW_IMAGE_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
/**
 * Longest NSW `view` sentence still usable as a label. NSW occasionally
 * repurposes `view` for a multi-paragraph works notice; real descriptions top
 * out around 120 characters.
 */
export const NSW_MAX_VIEW_LABEL = 140;
/** Open Calgary traffic cameras: one keyless Socrata endpoint for the whole
 * city; frames are stills on a City of Calgary host. */
export const DEFAULT_CALGARY_ROWS_URL =
  'https://data.calgary.ca/resource/k7p9-kppz.json?$limit=500';
/** The only origin Calgary camera frames may come from. The catalog publishes
 * most rows as `http://`; that host serves HTTPS and 301-redirects to it, so
 * URLs are upgraded and then pinned here before registration. */
export const CALGARY_IMAGE_ORIGIN = 'https://trafficcam.calgary.ca/';
/** Hard ceiling on the Calgary catalog body. The whole city is ~215 rows and
 * under 100 KB; this only exists so an upstream that streams an unbounded
 * body cannot be buffered without limit. */
export const CALGARY_MAX_CATALOG_BYTES = 4 * 1024 * 1024;

/** DelDOT CCTV: one keyless statewide JSON catalog; live video via RTMP-over-HTTP (rtmpt:80). */
export const DELDOT_CCTV_URL = 'https://tmc.deldot.gov/json/videocamera.json';
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
/** Silence a live body may carry before the relay gives up on it. Twice the
 * header deadline, because a camera that is merely slow between frames is far
 * more common than one that has died mid-stream, and a viewer would rather
 * wait than be dropped. */
export const CCTV_MEDIA_IDLE_TIMEOUT_MS = 30 * 1000;
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
export const CCTV_HOST_SPACING_MS = 150;
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
