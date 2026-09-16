import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cctvSourceFiles, createCctvCatalog, expandCctvPack, mergeCctvSources } from '../../server/providers/cctv/catalog.js';
import { CCTV_SOURCE_STAT_INTERVAL_MS, DEFAULT_CCTV_SOURCE_FILES } from '../../server/providers/cctv/constants.js';
import { cctvStillKey, normalizeFeedType, normalizeSourceItem } from '../../server/providers/cctv/normalize.js';

function tempRoot(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'gev-cctv-index-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const cams = (prefix, count, fields = {}) =>
  Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${i}`, name: `${prefix} ${i}`, lat: 43.6 + i * 1e-4, lon: -79.4, feedType: 'image',
    url: `https://cams.example.org/${prefix}-${i}.jpg`, ...fields,
  }));

test('the catalogue is rebuilt only after a pack file changes, checked at most every 10 s', async (t) => {
  const dir = tempRoot(t);
  const file = path.join(dir, 'pack.json');
  writeFileSync(file, JSON.stringify(cams('on', 3, { country: 'CA', region: 'ON' })));
  let clock = 1_000_000;
  const catalog = createCctvCatalog({ sourceRoot: dir, env: { CCTV_SOURCES_FILE: file, CCTV_COUNTRIES: 'CA' }, now: () => clock });
  const first = await catalog.snapshot();
  assert.equal(first.generation, 1);
  assert.equal(first.total, 3);
  clock += 1000;
  assert.equal(await catalog.snapshot(), first, 'the same snapshot object');

  writeFileSync(file, JSON.stringify(cams('on', 5, { country: 'CA', region: 'ON' })));
  clock += 1000;
  assert.equal((await catalog.snapshot()).generation, 1, 'files are not stat-ed again inside 10 s');
  clock += CCTV_SOURCE_STAT_INTERVAL_MS;
  const second = await catalog.snapshot();
  assert.equal(second.generation, 2);
  assert.equal(second.total, 5);
  clock += CCTV_SOURCE_STAT_INTERVAL_MS;
  assert.equal(await catalog.snapshot(), second, 'an unchanged file is not read again');
  assert.equal(CCTV_SOURCE_STAT_INTERVAL_MS, 10000);
});

test('CCTV_SOURCES_FILE is a comma list of plain arrays and gev-cctv-pack/1 envelopes', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  assert.equal(DEFAULT_CCTV_SOURCE_FILES, 'config/cctv_sources.canada.json,config/cctv_sources.us.json,config/cctv_sources.intl.json');
  assert.deepEqual(cctvSourceFiles({}), ['config/cctv_sources.canada.json', 'config/cctv_sources.us.json', 'config/cctv_sources.intl.json']);
  assert.deepEqual(cctvSourceFiles({ CCTV_SOURCES_FILE: ' a.json , ,b.json' }), ['a.json', 'b.json']);

  const dir = tempRoot(t);
  mkdirSync(path.join(dir, 'config'));
  writeFileSync(path.join(dir, 'config', 'cctv_sources.canada.json'), JSON.stringify(cams('on', 2, { country: 'CA', region: 'ON' })));
  writeFileSync(path.join(dir, 'config', 'cctv_sources.us.json'), JSON.stringify({
    format: 'gev-cctv-pack/1',
    defaults: { country: 'US', sourceKind: 'configured', pitchDeg: -6, fovDeg: 70, rangeM: 500, mountHeightM: 10, headingConfidence: 'unknown' },
    providers: { ga: { provider: 'Georgia DOT', license: 'Georgia DOT (listing: Road511)' } },
    cameras: [
      { id: 'us511-GA-cam-1', name: 'I-75 at 10th', city: 'Atlanta', region: 'GA', lat: 33.78, lon: -84.39, p: 'ga', feedType: 'image', url: 'https://511ga.org/map/Cctv/1', headingDeg: 90, headingConfidence: 'estimated' },
      { id: 'us511-GA-cam-2', name: 'No still', city: 'Atlanta', region: 'GA', lat: 33.79, lon: -84.39, p: 'ga', feedType: 'none', lookup: 'road511', videoUrl: 'https://cams.example.org/2.m3u8' },
      { id: 'us511-GA-cam-3', name: 'Unknown provider key', region: 'GA', lat: 33.8, lon: -84.39, p: 'nope', feedType: 'image', url: 'https://x.example.org/3.jpg' },
    ],
  }));
  const snapshot = await createCctvCatalog({ sourceRoot: dir, env: { CCTV_COUNTRIES: '*' } }).snapshot();
  assert.equal(snapshot.total, 5);
  const one = snapshot.byId.get('us511-GA-cam-1');
  assert.equal(one.provider, 'Georgia DOT');
  assert.equal(one.license, 'Georgia DOT (listing: Road511)');
  assert.equal(one.country, 'US');
  assert.equal(one.pitchDeg, -6);
  assert.equal(one.headingConfidence, 'estimated', 'a camera field beats the defaults');
  assert.equal(one.regionKey, 'US-GA');
  const two = snapshot.byId.get('us511-GA-cam-2');
  assert.equal(two.feedType, 'none');
  assert.equal(two.lookup, 'road511');
  assert.equal(two.url, '');
  assert.equal(two.videoUrl, 'https://cams.example.org/2.m3u8');
  assert.equal(snapshot.byId.get('us511-GA-cam-3').provider, 'Configured CCTV Source');
  assert.equal(snapshot.byId.get('on-0').regionKey, 'CA-ON');

  assert.deepEqual(
    expandCctvPack({ format: 'gev-cctv-pack/1', defaults: { a: 1, b: 1 }, providers: { x: { b: 2, c: 2 } }, cameras: [{ id: 'z', p: 'x', c: 3 }] }),
    [{ a: 1, b: 2, c: 3, id: 'z' }],
  );
  assert.deepEqual(expandCctvPack({ cameras: [{ id: 'bare' }] }), [{ id: 'bare' }], 'an envelope without a format still reads');
  assert.deepEqual(expandCctvPack({ format: 'something-else/9', cameras: [{ id: 'q' }] }), []);
  assert.equal(warn.mock.callCount(), 1);
  assert.deepEqual(expandCctvPack({ nope: true }), []);
  assert.deepEqual(expandCctvPack([{ id: 'plain' }]), [{ id: 'plain' }]);
});

