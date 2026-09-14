import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { road511FeatureId } from '../../server/providers/cctv/road511-lookup.js';
import { isSchoolCamera } from '../../tools/camera-pack/school-cams.mjs';
import {
  PACK_DEFAULTS,
  classifyLink,
  dedupeRows,
  densestCircles,
  expandPack,
  fixCoordinates,
  formatPack,
  headingFromDirection,
  parseTsv,
  rowToEntries,
  schoolHit,
} from '../../tools/camera-pack/road511-tsv.mjs';
import { providerFor, providerRecord } from '../../tools/camera-pack/us-providers.mjs';

const BUILDER = fileURLToPath(new URL('../../tools/camera-pack/build-road511-us.mjs', import.meta.url));

const COLUMNS = [
  'state_id', 'state_name', 'camera_id', 'camera_name', 'location', 'road', 'latitude', 'longitude', 'direction',
  'camera_details', 'primary_url', 'video_url', 'N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW', 'number_of_views',
  'active', 'last_updated', 'source',
];

const row = (over = {}) => ({
  ...Object.fromEntries(COLUMNS.map((column) => [column, ''])),
  state_id: 'GA',
  state_name: 'Georgia',
  camera_id: 'GA-cam-1',
  camera_name: 'GDOT-0154: I-85 N past Old Peachtree Rd (Gwinnett)',
  latitude: '33.95',
  longitude: '-84.05',
  primary_url: 'https://511ga.org/map/Cctv/1',
  active: 'true',
  source: 'Road511',
  ...over,
});

const tsv = (rows, columns = COLUMNS) =>
  [columns.join('\t'), ...rows.map((r) => columns.map((column) => r[column] ?? '').join('\t'))].join('\r\n');

test('columns are read by header name in any order, with the BOM and CRLF stripped', () => {
  const columns = [...COLUMNS].reverse();
  const { rows } = parseTsv(`${String.fromCharCode(0xfeff)}${tsv([row(), row({ camera_id: 'GA-cam-2' })], columns)}\r\n`);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].camera_id, 'GA-cam-1');
  assert.equal(rows[0].state_id, 'GA', 'the last column carries no \\r');
  assert.equal(rows[1].primary_url, 'https://511ga.org/map/Cctv/1');
  assert.throws(() => parseTsv('state_id\tlatitude\n'), /camera_id/);
});

test('identical rows drop silently; a conflicting duplicate id keeps the first and is reported', () => {
  const first = row();
  const { rows, identical, conflicts, missingId } = dedupeRows([
    first,
    { ...first },
    row({ camera_name: 'Something else' }),
    row({ camera_id: '' }),
    row({ camera_id: 'GA-cam-2' }),
  ]);
  assert.deepEqual(rows.map((r) => r.camera_id), ['GA-cam-1', 'GA-cam-2']);
  assert.equal(rows[0], first);
  assert.equal(identical, 1);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].dropped.camera_name, 'Something else');
  assert.equal(missingId.length, 1);
});

test('a lost minus sign is restored near its state; the ocean and far-off test rows are rejected', () => {
  const at = (state, id, latitude, longitude, extra = {}) =>
    row({ state_id: state, state_name: state, camera_id: id, latitude: String(latitude), longitude: String(longitude), ...extra });
  const input = [
    at('GA', 'GA-cam-1', 33.75, -84.39),
    at('GA', 'GA-cam-2', 33.8, -84.3),
    at('GA', 'GA-cam-18120', 33.92558, 84.308849),
    at('NY', 'NY-cam-1', 40.75, -73.99),
    at('NY', 'NY-cam-2', 42.65, -73.75),
    at('NY', 'NY-cam-icdhy1zlpqf', 45, -50, { camera_name: 'KATHY ROADWAY' }),
    at('LA', 'LA-cam-1', 30.45, -91.18),
    at('LA', 'LA-cam-2', 29.95, -90.07),
    at('LA', 'LA-cam-378', 43.652678, -79.109116, { camera_name: 'test location' }),
    at('TX', 'TX-cam-aus', 30.27, -97.74),
    at('TX', 'TX-cam-dal', 32.78, -96.8),
    at('TX', 'TX-cam-hou', 29.76, -95.37),
    at('TX', 'TX-cam-elp', 31.878757, -106.625477),
    at('AK', 'AK-cam-1', 61.2, -149.9),
    at('AK', 'AK-cam-2', 55.45805, -132.84125),
    at('AK', 'AK-cam-3', 61.2, 149.9),
    at('OH', 'OH-cam-1', '', -83),
  ];
  const { rows, fixes, rejects } = fixCoordinates(input);
  assert.deepEqual(fixes.map((f) => [f.id, f.to.lon]), [['GA-cam-18120', -84.308849]]);
  assert.deepEqual(
    rejects.map((r) => r.id).sort(),
    ['AK-cam-3', 'LA-cam-378', 'NY-cam-icdhy1zlpqf', 'OH-cam-1'],
    'the Atlantic, Ontario, an unflipped Alaskan sign and an empty point',
  );
  assert.match(rejects.find((r) => r.id === 'LA-cam-378').reason, /km from the median LA camera point/);
  const kept = new Map(rows.map((r) => [r.camera_id, r]));
  assert.ok(kept.has('TX-cam-elp'), 'El Paso is Texas, 900 km from the middle of its cameras');
  assert.ok(kept.has('AK-cam-2'), 'Southeast Alaska is Alaska');
  assert.equal(kept.get('GA-cam-18120').lon, -84.308849);
});

