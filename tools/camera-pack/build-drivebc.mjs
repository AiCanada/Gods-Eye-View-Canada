// Convert DriveBC's public webcam list into source-pack entries.
//
// Source: https://www.drivebc.ca/api/webcams/ (the list behind
// https://www.drivebc.ca/cameras), saved as sources/drivebc-webcams.json.
// BC Ministry of Transportation and Transit. Raw download, not committed.
//
// Every camera is kept, switched-off ones included: a camera that is down today
// is usually back within the day, and the proxy backs off from a failing still
// and shows the placeholder card until it returns. The stills are served at
// https://www.drivebc.ca/images/<id>.jpg, the same address the directory packs
// already used for the 150 DriveBC cameras they carried, so those copies drop
// out of the merge as duplicate feed URLs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sources');
const src = (name) => path.join(SOURCES, name);

const raw = JSON.parse(fs.readFileSync(src('drivebc-webcams.json'), 'utf8'));
const list = Array.isArray(raw) ? raw : raw.webcams || raw.results || [];

// DriveBC names the direction each camera looks.
const COMPASS = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 };

const out = [];
const skipped = {};
const skip = (why) => {
  skipped[why] = (skipped[why] || 0) + 1;
};

for (const cam of list) {
  const [lon, lat] = cam.location?.coordinates || [];
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) { skip('no coordinates'); continue; }
  if (!Number.isInteger(cam.id)) { skip('no id'); continue; }

  const heading = COMPASS[String(cam.orientation || '').trim().toUpperCase()];
  const elevation = Number(cam.elevation);
  out.push({
    id: `bc-drivebc-${cam.id}`,
    name: String(cam.name_override || cam.name || `DriveBC camera ${cam.id}`).trim(),
    city: String(cam.highway_description || cam.region_name || 'British Columbia').trim(),
    cityId: 'bc',
    provider: 'DriveBC',
    sourceKind: 'configured',
    feedType: 'image',
    url: `https://www.drivebc.ca/images/${cam.id}.jpg`,
    lat,
    lon,
    headingDeg: Number.isFinite(heading) ? heading : null,
    headingConfidence: Number.isFinite(heading) ? 'estimated' : 'unknown',
    pitchDeg: -6,
    fovDeg: 70,
    rangeM: 500,
    mountHeightM: 10,
    groundElevationM: Number.isFinite(elevation) ? elevation : 10,
    license: `DriveBC — BC Ministry of Transportation and Transit${cam.caption ? `: ${String(cam.caption_override || cam.caption).trim()}` : ''}`,
    coordConfidence: 'exact',
    country: 'CA',
  });
}

fs.writeFileSync(src('cams-drivebc.json'), JSON.stringify(out, null, 2));
const withHeading = out.filter((c) => c.headingConfidence === 'estimated').length;
process.stderr.write(
  `drivebc: ${out.length} cameras of ${list.length} (${withHeading} with a heading)` +
    `${Object.keys(skipped).length ? `; skipped ${JSON.stringify(skipped)}` : ''}\n`,
);
