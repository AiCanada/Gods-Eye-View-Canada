// Convert Alberta 511's public camera list into source-pack entries.
//
// Source: the list behind https://511.alberta.ca/cctv, paged 100 sites at a
// time and saved as sources/alberta511-cameras.json. Alberta Transportation and
// Economic Corridors. Raw download, not committed. See ibi511-list.mjs.
//
// The Trans-Canada directory pack carried 121 of these stills at the same
// addresses, so those copies drop out of the merge as duplicate feed URLs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSitesToEntries, summary } from './ibi511-list.mjs';

const SOURCES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sources');
const src = (name) => path.join(SOURCES, name);

const raw = JSON.parse(fs.readFileSync(src('alberta511-cameras.json'), 'utf8'));
const sites = Array.isArray(raw) ? raw : raw.data || [];

const { entries, skipped } = listSitesToEntries(sites, {
  host: '511.alberta.ca',
  idPrefix: 'ab511',
  cityId: 'ab',
  provider: 'Alberta 511',
  operator: 'Alberta 511 — Alberta Transportation and Economic Corridors',
  regionFallback: 'Alberta',
});

fs.writeFileSync(src('cams-alberta511.json'), JSON.stringify(entries, null, 2));
process.stderr.write(summary('alberta511', entries, sites.length, skipped));