test('a compass label is an estimated heading; anything else is unknown', () => {
  assert.deepEqual(headingFromDirection('N'), { headingDeg: 0, headingConfidence: 'estimated' });
  assert.deepEqual(headingFromDirection('SW'), { headingDeg: 225, headingConfidence: 'estimated' });
  assert.deepEqual(headingFromDirection('Eastbound'), { headingDeg: 90, headingConfidence: 'estimated' });
  assert.deepEqual(headingFromDirection(''), { headingDeg: null, headingConfidence: 'unknown' });
  assert.deepEqual(headingFromDirection('Both'), { headingDeg: null, headingConfidence: 'unknown' });
});

test('a still link is an image camera, its address percent-encoded', () => {
  const [camera] = rowToEntries(row({
    state_id: 'OH', state_name: 'Ohio', camera_id: 'OH-cam-7', camera_name: 'I-70 at MM 88', direction: 'E',
    primary_url: 'https://itscameras.dot.state.oh.us:443/images/CMH/I-70 at MM 88.jpg',
    video_url: 'https://example-video.skyvdn.com/live/88.stream/playlist.m3u8',
  }));
  assert.deepEqual(camera, {
    id: 'us511-OH-cam-7',
    name: 'I-70 at MM 88',
    city: 'Ohio',
    region: 'OH',
    lat: 33.95,
    lon: -84.05,
    p: 'ohgo',
    feedType: 'image',
    url: 'https://itscameras.dot.state.oh.us/images/CMH/I-70%20at%20MM%2088.jpg',
    headingDeg: 90,
    headingConfidence: 'estimated',
  });
});

test('no link, a stream only, or a link that is not a still makes a Road511 lookup camera', () => {
  const [texas] = rowToEntries(row({
    state_id: 'TX', state_name: 'Texas', camera_id: 'TX-cam-0e7e4a5b8ff24e2ca479b019', camera_name: 'TX_ELP_174',
    camera_details: 'IH10 @ Mesa St', primary_url: '',
  }));
  assert.equal(texas.feedType, 'none');
  assert.equal(texas.lookup, 'road511');
  assert.equal(texas.p, 'drivetexas');
  assert.equal('url' in texas, false);
  assert.equal('videoUrl' in texas, false);
  assert.equal(texas.name, 'IH10 @ Mesa St');
  assert.equal(road511FeatureId(texas.id), 'TX-cam-0e7e4a5b8ff24e2ca479b019');

  const [maryland] = rowToEntries(row({
    state_id: 'MD', state_name: 'Maryland', camera_id: 'MD-cam-5', camera_name: 'I-270 & W Diamond Ave (MD 117)',
    primary_url: '', video_url: 'https://chart.maryland.gov/Video/GetVideo/0901227b0096007b00488436cf235d0a',
  }));
  assert.equal(maryland.feedType, 'none');
  assert.equal(maryland.videoUrl, 'https://chart.maryland.gov/Video/GetVideo/0901227b0096007b00488436cf235d0a',
    'the video column is a stream even without a playlist extension');
  assert.equal(maryland.p, 'mdchart');
  const [delaware] = rowToEntries(row({
    state_id: 'DE', state_name: 'Delaware', camera_id: 'DE-cam-1', primary_url: '', video_url: 'https://video.deldot.gov/live/KCAM 001.stream/playlist.m3u8',
  }));
  assert.equal(delaware.videoUrl, 'https://video.deldot.gov/live/KCAM%20001.stream/playlist.m3u8');

  const [missouri] = rowToEntries(row({
    state_id: 'MO', state_name: 'Missouri', camera_id: 'MO-cam-209', camera_name: 'I-70 at Rte 291',
    primary_url: 'https://sfs02-traveler.modot.mo.gov/rtplive/MODOT_CAM_209/playlist.m3u8',
  }));
  assert.equal(missouri.feedType, 'none');
  assert.equal(missouri.videoUrl, 'https://sfs02-traveler.modot.mo.gov/rtplive/MODOT_CAM_209/playlist.m3u8');
  assert.equal(missouri.p, 'modot');

  const [kentucky] = rowToEntries(row({
    state_id: 'KY', state_name: 'Kentucky', camera_id: 'KY-cam-9', camera_name: 'I-64 at Exit 9',
    primary_url: 'http://172.19.40.191/aca/index.html#view',
  }));
  assert.equal(kentucky.feedType, 'none');
  assert.equal('videoUrl' in kentucky, false, 'a private address is never kept');
  assert.equal(classifyLink('http://172.19.40.191/aca/index.html#view').kind, 'private');
  assert.equal(classifyLink('https://www.example.gov/cams/view.aspx').kind, 'page');
  assert.equal(classifyLink('https://snapshot.vdotcameras.com/thumbs/x.flv.png').kind, 'still');
});

