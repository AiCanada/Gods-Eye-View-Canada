// Convert Québec's open traffic-camera dataset into source-pack entries.
//
// Dataset: "Traffic camera", Ministère des Transports et de la Mobilité durable
// (MTMD), the cameras on the Québec 511 map. CC-BY 4.0 (Québec).
// https://open.canada.ca/data/en/dataset/d2f1dce5-35c5-4bb5-a54c-3b8ec9ac9de9
//
// Inputs in sources/ (raw downloads, not committed):
//   quebec511-cameras.geojson  WFS ms:infos_cameras as GeoJSON (EPSG:4326):
//                              every CSV column plus the camera's point
//   quebec511-cameras.csv      the CSV export, used only to cross-check the count
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sources');
const src = (name) => path.join(SOURCES, name);

const features = JSON.parse(fs.readFileSync(src('quebec511-cameras.geojson'), 'utf8')).features || [];

// The dataset only links each camera's viewer page (FenetreVideo.html), which
// the pack cannot store. The still behind it is published per regional folder:
// the camera code's letter picks the folder and the rest of the code is the
// image number, so Q19901 -> Quebec/cam/19901.jpg. Every Québec 511 still
// already in the pack follows this rule.
const FOLDER = { Q: 'Quebec', M: 'Montreal', G: 'Gatineau', T: 'TroisRivieres' };
const IMAGE_ROOT = 'https://www.quebec511.info/Images/Cameras';

// Direction of travel the camera faces, when the description says so.
const HEADING = [
  [/\((northward|direction nord)\)/i, 0],
  [/\((eastward|direction est)\)/i, 90],
  [/\((southward|direction sud)\)/i, 180],
  [/\((westward|direction ouest)\)/i, 270],
];

// Regions whose cameras belong to one city when the description names no town,
// so they can group under that city's preset (the app also checks distance).
const REGION_CITY = {
  'Québec (Capitale-Nationale)': 'Québec City',
  Montréal: 'Montréal',
  Laval: 'Laval',
  Outaouais: 'Gatineau',
};

const DIRECTION_WORDS = /^(northward|eastward|southward|westward|direction (nord|est|sud|ouest))$/i;

/** Town named in a description's trailing parentheses, e.g. "... (Bromont)". */
const townOf = (description) => {
  const match = String(description || '').match(/\(([^()]+)\)\s*$/);
  const town = match?.[1]?.trim();
  return town && !DIRECTION_WORDS.test(town) ? town : '';
};

const out = [];
const skipped = {};
const skip = (why) => {
  skipped[why] = (skipped[why] || 0) + 1;
};
const perFolder = {};

for (const feature of features) {
  const p = feature.properties || {};
  const [lon, lat] = feature.geometry?.coordinates || [];
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) { skip('no coordinates'); continue; }

  const code = String(p.NumeroCamera || '').trim();
  const match = code.match(/^([A-Za-z])(\d+)$/);
  const folder = match && FOLDER[match[1].toUpperCase()];
  if (!folder) { skip(`unrecognised camera code ${code || '(empty)'}`); continue; }

  const nameEn = String(p.DescriptionLocalisationEn || '').trim();
  const nameFr = String(p.DescriptionLocalisationFr || '').trim();
  const name = nameEn || nameFr || `Québec 511 camera ${code}`;
  const border = String(p.NomPosteFrontalier || p.NomPontFrontalier || '').trim();
  const heading = HEADING.find(([pattern]) => pattern.test(`${nameEn} ${nameFr}`))?.[1];
  const region = String(p.NomRegionDiffusion || '').trim();

  out.push({
    id: `qc511-${p.IDEcamera}`,
    name: border ? `${name} (${border})` : name,
    city: townOf(nameEn) || townOf(nameFr) || REGION_CITY[region] || region || 'Québec',
    cityId: 'qc',
    provider: 'Québec 511 (MTMD)',
    sourceKind: 'configured',
    feedType: 'image',
    url: `${IMAGE_ROOT}/${folder}/cam/${match[2]}.jpg`,
    viewerUrl: String(p.URL_FLUX_DONNEE || ''),
    lat,
    lon,
    headingDeg: Number.isFinite(heading) ? heading : null,
    headingConfidence: Number.isFinite(heading) ? 'estimated' : 'unknown',
    pitchDeg: -6,
    fovDeg: 70,
    rangeM: 500,
    mountHeightM: 10,
    groundElevationM: 10,
    license:
      'Québec 511 — Ministère des Transports et de la Mobilité durable; Données Québec, CC-BY 4.0',
    coordConfidence: 'exact',
    country: 'CA',
  });
  perFolder[folder] = (perFolder[folder] || 0) + 1;
}

// Cross-check against the CSV export when it is present.
if (fs.existsSync(src('quebec511-cameras.csv'))) {
  const rows = fs.readFileSync(src('quebec511-cameras.csv'), 'utf8')
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .slice(1)
    .filter((line) => /^"?\d+"?,/.test(line));
  const csvIds = new Set(rows.map((line) => line.match(/^"?(\d+)"?,/)[1]));
  const built = new Set(out.map((cam) => cam.id.replace(/^qc511-/, '')));
  const missing = [...csvIds].filter((id) => !built.has(id));
  process.stderr.write(`csv cross-check: ${csvIds.size} in CSV, ${missing.length} not built${missing.length ? ` (${missing.slice(0, 10).join(', ')})` : ''}\n`);
}

fs.writeFileSync(src('cams-quebec511.json'), JSON.stringify(out, null, 2));
const withHeading = out.filter((c) => c.headingConfidence === 'estimated').length;
process.stderr.write(
  `quebec 511: ${out.length} cameras (${withHeading} with a direction-derived heading) by folder ${JSON.stringify(perFolder)}` +
    `${Object.keys(skipped).length ? `; skipped ${JSON.stringify(skipped)}` : ''}\n`,
);
