// Build the US camera pack from Road511's public-webcam listing.
//
//   node tools/camera-pack/build-road511-us.mjs --input <us_public_webcams.tsv>
//        [--out config/cctv_sources.us.json] [--report tools/camera-pack/cctv_sources.us.report.txt]
//
// The TSV is a raw download and is never committed (put a copy in sources/,
// which ignores *.tsv, or pass its path). The build makes no network request:
// it reads the listing, repairs or rejects bad coordinates, removes school
// cameras, keeps every other camera (offline ones included), and writes the
// compact pack plus a report of every decision. See road511-tsv.mjs.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  ROAD511_FEATURE_ID_PATTERN,
  road511FeatureId,
} from '../../server/providers/cctv/road511-lookup.js';
import {
  ID_PREFIX,
  PACK_DEFAULTS,
  VIEW_DIRECTIONS,
  cameraName,
  classifyLink,
  dedupeRows,
  densestCircles,
  expandPack,
  fixCoordinates,
  formatPack,
  parseTsv,
  rowLinks,
  rowProvider,
  rowToEntries,
  schoolHit,
} from './road511-tsv.mjs';
import { hasSchoolWord } from './school-cams.mjs';
import { providerRecord } from './us-providers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
/** The server's per-area load cap and radius, for the density section of the report. */
const AREA_CAP = 2500;
const AREA_RADIUS_KM = 50;

function arg(name) {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index === -1 ? '' : process.argv[index + 1] || '';
}

const input = path.resolve(arg('--input') || path.join(HERE, 'sources', 'us_public_webcams.tsv'));
const outPath = path.resolve(arg('--out') || path.join(ROOT, 'config', 'cctv_sources.us.json'));
const reportPath = path.resolve(arg('--report') || path.join(HERE, 'cctv_sources.us.report.txt'));
if (!fs.existsSync(input)) {
  console.error(`Road511 listing not found: ${input}`);
  console.error('usage: node tools/camera-pack/build-road511-us.mjs --input <us_public_webcams.tsv>');
  process.exit(1);
}

const fmt = (n) => Number(n).toLocaleString('en-US');
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/');
const bump = (map, key, by = 1) => map.set(key, (map.get(key) || 0) + by);
const collator = new Intl.Collator('en', { numeric: true });

// --- read, dedupe, repair ---------------------------------------------------
const { rows: parsedRows } = parseTsv(fs.readFileSync(input, 'utf8'));
const deduped = dedupeRows(parsedRows);
const coords = fixCoordinates(deduped.rows);

// --- rows -> cameras ----------------------------------------------------------
const cameras = [];
const seenIds = new Set();
const idCollisions = [];
const schoolRemoved = [];
const schoolKept = [];
const linkIssues = [];
const unmappedHosts = new Map();
const renamedByState = new Map();
let splitRows = 0;
let switchedOff = 0;
let lookupNoLink = 0;
let lookupStream = 0;
let lookupBadLink = 0;
let lastUpdated = '';

for (const row of coords.rows) {
  if (row.last_updated && row.last_updated > lastUpdated) lastUpdated = row.last_updated;
  const hit = schoolHit(row);
  if (hit) {
    schoolRemoved.push({ row, hit });
    continue;
  }
  const keptFields = ['camera_name', 'location', 'camera_details', 'road'].filter((field) => hasSchoolWord(row[field]));
  if (keptFields.length) schoolKept.push({ row, field: keptFields[0] });
  if (/^(?:false|0|no)$/i.test(row.active || '')) switchedOff += 1;

  const links = rowLinks(row);
  const provider = rowProvider(row, links);
  for (const host of provider.unmapped) {
    const entry = unmappedHosts.get(host) || { count: 0, fallback: 0, states: new Set() };
    entry.count += 1;
    if (provider.fallback) entry.fallback += 1;
    entry.states.add(row.state_id);
    unmappedHosts.set(host, entry);
  }
  for (const link of [links.primary, links.video, ...VIEW_DIRECTIONS.map((dir) => classifyLink(row[dir]))]) {
    if (link && ['page', 'private', 'invalid'].includes(link.kind)) linkIssues.push({ row, link });
  }
  if (cameraName(row) !== String(row.camera_name || '').replace(/\s+/g, ' ').trim()) bump(renamedByState, row.state_id);

  const entries = rowToEntries(row);
  if (entries.length > 1) splitRows += 1;
  for (const entry of entries) {
    if (seenIds.has(entry.id)) {
      idCollisions.push(entry.id);
      continue;
    }
    seenIds.add(entry.id);
    cameras.push(entry);
    if (entry.feedType !== 'none') continue;
    if (entry.videoUrl) lookupStream += 1;
    else if (links.primary || links.video) lookupBadLink += 1;
    else lookupNoLink += 1;
  }
}

