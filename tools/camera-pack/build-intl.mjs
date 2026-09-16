// Build the international camera pack from the public-webcam listing.
//
//   node tools/camera-pack/build-intl.mjs --input <international_webcams.tsv>
//        [--out config/cctv_sources.intl.json] [--report tools/camera-pack/cctv_sources.intl.report.txt]
//
// The TSV is a raw download and is never committed (put a copy in sources/,
// which ignores *.tsv, or pass its path). The build makes no network request:
// it reads the listing, keeps one camera per Windy webcam id, rejects missing
// coordinates, removes school cameras and YouTube/Vimeo embeds, keeps every
// other camera (offline ones included), and writes the compact pack plus a
// report of every decision. See intl-tsv.mjs.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { cameraIdOf } from './road511-tsv.mjs';
import { providerRecord } from './intl-providers.mjs';
import {
  ID_PREFIX,
  PACK_DEFAULTS,
  collapseWindyRows,
  dedupeRows,
  densestCircles,
  expandPack,
  fixCoordinates,
  formatPack,
  parseTsv,
  rowToEntries,
  schoolHit,
  schoolKeptFields,
} from './intl-tsv.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const AREA_CAP = 1000;
const AREA_RADIUS_KM = 50;

function arg(name) {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index === -1 ? '' : process.argv[index + 1] || '';
}

const input = path.resolve(arg('--input') || path.join(HERE, 'sources', 'international_webcams.tsv'));
const outPath = path.resolve(arg('--out') || path.join(ROOT, 'config', 'cctv_sources.intl.json'));
const reportPath = path.resolve(arg('--report') || path.join(HERE, 'cctv_sources.intl.report.txt'));
if (!fs.existsSync(input)) {
  console.error(`International listing not found: ${input}`);
  console.error('usage: node tools/camera-pack/build-intl.mjs --input <international_webcams.tsv>');
  process.exit(1);
}

const fmt = (n) => Number(n).toLocaleString('en-US');
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/');
const bump = (map, key, by = 1) => map.set(key, (map.get(key) || 0) + by);
const collator = new Intl.Collator('en', { numeric: true });

const { rows: parsedRows } = parseTsv(fs.readFileSync(input, 'utf8'));
const deduped = dedupeRows(parsedRows);
const windy = collapseWindyRows(deduped.rows);
const coords = fixCoordinates(windy.rows);

const cameras = [];
const seenIds = new Set();
const idCollisions = [];
const schoolRemoved = [];
const schoolKept = [];
const youtubeRemoved = [];
const sourceByKey = new Map();
let splitRows = 0;
let switchedOff = 0;
let noneNoLink = 0;
let noneStream = 0;
let lastUpdated = '';

for (const row of coords.rows) {
  if (row.last_updated && row.last_updated > lastUpdated) lastUpdated = row.last_updated;
  const hit = schoolHit(row);
  if (hit) {
    schoolRemoved.push({ row, hit });
    continue;
  }
  const keptFields = schoolKeptFields(row);
  if (keptFields.length) schoolKept.push({ row, field: keptFields[0] });
  if (/^(?:false|0|no)$/i.test(row.active || '')) switchedOff += 1;

  const entries = rowToEntries(row);
  if (!entries.length) {
    youtubeRemoved.push(row);
    continue;
  }
  if (entries.length > 1) splitRows += 1;
  for (const entry of entries) {
    if (seenIds.has(entry.id)) {
      idCollisions.push(entry.id);
      continue;
    }
    seenIds.add(entry.id);
    cameras.push(entry);
    if (!sourceByKey.has(entry.p)) sourceByKey.set(entry.p, row.source);
    if (entry.feedType !== 'none') continue;
    if (entry.videoUrl) noneStream += 1;
    else noneNoLink += 1;
  }
}

cameras.sort(
  (a, b) =>
    collator.compare(a.country || 'ZZ', b.country || 'ZZ') ||
    collator.compare(a.region || '', b.region || '') ||
    collator.compare(a.id, b.id),
);
const providerKeys = [...new Set(cameras.map((camera) => camera.p))].sort(collator.compare);
const providers = Object.fromEntries(
  providerKeys.map((key) => [key, providerRecord(key, sourceByKey.get(key) || '')]),
);

const text = formatPack({ providers, cameras, defaults: PACK_DEFAULTS });
fs.mkdirSync(path.dirname(outPath), { recursive: true });
const tmpPath = `${outPath}.${process.pid}.tmp`;
fs.writeFileSync(tmpPath, text);
fs.renameSync(tmpPath, outPath);

