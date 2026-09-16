import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { providerKeyForSource, providerRecord } from '../../tools/camera-pack/intl-providers.mjs';
import {
  ID_PREFIX,
  PACK_DEFAULTS,
  collapseWindyRows,
  countryOf,
  dedupeRows,
  expandPack,
  fixCoordinates,
  formatPack,
  packHeading,
  parseTsv,
  rowToEntries,
  schoolHit,
  windyWebcamId,
} from '../../tools/camera-pack/intl-tsv.mjs';

const BUILDER = fileURLToPath(new URL('../../tools/camera-pack/build-intl.mjs', import.meta.url));

const COLUMNS = [
  'state_id', 'state_name', 'camera_id', 'camera_name', 'location', 'road', 'latitude', 'longitude', 'direction',
  'camera_details', 'primary_url', 'video_url', 'N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW', 'number_of_views',
  'active', 'last_updated', 'source',
];

const row = (over = {}) => ({
  ...Object.fromEntries(COLUMNS.map((column) => [column, ''])),
  state_id: 'IT',
  state_name: 'Italy',
  camera_id: 'IT-cam-1',
  camera_name: 'Piazza del Duomo',
  latitude: '45.4642',
  longitude: '9.1900',
  primary_url: 'https://cams.example.org/milan.jpg',
  active: 'true',
  source: 'WebcamGalore',
  ...over,
});

const tsv = (rows, columns = COLUMNS) =>
  [columns.join('\t'), ...rows.map((r) => columns.map((column) => r[column] ?? '').join('\t'))].join('\r\n');

test('columns are read by header name in any order, with the BOM and CRLF stripped', () => {
  const columns = [...COLUMNS].reverse();
  const { rows } = parseTsv(`${String.fromCharCode(0xfeff)}${tsv([row(), row({ camera_id: 'IT-cam-2' })], columns)}\r\n`);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].camera_id, 'IT-cam-1');
  assert.equal(rows[0].source, 'WebcamGalore', 'the last column carries no \\r');
  assert.throws(() => parseTsv('state_id\tlatitude\n'), /camera_id/);
});

test('identical rows drop silently; a conflicting duplicate id keeps the first', () => {
  const first = row();
  const { rows, identical, conflicts, missingId } = dedupeRows([
    first,
    { ...first },
    row({ camera_name: 'Something else' }),
    row({ camera_id: '' }),
    row({ camera_id: 'IT-cam-2' }),
  ]);
  assert.deepEqual(rows.map((r) => r.camera_id), ['IT-cam-1', 'IT-cam-2']);
  assert.equal(identical, 1);
  assert.equal(conflicts.length, 1);
  assert.equal(missingId.length, 1);
});

test('AU-NSW is Australia; XX and INT are unclassified', () => {
  assert.deepEqual(countryOf('AU-NSW'), { country: 'AU', region: 'NSW' });
  assert.deepEqual(countryOf('GB-ENG'), { country: 'GB', region: 'ENG' });
  assert.deepEqual(countryOf('DE'), { country: 'DE', region: '' });
  assert.deepEqual(countryOf('XX'), { country: '', region: '' });
  assert.deepEqual(countryOf('??'), { country: '', region: '' });
  assert.deepEqual(countryOf('INT'), { country: '', region: '' });
  assert.deepEqual(countryOf('xk'), { country: 'XK', region: '' });
});

test('one Windy webcam id is kept, preferring a classified country over XX', () => {
  const a = row({
    state_id: 'XX',
    camera_id: 'WINDY-cam-1755128434',
    source: 'Windy-public-list',
    primary_url: 'https://imgproxy.windy.com/_/preview/plain/current/1755128434/original.jpg?v=2',
  });
  const b = row({
    state_id: 'IT',
    camera_id: 'IT-windy-1755128434',
    source: 'Windy',
    primary_url: 'https://imgproxy.windy.com/_/preview/plain/current/1755128434/original.jpg',
  });
  assert.equal(windyWebcamId(a), '1755128434');
  assert.equal(windyWebcamId(b), '1755128434');
  const { rows, collapsed } = collapseWindyRows([a, b]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].camera_id, 'IT-windy-1755128434');
  assert.equal(collapsed.length, 1);
});

test('missing, out-of-range and 0,0 coordinates are rejected; east longitudes stay', () => {
  const { rows, rejects } = fixCoordinates([
    row(),
    row({ camera_id: 'JP-cam-1', latitude: '35.6', longitude: '139.7' }),
    row({ camera_id: 'none', latitude: '', longitude: '' }),
    row({ camera_id: 'zero', latitude: '0', longitude: '0' }),
    row({ camera_id: 'oor', latitude: '95', longitude: '10' }),
  ]);
  assert.deepEqual(rows.map((r) => r.camera_id).sort(), ['IT-cam-1', 'JP-cam-1']);
  assert.equal(rows.find((r) => r.camera_id === 'JP-cam-1').lon, 139.7);
  assert.deepEqual(rejects.map((r) => r.id).sort(), ['none', 'oor', 'zero']);
});

