// Build the inventory camera pack from the CCTV inventory CSV, and give the
// inventory's pictures to US and international pack cameras that have none.
//
//   node tools/camera-pack/build-inventory.mjs --input <cctv-inventory-YYYY-MM-DD.csv>
//        [--out config/cctv_sources.inventory.json]
//        [--report tools/camera-pack/cctv_sources.inventory.report.txt]
//        [--packs config] [--dry-run] [--dump <pack.json>] [--audit <pairs.jsonl>]
//
// --dry-run prints the report and writes nothing; --dump writes the pack it
// would build to another file; --audit writes every match it made, one JSON
// line each (the rule, both names, both addresses, the distance), for review.
//
// The CSV is a raw download and is never committed. The build makes no network
// request. A camera already in the Canadian, US or international pack is not
// written again; nothing is left out for standing near another camera (see
// inventory-csv.mjs for what counts as the same camera). A Road511 camera with
// no still that the inventory has a picture for gets that picture in its own
// pack file, keeping its id, name and place. Run it again after rebuilding
// the US or international pack.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { cctvRegionKey } from '../../server/providers/cctv/catalog.js';
import { canonicalCountryCode } from '../../server/providers/cctv/normalize.js';
import { densestCircles } from './road511-tsv.mjs';
import {
  ID_PREFIX,
  LISTING,
  LIVE_PACK_PROVIDERS,
  NAME_GUARD_KM,
  OPID_GUARD_KM,
  PACK_DEFAULTS,
  REQUIRED_COLUMNS,
  countryCode,
  distanceKm,
  expandPack,
  feedKeysOf,
  formatPack,
  lacksStill,
  nameKeysOf,
  namesAgree,
  noFeedReason,
  packOperatorIds,
  parseCsv,
  pointProblem,
  providerKey,
  regionCode,
  rowOperatorIds,
  rowToCameras,
  schoolCamera,
  trimmedNameKeys,
} from './inventory-csv.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

function arg(name) {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index === -1 ? '' : process.argv[index + 1] || '';
}

const inputArg = arg('--input');
const input = inputArg ? path.resolve(inputArg) : '';
const outPath = path.resolve(arg('--out') || path.join(ROOT, 'config', 'cctv_sources.inventory.json'));
const reportPath = path.resolve(arg('--report') || path.join(HERE, 'cctv_sources.inventory.report.txt'));
const packDir = path.resolve(arg('--packs') || path.join(ROOT, 'config'));
const dryRun = process.argv.includes('--dry-run');
const dumpPath = arg('--dump') ? path.resolve(arg('--dump')) : '';
const auditPath = arg('--audit') ? path.resolve(arg('--audit')) : '';
const audit = [];
if (!input || !fs.existsSync(input)) {
  console.error(`CCTV inventory not found: ${input || '(no --input)'}`);
  console.error('usage: node tools/camera-pack/build-inventory.mjs --input <cctv-inventory-YYYY-MM-DD.csv>');
  process.exit(1);
}

const fmt = (n) => Number(n).toLocaleString('en-US');
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/');
const bump = (map, key, by = 1) => map.set(key, (map.get(key) || 0) + by);
const collator = new Intl.Collator('en', { numeric: true });
const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------
// The packs that already hold cameras, highest priority first.

const PACKS = [
  { name: 'canada', file: path.join(packDir, 'cctv_sources.canada.json'), editable: false },
  { name: 'us', file: path.join(packDir, 'cctv_sources.us.json'), editable: true },
  { name: 'intl', file: path.join(packDir, 'cctv_sources.intl.json'), editable: true },
];
for (const pack of PACKS) {
  pack.raw = fs.existsSync(pack.file) ? JSON.parse(fs.readFileSync(pack.file, 'utf8')) : [];
  const rawCameras = Array.isArray(pack.raw) ? pack.raw : pack.raw.cameras || [];
  pack.entries = expandPack(pack.raw).map((entry, index) => ({ ...entry, pack: pack.name, raw: rawCameras[index] }));
}

const feedIndex = new Map(); // key -> entry
const keyIndex = new Map(); // key -> entries
// Which sources each held camera has answered for: one source's two views
// never both match one camera, but two sources listing it both do.
const claimed = new Map(); // entry -> Set(provider key)
const claimedBy = (entry, source) => claimed.get(entry)?.has(source) ?? false;
const claim = (entry, source) => {
  if (!claimed.has(entry)) claimed.set(entry, new Set());
  claimed.get(entry).add(source);
};
const regionOf = (entry) => cctvRegionKey(entry) || canonicalCountryCode(entry.country) || '';

