// Merge every collected camera pack into one God's Eye View CCTV source file.
//
// The merge never thins: every accepted camera is written. The server caps each
// country (CCTV_MAX_SOURCES per country, hard ceiling 5000) by keeping the FIRST
// N entries, so the output is still ordered nearest-to-Saint-John first, pack
// by pack, and the merge warns when the catalogue would exceed that ceiling.
//
// Writes the capped catalogue the app reads straight into config/ (the single
// copy) and keeps the complete, uncapped merge beside this script as an
// archive the app never loads.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSchoolCamera } from './school-cams.mjs';

// Scraper outputs live beside this script, so the build works from any cwd.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = path.join(HERE, 'sources');
const CONFIG_DIR = path.resolve(HERE, '..', '..', 'config');
const sourcePath = (f) => path.join(SOURCE_DIR, f);

// Matches the server's per-country ceiling (CCTV_MAX_SOURCES clamps to 5000).
const CAP = Number(process.env.PACK_CAP || 5000);

// ISO country code per entry, so CCTV_COUNTRIES can switch whole countries on
// and off. Everything collected here is Canadian except the two
// Saint-Pierre-et-Miquelon streams, which are French territory and carry their
// own code so they are off unless asked for.
const countryFor = (cityId) => (String(cityId).toLowerCase() === 'pm' ? 'PM' : 'CA');
const SAINT_JOHN = { lat: 45.2733, lon: -66.0633 };

// Ordered by priority. Missing files are skipped, so this runs before every
// scraper has finished.
const PACKS = [
  'cams-saintjohn.json',
  'nbcams.json',
  'cams-windy.json',
  'cams-ns.json',
  'cams-pei.json',
  'cams-skaping.json',
  // Québec's official open dataset ranks above the directories that re-list
  // the same Québec 511 cameras, so its entries win the duplicate checks.
  'cams-quebec511.json',
  'cams-aggregators.json',
  // Every switched-on DriveBC camera, from DriveBC's own list; it ranks above
  // the directory that re-lists 150 of them, so those copies drop out.
  'cams-drivebc.json',
  // Every Alberta 511 camera view, from Alberta 511's own list; it ranks above
  // the directory that re-lists 121 of them, so those copies drop out.
  'cams-alberta511.json',
  'cams-transcanada.json',
  // Individual city, tourism and news webcams listed on the same
  // transcanadahighway.com page (build-transcanada-links.mjs).
  'cams-transcanada-links.json',
  'cams-on.json',
];

