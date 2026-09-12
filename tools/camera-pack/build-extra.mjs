// Build the hand-curated Saint John city cameras plus the Windy feeds that
// meteoblue lists for the Saint John area.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Inputs and outputs live in sources/ beside this script, where merge-pack
// reads them, so the build works from any cwd.
const SOURCES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sources');
const src = (name) => path.join(SOURCES, name);

const base = {
  sourceKind: 'configured',
  rangeM: 700,
  mountHeightM: 14,
  groundElevationM: 8,
};

// City of Saint John public cameras. Each page embeds an ipcamlive player; the
// alias resolves to a keyless still-image endpoint that returns a live JPEG.
// Coordinates come from the nbcams.ca directory, which mirrors these same three
// feeds through its own cache and pins each one. Those positions are better than
// placing them by name, so the direct first-party ipcamlive feed is kept here and
// the mirrored duplicates are dropped during the merge.
const saintJohn = [
  {
    id: 'sj-fundy-quay',
    name: 'Fundy Quay / Loyalist Plaza',
    alias: 'loyalistplaza',
    lat: 45.273305,
    lon: -66.062873,
    headingDeg: 180,
    pitchDeg: -8,
    fovDeg: 80,
    note: 'Loyalist Plaza on the harbour boardwalk, looking south over the Fundy Quay site',
  },
  {
    id: 'sj-kings-square',
    name: "King's Square",
    alias: 'kingssquare',
    lat: 45.272974,
    lon: -66.058442,
    headingDeg: 225,
    pitchDeg: -10,
    fovDeg: 75,
    note: "King's Square in uptown Saint John",
  },
  {
    id: 'sj-partridge-island',
    name: 'Partridge Island',
    alias: 'partridgeisland',
    // The camera sits in the South End, not on the island; it looks south down
    // the harbour toward Partridge Island, bearing roughly 166 degrees.
    lat: 45.272467,
    lon: -66.058449,
    headingDeg: 166,
    pitchDeg: -6,
    fovDeg: 80,
    note: 'South End vantage looking south down the harbour toward Partridge Island',
  },
].map((c) => ({
  ...base,
  id: c.id,
  name: c.name,
  city: 'Saint John',
  cityId: 'saint-john',
  provider: 'City of Saint John',
  feedType: 'image',
  url: `https://g1.ipcamlive.com/player/snapshot.php?alias=${c.alias}`,
  lat: c.lat,
  lon: c.lon,
  headingDeg: c.headingDeg,
  headingConfidence: 'estimated',
  pitchDeg: c.pitchDeg,
  fovDeg: c.fovDeg,
  poseSource: 'curated',
  license: `City of Saint John public web cam - ${c.note}`,
  coordConfidence: 'exact',
}));

// Windy-hosted cameras that meteoblue lists around Saint John. The listing page
// carries names but no coordinates, so these are placed from the named
// community and flagged as estimated.
const windyPlaces = {
  1516544672: { name: 'Saint John: Kennebecasis River', city: 'Saint John', lat: 45.3512, lon: -66.0192 },
  1793884641: { name: 'Thumb Cap', city: 'Quispamsis', lat: 45.4286, lon: -65.9531 },
  1793884620: { name: 'Thumb Cap (second view)', city: 'Quispamsis', lat: 45.4286, lon: -65.9531 },
  1793884638: { name: 'Rothesay', city: 'Rothesay', lat: 45.3868, lon: -65.9968 },
  1793884664: { name: 'Woodmans Point', city: 'Grand Bay-Westfield', lat: 45.3556, lon: -66.1408 },
  1793884669: { name: 'Grand Bay-Westfield', city: 'Grand Bay-Westfield', lat: 45.3607, lon: -66.2361 },
  1793884670: { name: 'Quispamsis', city: 'Quispamsis', lat: 45.4325, lon: -65.9469 },
  1793884666: { name: 'Quispamsis (second view)', city: 'Quispamsis', lat: 45.4325, lon: -65.9469 },
  1793884617: { name: 'Bayard', city: 'Bayard', lat: 45.4667, lon: -66.1833 },
  1793884653: { name: 'Welsford', city: 'Welsford', lat: 45.4436, lon: -66.3494 },
  1608721024: { name: 'Hampton south-west', city: 'Hampton', lat: 45.5286, lon: -65.8536 },
};

const html = fs.readFileSync(src('meteoblue.html'), 'utf8');
const ids = [...new Set([...html.matchAll(/embed\/player\/(\d+)/g)].map((m) => m[1]))];

const windy = ids
  .filter((id) => windyPlaces[id])
  .map((id) => {
    const p = windyPlaces[id];
    return {
      ...base,
      id: `windy-${id}`,
      name: p.name,
      city: p.city,
      cityId: 'nb',
      provider: 'Windy Webcams (listed by meteoblue)',
      feedType: 'image',
      url: `https://imgproxy.windy.com/_/full/plain/current/${id}/original.jpg`,
      lat: p.lat,
      lon: p.lon,
      headingDeg: 0,
      headingConfidence: 'unknown',
      pitchDeg: -6,
      fovDeg: 70,
      license: 'Windy.com public webcam, listed on meteoblue',
      coordConfidence: 'estimated',
    };
  });

const unmatched = ids.filter((id) => !windyPlaces[id]);
if (unmatched.length) {
  process.stderr.write(`windy ids with no place mapping (skipped): ${unmatched.join(', ')}\n`);
}

fs.writeFileSync(src('cams-saintjohn.json'), JSON.stringify(saintJohn, null, 2));
fs.writeFileSync(src('cams-windy.json'), JSON.stringify(windy, null, 2));
process.stderr.write(`saint john: ${saintJohn.length}, windy: ${windy.length}\n`);
