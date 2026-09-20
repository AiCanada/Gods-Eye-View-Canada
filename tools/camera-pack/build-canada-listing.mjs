// Build sources/cams-canada-listing.json from the Canadian webcam listing
// (canada_webcams.tsv: the 24-column Road511 layout, Canada only).
//
//   node tools/camera-pack/build-canada-listing.mjs --input <path>/canada_webcams.tsv [--offline]
//
// The listing is a raw download and is never committed. What this writes is the
// lowest-priority Canadian pack: merge-pack.mjs then drops every camera the
// pack already holds (same id, same address, or within 25 m of a camera from a
// province's own list), so only cameras not acquired yet are added.
//
// A row with no coordinates is placed by its address: the listing's location,
// street names or town are looked up with Photon (the geocoder
// build-transcanada-links.mjs uses), one request a second, and every answer is
// kept in sources/canada-listing-geocode.json so a rebuild asks nothing twice
// (--offline asks nothing at all). Such a camera is `coordConfidence:
// 'estimated'` with `placedBy: 'address'`, and its owner can drag it into place.
// A row with neither coordinates nor anything to look up is reported, never
// dropped onto a city centre it may be nowhere near.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dedupeRows, parseTsv } from './road511-tsv.mjs';
import {
  ID_PREFIX,
  PROVINCES,
  TOWN_REACH_KM,
  addressQueries,
  canonicalHref,
  distanceKm,
  dropCrossHostCopies,
  excludedReason,
  inCanada,
  provinceOf,
  rowMedia,
  rowPoint,
  rowToEntries,
  rowTown,
  spreadPoint,
} from './canada-listing-tsv.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCES = path.join(HERE, 'sources');
const src = (name) => path.join(SOURCES, name);
const OUT = src('cams-canada-listing.json');
const REPORT = src('cams-canada-listing.report.txt');
const GEOCODE_CACHE = src('canada-listing-geocode.json');
const PACK = path.resolve(HERE, '..', '..', 'config', 'cctv_sources.canada.json');

const args = process.argv.slice(2);
const inputAt = args.indexOf('--input');
const input = inputAt >= 0 ? args[inputAt + 1] : src('canada_webcams.tsv');
const offline = args.includes('--offline');
if (!input || !fs.existsSync(input)) {
  console.error(`Listing not found: ${input}\nUsage: node build-canada-listing.mjs --input <path>/canada_webcams.tsv [--offline]`);
  process.exit(1);
}

const GEOCODE_INTERVAL_MS = 1100;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const count = (map, key) => map.set(key, (map.get(key) || 0) + 1);
const table = (map) => [...map].sort((a, b) => b[1] - a[1]).map(([key, n]) => `  ${String(n).padStart(6)}  ${key}`).join('\n');

// ---- the listing -------------------------------------------------------------
const parsed = parseTsv(fs.readFileSync(input, 'utf8'));
const { rows, identical, conflicts, missingId } = dedupeRows(parsed.rows);
const excluded = new Map();
const kept = [];
for (const row of rows) {
  const why = excludedReason(row);
  if (why) count(excluded, why);
  else kept.push(row);
}

// ---- what the pack already has -------------------------------------------------
// By address only; merge-pack.mjs applies the position rule. A previous run's
// own entries are not "already acquired".
const norm = (href) => canonicalHref(href).toLowerCase();
const acquired = new Set();
if (fs.existsSync(PACK)) {
  for (const cam of JSON.parse(fs.readFileSync(PACK, 'utf8'))) {
    if (String(cam.id).startsWith(ID_PREFIX)) continue;
    for (const href of [cam.url, cam.pageUrl, cam.videoUrl]) if (href) acquired.add(norm(href));
  }
}
const hrefsOf = (media) => (media.kind === 'views' ? media.views.map((view) => view.href) : media.href ? [media.href] : []);