const haversineKm = (a, b) => {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

// The nbcams.ca directory re-serves the three City of Saint John cameras through
// its own cache. The first-party ipcamlive feed is kept instead, so these
// mirrors are dropped rather than shown twice a few metres apart.
const MIRRORED_FEEDS = [
  'cache3.nbcams.ca/camera/SaintJohnLoyalistPlaza',
  'cache3.nbcams.ca/camera/SaintJohnKingSquare',
  'cache3.nbcams.ca/camera/SaintJohnPartridgeIsland',
];

// Hosts confirmed unreachable at build time. Re-test before adding one; a host
// that times out once is usually rate-limiting, not dead. `stream.cheznoo.net`
// (Saint-Pierre-et-Miquelon) was listed here and then cleared on retest, so it
// stays in the pack under cityId "pm" — French territory reached from a
// Canadian directory, labelled honestly rather than filed under a province.
const DEAD_HOSTS = [];

// headingDeg is handled separately: an absent heading stays null so the app
// falls back to its own prior instead of pointing every unknown camera north.
const REQUIRED_NUM = ['lat', 'lon', 'pitchDeg', 'fovDeg', 'rangeM', 'mountHeightM', 'groundElevationM'];
/** Cross-pack duplicates: the same physical camera listed by two directories. */
const DUPLICATE_RADIUS_KM = 0.025;
// No 'hls': the app ships no HLS player, so a playlist in a plain <video>
// element renders a blank plane while reporting itself live. Bring the rows
// back when a decoder exists.
const FEED_TYPES = new Set(['image', 'mjpeg', 'mp4', 'webm']);
// Canada, generously bounded.
const BOUNDS = { latMin: 41.5, latMax: 83.5, lonMin: -141.5, lonMax: -52.0 };

const report = [];
const perPack = [];
const byId = new Map();
const byUrl = new Map();
/** Accepted entries from EARLIER packs, for the proximity dedupe. */
const placedEarlier = [];
let rejected = 0;
const rejectReasons = {};

const reject = (why) => {
  rejected += 1;
  rejectReasons[why] = (rejectReasons[why] || 0) + 1;
};

for (const file of PACKS) {
  if (!fs.existsSync(sourcePath(file))) {
    report.push(`${file.padEnd(26)} MISSING (skipped)`);
    continue;
  }
  let items;
  try {
    items = JSON.parse(fs.readFileSync(sourcePath(file), 'utf8'));
  } catch (err) {
    report.push(`${file.padEnd(26)} UNREADABLE: ${err.message}`);
    continue;
  }
  if (!Array.isArray(items)) {
    report.push(`${file.padEnd(26)} not a JSON array (skipped)`);
    continue;
  }

  // Within a pack, order by distance from Saint John so the nearest cameras
  // survive the cap.
  const ordered = items
    .filter((c) => c && Number.isFinite(Number(c.lat)) && Number.isFinite(Number(c.lon)))
    .sort((a, b) => haversineKm(SAINT_JOHN, a) - haversineKm(SAINT_JOHN, b));

  let kept = 0;
  const accepted = [];
  for (const cam of ordered) {
    if (!cam.id || !cam.name) { reject('missing id or name'); continue; }
    // School cameras are never stored, whichever pack they arrive in.
    if (isSchoolCamera(cam)) { reject('school camera'); continue; }

    // A resolver-backed camera carries no feed URL by design: the proxy reads
    // the current frame from the operator's page on each request. Validate the
    // page instead, and key deduplication off it.
    const resolverBacked = Boolean(cam.frameResolver && cam.pageUrl);
    const dedupeKey = resolverBacked ? cam.pageUrl : cam.url;

    if (resolverBacked) {
      if (!/^https?:\/\//i.test(cam.pageUrl)) { reject('bad resolver pageUrl'); continue; }
      if (cam.url) { reject('resolver-backed entry must not store a feed url'); continue; }
    } else if (typeof cam.url !== 'string' || !/^https?:\/\//i.test(cam.url)) {
      reject('bad url');
      continue;
    }
    let urlRejected = '';
    if (!resolverBacked) {
      if (/\.(html?|asp|php)(\?|$)/i.test(cam.url) && !/snapshot\.php|player\.php/i.test(cam.url)) {
        urlRejected = 'url points at an HTML page';
      } else if (MIRRORED_FEEDS.some((m) => cam.url.includes(m))) {
        urlRejected = 'mirror of a first-party feed';
      } else if (DEAD_HOSTS.some((h) => cam.url.includes(h))) {
        urlRejected = 'host unreachable at build time';
      } else if (/\/\d{4}\/\d{2}\/\d{2}\/.*\/\d{2}-\d{2}\.(jpg|jpeg|png)$/i.test(cam.url)) {
        // A feed URL with the capture date and minute baked into the path stops
        // advancing the moment it is stored: the camera would serve one frozen
        // frame while still presenting as live. Such a source belongs in the
        // catalogue as a resolver-backed entry, not as a stored URL.
        urlRejected = 'feed url embeds a capture timestamp and will rot';
      }
    }
    if (urlRejected) { reject(urlRejected); continue; }

    if (!FEED_TYPES.has(cam.feedType)) { reject(`unsupported feedType ${cam.feedType}`); continue; }

    const lat = Number(cam.lat);
    const lon = Number(cam.lon);
    if (lat < BOUNDS.latMin || lat > BOUNDS.latMax || lon < BOUNDS.lonMin || lon > BOUNDS.lonMax) {
      reject('coordinates outside Canada');
      continue;
    }
    if (byId.has(cam.id)) { reject('duplicate id'); continue; }
    if (byUrl.has(dedupeKey)) { reject('duplicate feed url'); continue; }
    // The same camera reached through two directories (nbcams.ca and a
    // provincial dump both list the NB 511 cameras) shows up twice a few
    // metres apart; the earlier, higher-priority pack wins.
    if (placedEarlier.some((other) => haversineKm(other, { lat, lon }) <= DUPLICATE_RADIUS_KM)) {
      reject('duplicate of a camera in a higher-priority pack');
      continue;
    }

    const entry = { ...cam, lat, lon, country: cam.country || countryFor(cam.cityId) };
    for (const key of REQUIRED_NUM) {
      const n = Number(entry[key]);
      entry[key] = Number.isFinite(n) ? n : 0;
    }
    // Keep the frustum pointing at the ground, never the sky.
    entry.pitchDeg = Math.min(0, Math.max(-45, entry.pitchDeg));
    entry.fovDeg = Math.min(120, Math.max(20, entry.fovDeg || 70));
    // Heading: a source with no bearing says so with null rather than a
    // fabricated 0. A source flagged unknown that nevertheless carries a
    // non-zero bearing (name-derived) is a real prior, so it is kept as an
    // estimate rather than thrown away with the unknowns.
    const rawHeading = Number(entry.headingDeg);
    const confidence = String(entry.headingConfidence || 'unknown').toLowerCase();
    if (!Number.isFinite(rawHeading) || (confidence === 'unknown' && rawHeading === 0)) {
      entry.headingDeg = null;
      entry.headingConfidence = 'unknown';
    } else {
      entry.headingDeg = ((rawHeading % 360) + 360) % 360;
      entry.headingConfidence = confidence === 'unknown' ? 'estimated' : confidence;
    }
    // A hand-curated heading is a curated pose for the CAL badge.
    if (entry.headingConfidence === 'curated' && !entry.poseSource) entry.poseSource = 'curated';

    byId.set(entry.id, entry);
    byUrl.set(dedupeKey, entry.id);
    accepted.push(entry);
    kept += 1;
  }
  perPack.push([file, accepted]);
  placedEarlier.push(...accepted);
  report.push(`${file.padEnd(26)} ${String(items.length).padStart(5)} read  ->${String(kept).padStart(5)} kept`);
}

// No thinning: every accepted camera is written, in pack priority order. When
// the catalogue outgrows the server's per-country ceiling the merge says so,
// and the server keeps the first CAP entries.
const all = [...byId.values()];
const total = all.length;
const merged = all;
if (total > CAP) {
  console.warn(`WARNING: ${total} cameras exceed the per-country ceiling of ${CAP}; the server will keep the first ${CAP}. Raise CCTV_MAX_SOURCES_HARD_CAP and PACK_CAP to serve them all.`);
}

// Write the catalogue the app reads into config/, plus the same complete merge
// beside this script as the archive copy.
fs.mkdirSync(CONFIG_DIR, { recursive: true });
fs.writeFileSync(path.join(CONFIG_DIR, 'cctv_sources.canada.json'), JSON.stringify(merged, null, 2) + '\n');
fs.writeFileSync(path.join(HERE, 'cctv_sources.canada.full.json'), JSON.stringify(all, null, 2) + '\n');

const near = merged.filter((c) => haversineKm(SAINT_JOHN, c) <= 50).length;
const byRegion = merged.reduce((acc, c) => {
  acc[c.cityId || '?'] = (acc[c.cityId || '?'] || 0) + 1;
  return acc;
}, {});

console.log(report.join('\n'));
console.log('');
console.log(`accepted ${total}, rejected ${rejected}`);
if (rejected) console.log('reject reasons:', JSON.stringify(rejectReasons));
console.log(`written ${merged.length} (no thinning; server ceiling ${CAP} per country)`);
console.log(`within 50 km of Saint John: ${near}`);
console.log('by region:', JSON.stringify(byRegion));
