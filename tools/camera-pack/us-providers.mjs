// Who operates each camera in the Road511 US listing. Road511 only indexes
// the cameras; the pictures belong to the state DOTs and city traffic centres
// that publish them, so every pack entry names that operator in its license
// and credits Road511 for the listing.
//
// The operator is read from the host of the camera's still, stream or view
// link (first host that matches wins). A camera with no link at all, or only
// links on hosts this table does not know, falls back to its state's DOT.

/** Pack provider key -> label shown per camera and the operator credited in the license. */
export const US_PROVIDERS = Object.freeze({
  ak511: { provider: 'Alaska 511', operator: 'Alaska Department of Transportation & Public Facilities' },
  algo: { provider: 'ALGO Traffic', operator: 'Alabama Department of Transportation' },
  az511: { provider: 'AZ511', operator: 'Arizona Department of Transportation' },
  caltrans: { provider: 'Caltrans', operator: 'California Department of Transportation (Caltrans)' },
  coloradosprings: { provider: 'Colorado Springs Traffic', operator: 'City of Colorado Springs' },
  cotrip: { provider: 'COtrip', operator: 'Colorado Department of Transportation' },
  ctroads: { provider: 'CTroads', operator: 'Connecticut Department of Transportation' },
  ddot: { provider: 'DDOT', operator: 'District Department of Transportation' },
  deldot: { provider: 'DelDOT', operator: 'Delaware Department of Transportation' },
  drivenc: { provider: 'DriveNC', operator: 'North Carolina Department of Transportation' },
  drivetexas: { provider: 'DriveTexas', operator: 'Texas Department of Transportation' },
  fl511: { provider: 'FL511', operator: 'Florida Department of Transportation' },
  ga511: { provider: '511 Georgia', operator: 'Georgia Department of Transportation' },
  goky: { provider: 'GoKY', operator: 'Kentucky Transportation Cabinet' },
  hidot: { provider: 'Hawaii DOT', operator: 'Hawaii Department of Transportation' },
  id511: { provider: 'Idaho 511', operator: 'Idaho Transportation Department' },
  idrivearkansas: { provider: 'IDriveArkansas', operator: 'Arkansas Department of Transportation' },
  indot: { provider: 'TrafficWise', operator: 'Indiana Department of Transportation' },
  iowadot: { provider: '511 Iowa', operator: 'Iowa Department of Transportation' },
  kcscout: { provider: 'KC Scout', operator: 'KC Scout (Kansas and Missouri Departments of Transportation)' },
  kdot: { provider: 'KanDrive', operator: 'Kansas Department of Transportation' },
  la511: { provider: '511 Louisiana', operator: 'Louisiana Department of Transportation and Development' },
  lakecountypassage: { provider: 'Lake County PASSAGE', operator: 'Lake County Division of Transportation, Illinois' },
  lewiscounty: { provider: 'Lewis County webcam', operator: 'Lewis County, Washington' },
  lexington: { provider: 'Lexington traffic cameras', operator: 'Lexington-Fayette Urban County Government' },
  mainedot: { provider: 'New England 511', operator: 'Maine Department of Transportation' },
  massdot: { provider: 'Mass511', operator: 'Massachusetts Department of Transportation' },
  mdchart: { provider: 'MDOT SHA CHART', operator: 'Maryland Department of Transportation State Highway Administration' },
  mdot_ms: { provider: 'MDOTtraffic', operator: 'Mississippi Department of Transportation' },
  mdt: { provider: 'MDT Travel Info', operator: 'Montana Department of Transportation' },
  midrive: { provider: 'Mi Drive', operator: 'Michigan Department of Transportation' },
  mn511: { provider: '511 Minnesota', operator: 'Minnesota Department of Transportation' },
  modot: { provider: 'MoDOT Traveler Information', operator: 'Missouri Department of Transportation' },
  ndroads: { provider: 'ND Roads', operator: 'North Dakota Department of Transportation' },
  ne511: { provider: 'Nebraska 511', operator: 'Nebraska Department of Transportation' },
  nhdot: { provider: 'New England 511', operator: 'New Hampshire Department of Transportation' },
  nj511: { provider: '511NJ', operator: 'New Jersey Department of Transportation' },
  nmroads: { provider: 'NMRoads', operator: 'New Mexico Department of Transportation' },
  nps: { provider: 'National Park Service webcam', operator: 'National Park Service' },
  nvroads: { provider: 'NVRoads', operator: 'Nevada Department of Transportation' },
  ny511: { provider: '511NY', operator: 'New York State Department of Transportation' },
  ohgo: { provider: 'OHGO', operator: 'Ohio Department of Transportation' },
  oktraffic: { provider: 'OKTraffic', operator: 'Oklahoma Department of Transportation' },
  ozarkstraffic: { provider: 'Ozarks Traffic', operator: 'Ozarks Traffic (Missouri Department of Transportation and City of Springfield)' },
  pa511: { provider: '511PA', operator: 'Pennsylvania Department of Transportation' },
  pangborn: { provider: 'Pangborn Airport webcam', operator: 'Pangborn Memorial Airport' },
  ridot: { provider: 'RIDOT', operator: 'Rhode Island Department of Transportation' },
  road511: { provider: 'Road511 listing', operator: 'Public traffic camera operator' },
  sc511: { provider: 'SC511', operator: 'South Carolina Department of Transportation' },
  sd511: { provider: 'SD511', operator: 'South Dakota Department of Transportation' },
  seattledot: { provider: 'Seattle traffic cameras', operator: 'Seattle Department of Transportation' },
  smartway: { provider: 'TDOT SmartWay', operator: 'Tennessee Department of Transportation' },
  sunmountainlodge: { provider: 'Sun Mountain Lodge webcam', operator: 'Sun Mountain Lodge' },
  travelmidwest: { provider: 'Travel Midwest', operator: 'Illinois Department of Transportation and partner agencies' },
  trimarc: { provider: 'TRIMARC', operator: 'TRIMARC (Kentucky Transportation Cabinet and Louisville Metro)' },
  tripcheck: { provider: 'TripCheck', operator: 'Oregon Department of Transportation' },
  udot: { provider: 'UDOT Traffic', operator: 'Utah Department of Transportation' },
  vdot: { provider: 'VDOT 511', operator: 'Virginia Department of Transportation' },
  vtrans: { provider: 'New England 511', operator: 'Vermont Agency of Transportation' },
  wi511: { provider: '511 Wisconsin', operator: 'Wisconsin Department of Transportation' },
  wsdot: { provider: 'WSDOT', operator: 'Washington State Department of Transportation' },
  wv511: { provider: 'WV511', operator: 'West Virginia Department of Transportation' },
  wyoroad: { provider: 'WYDOT 511', operator: 'Wyoming Department of Transportation' },
  yakimaairport: { provider: 'Yakima Air Terminal webcam', operator: 'Yakima Air Terminal' },
});