cameras.sort((a, b) => collator.compare(a.region, b.region) || collator.compare(a.id, b.id));
const providerKeys = [...new Set(cameras.map((camera) => camera.p))].sort(collator.compare);
const providers = Object.fromEntries(providerKeys.map((key) => [key, providerRecord(key)]));

// --- write the pack atomically, then read it back the way the loader will ----
const text = formatPack({ providers, cameras, defaults: PACK_DEFAULTS });
fs.mkdirSync(path.dirname(outPath), { recursive: true });
const tmpPath = `${outPath}.${process.pid}.tmp`;
fs.writeFileSync(tmpPath, text);
fs.renameSync(tmpPath, outPath);

const expanded = expandPack(JSON.parse(fs.readFileSync(outPath, 'utf8')));
const broken = expanded.filter((camera) => camera.country !== 'US' || !camera.provider || !camera.license || 'p' in camera);
if (expanded.length !== cameras.length || broken.length) {
  throw new Error(`pack round trip failed: ${expanded.length}/${cameras.length} cameras, ${broken.length} incomplete`);
}
const gzipBytes = zlib.gzipSync(text).length;

// --- report --------------------------------------------------------------------
const images = cameras.filter((camera) => camera.feedType === 'image');
const lookups = cameras.filter((camera) => camera.feedType === 'none');
const withHeading = cameras.filter((camera) => camera.headingConfidence === 'estimated').length;
// Lookup ids are checked with the server's own rules, so the report cannot
// disagree with what POST /api/cctv/lookup/:id will actually send.
const refusedLookupIds = lookups.filter((camera) => !road511FeatureId(camera.id));
const suffixLookupIds = lookups.filter((camera) => {
  const feature = road511FeatureId(camera.id);
  return feature && feature !== camera.id.slice(ID_PREFIX.length);
});

const lines = [];
const out = (line = '') => lines.push(line);
const section = (title) => {
  out();
  out(title);
  out('-'.repeat(title.length));
};
const table = (rows, aligns) => {
  const widths = rows[0].map((_, col) => Math.max(...rows.map((cells) => String(cells[col]).length)));
  for (const cells of rows) {
    out(cells.map((cell, col) => (aligns[col] === 'r' ? String(cell).padStart(widths[col]) : String(cell).padEnd(widths[col]))).join('  ').trimEnd());
  }
};

out('Road511 US camera pack: build report');
out('====================================');
out(`Input:   ${path.basename(input)}${lastUpdated ? ` (listing updated up to ${lastUpdated})` : ''}`);
out(`Output:  ${rel(outPath)} (${mb(Buffer.byteLength(text))}, ${mb(gzipBytes)} gzipped)`);
out('Built by tools/camera-pack/build-road511-us.mjs with no network requests.');
out('Offline cameras are kept. School cameras are removed. The server loads at most');
out(`${fmt(AREA_CAP)} cameras, the nearest within ${AREA_RADIUS_KM} km of the selected place.`);