test('a Nebraska row with several view stills becomes one camera per view', () => {
  const base = 'https://dot511.nebraska.gov/images/vid-003020407';
  const entries = rowToEntries(row({
    state_id: 'NE', state_name: 'Nebraska', camera_id: 'NE-cam-291', camera_name: 'Allen', road: 'US 20',
    primary_url: `${base}-01.jpg`, E: `${base}-01.jpg`, W: `${base}-02.jpg`, S: `${base}-04.jpg`, N: `${base}-04.jpg`,
  }));
  assert.deepEqual(entries.map((e) => e.id), ['us511-NE-cam-291-N', 'us511-NE-cam-291-E', 'us511-NE-cam-291-W'],
    'a still listed under two directions is one view');
  assert.deepEqual(entries.map((e) => e.headingDeg), [0, 90, 270]);
  assert.deepEqual(entries.map((e) => e.name), ['Allen (North view)', 'Allen (East view)', 'Allen (West view)']);
  assert.ok(entries.every((e) => e.feedType === 'image' && e.p === 'ne511' && e.headingConfidence === 'estimated'));
  assert.equal(road511FeatureId('us511-NE-cam-291-E'), 'NE-cam-291');

  const [single] = rowToEntries(row({
    state_id: 'NE', state_name: 'Nebraska', camera_id: 'NE-cam-9', camera_name: 'Ogallala', primary_url: `${base}-09.jpg`, W: `${base}-09.jpg`,
  }));
  assert.equal(single.id, 'us511-NE-cam-9');
  assert.equal(single.headingDeg, 270);
});

test('the operator comes from the link host, a shared vendor host by state, and else the state DOT', () => {
  assert.equal(providerFor({ state: 'IN', hosts: ['public.carsprogram.org'] }).key, 'indot');
  assert.equal(providerFor({ state: 'MA', hosts: ['public.carsprogram.org'] }).key, 'massdot');
  assert.deepEqual(providerFor({ state: 'WA', hosts: ['assets2.webcam.io'] }), {
    key: 'wsdot', fallback: true, unmapped: ['assets2.webcam.io'],
  });
  assert.deepEqual(providerFor({ state: 'TX', hosts: [] }), { key: 'drivetexas', fallback: true, unmapped: [] });
  assert.equal(providerFor({ state: 'KY', hosts: ['www.trimarc.org'] }).key, 'trimarc');
  assert.deepEqual(providerRecord('fl511'), {
    provider: 'FL511', license: 'Florida Department of Transportation (listing: Road511)',
  });
});