// [host pattern, provider key or { STATE: key }]. A vendor host shared by
// several states (a CARS program host, a video platform) names the operator
// only together with the camera's state.
const HOSTS = [
  [/(^|\.)511\.alaska\.gov$/, 'ak511'],
  [/(^|\.)az511\.com$/, 'az511'],
  [/(^|\.)dot\.ca\.gov$/, 'caltrans'],
  [/(^|\.)coloradosprings\.gov$/, 'coloradosprings'],
  [/^cocam\.carsprogram\.org$/, 'cotrip'],
  [/(^|\.)cotrip\.org$/, 'cotrip'],
  [/(^|\.)deldot\.gov$/, 'deldot'],
  [/(^|\.)drivenc\.gov$/, 'drivenc'],
  [/(^|\.)ncdot\.gov$/, 'drivenc'],
  [/(^|\.)fl511\.com$/, 'fl511'],
  [/(^|\.)divas\.cloud$/, { FL: 'fl511' }],
  [/(^|\.)511ga\.org$/, 'ga511'],
  [/(^|\.)511\.idaho\.gov$/, 'id511'],
  [/(^|\.)idrivearkansas\.com$/, 'idrivearkansas'],
  [/^public\.carsprogram\.org$/, { IN: 'indot', MA: 'massdot' }],
  [/(^|\.)trafficwise\.org$/, 'indot'],
  [/(^|\.)iowadot\.gov$/, 'iowadot'],
  [/(^|\.)kcscout\.net$/, 'kcscout'],
  [/^kscam\.carsprogram\.org$/, 'kdot'],
  [/^kdot-sfs\d*\.us-east-\d\.skyvdn\.com$/, 'kdot'],
  [/(^|\.)511la\.org$/, 'la511'],
  [/(^|\.)dotd\.la\.gov$/, 'la511'],
  [/(^|\.)lakecountypassage\.com$/, 'lakecountypassage'],
  [/(^|\.)lewiscounty\.com$/, 'lewiscounty'],
  [/^6855e4345af72\.streamlock\.net$/, 'lexington'],
  [/^api\.trafficland\.com$/, { MA: 'massdot' }],
  [/(^|\.)chart\.maryland\.gov$/, 'mdchart'],
  [/^mt\.cdn\.iteris-atis\.com$/, 'mdt'],
  [/(^|\.)micamerasimages\.net$/, 'midrive'],
  [/(^|\.)modot\.org$/, 'modot'],
  [/(^|\.)modot\.mo\.gov$/, 'modot'],
  [/(^|\.)dot\.nd\.gov$/, 'ndroads'],
  [/(^|\.)dot511\.nebraska\.gov$/, 'ne511'],
  [/(^|\.)nmroads\.com$/, 'nmroads'],
  [/(^|\.)nps\.gov$/, 'nps'],
  [/(^|\.)nvroads\.com$/, 'nvroads'],
  [/(^|\.)its\.nv\.gov$/, 'nvroads'],
  [/(^|\.)511ny\.org$/, 'ny511'],
  [/\.nysdot\.skyvdn\.com$/, 'ny511'],
  [/(^|\.)dot\.state\.oh\.us$/, 'ohgo'],
  [/(^|\.)ozarkstrafficoneview\.com$/, 'ozarkstraffic'],
  [/(^|\.)511pa\.com$/, 'pa511'],
  [/(^|\.)arcadis-ivds\.com$/, { PA: 'pa511' }],
  [/(^|\.)pangbornairport\.com$/, 'pangborn'],
  [/^scdotsnap\.us-east-1\.skyvdn\.com$/, 'sc511'],
  [/^sd\.cdn\.iteris-atis\.com$/, 'sd511'],
  [/(^|\.)seattle\.gov$/, 'seattledot'],
  [/(^|\.)tnsnapshots\.com$/, 'smartway'],
  [/^mcleansfs\d*\.us-east-1\.skyvdn\.com$/, { TN: 'smartway' }],
  [/(^|\.)sunmountainlodge\.com$/, 'sunmountainlodge'],
  [/^cctv\.travelmidwest\.com$/, 'travelmidwest'],
  [/(^|\.)trimarc\.org$/, 'trimarc'],
  [/(^|\.)tripcheck\.com$/, 'tripcheck'],
  [/(^|\.)udottraffic\.utah\.gov$/, 'udot'],
  [/(^|\.)vdotcameras\.com$/, 'vdot'],
  [/(^|\.)511wi\.gov$/, 'wi511'],
  [/(^|\.)dot\.wi\.gov$/, 'wi511'],
  [/(^|\.)wsdot\.wa\.gov$/, 'wsdot'],
  [/(^|\.)wyoroad\.info$/, 'wyoroad'],
  [/(^|\.)flyykm\.com$/, 'yakimaairport'],
];

