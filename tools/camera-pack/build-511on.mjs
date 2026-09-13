// Convert Ontario 511's public camera list into source-pack entries.
//
// Source: the list behind https://511on.ca/cctv, paged 100 sites at a time and
// saved as sources/511on-cameras.json. Ministry of Transportation Ontario. Raw
// download, not committed. See ibi511-list.mjs.
//
// The keyless /api/v2/get/cameras endpoint this pack used to read lists the
// same 944 sites, but only the first view of each was kept; the list carries
// every view (1,672), so a pole looking both ways now shows both.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSitesToEntries, summary } from './ibi511-list.mjs';

const SOURCES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sources');
const src = (name) => path.join(SOURCES, name);

const raw = JSON.parse(fs.readFileSync(src('511on-cameras.json'), 'utf8'));
const sites = Array.isArray(raw) ? raw : raw.data || [];

const { entries, skipped } = listSitesToEntries(sites, {
  host: '511on.ca',
  idPrefix: 'on511',
  cityId: 'on',
  provider: 'Ontario 511',
  operator: 'Ontario 511 — Ministry of Transportation Ontario',
  regionFallback: 'Ontario',
  // Ontario, generously bounded, to drop any stray or placeholder record.
  bounds: { latMin: 41.5, latMax: 57, lonMin: -95.5, lonMax: -74 },
});

fs.writeFileSync(src('cams-on.json'), JSON.stringify(entries, null, 2));
process.stderr.write(summary('ontario511', entries, sites.length, skipped));