test('names fall back from codes and bare roads; cities come from the name, the township, or the state', () => {
  const entry = (over) => rowToEntries(row(over))[0];
  assert.equal(entry({ camera_name: 'BARR-0032: SR 11 at Star St (BARROW)' }).city, 'Barrow');
  assert.equal(entry({ camera_name: 'I-285 at Ashford Dunwoody Rd (Dunwoody)' }).city, 'Dunwoody');
  assert.equal(entry({ camera_name: 'IH20 @ MRM 12 (EB)', state_name: 'Texas', state_id: 'TX' }).city, 'Texas');
  assert.equal(entry({ camera_name: 'Main / 16th (Lom)' }).city, 'Georgia', 'an abbreviation is not a city');
  assert.equal(entry({ camera_name: 'I-80 (Rest Area)' }).city, 'Georgia');
  assert.equal(entry({ state_id: 'MS', state_name: 'Mississippi', camera_name: 'US 90 at Main St (Bay St. Louis)' }).city, 'Bay St. Louis');
  for (const label of [
    'NORTH OFF', 'View South', 'East End', 'S. Smyrna', 'Mississippi River - IL', 'County Jail', 'Manning Av S', 'near Waltman',
    'Main St', 'Arch St.', 'New York Line', 'Holiday Inn', 'Arthur East',
  ]) {
    assert.equal(entry({ camera_name: `Camera (${label})` }).city, 'Georgia', label);
  }
  assert.equal(entry({ state_id: 'ME', state_name: 'Maine', camera_name: 'I-95 Mile 124 NB (Waterville New)' }).city, 'Waterville');
  assert.equal(entry({ state_id: 'NJ', state_name: 'New Jersey', camera_name: 'I-280 @ Exit 11', camera_details: 'I-280 (East Orange)' }).city,
    'East Orange');
  assert.equal(entry({ state_id: 'NJ', state_name: 'New Jersey', camera_name: 'US 1 @ Ridge Rd', camera_details: 'South Brunswick Township' }).city,
    'South Brunswick Township', 'a compass word inside a town name is part of it');
  assert.equal(entry({ state_id: 'NJ', state_name: 'New Jersey', camera_name: 'I-195 @ CR 537', camera_details: 'Jackson Township' }).city,
    'Jackson Township');

  assert.equal(entry({ state_id: 'UT', camera_name: 'SR-92', road: 'SR-92', location: 'Alpine Loop / SR-92 @ East Toll Booth / MP 22.5, UT' }).name,
    'Alpine Loop / SR-92 @ East Toll Booth / MP 22.5, UT');
  assert.equal(entry({ state_id: 'TX', camera_name: 'IH20 @ MRM 0 (WB)', camera_details: 'IH20 @ IH35E S.W. 3', road: 'IH20' }).name,
    'IH20 @ IH35E S.W. 3 (WB)');
  assert.equal(entry({ state_id: 'VA', camera_name: 'NO0092', road: 'I-66' }).name, 'I-66 (NO0092)');
  assert.equal(entry({ state_id: 'MD', camera_name: '109001', location: 'US 50 AT MD 731 VIENNA TWR', road: 'US-50' }).name,
    'US 50 AT MD 731 VIENNA TWR');
  assert.equal(entry({ state_id: 'NY', camera_name: 'I-490', road: 'I-490', location: 'Traffic closest to the camera is traveling east.' }).name,
    'I-490');
  assert.equal(entry({ state_id: 'CA', camera_name: 'I5-SR273', road: 'I-5' }).name, 'I5-SR273');
  assert.equal(entry({ state_id: 'LA', camera_name: 'I-10', road: 'I-10 at Terrace Ave.' }).name, 'I-10 at Terrace Ave.');
  assert.equal(entry({ state_id: 'NJ', camera_name: '', camera_details: 'Howell Township', road: '' }).name, 'GA-cam-1');
  assert.equal(entry({ state_id: 'NC', camera_name: 'PCCTVSW-050', road: 'Other' }).name, 'PCCTVSW-050');
  assert.equal(entry({ state_id: 'VA', camera_name: '0wyvj6n16r826rz758qn5mf48ogpj1fp', road: 'RT 50' }).name, 'RT 50');
  assert.equal(entry({ state_id: 'AK', camera_name: 'Glenn Hwy & Outer Spring Loop', road: 'Glenn Hwy & OuterSpring Loop' }).name,
    'Glenn Hwy & Outer Spring Loop', 'a road that differs only in spacing leaves the name alone');
});