function indexEntry(entry, region) {
  for (const key of feedKeysOf(entry)) if (!feedIndex.has(key)) feedIndex.set(key, entry);
  const keys = [...packOperatorIds(entry), ...nameKeysOf(entry, region)];
  if (entry.pack !== 'inventory' && lacksStill(entry)) keys.push(...trimmedNameKeys(entry, region));
  for (const key of keys) {
    if (!keyIndex.has(key)) keyIndex.set(key, []);
    keyIndex.get(key).push(entry);
  }
}
for (const pack of PACKS) for (const entry of pack.entries) indexEntry(entry, regionOf(entry));

// A US or Canadian row whose province is blank or not a state ("Los Angeles"
// is an airport camera's time zone) takes the state of the nearest held
// camera in its country. It only labels the camera; nothing is left out by it.
const STATE_REACH_KM = 100;
const stateGrid = new Map();
const cellOf = (lat, lon) => `${Math.floor(lat * 2)}|${Math.floor(lon * 2)}`;
for (const pack of PACKS) {
  for (const entry of pack.entries) {
    const key = regionOf(entry);
    if (!/^(?:US|CA)-[A-Z]{2}$/.test(key) || !Number.isFinite(entry.lat) || !Number.isFinite(entry.lon)) continue;
    const cell = cellOf(entry.lat, entry.lon);
    if (!stateGrid.has(cell)) stateGrid.set(cell, []);
    stateGrid.get(cell).push({ lat: entry.lat, lon: entry.lon, country: key.slice(0, 2), state: key.slice(3) });
  }
}
function nearestState(country, lat, lon) {
  let best = '';
  let bestKm = STATE_REACH_KM;
  const [ci, cj] = cellOf(lat, lon).split('|').map(Number);
  for (let di = -1; di <= 1; di++) {
    for (let dj = -1; dj <= 1; dj++) {
      for (const held of stateGrid.get(`${ci + di}|${cj + dj}`) || []) {
        if (held.country !== country) continue;
        const km = distanceKm({ lat, lon }, held);
        if (km < bestKm) {
          bestKm = km;
          best = held.state;
        }
      }
    }
  }
  return best;
}
let statesInferred = 0;

const genericPackName = (name) => /^camera\s+\S+$/i.test(clean(name));
const distinctiveId = (id) => /[a-z]/i.test(id) && /\d/.test(id) && id.length >= 6;

