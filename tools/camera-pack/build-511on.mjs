// Convert the keyless Ontario 511 camera API dump into source-pack entries.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Inputs and outputs live in sources/ beside this script, where merge-pack
// reads them, so the build works from any cwd.
const SOURCES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sources');
const src = (name) => path.join(SOURCES, name);

const raw = JSON.parse(fs.readFileSync(src('511on.json'), 'utf8'));

// The API reports the direction of travel the camera faces, which is a usable
// heading prior for the projected frustum. Anything else stays unknown.
const COMPASS = {
  north: 0, northeast: 45, east: 90, southeast: 135,
  south: 180, southwest: 225, west: 270, northwest: 315,
};

const slug = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

const out = [];
const seen = new Set();

for (const cam of raw) {
  const lat = Number(cam.Latitude);
  const lon = Number(cam.Longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
  // Ontario bounding box, to drop any stray or placeholder record.
  if (lat < 41.5 || lat > 57 || lon < -95.5 || lon > -74) continue;

  const view = (cam.Views || []).find((v) => v.Status === 'Enabled');
  if (!view?.Url) continue;

  const dir = String(cam.Direction || '').trim().toLowerCase();
  const heading = COMPASS[dir];

  let id = `on-${slug(cam.Location || cam.SourceId || cam.Id)}`;
  let n = 2;
  while (seen.has(id)) id = `on-${slug(cam.Location || cam.Id)}-${n++}`;
  seen.add(id);

  out.push({
    id,
    name: [cam.Roadway, cam.Location].filter(Boolean).join(' - ') || `Camera ${cam.Id}`,
    city: cam.Roadway || 'Ontario',
    cityId: 'on',
    provider: cam.Source || 'Ontario 511',
    sourceKind: 'configured',
    feedType: 'image',
    url: view.Url,
    lat,
    lon,
    headingDeg: Number.isFinite(heading) ? heading : 0,
    headingConfidence: Number.isFinite(heading) ? 'estimated' : 'unknown',
    pitchDeg: -6,
    fovDeg: 70,
    rangeM: 500,
    mountHeightM: 10,
    groundElevationM: 10,
    license: `${cam.Source || 'Ontario 511'} - ${view.Description || 'traffic camera'}`,
    coordConfidence: 'exact',
  });
}

fs.writeFileSync(src('cams-on.json'), JSON.stringify(out, null, 2));
const withHeading = out.filter((c) => c.headingConfidence === 'estimated').length;
process.stderr.write(`ontario: ${out.length} cameras (${withHeading} with a direction-derived heading)\n`);