/** Each state's own DOT, for a camera no link host identifies. */
export const STATE_PROVIDERS = Object.freeze({
  AK: 'ak511', AL: 'algo', AR: 'idrivearkansas', AZ: 'az511', CA: 'caltrans', CO: 'cotrip', CT: 'ctroads',
  DC: 'ddot', DE: 'deldot', FL: 'fl511', GA: 'ga511', HI: 'hidot', IA: 'iowadot', ID: 'id511',
  IL: 'travelmidwest', IN: 'indot', KS: 'kdot', KY: 'goky', LA: 'la511', MA: 'massdot', MD: 'mdchart',
  ME: 'mainedot', MI: 'midrive', MN: 'mn511', MO: 'modot', MS: 'mdot_ms', MT: 'mdt', NC: 'drivenc',
  ND: 'ndroads', NE: 'ne511', NH: 'nhdot', NJ: 'nj511', NM: 'nmroads', NV: 'nvroads', NY: 'ny511',
  OH: 'ohgo', OK: 'oktraffic', OR: 'tripcheck', PA: 'pa511', RI: 'ridot', SC: 'sc511', SD: 'sd511',
  TN: 'smartway', TX: 'drivetexas', UT: 'udot', VA: 'vdot', VT: 'vtrans', WA: 'wsdot', WI: 'wi511',
  WV: 'wv511', WY: 'wyoroad',
});

/** The provider key a link host names for a camera in `state`, or '' when the table has no answer. */
export function providerKeyForHost(host, state = '') {
  const name = String(host || '').toLowerCase();
  if (!name) return '';
  for (const [pattern, target] of HOSTS) {
    if (!pattern.test(name)) continue;
    if (typeof target === 'string') return target;
    if (target[state]) return target[state];
  }
  return '';
}

/**
 * @param {{ state: string, hosts?: string[] }} camera  link hosts in priority order (still, stream, views)
 * @returns {{ key: string, fallback: boolean, unmapped: string[] }}
 */
export function providerFor({ state, hosts = [] }) {
  const unmapped = [];
  let key = '';
  for (const host of hosts) {
    if (!host) continue;
    const found = providerKeyForHost(host, state);
    if (!found) unmapped.push(host);
    else if (!key) key = found;
  }
  if (key) return { key, fallback: false, unmapped };
  return { key: STATE_PROVIDERS[state] || 'road511', fallback: true, unmapped };
}

/** The pack's `providers[key]` record: the label and a license naming the operator and the listing. */
export function providerRecord(key) {
  const entry = US_PROVIDERS[key] || US_PROVIDERS.road511;
  return { provider: entry.provider, license: `${entry.operator} (listing: Road511)` };
}