test('a school named as the place removes the camera; roads named after schools stay', () => {
  assert.deepEqual(schoolHit(row({ camera_name: 'DE 24 @ BEACON MIDDLE SCHOOL' })), {
    field: 'camera_name', text: 'DE 24 @ BEACON MIDDLE SCHOOL',
  });
  assert.equal(schoolHit(row({ camera_name: 'NY 32', location: 'NY 32 at Elementary School Parking Lot' }))?.field, 'location');
  assert.equal(schoolHit(row({ primary_url: 'https://cams.example.edu/quad.jpg' }))?.field, 'primary_url');

  for (const name of [
    'SR-101 @Indian School Rd',
    'I-17 @S of Indian School',
    'I-30 at University Ave.',
    'US 5 at College Hwy',
    'I-5 at MP 227.7: College Way',
    'Johnston at University',
    'US 150 (University) at Cunningham',
  ]) {
    assert.equal(schoolHit(row({ camera_name: name })), null, name);
  }
  assert.equal(schoolHit(row({ camera_name: 'University at Cameron', road: 'University' })), null, 'a bare road column is the road');
  assert.equal(schoolHit(row({ camera_name: 'SR-146 at Dillon School', road: 'SR-146 at Dillon School, D05-013' })), null);
});

test('the pack keeps one camera per line and expands to complete entries', () => {
  const cameras = [
    rowToEntries(row({ state_id: 'FL', state_name: 'Florida', camera_id: 'FL-cam-1', camera_name: 'I-95 at Glades Rd', primary_url: 'https://fl511.com/map/Cctv/1' }))[0],
    rowToEntries(row({ state_id: 'FL', state_name: 'Florida', camera_id: 'FL-cam-2', camera_name: 'I-95 at Yamato Rd', primary_url: 'https://fl511.com/map/Cctv/2' }))[0],
  ];
  const text = formatPack({ providers: { fl511: providerRecord('fl511') }, cameras });
  const lines = text.split('\n');
  assert.equal(lines.filter((line) => line.startsWith('{"id":"us511-')).length, 2);
  const pack = JSON.parse(text);
  assert.equal(pack.format, 'gev-cctv-pack/1');
  assert.deepEqual(pack.defaults, PACK_DEFAULTS);
  const [first] = expandPack(pack);
  assert.equal('p' in first, false);
  assert.equal(first.country, 'US');
  assert.equal(first.region, 'FL');
  assert.equal(first.provider, 'FL511');
  assert.equal(first.license, 'Florida Department of Transportation (listing: Road511)');
  assert.equal(first.pitchDeg, -6);
  assert.equal(first.headingConfidence, 'unknown');
  assert.equal(first.url, 'https://fl511.com/map/Cctv/1');
  assert.deepEqual(expandPack([{ id: 'x' }]), [{ id: 'x' }], 'a plain array passes through');
});

test('the densest circles name distinct areas, busiest first', () => {
  const atlanta = Array.from({ length: 5 }, (_, i) => ({ lat: 33.75 + i * 0.01, lon: -84.39 }));
  const savannah = [{ lat: 32.08, lon: -81.09 }, { lat: 32.09, lon: -81.1 }];
  const far = [{ lat: 34.2, lon: -84.39 }];
  const circles = densestCircles([...savannah, ...atlanta, ...far], { radiusKm: 50, count: 5 });
  assert.deepEqual(circles.map((c) => c.count), [6, 2]);
  assert.ok(circles[0].point.lat < 34, 'centred in Atlanta, where the cameras are');
});

test('camera ids keep their inner spaces: two Vermont ids that differ by one space are two cameras', () => {
  const single = row({ state_id: 'VT', state_name: 'Vermont', camera_id: 'VT-cam-HARTFORD RWIS CCTV', camera_name: 'HARTFORD I-91 North', latitude: '43.62101', longitude: '-72.347842', primary_url: '' });
  const double = row({ state_id: 'VT', state_name: 'Vermont', camera_id: 'VT-cam-HARTFORD  RWIS CCTV', camera_name: 'HARTFORD I-89 South', latitude: '43.662454', longitude: '-72.373582', primary_url: '' });
  const parsed = parseTsv(tsv([{ ...double, camera_id: ` ${double.camera_id} ` }])).rows[0];
  assert.equal(parsed.camera_id, 'VT-cam-HARTFORD  RWIS CCTV', 'only the cell edges are trimmed');

  const { rows, conflicts, identical } = dedupeRows([single, double]);
  assert.equal(rows.length, 2);
  assert.equal(conflicts.length, 0);
  assert.equal(identical, 0);

  const [a] = rowToEntries(single);
  const [b] = rowToEntries(double);
  assert.equal(a.id, 'us511-VT-cam-HARTFORD RWIS CCTV');
  assert.equal(b.id, 'us511-VT-cam-HARTFORD  RWIS CCTV');
  assert.equal(b.name, 'HARTFORD I-89 South');
  assert.equal(road511FeatureId(b.id), 'VT-cam-HARTFORD  RWIS CCTV', 'the lookup asks Road511 for this camera, not its neighbour');

  const flipped = fixCoordinates([single, double, { ...double, camera_id: 'VT-cam-LUDLOW  vt-100', longitude: '72.70565' }]);
  assert.equal(flipped.fixes[0].id, 'VT-cam-LUDLOW  vt-100');
  const far = fixCoordinates([single, double, { ...double, camera_id: 'VT-cam-MENDON MOUNTAIN RWIS CCTV  WEST', latitude: '30' }]);
  assert.equal(far.rejects[0].id, 'VT-cam-MENDON MOUNTAIN RWIS CCTV  WEST');
});