test('a compass label or a numeric degree is an estimated heading', () => {
  assert.deepEqual(packHeading('N'), { headingDeg: 0, headingConfidence: 'estimated' });
  assert.deepEqual(packHeading('180'), { headingDeg: 180, headingConfidence: 'estimated' });
  assert.deepEqual(packHeading(''), { headingDeg: null, headingConfidence: 'unknown' });
  assert.deepEqual(packHeading('IN'), { headingDeg: null, headingConfidence: 'unknown' });
});

test('YouTube embeds are skipped; timestamped stills become none; XX omits country', () => {
  assert.deepEqual(rowToEntries(row({ primary_url: 'https://i.ytimg.com/vi/abc/hqdefault.jpg' })), []);
  const rotten = rowToEntries(row({
    camera_id: 'SG-lta-1',
    state_id: 'SG',
    primary_url: 'https://images.data.gov.sg/api/traffic-images/2026/09/22a7bca1.jpg',
  }))[0];
  assert.equal(rotten.feedType, 'none');
  assert.equal(rotten.url, undefined);
  const unknown = rowToEntries(row({ state_id: 'XX', camera_id: 'XX-cam-1' }))[0];
  assert.equal(unknown.country, undefined);
  assert.equal(unknown.id, `${ID_PREFIX}XX-cam-1`);
  const au = rowToEntries(row({ state_id: 'AU-NSW', camera_id: 'AU-NSW-cam-1', latitude: '-33.8', longitude: '151.2' }))[0];
  assert.equal(au.country, 'AU');
  assert.equal(au.region, 'NSW');
});

test('TfL and OSM licenses name the required attribution', () => {
  assert.equal(providerKeyForSource('TfL JamCams'), 'tfl');
  assert.match(providerRecord('tfl').license, /Powered by TfL Open Data/);
  assert.equal(providerKeyForSource('OSM-contact:webcam'), 'osm');
  assert.match(providerRecord('osm').license, /OpenStreetMap contributors/);
  assert.equal(providerKeyForSource('Windy/ski'), 'windy');
});

test('a school named as the place is removed; a university avenue stays', () => {
  assert.equal(schoolHit(row({ camera_name: 'Universidad de Buenos Aires' }))?.field, 'camera_name');
  assert.equal(schoolHit(row({ camera_name: 'Aspen Ski School' }))?.field, 'camera_name');
  assert.equal(schoolHit(row({ camera_name: 'University Avenue' })), null);
});

test('the builder writes a compact pack and a report with no network access', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intl-build-'));
  try {
    const input = path.join(dir, 'listing.tsv');
    const out = path.join(dir, 'pack.json');
    const report = path.join(dir, 'report.txt');
    fs.writeFileSync(input, tsv([
      row(),
      row({
        camera_id: 'WINDY-cam-1',
        source: 'Windy',
        primary_url: 'https://imgproxy.windy.com/_/preview/plain/current/1/original.jpg',
      }),
      row({
        camera_id: 'WINDY-pub-1',
        state_id: 'XX',
        source: 'Windy-public-list',
        primary_url: 'https://imgproxy.windy.com/_/preview/plain/current/1/original.jpg?v=2',
      }),
      row({ camera_id: 'school-1', camera_name: 'Scuola elementare' }),
      row({ camera_id: 'yt-1', primary_url: 'https://www.youtube.com/watch?v=abc' }),
    ]));
    const run = spawnSync(process.execPath, [BUILDER, '--input', input, '--out', out, '--report', report], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    const pack = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(pack.format, 'gev-cctv-pack/1');
    assert.deepEqual(pack.defaults, PACK_DEFAULTS);
    const cameras = expandPack(pack);
    assert.deepEqual(cameras.map((camera) => camera.id).sort(), [`${ID_PREFIX}IT-cam-1`, `${ID_PREFIX}WINDY-cam-1`]);
    assert.equal(cameras.find((camera) => camera.id.endsWith('IT-cam-1')).provider, 'WebcamGalore');
    assert.equal('p' in cameras.find((camera) => camera.id.endsWith('IT-cam-1')), false);
    const text = fs.readFileSync(report, 'utf8');
    assert.match(text, /Windy webcam-id copies/);
    assert.match(text, /school cameras removed/);
    assert.match(text, /YouTube\/Vimeo embeds removed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