section('Headline');
table(
  [
    ['TSV rows', fmt(parsedRows.length), ''],
    ['  identical duplicate rows', fmt(deduped.identical), 'dropped'],
    ['  conflicting duplicate ids', fmt(deduped.conflicts.length), 'first row kept'],
    ['  rows with no camera id', fmt(deduped.missingId.length), 'dropped'],
    ['  coordinates fixed', fmt(coords.fixes.length), ''],
    ['  coordinates rejected', fmt(coords.rejects.length), ''],
    ['  school cameras removed', fmt(schoolRemoved.length), ''],
    ['  switched off in the listing', fmt(switchedOff), 'kept'],
    ['Cameras written', fmt(cameras.length), `${fmt(splitRows)} multi-view rows split into views`],
    ['  image (public still)', fmt(images.length), ''],
    ['  none (Road511 lookup on open)', fmt(lookups.length), ''],
    ['    no link at all', fmt(lookupNoLink), ''],
    ['    stream only (HLS or video)', fmt(lookupStream), 'videoUrl kept, never served'],
    ['    link is not a still', fmt(lookupBadLink), 'web page or private address'],
    ['  with an estimated heading', fmt(withHeading), ''],
    ['  names rebuilt from location/details/road', fmt([...renamedByState.values()].reduce((a, b) => a + b, 0)), ''],
    ['Providers', fmt(providerKeys.length), ''],
    ['Duplicate pack ids after view split', fmt(idCollisions.length), 'dropped'],
  ],
  ['l', 'r', 'l'],
);

section('Cameras per state');
const states = new Map();
for (const camera of cameras) {
  const entry = states.get(camera.region) || { total: 0, image: 0, none: 0, heading: 0 };
  entry.total += 1;
  entry[camera.feedType === 'image' ? 'image' : 'none'] += 1;
  if (camera.headingConfidence === 'estimated') entry.heading += 1;
  states.set(camera.region, entry);
}
table(
  [
    ['State', 'Cameras', 'Image', 'Lookup', 'Heading', 'Renamed'],
    ...[...states].sort((a, b) => b[1].total - a[1].total || collator.compare(a[0], b[0]))
      .map(([state, s]) => [state, fmt(s.total), fmt(s.image), fmt(s.none), fmt(s.heading), fmt(renamedByState.get(state) || 0)]),
  ],
  ['l', 'r', 'r', 'r', 'r', 'r'],
);

section('Cameras per provider');
const perProvider = new Map();
for (const camera of cameras) {
  const entry = perProvider.get(camera.p) || { total: 0, image: 0, none: 0, states: new Set() };
  entry.total += 1;
  entry[camera.feedType === 'image' ? 'image' : 'none'] += 1;
  entry.states.add(camera.region);
  perProvider.set(camera.p, entry);
}
table(
  [
    ['Key', 'Provider', 'Cameras', 'Image', 'Lookup', 'States'],
    ...[...perProvider].sort((a, b) => b[1].total - a[1].total || collator.compare(a[0], b[0]))
      .map(([key, s]) => [key, providers[key].provider, fmt(s.total), fmt(s.image), fmt(s.none), [...s.states].sort().join(',')]),
  ],
  ['l', 'l', 'r', 'r', 'r', 'l'],
);

section(`Coordinate fixes (${coords.fixes.length})`);
for (const fix of coords.fixes) {
  out(`${fix.id}  ${fix.state}  ${fix.from.lat},${fix.from.lon} -> ${fix.to.lat},${fix.to.lon}  ${fix.reason}`);
}

section(`Coordinate rejects (${coords.rejects.length})`);
for (const reject of coords.rejects) {
  out(`${reject.id}  ${reject.state}  ${reject.lat},${reject.lon}  ${reject.reason}  "${reject.name}"`);
}

section(`Conflicting duplicate ids (${deduped.conflicts.length})`);
for (const conflict of deduped.conflicts) out(`${conflict.id}  kept "${conflict.kept.camera_name}", dropped "${conflict.dropped.camera_name}"`);

section(`School cameras removed (${schoolRemoved.length})`);
for (const { row, hit } of schoolRemoved) out(`us511-${row.camera_id}  ${row.state_id}  ${hit.field}: ${hit.text}`);