test('school abbreviations and connector-bound institutions remove the camera; Boise crossing roads stay', () => {
  assert.equal(schoolHit(row({ camera_name: 'GWIN-433_538: Spalding Dr at Norcross HS', road: 'Spalding Dr' }))?.field, 'camera_name');
  assert.equal(schoolHit(row({ state_id: 'TX', camera_name: 'SH321', road: 'SH321', camera_details: 'SH321 @ Dayton HS Driveway', primary_url: '' }))?.field,
    'camera_details');
  assert.equal(schoolHit(row({ state_id: 'NY', camera_name: 'I-490', road: 'I-490', location: 'I-490 at Gates HS' }))?.field, 'location');
  assert.equal(schoolHit(row({ state_id: 'TX', camera_name: 'US69', road: 'US69', camera_details: 'US69/287 @ Lumberton Middle', primary_url: '' }))?.field,
    'camera_details');
  assert.equal(schoolHit(row({ camera_name: 'CARR-0201: SR 1 at Prmy Sch Rd (CARROLL)', road: 'SR 1' })), null);

  for (const [id, name, road, cctv] of [
    ['ID-cam-41', 'Broadway University', 'US-20 Broadway', 1074],
    ['ID-cam-42', 'Capitol University', 'Capitol', 1075],
    ['ID-cam-115', 'University Joyce-LL', 'University', 1140],
  ]) {
    const boise = row({ state_id: 'ID', state_name: 'Idaho', camera_id: id, camera_name: name, road, primary_url: `https://511.idaho.gov/map/Cctv/${cctv}` });
    assert.equal(schoolHit(boise), null, name);
    const [entry] = rowToEntries(boise);
    assert.equal(isSchoolCamera(entry), false, `${name}: the server keeps the pack entry too`);
  }
});

test('the build report checks lookup ids with the server lookup rules', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'road511-build-'));
  try {
    const input = path.join(dir, 'listing.tsv');
    const out = path.join(dir, 'pack.json');
    const report = path.join(dir, 'report.txt');
    const vt = (camera_id, camera_name, latitude, longitude) =>
      row({ state_id: 'VT', state_name: 'Vermont', camera_id, camera_name, latitude, longitude, primary_url: '' });
    fs.writeFileSync(input, tsv([
      vt('VT-cam-HARTFORD RWIS CCTV', 'HARTFORD I-91 North', '43.62101', '-72.347842'),
      vt('VT-cam-HARTFORD  RWIS CCTV', 'HARTFORD I-89 South', '43.662454', '-72.373582'),
      row({ state_id: 'ME', state_name: 'Maine', camera_id: 'ME-cam-I-95 Mile 108 NB (Augusta)', camera_name: 'I-95 Mile 108 NB (Augusta)', latitude: '44.3', longitude: '-69.8', primary_url: '' }),
      row({ state_id: 'NH', state_name: 'New Hampshire', camera_id: 'NH-cam-Route 3, Exit 5?', camera_name: 'Route 3 Exit 5', latitude: '42.8', longitude: '-71.5', primary_url: '' }),
    ]));
    const run = spawnSync(process.execPath, [BUILDER, '--input', input, '--out', out, '--report', report], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const ids = expandPack(JSON.parse(fs.readFileSync(out, 'utf8'))).map((camera) => camera.id).sort();
    assert.deepEqual(ids, [
      'us511-ME-cam-I-95 Mile 108 NB (Augusta)',
      'us511-NH-cam-Route 3, Exit 5?',
      'us511-VT-cam-HARTFORD  RWIS CCTV',
      'us511-VT-cam-HARTFORD RWIS CCTV',
    ]);
    const text = fs.readFileSync(report, 'utf8');
    assert.match(text, /Conflicting duplicate ids \(0\)/);
    assert.match(text, /Lookup cameras the Road511 lookup route refuses \(0\)/);
    assert.doesNotMatch(text, /never resolve/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