const noMedia = new Map();
const alreadyBySource = new Map();
const placed = [];
const unplaced = [];
const seenHrefs = new Set();
// Rows with their own point first: a view listed again without one (Vancouver
// lists each view of an intersection a second time) is then a known address.
for (const row of [...kept].sort((a, b) => Number(Boolean(rowPoint(b))) - Number(Boolean(rowPoint(a))))) {
  const media = rowMedia(row);
  if (media.kind === 'none') { count(noMedia, row.source || '(no source)'); continue; }
  const hrefs = hrefsOf(media).map(norm);
  if (hrefs.every((href) => acquired.has(href) || seenHrefs.has(href))) { count(alreadyBySource, row.source || '(no source)'); continue; }
  for (const href of hrefs) seenHrefs.add(href);
  const point = rowPoint(row);
  if (point && inCanada(point)) placed.push({ row, point });
  else unplaced.push(row);
}

// ---- placing by address ---------------------------------------------------------
const cache = fs.existsSync(GEOCODE_CACHE) ? JSON.parse(fs.readFileSync(GEOCODE_CACHE, 'utf8')) : {};
let asked = 0;
async function geocode(query, provinceName) {
  if (Object.hasOwn(cache, query)) return cache[query];
  if (offline) return null;
  if (asked) await sleep(GEOCODE_INTERVAL_MS);
  asked += 1;
  let answer = null;
  try {
    const response = await fetch(`https://photon.komoot.io/api/?limit=5&lang=en&q=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': 'GodsEyeView-camera-pack/1.0' },
      signal: AbortSignal.timeout(20000),
    });
    if (response.ok) {
      const features = (await response.json()).features || [];
      // A province or the country itself is not an address: a name the
      // geocoder cannot place answers with the province it was asked about.
      const canadian = features.filter(
        (feature) =>
          /^(?:CA|Canada)$/i.test(feature.properties?.countrycode || feature.properties?.country || '') &&
          !/^(?:state|country|region)$/i.test(feature.properties?.type || '') &&
          !/^(?:state|province|country)$/i.test(feature.properties?.osm_value || ''),
      );
      const feature = canadian.find((item) => item.properties?.state === provinceName) || canadian.find((item) => !item.properties?.state);
      if (feature) {
        const [lon, lat] = feature.geometry.coordinates;
        answer = { lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6, label: [feature.properties.name, feature.properties.city, feature.properties.state].filter(Boolean).join(', '), kind: feature.properties.osm_value || feature.properties.type || '' };
      }
    } else if (response.status === 429 || response.status >= 500) {
      // Not an answer: do not remember it, so the next run asks again.
      return null;
    }
  } catch {
    return null;
  }
  cache[query] = answer;
  if (asked % 25 === 0) fs.writeFileSync(GEOCODE_CACHE, JSON.stringify(cache, null, 1));
  return answer;
}

const noAddress = new Map();
const atTownCentre = new Map();
const notFound = [];
const byAddress = [];
const usedPoints = new Map();
let done = 0;
for (const row of unplaced) {
  done += 1;
  const provinceName = PROVINCES[provinceOf(row)].name;
  const queries = addressQueries(row);
  // Last resort: the centre of the town the row is known to be in. A row with
  // no address and no town either has nothing to be placed by.
  const town = rowTown(row);
  if (town) queries.push(`${town}, ${provinceName}, Canada`);
  if (!queries.length) { count(noAddress, row.source || '(no source)'); continue; }
  // A street name exists in many towns ("Victoria ..." answered from Victoria
  // for a Vancouver camera): an answer must lie within reach of the row's town.
  const townCentre = town ? await geocode(`${town}, ${provinceName}, Canada`, provinceName) : null;
  let hit = null;
  let address = '';
  for (const query of queries) {
    hit = await geocode(query, provinceName);
    if (hit && inCanada(hit) && (!townCentre || distanceKm(townCentre, hit) <= TOWN_REACH_KM)) { address = query; break; }
    hit = null;
  }
  if (!hit) { notFound.push(`${row.source} | ${row.camera_name} | tried: ${queries.join(' ; ')}`); continue; }
  const key = `${hit.lat},${hit.lon}`;
  const index = usedPoints.get(key) || 0;
  usedPoints.set(key, index + 1);
  const townCentreOnly = Boolean(town) && address === `${town}, ${provinceName}, Canada`;
  if (townCentreOnly) count(atTownCentre, `${town} (${row.source})`);
  byAddress.push({ row, point: spreadPoint(hit, index), address: townCentreOnly ? `${address} (town centre: the listing gives no address)` : address, label: hit.label });
  if (done % 50 === 0) process.stderr.write(`  placed by address: ${byAddress.length} (${done}/${unplaced.length} rows, ${asked} lookups)\n`);
}
fs.writeFileSync(GEOCODE_CACHE, JSON.stringify(cache, null, 1));

// ---- entries ---------------------------------------------------------------------
const entries = [];
for (const { row, point } of placed) entries.push(...rowToEntries(row, point));
for (const { row, point, address } of byAddress) entries.push(...rowToEntries(row, point, { placedBy: 'address', address }));
// A view the pack already holds is not written again beside its new siblings.
const notAcquired = entries.filter((entry) => !acquired.has(norm(entry.url || entry.videoUrl)));
// ...and a camera the listing reaches through two hosts is written once.
const { kept: fresh, dropped: crossHostCopies } = dropCrossHostCopies(notAcquired);
fs.writeFileSync(OUT, JSON.stringify(fresh, null, 2) + '\n');

const bySource = new Map();
const byProvince = new Map();
const byKind = new Map();
for (const entry of fresh) {
  count(bySource, entry.provider);
  count(byProvince, entry.cityId);
  count(byKind, entry.feedType === 'none' ? 'stream only (HLS)' : entry.placedBy === 'address' ? 'still, placed by address' : 'still, placed by the listing');
}
const report = [
  `Canadian webcam listing -> ${path.relative(HERE, OUT)}`,
  `input: ${path.basename(input)}  rows ${parsed.rows.length}  (identical copies ${identical}, conflicting ids ${conflicts.length}, no id ${missingId.length})`,
  '',
  `entries written: ${fresh.length}  (merge-pack.mjs still drops any within 25 m of a camera the pack already holds)`,
  table(byKind),
  '',
  `listed twice through two hosts (the operator's own host kept, a 511 re-listing dropped): ${crossHostCopies.length}`,
  table(crossHostCopies.reduce((map, entry) => map.set(entry.provider, (map.get(entry.provider) || 0) + 1), new Map())),
  '',
  'left out before placing:',
  table(excluded) || '  (none)',
  '',
  `already acquired (same address as a camera in the pack, or listed twice): ${[...alreadyBySource.values()].reduce((a, b) => a + b, 0)}`,
  table(alreadyBySource),
  '',
  `nothing to watch (a web page only, or a stream the server cannot carry): ${[...noMedia.values()].reduce((a, b) => a + b, 0)}`,
  table(noMedia),
  '',
  `placed by address: ${byAddress.length}   lookups made this run: ${asked}${offline ? ' (offline)' : ''}`,
  ...byAddress.map(({ row, address, label, point }) => `  ${row.camera_id}  ${row.camera_name}  <-  "${address}"  =>  ${label}  (${point.lat}, ${point.lon})`),
  '',
  `...of which at their town's centre, because the listing gives no address: ${[...atTownCentre.values()].reduce((a, b) => a + b, 0)}`,
  table(atTownCentre),
  '',
  `no coordinates and nothing to look up (a serial number only, and no town): ${[...noAddress.values()].reduce((a, b) => a + b, 0)}`,
  table(noAddress),
  '',
  `address not found: ${notFound.length}`,
  ...notFound.map((line) => `  ${line}`),
  '',
  'entries by source:',
  table(bySource),
  '',
  'entries by province:',
  table(byProvince),
  '',
].join('\n');
fs.writeFileSync(REPORT, report);
process.stderr.write(report.split('\n').filter((line) => !/^ {2}[A-Z]{2}-|<-/.test(line)).slice(0, 60).join('\n') + '\n');