/** The entry this camera already is, and the rule that says so; null if it is new. */
function findHeld(entry, row, country, region, regionKey, singleView) {
  for (const key of feedKeysOf(entry)) {
    const held = feedIndex.get(key);
    if (held) return { held, rule: 'same address' };
  }
  const near = (held, km) => distanceKm(entry, held) <= km;
  // A code or an operator number names one camera, so any number of copies may
  // match it; a name can be shared by a site's views, so each of a source's
  // views takes a different camera of that name.
  const take = (key, accept, shared = false) =>
    (keyIndex.get(key) || []).find((held) => (shared || !claimedBy(held, entry.p)) && accept(held));
  if (singleView) {
    for (const key of rowOperatorIds(row, country, region)) {
      const sourceId = clean(row.sourceId);
      const held = take(key, (h) => near(h, OPID_GUARD_KM) && (namesAgree(entry.name, h.name) || genericPackName(h.name) || distinctiveId(sourceId)), true);
      if (held) return { held, rule: 'same operator camera number' };
    }
  }
  const keys = nameKeysOf(entry, regionKey);
  for (const key of keys.filter((k) => k.startsWith('code:'))) {
    const held = take(key, (h) => near(h, OPID_GUARD_KM), true);
    if (held) return { held, rule: 'same operator code' };
  }
  for (const key of keys.filter((k) => k.startsWith('name:'))) {
    const held = take(key, (h) => near(h, NAME_GUARD_KM));
    if (held) return { held, rule: 'same name' };
  }
  for (const key of keys.filter((k) => k.startsWith('base:'))) {
    const held = take(key, (h) => near(h, NAME_GUARD_KM));
    if (held) return { held, rule: 'same name on the same site' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The inventory.

const { header, rows, badRows } = parseCsv(fs.readFileSync(input, 'utf8'));
// A site's views, across every row that lists it: an operator number names
// the site, so it identifies a camera only when the site has one view.
const siteKey = (row) => `${providerKey(clean(row.provider))}|${clean(row.sourceId).toLowerCase()}`;
const viewsPerSite = new Map();
const rowCameras = rows.map((row) => {
  const result = rowToCameras(row);
  bump(viewsPerSite, siteKey(row), result.cameras.length);
  return result;
});
const missing = REQUIRED_COLUMNS.filter((column) => !header.includes(column));
if (missing.length) {
  console.error(`The inventory lacks column(s): ${missing.join(', ')}`);
  process.exit(1);
}

const excluded = new Map(); // reason -> Map(provider -> count)
const exclude = (reason, provider, by = 1) => {
  if (!excluded.has(reason)) excluded.set(reason, new Map());
  bump(excluded.get(reason), provider, by);
};
const duplicates = new Map(); // rule -> Map(where -> count)
const duplicate = (rule, where) => {
  if (!duplicates.has(rule)) duplicates.set(rule, new Map());
  bump(duplicates.get(rule), where);
};
const upgrades = new Map(); // pack entry -> inventory camera
const added = [];
const providers = new Map();
const usedIds = new Set();
let views = 0;

function uniqueId(base) {
  let id = base;
  for (let n = 2; usedIds.has(id); n++) id = `${base}-x${n}`;
  usedIds.add(id);
  return id;
}
const slugId = (text) => clean(text).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');

// Every camera view the inventory lists that could be stored.
const candidates = [];
for (const [rowIndex, row] of rows.entries()) {
  const provider = clean(row.provider) || 'Unknown';
  const country = countryCode(row.country);
  if (!country) {
    exclude(`country not recognised ("${clean(row.country)}")`, provider);
    continue;
  }
  const key = providerKey(provider);
  if (LIVE_PACK_PROVIDERS.has(key)) {
    exclude('served by the Austin open-data live pack', provider);
    continue;
  }
  const lat = Number(row.lat);
  const lon = Number(row.lon);
  const problem = String(row.lat ?? '').trim() === '' || String(row.lon ?? '').trim() === '' ? 'no coordinates' : pointProblem(country, lat, lon);
  if (problem) {
    exclude(problem, provider);
    continue;
  }
  const { cameras, kinds } = rowCameras[rowIndex];
  if (!cameras.length) {
    exclude(noFeedReason(kinds), provider);
    continue;
  }
  let region = regionCode(country, row.province);
  if (!region && (country === 'US' || country === 'CA')) {
    region = nearestState(country, lat, lon);
    if (region) statesInferred += 1;
  }
  const regionKey = country === 'US' || country === 'CA' ? (region ? `${country}-${region}` : country) : country;
  const town = clean(row.region);
  const city = town && town.toLowerCase() !== clean(row.province).toLowerCase() ? town : clean(row.province) || town || country;
  const baseId = `${ID_PREFIX}${key}-${slugId(row.sourceId) || 'cam'}`;
  const singleView = viewsPerSite.get(siteKey(row)) === 1;
  for (const camera of cameras) {
    views += 1;
    const { viewIndex, viewCount, name, ...feed } = camera;
    const entry = {
      id: `${baseId}${viewCount > 1 ? `-${viewIndex + 1}` : ''}`,
      name,
      city,
      ...(region ? { region } : {}),
      country,
      lat: Math.round(lat * 1e6) / 1e6,
      lon: Math.round(lon * 1e6) / 1e6,
      p: key,
      ...feed,
    };
    if (schoolCamera(row, entry)) {
      exclude('school, university, college or library camera', provider);
      continue;
    }
    candidates.push({ entry, row, provider, country, region, regionKey, singleView });
  }
}

// Copies of one camera: views that share a still or stream address, in any
// row of any source, are one camera however each copy is named.
const parent = candidates.map((_, i) => i);
const rootOf = (i) => {
  while (parent[i] !== i) {
    parent[i] = parent[parent[i]];
    i = parent[i];
  }
  return i;
};
const addressOwner = new Map();
candidates.forEach((candidate, i) => {
  for (const key of feedKeysOf(candidate.entry)) {
    if (!addressOwner.has(key)) {
      addressOwner.set(key, i);
      continue;
    }
    const a = rootOf(i);
    const b = rootOf(addressOwner.get(key));
    if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
  }
});
const groups = new Map();
candidates.forEach((candidate, i) => {
  const root = rootOf(i);
  if (!groups.has(root)) groups.set(root, []);
  groups.get(root).push(candidate);
});

// Each camera once: already held, or new.
const order = ['id', 'name', 'city', 'region', 'country', 'lat', 'lon', 'p', 'feedType', 'url', 'videoUrl', 'headingDeg', 'headingConfidence'];

/** Count a group of copies as the camera `held` already is. */
function heldAs(members, matched, held, rule) {
  const where = held.pack === 'inventory' ? 'inventory (listed twice)' : `${held.pack} pack`;
  if (auditPath) {
    const pick = ({ id, name, url, videoUrl, lat, lon, pack }) => ({ id, name, url, videoUrl, lat, lon, pack });
    audit.push(JSON.stringify({ rule, km: Math.round(distanceKm(matched.entry, held) * 1000) / 1000, inventory: pick(matched.entry), held: pick(held) }));
  }
  for (const member of members) {
    claim(held, member.entry.p);
    for (const alias of feedKeysOf(member.entry)) if (!feedIndex.has(alias)) feedIndex.set(alias, held);
    duplicate(member === matched ? rule : 'same address', where);
  }
  const still = members.find((member) => member.entry.url);
  const stream = members.find((member) => member.entry.videoUrl);
  const pack = PACKS.find((p) => p.name === held.pack);
  if (pack?.editable && lacksStill(held) && !upgrades.has(held) && (still || (stream && !held.videoUrl)))
    upgrades.set(held, { url: still?.entry.url || '', videoUrl: still?.entry.videoUrl || stream?.entry.videoUrl || '' });
}

// First every camera whose address a pack already holds, across the whole
// inventory, so a source's other views are never taken for a camera that
// source lists under its own address.
const open = [];
for (const members of groups.values()) {
  let hit = null;
  for (const member of members) {
    const key = feedKeysOf(member.entry).find((k) => feedIndex.has(k));
    if (key) {
      hit = { member, held: feedIndex.get(key) };
      break;
    }
  }
  if (hit) heldAs(members, hit.member, hit.held, 'same address');
  else open.push(members);
}

// Then the rest: held by operator number, code or name, or new.
for (const members of open) {
  let found = null;
  let matched = null;
  for (const member of members) {
    found = findHeld(member.entry, member.row, member.country, member.region, member.regionKey, member.singleView);
    if (found) {
      matched = member;
      break;
    }
  }
  if (found) {
    heldAs(members, matched, found.held, found.rule);
    continue;
  }
  // New: one camera, from the copy with a still, with a stream from any copy.
  const still = members.find((member) => member.entry.url);
  const stream = members.find((member) => member.entry.videoUrl);
  const lead = still || members[0];
  const entry = { ...lead.entry, id: uniqueId(lead.entry.id) };
  if (!entry.videoUrl && stream) entry.videoUrl = stream.entry.videoUrl;
  for (const member of members) if (member !== lead) duplicate('same address', 'inventory (listed twice)');
  const compact = Object.fromEntries(order.filter((field) => entry[field] !== undefined).map((field) => [field, entry[field]]));
  added.push(compact);
  if (!providers.has(entry.p)) providers.set(entry.p, { provider: lead.provider, license: `${lead.provider} public camera (listing: ${LISTING})` });
  const stored = { ...compact, pack: 'inventory' };
  indexEntry(stored, lead.regionKey);
  for (const member of members) {
    // The source's other views are other cameras, never this one.
    claim(stored, member.entry.p);
    for (const alias of feedKeysOf(member.entry)) if (!feedIndex.has(alias)) feedIndex.set(alias, stored);
  }
}

// ---------------------------------------------------------------------------
// Pictures for pack cameras that had none.

const upgradeCounts = new Map();
for (const [held, entry] of upgrades) {
  const raw = held.raw;
  if (entry.url) {
    raw.feedType = 'image';
    raw.url = entry.url;
    delete raw.lookup;
    if (entry.videoUrl && !raw.videoUrl) raw.videoUrl = entry.videoUrl;
  } else {
    raw.videoUrl = entry.videoUrl;
  }
  raw.feedFrom = 'inventory';
  bump(upgradeCounts, `${held.pack} · ${held.region || canonicalCountryCode(held.country) || '?'} · ${entry.url ? 'still' : 'stream'}`);
}

added.sort(
  (a, b) =>
    collator.compare(a.country, b.country) ||
    collator.compare(a.region || '', b.region || '') ||
    collator.compare(a.p, b.p) ||
    collator.compare(a.id, b.id),
);
const providerBlock = Object.fromEntries([...providers].sort((a, b) => collator.compare(a[0], b[0])));
const packText = formatPack({ providers: providerBlock, cameras: added, defaults: PACK_DEFAULTS });

// ---------------------------------------------------------------------------
// Report.

const lines = [];
const out = (text = '') => lines.push(text);
const table = (map, indent = '  ') => {
  for (const [label, count] of [...map].sort((a, b) => b[1] - a[1] || collator.compare(a[0], b[0])))
    out(`${indent}${fmt(count).padStart(8)}  ${label}`);
};
const total = (map) => [...map.values()].reduce((sum, n) => sum + (n instanceof Map ? total(n) : n), 0);

out(`CCTV inventory pack, built from ${path.basename(input)}`);
out(`Rows: ${fmt(rows.length)}${badRows ? ` (${fmt(badRows)} malformed rows skipped)` : ''}; camera views: ${fmt(views)}.`);
out(`Written: ${fmt(added.length)} new cameras to ${rel(outPath)}.`);
out(`Already in the packs (not written again): ${fmt(total(duplicates))}.`);
out(`Pack cameras that had no picture and now have the inventory's: ${fmt(upgrades.size)}.`);
out(`US and Canadian rows with no usable state or province, given the nearest held camera's: ${fmt(statesInferred)}.`);
out(`Left out: ${fmt(total(excluded))}.`);
out('No camera is left out for standing near another one.');
out();
out('Already held, by what makes it the same camera:');
for (const [rule, where] of [...duplicates].sort((a, b) => total(b[1]) - total(a[1]))) {
  out(`  ${rule}: ${fmt(total(where))}`);
  table(where, '      ');
}
out();
out('Left out, by reason:');
for (const [reason, byProvider] of [...excluded].sort((a, b) => total(b[1]) - total(a[1]))) {
  out(`  ${reason}: ${fmt(total(byProvider))}`);
  table(byProvider, '      ');
}
out();
out('Pictures given to pack cameras (pack · state/country · kind):');
table(upgradeCounts);
out();
const byCountry = new Map();
const byProvider = new Map();
let stills = 0;
let streamOnly = 0;
let headed = 0;
for (const camera of added) {
  bump(byCountry, camera.country);
  bump(byProvider, `${camera.country} · ${providers.get(camera.p).provider}`);
  if (camera.url) stills += 1;
  else streamOnly += 1;
  if (Number.isFinite(camera.headingDeg)) headed += 1;
}
out(`New cameras: ${fmt(added.length)} (${fmt(stills)} with a still, ${fmt(streamOnly)} stream-only, ${fmt(headed)} with an estimated heading).`);
out('By country:');
table(byCountry);
out('By operator:');
table(byProvider);
out();
out('Busiest 50 km areas of the new cameras (the server loads at most 1,000 per area):');
for (const { point, count } of densestCircles(added, { radiusKm: 50, count: 8 }))
  out(`  ${fmt(count).padStart(6)}  around ${point.name} (${point.city}, ${point.country}) ${point.lat.toFixed(3)}, ${point.lon.toFixed(3)}`);
const report = `${lines.join('\n')}\n`;

if (dumpPath) fs.writeFileSync(dumpPath, packText);
if (auditPath) fs.writeFileSync(auditPath, `${audit.join('\n')}\n`);
if (dryRun) {
  process.stdout.write(report);
  process.exit(0);
}
fs.writeFileSync(outPath, packText);
for (const pack of PACKS) {
  if (!pack.editable || ![...upgrades.keys()].some((held) => held.pack === pack.name)) continue;
  fs.writeFileSync(pack.file, formatPack({ providers: pack.raw.providers, cameras: pack.raw.cameras, defaults: pack.raw.defaults }));
}
fs.writeFileSync(reportPath, report);
const gz = zlib.gzipSync(packText).length;
console.log(`${rel(outPath)}: ${fmt(added.length)} cameras, ${mb(Buffer.byteLength(packText))} (${mb(gz)} gzipped)`);
console.log(`pictures given to ${fmt(upgrades.size)} pack cameras; report: ${rel(reportPath)}`);
