// Who operates each camera in the international webcam listing. The listing
// only records where a camera is and where its picture lives; the pictures
// belong to the operators, so every pack entry names that operator in its
// license and credits the listing it came from.

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

/** Known listing families: provider label, operator credited, listing name. */
export const INTL_PROVIDERS = Object.freeze({
  adm: { provider: 'ADM Trafic', operator: 'Autoroutes du Maroc', listing: 'ADM Trafic' },
  amos: { provider: 'AMOS', operator: 'Camera operator (AMOS archive)', listing: 'AMOS' },
  balticlivecam: { provider: 'BalticLiveCam', operator: 'BalticLiveCam webcam operator', listing: 'BalticLiveCam' },
  dgt: { provider: 'DGT', operator: 'Dirección General de Tráfico', listing: 'DGT' },
  digitraffic: { provider: 'Digitraffic', operator: 'Fintraffic', listing: 'Digitraffic' },
  feratel: { provider: 'feratel', operator: 'feratel webcam operator', listing: 'feratel / Open Data Hub' },
  fotowebcam: { provider: 'foto-webcam.eu', operator: 'foto-webcam.eu operator', listing: 'foto-webcam.eu' },
  hktd: { provider: 'Hong Kong Transport Department', operator: 'Transport Department, HKSAR', listing: 'Hong Kong Transport Department' },
  les: { provider: 'Live Environment Streams', operator: 'Camera operator', listing: 'Live Environment Streams' },
  llm: { provider: 'LLM highway CCTV', operator: 'Lembaga Lebuhraya Malaysia', listing: 'LLM highway CCTV' },
  madridinformo: { provider: 'Madrid Informo', operator: 'Madrid Informo', listing: 'Madrid Informo' },
  mlit: { provider: 'MLIT', operator: 'Ministry of Land, Infrastructure, Transport and Tourism, Japan', listing: 'MLIT Road Information Provision System' },
  nzta: { provider: 'NZTA TrafficNZ', operator: 'NZ Transport Agency', listing: 'NZTA TrafficNZ' },
  opendatahub: { provider: 'Open Data Hub', operator: 'Open Data Hub webcam operator', listing: 'Open Data Hub' },
  openeagleeye: { provider: 'OpenEagleEye', operator: 'Camera operator', listing: 'OpenEagleEye' },
  osm: {
    provider: 'OpenStreetMap',
    operator: 'OpenStreetMap-listed webcam operator',
    listing: 'OpenStreetMap',
    extra: '© OpenStreetMap contributors',
  },
  panomax: { provider: 'Panomax', operator: 'Panomax webcam operator', listing: 'Panomax' },
  roundshot: { provider: 'Roundshot', operator: 'Roundshot webcam operator', listing: 'Roundshot' },
  sanral: { provider: 'SANRAL i-traffic', operator: 'SANRAL i-traffic', listing: 'SANRAL i-traffic' },
  skaping: { provider: 'Skaping', operator: 'Skaping webcam operator', listing: 'Skaping' },
  skylinewebcams: { provider: 'SkylineWebcams', operator: 'SkylineWebcams', listing: 'SkylineWebcams' },
  tfl: {
    provider: 'TfL JamCams',
    operator: 'Transport for London',
    listing: 'TfL Open Data',
    license: 'Powered by TfL Open Data. Contains OS data © Crown copyright and database rights',
  },
  thb: { provider: 'THB', operator: 'Directorate General of Highways, Taiwan', listing: 'THB' },
  trafikverket: { provider: 'Trafikverket', operator: 'Trafikverket', listing: 'Trafikverket' },
  vegagerdin: { provider: 'Vegagerðin', operator: 'Vegagerðin', listing: 'Vegagerðin' },
  vegvesen: { provider: 'Statens vegvesen', operator: 'Statens vegvesen', listing: 'Statens vegvesen' },
  viewsurf: { provider: 'ViewSurf', operator: 'ViewSurf webcam operator', listing: 'ViewSurf' },
  webcamerapl: { provider: 'WebCamera.pl', operator: 'WebCamera.pl webcam operator', listing: 'WebCamera.pl' },
  webcamgalore: { provider: 'WebcamGalore', operator: 'WebcamGalore webcam operator', listing: 'WebcamGalore' },
  whatsupcams: { provider: 'Whatsupcams', operator: 'Whatsupcams webcam operator', listing: 'Whatsupcams' },
  windy: { provider: 'Windy', operator: 'Windy.com webcam operator', listing: 'Windy.com' },
  worldcam: { provider: 'WorldCam', operator: 'WorldCam webcam operator', listing: 'WorldCam' },
});

// More specific patterns first: a feratel Open Data Hub row is feratel, not
// the generic Open Data Hub bucket.
const SOURCE_GROUPS = [
  [/^Windy/i, 'windy'],
  [/^WebcamGalore$/i, 'webcamgalore'],
  [/^WorldCam$/i, 'worldcam'],
  [/^Panomax$/i, 'panomax'],
  [/feratel/i, 'feratel'],
  [/^ODH |^OpenDataHub/i, 'opendatahub'],
  [/^OSM-contact|^OpenStreetMap$/i, 'osm'],
  [/^AMOS/i, 'amos'],
  [/skyline/i, 'skylinewebcams'],
  [/^Whatsupcams$/i, 'whatsupcams'],
  [/^DGT /i, 'dgt'],
  [/^Trafikverket$/i, 'trafikverket'],
  [/^Digitraffic$/i, 'digitraffic'],
  [/vegvesen/i, 'vegvesen'],
  [/Vegagerdin/i, 'vegagerdin'],
  [/^TfL /i, 'tfl'],
  [/^HK TD /i, 'hktd'],
  [/^THB |taiwan_freeway/i, 'thb'],
  [/^MLIT /i, 'mlit'],
  [/i-traffic\.co\.za|SANRAL/i, 'sanral'],
  [/^Skaping$/i, 'skaping'],
  [/^Roundshot$|^MeteoSwiss\/Roundshot$/i, 'roundshot'],
  [/foto-webcam/i, 'fotowebcam'],
  [/Madrid Informo/i, 'madridinformo'],
  [/^NZTA /i, 'nzta'],
  [/^ViewSurf$/i, 'viewsurf'],
  [/WebCamera\.pl/i, 'webcamerapl'],
  [/BalticLiveCam/i, 'balticlivecam'],
  [/^LLM /i, 'llm'],
  [/ADM Trafic/i, 'adm'],
  [/^LES:|^Live Environment Streams|^LES-/i, 'les'],
  [/^OpenEagleEye/i, 'openeagleeye'],
];

export function slugSource(source) {
  return (
    clean(source)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'listing'
  );
}

/** Pack provider key for a listing `source` value. */
export function providerKeyForSource(source) {
  const text = clean(source);
  for (const [pattern, key] of SOURCE_GROUPS) {
    if (pattern.test(text)) return key;
  }
  return slugSource(text);
}

export function providerFor(source) {
  return { key: providerKeyForSource(source) };
}

/** The pack's `providers[key]` record. */
export function providerRecord(key, source = '') {
  const meta = INTL_PROVIDERS[key];
  if (meta?.license) return { provider: meta.provider, license: meta.license };
  const listingName = clean(source) || key;
  if (!meta) {
    const label = listingName.slice(0, 80);
    return { provider: label, license: `Camera operator (listing: ${label})` };
  }
  const license = meta.extra
    ? `${meta.operator} (listing: ${meta.listing}); ${meta.extra}`
    : `${meta.operator} (listing: ${meta.listing})`;
  return { provider: meta.provider, license };
}