const expanded = expandPack(JSON.parse(fs.readFileSync(outPath, 'utf8')));
const broken = expanded.filter((camera) => !camera.provider || !camera.license || 'p' in camera);
if (expanded.length !== cameras.length || broken.length) {
  throw new Error(`pack round trip failed: ${expanded.length}/${cameras.length} cameras, ${broken.length} incomplete`);
}
const gzipBytes = zlib.gzipSync(text).length;

const images = cameras.filter((camera) => camera.feedType === 'image');
const none = cameras.filter((camera) => camera.feedType === 'none');
const withHeading = cameras.filter((camera) => camera.headingConfidence === 'estimated').length;
const countries = [...new Set(cameras.map((camera) => camera.country).filter(Boolean))].sort(collator.compare);
const unclassified = cameras.filter((camera) => !camera.country).length;

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
    out(
      cells
        .map((cell, col) => (aligns[col] === 'r' ? String(cell).padStart(widths[col]) : String(cell).padEnd(widths[col])))
        .join('  ')
        .trimEnd(),
    );
  }
};

out('International camera pack: build report');
out('=======================================');
out(`Input:   ${path.basename(input)}${lastUpdated ? ` (listing updated up to ${lastUpdated})` : ''}`);
out(`Output:  ${rel(outPath)} (${mb(Buffer.byteLength(text))}, ${mb(gzipBytes)} gzipped)`);
out('Built by tools/camera-pack/build-intl.mjs with no network requests.');
out('Offline cameras are kept. School cameras and YouTube/Vimeo embeds are removed.');
out('Windy lists many of the same webcams twice: one camera is kept per Windy webcam id.');
out(`The server loads at most ${fmt(AREA_CAP)} cameras, the nearest within ${AREA_RADIUS_KM} km of the selected place.`);

section('Headline');
table(
  [
    ['TSV rows', fmt(parsedRows.length), ''],
    ['  identical duplicate rows', fmt(deduped.identical), 'dropped'],
    ['  conflicting duplicate ids', fmt(deduped.conflicts.length), 'first row kept'],
    ['  rows with no camera id', fmt(deduped.missingId.length), 'dropped'],
    ['  Windy webcam-id copies', fmt(windy.collapsed.length), 'one kept per webcam id'],
    ['  coordinates rejected', fmt(coords.rejects.length), ''],
    ['  school cameras removed', fmt(schoolRemoved.length), ''],
    ['  YouTube/Vimeo embeds removed', fmt(youtubeRemoved.length), ''],
    ['  switched off in the listing', fmt(switchedOff), 'kept'],
    ['Cameras written', fmt(cameras.length), `${fmt(splitRows)} multi-view rows split into views`],
    ['  image (public still)', fmt(images.length), ''],
    ['  none (no still; stream kept, never served)', fmt(none.length), ''],
    ['    no still or stream', fmt(noneNoLink), ''],
    ['    stream only (HLS or video)', fmt(noneStream), 'videoUrl kept, never served'],
    ['  with an estimated heading', fmt(withHeading), ''],
    ['  countries', fmt(countries.length), unclassified ? `${fmt(unclassified)} unclassified (XX)` : ''],
    ['Providers', fmt(providerKeys.length), ''],
    ['Duplicate pack ids after view split', fmt(idCollisions.length), 'dropped'],
  ],
  ['l', 'r', 'l'],
);

section('Cameras per country');
const perCountry = new Map();
for (const camera of cameras) {
  const code = camera.country || 'XX';
  const entry = perCountry.get(code) || { total: 0, image: 0, none: 0, heading: 0 };
  entry.total += 1;
  entry[camera.feedType === 'image' ? 'image' : 'none'] += 1;
  if (camera.headingConfidence === 'estimated') entry.heading += 1;
  perCountry.set(code, entry);
}
table(
  [
    ['Country', 'Cameras', 'Image', 'None', 'Heading'],
    ...[...perCountry]
      .sort((a, b) => b[1].total - a[1].total || collator.compare(a[0], b[0]))
      .map(([code, s]) => [code, fmt(s.total), fmt(s.image), fmt(s.none), fmt(s.heading)]),
  ],
  ['l', 'r', 'r', 'r', 'r'],
);

section('Cameras per provider');
const perProvider = new Map();
for (const camera of cameras) {
  const entry = perProvider.get(camera.p) || { total: 0, image: 0, none: 0, countries: new Set() };
  entry.total += 1;
  entry[camera.feedType === 'image' ? 'image' : 'none'] += 1;
  if (camera.country) entry.countries.add(camera.country);
  perProvider.set(camera.p, entry);
}
table(
  [
    ['Key', 'Provider', 'Cameras', 'Image', 'None', 'Countries'],
    ...[...perProvider]
      .sort((a, b) => b[1].total - a[1].total || collator.compare(a[0], b[0]))
      .map(([key, s]) => [
        key,
        providers[key].provider,
        fmt(s.total),
        fmt(s.image),
        fmt(s.none),
        fmt(s.countries.size),
      ]),
  ],
  ['l', 'l', 'r', 'r', 'r', 'r'],
);