test('missing default packs are skipped quietly', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const snapshot = await createCctvCatalog({ sourceRoot: tempRoot(t), env: {} }).snapshot();
  assert.equal(snapshot.total, 0);
  assert.equal(warn.mock.callCount(), 0);
});

test('the country gate and CCTV_SOURCES_JSON apply without waiting for a file check', async (t) => {
  const dir = tempRoot(t);
  const file = path.join(dir, 'pack.json');
  writeFileSync(file, JSON.stringify([
    ...cams('ca', 2, { country: 'CA' }),
    ...cams('us', 3, { country: 'USA', region: 'Texas', lat: 29.76, lon: -95.37 }),
    ...cams('unclassified', 1),
  ]));
  const env = { CCTV_SOURCES_FILE: file, CCTV_COUNTRIES: 'CA' };
  const catalog = createCctvCatalog({ sourceRoot: dir, env, now: () => 0 });
  assert.deepEqual((await catalog.snapshot()).sources.map((s) => s.id).sort(), ['ca-0', 'ca-1', 'unclassified-0']);
  env.CCTV_COUNTRIES = 'CA,US';
  let snapshot = await catalog.snapshot();
  assert.equal(snapshot.total, 6);
  assert.equal(snapshot.byId.get('us-0').regionKey, 'US-TX');
  env.CCTV_SOURCES_JSON = JSON.stringify([{ id: 'inline', lat: 1, lon: 2, country: 'CA' }]);
  snapshot = await catalog.snapshot();
  assert.ok(snapshot.byId.has('inline'));
  env.CCTV_COUNTRIES = '';
  assert.deepEqual((await catalog.snapshot()).sources.map((s) => s.id), ['unclassified-0'], 'explicitly empty serves only unclassified cameras');
});

test('every camera is kept: 6,000 in one state and 5,200 in one country, no cap', async (t) => {
  const dir = tempRoot(t);
  const file = path.join(dir, 'pack.json');
  writeFileSync(file, JSON.stringify([
    ...cams('tx', 6000, { country: 'US', region: 'TX', lat: 29.76, lon: -95.37 }),
    ...cams('ca', 5200, { country: 'CA', region: 'ON' }),
  ]));
  const snapshot = await createCctvCatalog({ sourceRoot: dir, env: { CCTV_SOURCES_FILE: file, CCTV_COUNTRIES: '*' } }).snapshot();
  assert.equal(snapshot.total, 11200);
  assert.equal(snapshot.byId.size, 11200);
  let indexed = 0;
  for (const bucket of snapshot.grid.values()) indexed += bucket.length;
  assert.equal(indexed, 11200);
});

