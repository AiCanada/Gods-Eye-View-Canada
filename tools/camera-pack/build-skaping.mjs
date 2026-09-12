// The five Banff/Jasper/Golden cameras hosted by Skaping.
//
// Skaping publishes each frame at a path carrying the capture date and minute,
// so no stored URL stays current: it would keep returning one frozen image
// while the console presented it as live. These entries therefore carry NO feed
// URL. They declare the operator's own player page plus the strategy for
// reading the current frame out of it, and the proxy resolves the real URL per
// request.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Inputs and outputs live in sources/ beside this script, where merge-pack
// reads them, so the build works from any cwd.
const SOURCES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sources');
const src = (name) => path.join(SOURCES, name);

const cams = [
  {
    id: 'skaping-banff-gondola-summit',
    name: 'Banff Gondola Summit',
    city: 'Banff',
    cityId: 'ab',
    page: 'https://www.skaping.com/banffgondola',
    lat: 51.144607,
    lon: -115.574766,
    mountHeightM: 12,
    groundElevationM: 2281,
  },
  {
    id: 'skaping-maligne-lake',
    name: 'Maligne Lake',
    city: 'Jasper',
    cityId: 'ab',
    page: 'https://www.skaping.com/malignelake',
    lat: 52.729398,
    lon: -117.640123,
    mountHeightM: 8,
    groundElevationM: 1673,
  },
  {
    id: 'skaping-columbia-icefield',
    name: 'Columbia Icefield',
    city: 'Jasper',
    cityId: 'ab',
    page: 'https://www.skaping.com/columbiaicefield',
    lat: 52.220252,
    lon: -117.224694,
    mountHeightM: 10,
    groundElevationM: 1981,
  },
  {
    id: 'skaping-columbia-icefield-skywalk',
    name: 'Columbia Icefield Skywalk',
    city: 'Jasper',
    cityId: 'ab',
    page: 'https://www.skaping.com/columbiaicefieldskywalk',
    lat: 52.261255,
    lon: -117.280579,
    mountHeightM: 10,
    groundElevationM: 1520,
  },
  {
    id: 'skaping-golden-skybridge',
    name: 'Golden Skybridge',
    city: 'Golden',
    cityId: 'bc',
    page: 'https://www.skaping.com/golden-skybridge',
    lat: 51.316438,
    lon: -116.961835,
    mountHeightM: 10,
    groundElevationM: 1070,
  },
];

const out = cams.map((c) => ({
  id: c.id,
  name: c.name,
  city: c.city,
  cityId: c.cityId,
  provider: 'Skaping (Pursuit / Golden Skybridge)',
  sourceKind: 'configured',
  feedType: 'image',
  // Deliberately empty: resolved per request from `pageUrl`.
  url: '',
  pageUrl: c.page,
  frameResolver: 'og-image',
  framePreferLarge: true,
  // The page advertises frames on its CDN, not on its own host; the proxy
  // refuses any other host the page might name.
  frameHosts: ['skaping.s3.gra.io.cloud.ovh.net'],
  lat: c.lat,
  lon: c.lon,
  headingDeg: 0,
  headingConfidence: 'unknown',
  pitchDeg: -6,
  fovDeg: 70,
  rangeM: 4000,
  mountHeightM: c.mountHeightM,
  groundElevationM: c.groundElevationM,
  license: 'Public web camera published by the operator via Skaping',
  coordConfidence: 'exact',
}));

fs.writeFileSync(src('cams-skaping.json'), JSON.stringify(out, null, 2));
process.stderr.write(`skaping: ${out.length} resolver-backed cameras\n`);