section(`Windy webcam ids collapsed (${windy.collapsed.length})`);
out('Windy, Windy-public-list, weather, ski and harbour lists often carry the same webcam');
out('under different camera ids and image addresses (preview vs full, with or without ?v=2).');
const windyBySource = new Map();
for (const item of windy.collapsed) bump(windyBySource, item.dropped.source);
table(
  [
    ['Dropped listing', 'Copies'],
    ...[...windyBySource]
      .sort((a, b) => b[1] - a[1] || collator.compare(a[0], b[0]))
      .map(([source, n]) => [source, fmt(n)]),
  ],
  ['l', 'r'],
);

section(`Coordinate rejects (${coords.rejects.length})`);
const rejectReasons = new Map();
for (const reject of coords.rejects) bump(rejectReasons, reject.reason.split(' ')[0] === 'no' ? 'no coordinates' : reject.reason);
table(
  [
    ['Reason', 'Rows'],
    ...[...rejectReasons]
      .sort((a, b) => b[1] - a[1] || collator.compare(a[0], b[0]))
      .map(([reason, n]) => [reason, fmt(n)]),
  ],
  ['l', 'r'],
);
for (const reject of coords.rejects.slice(0, 40)) {
  out(`${reject.id}  ${reject.country || 'XX'}  ${reject.lat},${reject.lon}  ${reject.reason}  "${reject.name}"`);
}
if (coords.rejects.length > 40) out(`... and ${fmt(coords.rejects.length - 40)} more`);

section(`Conflicting duplicate ids (${deduped.conflicts.length})`);
for (const conflict of deduped.conflicts.slice(0, 40)) {
  out(`${conflict.id}  kept "${conflict.kept.camera_name}", dropped "${conflict.dropped.camera_name}"`);
}
if (deduped.conflicts.length > 40) out(`... and ${fmt(deduped.conflicts.length - 40)} more`);

section(`School cameras removed (${schoolRemoved.length})`);
for (const { row, hit } of schoolRemoved) {
  out(`${ID_PREFIX}${cameraIdOf(row)}  ${row.state_id}  ${hit.field}: ${hit.text}`);
}

section(`School words kept as road names (${schoolKept.length})`);
for (const { row, field } of schoolKept) {
  out(`${ID_PREFIX}${cameraIdOf(row)}  ${row.state_id}  ${field}: ${row[field]}`);
}

section(`YouTube/Vimeo embeds removed (${youtubeRemoved.length})`);
for (const row of youtubeRemoved.slice(0, 40)) {
  out(`${ID_PREFIX}${cameraIdOf(row)}  ${row.state_id}  ${row.source}  ${row.primary_url || row.video_url}`);
}
if (youtubeRemoved.length > 40) out(`... and ${fmt(youtubeRemoved.length - 40)} more`);

section(`Densest ${AREA_RADIUS_KM} km circles (load cap ${fmt(AREA_CAP)} per selected area)`);
const circles = densestCircles(cameras, { radiusKm: AREA_RADIUS_KM, count: 15 });
table(
  [
    ['#', 'Cameras', 'Centre', 'Nearest camera', 'At the cap'],
    ...circles.map(({ point, count }, index) => [
      index + 1,
      fmt(count),
      `${point.lat.toFixed(3)},${point.lon.toFixed(3)}`,
      `${point.name} (${point.city}, ${point.country || 'XX'})`.slice(0, 70),
      count > AREA_CAP ? `loads ${fmt(AREA_CAP)}, ${fmt(count - AREA_CAP)} more nearby` : '',
    ]),
  ],
  ['r', 'r', 'l', 'l', 'l'],
);

section('Country codes (for CCTV_COUNTRIES)');
out(countries.join(', '));

fs.writeFileSync(reportPath, `${lines.join('\n')}\n`);

console.log(
  `wrote ${rel(outPath)}: ${fmt(cameras.length)} cameras (${fmt(images.length)} image, ${fmt(none.length)} none), ` +
    `${mb(Buffer.byteLength(text))} (${mb(gzipBytes)} gzipped)`,
);
console.log(
  `rows ${fmt(parsedRows.length)}, identical ${fmt(deduped.identical)}, conflicts ${fmt(deduped.conflicts.length)}, ` +
    `Windy collapsed ${fmt(windy.collapsed.length)}, coordinates rejected ${fmt(coords.rejects.length)}, ` +
    `school removed ${fmt(schoolRemoved.length)}, embeds removed ${fmt(youtubeRemoved.length)}`,
);
console.log(`report: ${rel(reportPath)}`);
