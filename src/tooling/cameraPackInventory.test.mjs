import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ID_PREFIX,
  PACK_DEFAULTS,
  classifyView,
  countryCode,
  expandPack,
  feedKeysOf,
  formatPack,
  linkCode,
  nameTokens,
  operatorCode,
  parseCsv,
  pointProblem,
  regionCode,
  rowToCameras,
} from '../../tools/camera-pack/inventory-csv.mjs';

const BUILDER = fileURLToPath(
  new URL('../../tools/camera-pack/build-inventory.mjs', import.meta.url),
);

const COLUMNS = [
  'province',
  'region',
  'country',
  'provider',
  'id',
  'source',
  'sourceId',
  'roadway',
  'direction',
  'location',
  'lat',
  'lon',
  'views_json',
];
const quote = (value) =>
  /[",\n]/.test(String(value))
    ? `"${String(value).replace(/"/g, '""')}"`
    : String(value);
const csv = (rows) =>
  [
    COLUMNS.join(','),
    ...rows.map((row) =>
      COLUMNS.map((column) => quote(row[column] ?? '')).join(','),
    ),
  ].join('\n');
let serial = 0;
const row = (over = {}) => ({
  province: 'Ohio',
  region: 'Columbus',
  country: 'United States',
  provider: 'OHGO',
  id: String(++serial),
  source: 'ohgo-cameras',
  sourceId: `OH-${serial}`,
  roadway: 'I-70',
  direction: 'East',
  location: `I-70 at Exit ${serial}`,
  lat: '39.9612',
  lon: '-82.9988',
  views_json: JSON.stringify([
    {
      url: `https://cams.ohgo.example/still/${serial}.jpg`,
      status: 'Enabled',
      description: 'snapshot',
    },
  ]),
  ...over,
});
const views = (...urls) =>
  JSON.stringify(
    urls.map((url) =>
      typeof url === 'string'
        ? { url, status: 'Enabled', description: 'snapshot' }
        : url,
    ),
  );

test('the CSV reader keeps quoted commas, quotes and line breaks, and counts malformed rows', () => {
  const text = '﻿a,b,c\n1,"x, ""y""\nz",3\n4,5\n6,7,8\n';
  const { header, rows, badRows } = parseCsv(text);
  assert.deepEqual(header, ['a', 'b', 'c']);
  assert.deepEqual(rows, [
    { a: '1', b: 'x, "y"\nz', c: '3' },
    { a: '6', b: '7', c: '8' },
  ]);
  assert.equal(badRows, 1);
});

test('countries, states and points', () => {
  assert.equal(countryCode('United States'), 'US');
  assert.equal(countryCode('South Korea'), 'KR');
  assert.equal(countryCode('fi'), 'FI');
  assert.equal(countryCode('Atlantis'), '');
  // Every country name, not only a short list, and the inventories' spellings.
  assert.equal(countryCode('Russia'), 'RU');
  assert.equal(countryCode('Bosnia and Herzegovina'), 'BA');
  assert.equal(countryCode('Victoria'), 'AU');
  assert.equal(countryCode('Sri_Lanka'), 'LK');
  assert.equal(countryCode('Saint Barthélemy'), 'BL');
  assert.equal(countryCode('MSC Cruises'), '');
  assert.equal(regionCode('US', 'Alabama'), 'AL');
  assert.equal(regionCode('CA', 'Yukon'), 'YT');
  assert.equal(regionCode('KR', 'Seoul'), '');
  assert.equal(pointProblem('US', 0, 0), 'coordinates at 0,0');
  assert.equal(pointProblem('US', 45.5, 9.2), 'outside the United States');
  assert.equal(pointProblem('CA', 45.5, -73.6), '');
  assert.equal(pointProblem('KR', 37.5, 127), '');
  assert.equal(pointProblem('FI', 95, 20), 'coordinates out of range');
});

test('each listed link is classified by what the app can show', () => {
  const kind = (url, description = '') =>
    classifyView({ url, description }).kind;
  assert.equal(kind('https://511.alberta.ca/map/Cctv/497'), 'still');
  assert.equal(
    kind('https://api.algotraffic.com/v4/Cameras/1845/snapshot.jpg'),
    'still',
  );
  assert.equal(
    kind('https://cctvn.freeway.gov.tw/abs2mjpg/bmjpg?camera=10000', 'mjpeg'),
    'still',
  );
  assert.equal(
    kind('https://webcams.nyctmc.org/api/cameras/8a6b/image', 'snapshot'),
    'still',
  );
  assert.equal(
    kind('https://video.dot.state.mn.us/public/C001.stream/playlist.m3u8'),
    'hls',
  );
  assert.equal(
    kind('http://211.236.72.94:1935/live/video2.stream/playlist.m3u8'),
    'hls',
  );
  assert.equal(kind('http://127.0.0.1/live/x.stream/playlist.m3u8'), 'invalid');
  assert.equal(
    kind(
      'http://cctvsec.ktict.co.kr/73526/lcorYJ+MvVdWcUtysbr4aG8y/F2u5y/FHUZXuV+0DZmrJ0RUaoqCWFT+ozgr=',
      'stream',
    ),
    'signed',
  );
  assert.equal(
    kind(
      'https://streetside.example.dev/img/a/Cikini-001/preview.jpg?token=9042-1790571386',
    ),
    'signed',
  );
  assert.equal(
    kind('https://images.data.gov.sg/api/traffic-images/2026/09/30f292b6.jpg'),
    'timestamped',
  );
  assert.equal(
    kind('https://www.trafficnz.info/camera/thumb/190.jpg', 'thumbnail'),
    'alt',
  );
  assert.equal(
    kind('https://ww5.yorkmaps.ca/webtrafficimages/loc21R.jpg', 'reference'),
    'alt',
  );
  assert.equal(
    kind(
      'https://travelmidwest.com/showCamera?id=IL-IDOTD1-IK14B',
      'camera page',
    ),
    'page',
  );
  assert.equal(
    kind('https://chart.maryland.gov/Video/GetVideo/7a00a1dc', 'public video'),
    'page',
  );
  assert.equal(
    kind(
      'https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/00002.00865.mp4',
      'video clip',
    ),
    'video',
  );
  assert.equal(kind('https://www.youtube.com/watch?v=abc'), 'embed');
  assert.equal(kind('not a link'), 'invalid');
  // A long ordinary path is not a signed one.
  assert.equal(
    kind(
      'https://cwwp2.dot.ca.gov/data/d4/cctv/image/tvd32i80baybridgesastowerwest/tvd32i80baybridgesastowerwest.jpg',
    ),
    'still',
  );
});

test('a row becomes one camera per view; a stream joins the still it is listed with', () => {
  const pair = rowToCameras(
    row({
      location: 'I-10 @ McDonald Rd',
      direction: 'East',
      views_json: views(
        'https://api.algotraffic.com/v4/Cameras/1845/snapshot.jpg',
        'https://cdn3.wowza.com/5/x/mob-cam-c095.stream/playlist.m3u8',
      ),
    }),
  ).cameras;
  assert.equal(pair.length, 1);
  assert.equal(pair[0].feedType, 'image');
  assert.equal(
    pair[0].url,
    'https://api.algotraffic.com/v4/Cameras/1845/snapshot.jpg',
  );
  assert.equal(
    pair[0].videoUrl,
    'https://cdn3.wowza.com/5/x/mob-cam-c095.stream/playlist.m3u8',
  );
  assert.equal(pair[0].headingDeg, 90);

  const site = rowToCameras(
    row({
      location: 'QEW West of Thompson Road',
      views_json: views(
        { url: 'https://511on.ca/map/Cctv/1', description: 'Toronto Bound' },
        { url: 'https://511on.ca/map/Cctv/2', description: 'Looking Down' },
        { url: 'https://511on.ca/map/Cctv/3', description: 'Looking West' },
      ),
    }),
  ).cameras;
  assert.deepEqual(
    site.map((camera) => camera.name),
    [
      'QEW West of Thompson Road (Toronto Bound)',
      'QEW West of Thompson Road (Looking Down)',
      'QEW West of Thompson Road (Looking West)',
    ],
  );
  assert.deepEqual(
    site.map((camera) => camera.headingDeg ?? null),
    [null, null, 270],
  );

  const streamOnly = rowToCameras(
    row({
      views_json: views(
        'https://video.dot.state.mn.us/public/C001.stream/playlist.m3u8',
      ),
    }),
  ).cameras;
  assert.deepEqual(
    [streamOnly[0].feedType, streamOnly[0].url, streamOnly[0].videoUrl],
    [
      'none',
      undefined,
      'https://video.dot.state.mn.us/public/C001.stream/playlist.m3u8',
    ],
  );

  // A thumbnail is the still when the row has no other, and an alias when it does.
  const thumbOnly = rowToCameras(
    row({
      views_json: views({
        url: 'https://snapshot.vdotcameras.com/thumbs/RichmondCS095SB0984.flv.png',
        description: 'thumbnail',
      }),
    }),
  ).cameras;
  assert.equal(
    thumbOnly[0].url,
    'https://snapshot.vdotcameras.com/thumbs/RichmondCS095SB0984.flv.png',
  );
  const withThumb = rowToCameras(
    row({
      views_json: views('https://www.trafficnz.info/camera/190.jpg', {
        url: 'https://www.trafficnz.info/camera/thumb/190.jpg',
        description: 'thumbnail',
      }),
    }),
  ).cameras;
  assert.equal(withThumb.length, 1);
  assert.deepEqual(withThumb[0].aliases, [
    'https://www.trafficnz.info/camera/thumb/190.jpg',
  ]);

  const nothing = rowToCameras(
    row({
      views_json: views({
        url: 'https://travelmidwest.com/showCamera?id=X',
        description: 'camera page',
      }),
    }),
  );
  assert.deepEqual(nothing.cameras, []);
  assert.deepEqual(nothing.kinds, ['page']);
});

test('operator codes ignore zero padding but keep letters, and a camera-plus-milepost segment is no code', () => {
  assert.equal(operatorCode('FULT-0036: SR 70/FIB at SR 166'), 'FULT-36');
  assert.equal(
    operatorCode('SAV-C067: SR 307 at Garden City Terminal'),
    'SAV-C67',
  );
  assert.equal(operatorCode('SR-0400: GA 400'), '');
  assert.equal(operatorCode('I-70 at Exit 5'), '');
  assert.equal(
    linkCode(
      'https://sfs-lr-34.dot.ga.gov/rtplive/FULT-CCTV-0036/playlist.m3u8',
    ),
    'FULT-36',
  );
  assert.equal(
    linkCode(
      'https://vss1live.dot.ga.gov/lo/alph-cam-002.stream/playlist.m3u8',
    ),
    'ALPH-2',
  );
  assert.equal(
    linkCode('https://cdn3.wowza.com/5/x/mob-cam-c095.stream/playlist.m3u8'),
    'MOB-C95',
  );
  assert.equal(
    linkCode(
      'https://cdn3.wowza.com/5/x/tus-cam-001-12.3.stream/playlist.m3u8',
    ),
    '',
  );
});

test('names compare by their words, with the usual road abbreviations', () => {
  assert.deepEqual(
    nameTokens('Hillside Avenue @ Little Neck Parkway'),
    nameTokens('Hillside Ave @ Little Neck Pkwy'),
  );
  assert.deepEqual(
    nameTokens('Stoney Trail and Deerfoot Trail SE'),
    nameTokens('Stoney Trail / Deerfoot Trail SE'),
  );
  assert.notDeepEqual(
    nameTokens('I-10 @ MM 12.3'),
    nameTokens('I-10 @ MM 12.5'),
  );
});

test('a site and its www. name are one address', () => {
  const a = feedKeysOf({ url: 'https://www.511ny.org/map/Cctv/4438' });
  const b = feedKeysOf({ url: 'https://511ny.org/map/Cctv/4438' });
  assert.ok(a.some((key) => b.includes(key)));
  assert.ok(
    feedKeysOf({
      url: 'https://images.drivebc.ca/bchighwaycam/pub/cameras/2.jpg',
    }).includes('feed:https://www.drivebc.ca/images/2.jpg'),
  );
});

function build(packs, rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inventory-build-'));
  const packDir = path.join(dir, 'config');
  fs.mkdirSync(packDir);
  fs.writeFileSync(
    path.join(packDir, 'cctv_sources.canada.json'),
    JSON.stringify(packs.canada || []),
  );
  if (packs.us)
    fs.writeFileSync(
      path.join(packDir, 'cctv_sources.us.json'),
      formatPack(packs.us),
    );
  if (packs.intl)
    fs.writeFileSync(
      path.join(packDir, 'cctv_sources.intl.json'),
      formatPack(packs.intl),
    );
  const input = path.join(dir, 'inventory.csv');
  fs.writeFileSync(input, csv(rows));
  const out = path.join(dir, 'inventory.json');
  const report = path.join(dir, 'report.txt');
  const run = spawnSync(
    process.execPath,
    [
      BUILDER,
      '--input',
      input,
      '--packs',
      packDir,
      '--out',
      out,
      '--report',
      report,
    ],
    { encoding: 'utf8' },
  );
  const read = (file) =>
    fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const result = {
    run,
    pack: run.status === 0 ? JSON.parse(read(out)) : null,
    report: read(report),
    usText: read(path.join(packDir, 'cctv_sources.us.json')),
  };
  fs.rmSync(dir, { recursive: true, force: true });
  return result;
}

const US_DEFAULTS = {
  country: 'US',
  sourceKind: 'configured',
  pitchDeg: -6,
  fovDeg: 70,
  rangeM: 500,
  mountHeightM: 10,
  headingConfidence: 'unknown',
};
const usPack = (cameras) => ({
  defaults: US_DEFAULTS,
  providers: {
    ohgo: {
      provider: 'OHGO',
      license: 'Ohio Department of Transportation (listing: Road511)',
    },
  },
  cameras,
});

test('the builder writes only cameras the packs do not hold, and keeps cameras that stand close together', () => {
  const held = {
    id: 'us511-OH-cam-1',
    name: 'I-71 at Broad St',
    city: 'Ohio',
    region: 'OH',
    lat: 39.9612,
    lon: -82.9988,
    p: 'ohgo',
    feedType: 'image',
    url: 'https://cams.ohgo.example/still/held.jpg',
  };
  const { run, pack, report } = build({ us: usPack([held]) }, [
    // The same still under the site's www. name: held already.
    row({
      location: 'I-71 at Broad St',
      views_json: views('https://www.cams.ohgo.example/still/held.jpg'),
    }),
    // Two different cameras five metres from it and from each other: both new.
    row({
      sourceId: 'near-1',
      location: 'Broad St at 3rd St',
      lat: '39.96124',
      lon: '-82.99880',
      views_json: views('https://cams.ohgo.example/still/near-1.jpg'),
    }),
    row({
      sourceId: 'near-2',
      location: 'Broad St at 4th St',
      lat: '39.96128',
      lon: '-82.99880',
      views_json: views('https://cams.ohgo.example/still/near-2.jpg'),
    }),
    // The same still listed twice by two sources: written once.
    row({
      provider: 'City-of-Columbus',
      sourceId: 'c-9',
      location: 'High St at Long St',
      views_json: views('https://cams.ohgo.example/still/twice.jpg'),
    }),
    row({
      provider: 'OHGO',
      sourceId: 'o-9',
      location: 'High St / Long St',
      views_json: views('https://cams.ohgo.example/still/twice.jpg'),
    }),
    // One source's two views of one site, same name, different stills: two cameras.
    row({
      sourceId: 'rest-1',
      location: 'Rest Area I-70 EB MM 300',
      views_json: views('https://cams.ohgo.example/still/RA300-ENTRY.jpg'),
    }),
    row({
      sourceId: 'rest-2',
      location: 'Rest Area I-70 EB MM 300',
      views_json: views('https://cams.ohgo.example/still/RA300-EXIT.jpg'),
    }),
    // Another source's camera with the held camera's name, 50 km away: not the same camera.
    row({
      provider: 'Delaware-County',
      sourceId: 'far',
      location: 'I-71 at Broad St',
      lat: '40.40',
      lon: '-82.99',
      views_json: views('https://cams.delco.example/still/far.jpg'),
    }),
    // The same name from another source within a kilometre is the held camera.
    row({
      provider: 'Franklin-County',
      sourceId: 'same',
      location: 'I-71 & Broad Street',
      lat: '39.9640',
      lon: '-82.9988',
      views_json: views('https://cams.franklin.example/still/71-broad.jpg'),
    }),
    // Kept though its country is not one we know: it takes the nearest held
    // camera's. Nothing with a point is left out for its country name.
    row({
      sourceId: 'nowhere',
      country: 'Atlantis',
      location: 'I-70 at Exit 13',
      views_json: views('https://cams.ohgo.example/still/atlantis.jpg'),
    }),
    // Left out: a school, the Austin live pack, an expiring link, no country and
    // no point, 0,0.
    row({
      sourceId: 'school',
      location: 'Main St at Lincoln Elementary School',
      views_json: views('https://cams.ohgo.example/still/school.jpg'),
    }),
    row({
      provider: 'AustinATD',
      province: 'Texas',
      views_json: views('https://cctv.austinmobility.example/image/1.jpg'),
    }),
    row({
      sourceId: 'signed',
      views_json: views(
        'https://cams.ohgo.example/still/x.jpg?token=abc-1790571386',
      ),
    }),
    row({ sourceId: 'lost', country: 'Atlantis', lat: '', lon: '' }),
    row({
      sourceId: 'ua',
      country: 'Ukraine',
      views_json: views('https://cams.example.ua/still/1.jpg'),
    }),
    row({ sourceId: 'zero', lat: '0', lon: '0' }),
    // Another country, stream only.
    row({
      province: '서울교통정보센터',
      region: '서울교통정보센터',
      country: 'South Korea',
      provider: 'UTIC-Korea',
      sourceId: 'L1',
      location: '대신R',
      lat: '37.561',
      lon: '126.941',
      views_json: views({
        url: 'https://its.example.kr/live/111.stream/playlist.m3u8',
        description: 'stream',
      }),
    }),
  ]);
  assert.equal(run.status, 0, run.stderr + run.stdout);
  assert.equal(pack.format, 'gev-cctv-pack/1');
  assert.deepEqual(pack.defaults, PACK_DEFAULTS);
  const cameras = expandPack(pack);
  const names = cameras.map((camera) => camera.name).sort();
  assert.deepEqual(names, [
    'Broad St at 3rd St',
    'Broad St at 4th St',
    'High St at Long St',
    'I-70 at Exit 13',
    'I-71 at Broad St',
    'Rest Area I-70 EB MM 300',
    'Rest Area I-70 EB MM 300',
    '대신R',
  ]);
  assert.equal(
    new Set(cameras.map((camera) => camera.id)).size,
    cameras.length,
  );
  assert.ok(cameras.every((camera) => camera.id.startsWith(ID_PREFIX)));
  const korea = cameras.find((camera) => camera.country === 'KR');
  assert.deepEqual(
    [korea.feedType, korea.url, korea.videoUrl, korea.region],
    [
      'none',
      undefined,
      'https://its.example.kr/live/111.stream/playlist.m3u8',
      undefined,
    ],
  );
  const ohio = cameras.find((camera) => camera.name === 'Broad St at 3rd St');
  assert.deepEqual(
    [ohio.country, ohio.region, ohio.city, ohio.provider],
    ['US', 'OH', 'Columbus', 'OHGO'],
  );
  assert.match(report, /No camera is left out for standing near another one\./);
  assert.match(report, /school, university, college or library camera: 1/);
  assert.match(report, /served by the Austin open-data live pack: 1/);
  assert.match(report, /only an expiring signed link: 1/);
  assert.match(
    report,
    /country not recognised \("Atlantis"\) and no usable coordinates: 1/,
  );
  assert.match(report, /given the nearest held camera's: 1./);
  assert.equal(
    cameras.find((camera) => camera.name === 'I-70 at Exit 13').country,
    'US',
  );
  assert.match(report, /coordinates at 0,0: 1/);
  assert.match(report, /Ukraine: 1/);
});

test('a Road511 camera with no still gets the inventory picture and keeps its id, name and place', () => {
  const lookup = {
    id: 'us511-MN-cam-502828',
    name: 'MN 36: T.H.36 WB @ Cleveland Ave',
    city: 'Minnesota',
    region: 'MN',
    lat: 45.0115,
    lon: -93.1874,
    p: 'mndot',
    feedType: 'none',
    lookup: 'road511',
  };
  const other = {
    id: 'us511-MN-cam-1',
    name: 'I-94 at Snelling',
    city: 'Minnesota',
    region: 'MN',
    lat: 44.95,
    lon: -93.17,
    p: 'mndot',
    feedType: 'image',
    url: 'https://cams.mn.example/1.jpg',
  };
  const pack = {
    defaults: US_DEFAULTS,
    providers: {
      mndot: { provider: 'MnDOT', license: 'MnDOT (listing: Road511)' },
    },
    cameras: [lookup, other],
  };
  const {
    run,
    pack: inventory,
    usText,
  } = build({ us: pack }, [
    row({
      province: 'Minnesota',
      region: 'Twin Cities',
      provider: 'MnDOT-IRIS',
      sourceId: 'C001',
      location: 'T.H.36 WB @ Cleveland Ave',
      lat: '45.0118',
      lon: '-93.1871',
      views_json: views(
        'https://cams.mn.example/C001.jpg',
        'https://video.dot.state.mn.us/public/C001.stream/playlist.m3u8',
      ),
    }),
  ]);
  assert.equal(run.status, 0, run.stderr + run.stdout);
  assert.equal(inventory.cameras.length, 0);
  const lines = usText.split('\n');
  const upgraded = JSON.parse(
    lines
      .find((line) => line.includes('us511-MN-cam-502828'))
      .replace(/,$/, ''),
  );
  assert.deepEqual(upgraded, {
    id: 'us511-MN-cam-502828',
    name: 'MN 36: T.H.36 WB @ Cleveland Ave',
    city: 'Minnesota',
    region: 'MN',
    lat: 45.0115,
    lon: -93.1874,
    p: 'mndot',
    feedType: 'image',
    url: 'https://cams.mn.example/C001.jpg',
    videoUrl: 'https://video.dot.state.mn.us/public/C001.stream/playlist.m3u8',
    feedFrom: 'inventory',
  });
  // Every other camera line is written back unchanged.
  assert.ok(lines.includes(`${JSON.stringify(other)}`));
});

test('the builder refuses a missing inventory', () => {
  const run = spawnSync(
    process.execPath,
    [BUILDER, '--input', path.join(os.tmpdir(), 'no-such-inventory.csv')],
    { encoding: 'utf8' },
  );
  assert.equal(run.status, 1);
  assert.match(run.stderr, /CCTV inventory not found/);
});