section(`School words kept as road names (${schoolKept.length})`);
for (const { row, field } of schoolKept) out(`us511-${row.camera_id}  ${row.state_id}  ${field}: ${row[field]}`);

section(`Links that are not a still or a stream (${linkIssues.length})`);
for (const { row, link } of linkIssues) out(`us511-${row.camera_id}  ${row.state_id}  ${link.kind}: ${link.href}`);

section(`Hosts with no operator in us-providers.mjs (${unmappedHosts.size})`);
table(
  [
    ['Host', 'Links', 'State fallback used', 'States'],
    ...[...unmappedHosts].sort((a, b) => b[1].count - a[1].count || collator.compare(a[0], b[0]))
      .map(([host, s]) => [host, fmt(s.count), fmt(s.fallback), [...s.states].sort().join(',')]),
  ],
  ['l', 'r', 'r', 'l'],
);

section('IBI 511 still hosts (/map/Cctv/): server budget 20 requests/min and 1,000/day per host');
const ibiHosts = new Map();
for (const camera of images) {
  if (camera.url.includes('/map/Cctv/')) bump(ibiHosts, new URL(camera.url).hostname);
}
table(
  [['Host', 'Cameras'], ...[...ibiHosts].sort((a, b) => b[1] - a[1]).map(([host, n]) => [host, fmt(n)])],
  ['l', 'r'],
);

section(`Lookup cameras the Road511 lookup route refuses (${refusedLookupIds.length})`);
out('Checked with road511FeatureId from server/providers/cctv/road511-lookup.js, the function the lookup route uses,');
out(`and its feature id pattern ${ROAD511_FEATURE_ID_PATTERN}. Ids are written exactly as Road511 lists them.`);
if (refusedLookupIds.length) {
  const perState = new Map();
  for (const camera of refusedLookupIds) bump(perState, camera.region);
  out(`The server never looks these up, so they keep their placeholder. By state: ${[...perState].map(([state, n]) => `${state} ${fmt(n)}`).join(', ')}.`);
}
for (const camera of refusedLookupIds.slice(0, 20)) out(`  ${camera.id}`);
if (refusedLookupIds.length > 20) out(`... and ${fmt(refusedLookupIds.length - 20)} more`);
if (suffixLookupIds.length) {
  out(`Lookup ids that end like a view suffix (-N, -SE...) and lose it in the feature id: ${suffixLookupIds.length}`);
  for (const camera of suffixLookupIds.slice(0, 20)) out(`  ${camera.id}`);
}

section(`Densest ${AREA_RADIUS_KM} km circles (load cap ${fmt(AREA_CAP)} per selected area)`);
const circles = densestCircles(cameras, { radiusKm: AREA_RADIUS_KM, count: 15 });
table(
  [
    ['#', 'Cameras', 'Centre', 'Nearest camera', 'At the cap'],
    ...circles.map(({ point, count }, index) => [
      index + 1,
      fmt(count),
      `${point.lat.toFixed(3)},${point.lon.toFixed(3)}`,
      `${point.name} (${point.city}, ${point.region})`.slice(0, 70),
      count > AREA_CAP ? `loads ${fmt(AREA_CAP)}, ${fmt(count - AREA_CAP)} more nearby` : '',
    ]),
  ],
  ['r', 'r', 'l', 'l', 'l'],
);

fs.writeFileSync(reportPath, `${lines.join('\n')}\n`);

console.log(
  `wrote ${rel(outPath)}: ${fmt(cameras.length)} cameras (${fmt(images.length)} image, ${fmt(lookups.length)} lookup), ` +
    `${mb(Buffer.byteLength(text))} (${mb(gzipBytes)} gzipped)`,
);
console.log(
  `rows ${fmt(parsedRows.length)}, identical duplicates ${fmt(deduped.identical)}, conflicts ${fmt(deduped.conflicts.length)}, ` +
    `coordinates fixed ${fmt(coords.fixes.length)} / rejected ${fmt(coords.rejects.length)}, school removed ${fmt(schoolRemoved.length)}`,
);
console.log(`report: ${rel(reportPath)}`);