test('a pack caught mid-write keeps the previous catalogue until it is fixed', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const dir = tempRoot(t);
  const file = path.join(dir, 'pack.json');
  writeFileSync(file, JSON.stringify(cams('on', 3, { country: 'CA' })));
  let clock = 0;
  const catalog = createCctvCatalog({ sourceRoot: dir, env: { CCTV_SOURCES_FILE: file, CCTV_COUNTRIES: 'CA' }, now: () => clock });
  const good = await catalog.snapshot();
  writeFileSync(file, '[{"id": "on-0", "na');
  clock += CCTV_SOURCE_STAT_INTERVAL_MS;
  assert.equal(await catalog.snapshot(), good);
  assert.equal(warn.mock.callCount(), 1);
  clock += CCTV_SOURCE_STAT_INTERVAL_MS;
  assert.equal(await catalog.snapshot(), good);
  assert.equal(warn.mock.callCount(), 1, 'the same broken file is not re-read');
  writeFileSync(file, JSON.stringify(cams('on', 4, { country: 'CA' })));
  clock += CCTV_SOURCE_STAT_INTERVAL_MS;
  const fixed = await catalog.snapshot();
  assert.equal(fixed.total, 4);
  assert.equal(fixed.generation, 2);
});

test('none is a canonical feed type, and lookup and videoUrl pass through', () => {
  assert.equal(normalizeFeedType('none'), 'none');
  assert.equal(normalizeFeedType(' NONE '), 'none');
  assert.equal(normalizeFeedType(''), 'image');
  const entry = normalizeSourceItem({ id: 'x', feedType: 'none', lookup: 'road511', videoUrl: 'https://a.example.org/x.m3u8' });
  assert.equal(entry.feedType, 'none');
  assert.equal(entry.lookup, 'road511');
  assert.equal(entry.videoUrl, 'https://a.example.org/x.m3u8');
  assert.equal(normalizeSourceItem({ id: 'y', lookup: 'someone-else' }).lookup, '');
  assert.equal(normalizeSourceItem({ id: 'y', videoUrl: 42 }).videoUrl, '');
});

test('a live TfL still replaces a file copy of the same JamCam', () => {
  const still = 'https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/00001.01251.jpg';
  const file = normalizeSourceItem({
    id: 'intl-GB-cam-00001.01251',
    name: 'Old Street',
    url: still,
    feedType: 'image',
    country: 'GB',
    headingConfidence: 'unknown',
  });
  const live = normalizeSourceItem({
    id: 'tfl-00001.01251',
    name: 'Old Street',
    url: still,
    snapshotUrl: still,
    feedType: 'image',
    country: 'GB',
    headingDeg: 22.5,
    headingConfidence: 'low',
    sourceKind: 'tfl-open-data',
  });
  const merged = mergeCctvSources([{ sources: [file] }, { sources: [live], live: true }]);
  assert.equal(merged.sources.length, 1);
  assert.equal(merged.sources[0].id, 'tfl-00001.01251');
  assert.equal(merged.duplicateStills, 1);
  assert.equal(merged.liveStillReplacements, 1);
});

test('cctvStillKey ignores cache busters, default ports, and Windy preview vs full', () => {
  assert.equal(
    cctvStillKey('https://imgproxy.windy.com/_/preview/plain/current/1755128434/original.jpg?v=2'),
    'windy:1755128434',
  );
  assert.equal(
    cctvStillKey('https://imgproxy.windy.com/_/full/plain/current/1755128434/original.jpg'),
    'windy:1755128434',
  );
  assert.equal(
    cctvStillKey('https://cams.example.org:443/a.jpg?v=2&t=9'),
    'https://cams.example.org/a.jpg',
  );
  assert.notEqual(
    cctvStillKey('https://cams.example.org/a.jpg?v=abc'),
    cctvStillKey('https://cams.example.org/a.jpg'),
    'a non-numeric v= is a video id, not a cache buster',
  );
});

test('still dedupe keys the fetched still, not a shared page URL', () => {
  const merged = mergeCctvSources([
    {
      sources: [
        normalizeSourceItem({
          id: 'a',
          snapshotUrl: 'https://cams.example.org/a.jpg',
          url: 'https://cams.example.org/player',
          feedType: 'image',
        }),
        normalizeSourceItem({
          id: 'b',
          snapshotUrl: 'https://cams.example.org/b.jpg',
          url: 'https://cams.example.org/player',
          feedType: 'image',
        }),
      ],
    },
  ]);
  assert.deepEqual(merged.sources.map((source) => source.id).sort(), ['a', 'b']);
  assert.equal(merged.duplicateStills, 0);
});
