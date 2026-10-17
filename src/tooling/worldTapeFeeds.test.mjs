import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { REGISTERED_LAYER_IDS } from '../data/layerState.js';
import { encodeCoverageTile } from '../layers/streetLevel/providers/mapillary/coverageFixture.mjs';
import { latToTileY, lonToTileX } from '../layers/streetLevel/tileMath.js';
import { createToolServices } from '../tools/services.js';
import { createTapeStore } from '../../server/shared/worldTapeStore.mjs';
import { createRecorder } from '../../server/shared/worldTapeRecorder.mjs';
import {
  WORLD_TAPE_FEEDS,
  feedMap,
} from '../../server/shared/worldTape/catalog.mjs';
import {
  CCTV_AREA_CAP,
  CCTV_HOST_SHARE,
  CCTV_PERIOD_MS,
  CCTV_RADIUS_KM,
  cctvHostKey,
} from '../../server/shared/worldTape/feeds/cctv.mjs';
import { IMAGE_SEARCHES_PER_AREA_DAY } from '../../server/shared/worldTape/feeds/street-level.mjs';
import { normalizeImagesBbox } from '../../server/providers/mapillary/images.js';
import {
  MILITARY_LIST_MAX_AGE_MS,
  haversineKm,
  noteFlightHexes,
  resetMilitaryList,
  weatherWindow,
} from '../../server/shared/worldTape/feeds/_util.mjs';

const T0 = Date.UTC(2026, 9, 13, 18, 5);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const CLASSES = ['open', 'nc', 'restricted', 'unclear', 'personal', 'static'];
const AUSTIN = { lat: 30.2672, lon: -97.7431, name: 'Austin' };
const PARIS = { lat: 48.8566, lon: 2.3522, name: 'Paris' };

const feeds = feedMap();
function feed(id) {
  const adapter = feeds.get(id);
  assert.ok(adapter, `the catalog has ${id}`);
  return adapter;
}

/**
 * Each layer's own refresh, from its module (or, where stricter, its source's
 * documented limit): a feed never polls faster than this.
 */
const LAYER_REFRESH_MS = {
  earthquakes: 60_000, // src/layers/earthquakes/index.js
  transit: 15_000, // src/layers/transit/policy.js TRANSIT_POLL_MS
  flights: 30_000, // src/layers/flights/queries.js
  military: 15_000, // src/layers/military/queries.js
  'weather-radar': 120_000, // src/layers/weather/index.js
  'weather-satellite': 120_000,
  'weather-lightning': 600_000,
  wind: 3_600_000, // src/layers/wind/index.js
  'weather-cyclones': 300_000, // src/layers/cyclones/index.js
  'local-firms': 1_800_000, // the FIRMS proxy refreshes every 30 minutes
  'fire-perimeters': 300_000, // src/layers/perimeters/index.js
  satellites: 300_000, // src/layers/satellites/controls.js refreshInterval
  'rocket-launches': 900_000, // LL2: 15 calls an hour (the layer polls 5 min)
  bikeshare: 60_000, // src/layers/bikeshare/policy.js STATUS_POLL_MS
  radio: 2_700_000, // src/layers/radio/controls.js
  'recent-imagery': DAY, // asked once a day an area
  'ais-live-vessels': 60_000, // src/layers/vessels/policy.js REFRESH_MS
  traffic: 120_000, // the TomTom proxy's tile cache
  cctv: 10_000, // src/layers/cctv/policy.js (each camera: 15 min, below)
  'street-level': DAY, // coverage tiles are cached a day
  news: 300_000, // the regional brief's cache
  'local-adsb': 1_000, // src/layers/localAdsb/feeds.js
  'device-feeds': 5_000, // src/data/deviceFeeds.js DEVICE_FEEDS_POLL_MS
  'private-cctv': 60_000, // src/data/privateCctv.js
  'flight-enrichment': 30_000, // the flights layer's own pace
  // Feeds with no layer of their own: their source's own publishing pace.
  'sea-surface-temperature': DAY, // MODIS Aqua L3 SST is a daily product
  'observed-weather': 900_000, // Open-Meteo current values update every 15 min
  'cctv-video': 300_000, // one keyframe per camera, no faster than the layer's stills
  'news-urls': 300_000, // the regional brief's cache
  markets: 300_000, // Twelve Data 8 credits a minute; quotes kept 5 min
  'air-quality': 3_600_000, // Open-Meteo / CAMS air quality is hourly
  'stream-gauges': 900_000, // USGS instantaneous values every 15 min
};

/** The app's military list, empty unless a test names aircraft. */
const NO_MILITARY = { getIdentities: async () => [] };

function context(overrides = {}) {
  const { services = {}, ...rest } = overrides;
  return {
    fetch: undefined,
    areas: [],
    state: {},
    now: () => T0,
    log: () => {},
    ...rest,
    services: { military: NO_MILITARY, ...services },
  };
}

/** A fetch Response stand-in. */
function response({ status = 200, headers = {}, json, bytes } = {}) {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key.toLowerCase(),
      String(value),
    ]),
  );
  const body = bytes ?? new Uint8Array();
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => lower[name.toLowerCase()] ?? null },
    body: { cancel: async () => {} },
    async json() {
      return json;
    },
    async arrayBuffer() {
      return body.buffer.slice(
        body.byteOffset,
        body.byteOffset + body.byteLength,
      );
    },
  };
}

/** The documented fields are there, and nothing claims the store's own. */
function assertFields(record, fields) {
  for (const field of fields)
    assert.ok(Object.hasOwn(record, field), `has ${field}`);
  for (const reserved of ['t', 'feed'])
    assert.equal(Object.hasOwn(record, reserved), false, `no ${reserved}`);
}

const recordsOf = (result) => result?.records ?? [];
const filesOf = (result) => result?.files ?? [];

test('every adapter: a licence class, a known layer, and no faster than its layer', () => {
  const known = new Set([...REGISTERED_LAYER_IDS, 'local-adsb']);
  const ids = WORLD_TAPE_FEEDS.map((adapter) => adapter.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  for (const adapter of WORLD_TAPE_FEEDS) {
    const { id } = adapter;
    assert.ok(CLASSES.includes(adapter.class), id);
    assert.ok(
      typeof adapter.licence === 'string' && adapter.licence.length > 10,
      id,
    );
    assert.ok(['feed', 'static'].includes(adapter.kind), id);
    assert.ok([1, 2].includes(adapter.phase), id);
    assert.ok(adapter.label, id);
    assert.ok(adapter.bytesPerDay > 0, id);
    assert.equal(typeof adapter.poll, 'function', id);
    assert.ok(Array.isArray(adapter.layers), id);
    for (const layer of adapter.layers)
      assert.ok(known.has(layer), `${id} names layer ${layer}`);
    if (known.has(id)) assert.ok(adapter.layers.includes(id), id);
    const floor = adapter.kind === 'static' ? DAY : LAYER_REFRESH_MS[id];
    assert.ok(Number.isFinite(floor), `${id}: its layer's refresh is known`);
    assert.ok(adapter.cadenceMs >= floor, `${id} polls no faster than that`);
  }
  // Every layer with a source of its own is recorded.
  // gnss-integrity (upstream, merged 2026-10-17) has no feed yet: the tab
  // lists it as STATIC until one records it.
  const skipped = [
    'directions',
    'military-awareness',
    'outbreak',
    'gnss-integrity',
  ];
  for (const layer of REGISTERED_LAYER_IDS)
    if (!skipped.includes(layer)) assert.ok(ids.includes(layer), layer);
  // The owner's classes.
  const classOf = (id) => feed(id).class;
  assert.equal(classOf('flights'), 'nc');
  assert.equal(classOf('military'), 'open');
  assert.equal(classOf('ais-live-vessels'), 'unclear');
  assert.equal(classOf('traffic'), 'restricted');
  assert.equal(classOf('cctv'), 'unclear');
  assert.equal(classOf('street-level'), 'open');
  assert.match(feed('street-level').licence, /share-alike/i);
  assert.equal(classOf('flight-enrichment'), 'restricted');
  assert.equal(classOf('telegeography-submarine-cables'), 'nc');
  assert.equal(classOf('bhote-koshi-2026'), 'nc');
  assert.equal(classOf('bhote-koshi-locator'), 'nc');
  for (const id of ['local-adsb', 'device-feeds', 'private-cctv'])
    assert.equal(classOf(id), 'personal');
  assert.match(feed('radio').licence, /never audio/i);
});

test('flights: the worldwide snapshot once, adsb.lol rows open, a stale copy holds the feed back', async () => {
  const calls = [];
  let snapshot = {
    source: 'OpenSky Network',
    observedAtMs: T0 - 4000,
    stale: false,
    records: [
      {
        id: 'a1b2c3',
        callsign: 'UAL1',
        latitude: 30.1234567,
        longitude: -97.7654321,
        baroAltitudeM: 10668.4,
        onGround: false,
        speedMps: 230.46,
        courseDeg: 271.6,
        verticalRateMps: -1.27,
        positionTimeMs: T0 - 5000,
        originCountry: 'United States',
      },
      { id: 'nopos', latitude: null, longitude: 2 },
    ],
  };
  const services = {
    aircraft: {
      getSnapshot: async (query) => {
        calls.push(query);
        return snapshot;
      },
    },
  };
  const state = {};
  let t = T0;
  const poll = () =>
    feed('flights').poll(
      context({ services, state, areas: [AUSTIN], now: () => t }),
    );
  const first = await poll();
  assert.deepEqual(calls[0], { latitude: AUSTIN.lat, longitude: AUSTIN.lon });
  assert.equal(recordsOf(first).length, 1);
  const [plane] = first.records;
  assertFields(plane, [
    'hex',
    'callsign',
    'lat',
    'lon',
    'alt',
    'speed',
    'track',
    'vrate',
    'ground',
    'source',
  ]);
  assert.deepEqual(
    [plane.hex, plane.lat, plane.alt, plane.speed, plane.track, plane.source],
    ['a1b2c3', 30.12346, 10668, 230.5, 272, 'opensky'],
  );
  assert.equal(plane.class, undefined, 'OpenSky rows take the feed class');
  t += 5 * MINUTE;
  assert.equal(recordsOf(await poll()).length, 0, 'the same snapshot once');
  snapshot = { ...snapshot, source: 'adsb.lol', observedAtMs: T0 + MINUTE };
  const fallback = await poll();
  assert.equal(fallback.records[0].source, 'adsb.lol');
  assert.equal(fallback.records[0].class, 'open');
  t += 5 * MINUTE;
  snapshot = { ...snapshot, stale: true, observedAtMs: T0 - HOUR };
  assert.deepEqual(await poll(), {});
  snapshot = { ...snapshot, stale: false, observedAtMs: T0 + 10 * MINUTE };
  t += 5 * MINUTE;
  const asked = calls.length;
  assert.deepEqual(await poll(), {}, 'held back after a stale copy');
  assert.equal(calls.length, asked, 'nothing asked while held back');
  t += 15 * MINUTE;
  assert.equal(recordsOf(await poll()).length, 1);
});

test('flights: anonymous OpenSky is recorded once an hour; OpenSky rows carry the auth mode', async () => {
  let asked = 0;
  let snapshot = {
    source: 'OpenSky Network',
    observedAtMs: T0 - 3000,
    stale: false,
    authModeUsed: 'anon',
    records: [{ id: 'a1b2c3', latitude: 30.1, longitude: -97.7 }],
  };
  const services = {
    aircraft: {
      getSnapshot: async () => {
        asked += 1;
        return snapshot;
      },
    },
  };
  const state = {};
  let t = T0;
  const poll = () =>
    feed('flights').poll(context({ services, state, now: () => t }));
  const first = await poll();
  assert.equal(first.records[0].auth, 'anon');
  for (const minutes of [5, 30, 55]) {
    t = T0 + minutes * MINUTE;
    assert.deepEqual(await poll(), {}, `held at ${minutes} minutes`);
  }
  assert.equal(asked, 1, 'nothing asked within the hour');
  t = T0 + HOUR;
  snapshot = { ...snapshot, observedAtMs: t - 3000 };
  assert.equal(recordsOf(await poll()).length, 1);
  // A stale anonymous copy holds the feed back for the hour, not 15 minutes.
  t = T0 + 2 * HOUR;
  snapshot = { ...snapshot, stale: true };
  assert.deepEqual(await poll(), {});
  t += 20 * MINUTE;
  assert.deepEqual(await poll(), {});
  assert.equal(asked, 3);
  // Signed in: every 5 minutes, as before.
  t = T0 + 3 * HOUR;
  snapshot = { ...snapshot, stale: false, authModeUsed: 'oauth' };
  snapshot.observedAtMs = t;
  assert.equal((await poll()).records[0].auth, 'oauth');
  t += 5 * MINUTE;
  snapshot = { ...snapshot, observedAtMs: t };
  assert.equal(recordsOf(await poll()).length, 1, 'not held');
  // The adsb.lol fallback is no OpenSky mode, and is not held either.
  t += 5 * MINUTE;
  snapshot = {
    ...snapshot,
    source: 'adsb.lol',
    authModeUsed: 'adsblol-regional',
    observedAtMs: t,
  };
  const fallback = await poll();
  assert.equal(fallback.records[0].source, 'adsb.lol');
  assert.equal(Object.hasOwn(fallback.records[0], 'auth'), false);
  t += 5 * MINUTE;
  snapshot = { ...snapshot, observedAtMs: t };
  assert.equal(recordsOf(await poll()).length, 1);
  // A proxy that names no mode: no field, no hold.
  t += 5 * MINUTE;
  const { authModeUsed, ...silent } = snapshot;
  assert.equal(authModeUsed, 'adsblol-regional');
  snapshot = { ...silent, source: 'OpenSky Network', observedAtMs: t };
  const unnamed = await poll();
  assert.equal(Object.hasOwn(unnamed.records[0], 'auth'), false);
  assert.ok(!(state.holdUntil > t));
});

test('military: the adsb.lol snapshot mapped, the proxy cache recorded once', async () => {
  let snapshot = {
    observedAtMs: T0 - 3000,
    stale: false,
    records: [
      {
        id: 'ae1234',
        callsign: 'RCH123',
        typeCode: 'C17',
        registration: '05-5140',
        latitude: 36.5,
        longitude: -76.2,
        baroAltitudeM: 7315.2,
        speedMps: 220.1,
        courseDeg: 45.2,
        onGround: false,
      },
    ],
  };
  const services = { military: { getSnapshot: async () => snapshot } };
  const state = {};
  const first = await feed('military').poll(context({ services, state }));
  assertFields(first.records[0], [
    'hex',
    'callsign',
    'type',
    'lat',
    'lon',
    'alt',
    'speed',
    'track',
  ]);
  assert.equal(first.records[0].type, 'C17');
  snapshot = { ...snapshot, observedAtMs: T0 - 2500 };
  assert.equal(
    recordsOf(await feed('military').poll(context({ services, state }))).length,
    0,
    'the same cached body',
  );
  snapshot = { ...snapshot, observedAtMs: T0 + 30_000 };
  assert.equal(
    recordsOf(await feed('military').poll(context({ services, state }))).length,
    1,
  );
  snapshot = { ...snapshot, stale: true, observedAtMs: T0 + 60_000 };
  assert.deepEqual(
    await feed('military').poll(context({ services, state })),
    {},
  );
});

function fakeWeather() {
  const manifest = {
    latest: '2026-10-13T18:00:00.000Z',
    bounds: { west: -130, south: 20, east: -60, north: 55 },
    unavailable: false,
  };
  const images = [];
  return {
    manifest,
    images,
    service: {
      async getSnapshot({ product }) {
        return { schemaVersion: 1, product, ...manifest };
      },
      async getImage(args) {
        images.push(args);
        return {
          contentType: 'image/png',
          bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, images.length]),
        };
      },
    },
  };
}

test('weather rasters: the whole extent and a window per area inside it, each observation once', async () => {
  const weather = fakeWeather();
  const services = { weatherMaps: weather.service };
  const state = {};
  const ctx = () => context({ services, state, areas: [AUSTIN, PARIS] });
  const first = await feed('weather-radar').poll(ctx());
  assert.equal(
    filesOf(first).length,
    2,
    'the extent and Austin (Paris is outside)',
  );
  const [extent, window] = first.files;
  assertFields(extent.record, ['layer', 'time', 'bbox', 'product']);
  assert.equal(extent.record.layer, 'weather-radar');
  assert.equal(extent.record.time, weather.manifest.latest);
  assert.deepEqual(extent.record.bbox, [-130, 20, -60, 55]);
  assert.match(extent.name, /^radar-20261013T180000\.png$/);
  assert.equal(window.record.area, 'Austin');
  assert.deepEqual(weather.images[0], {
    product: 'radar',
    time: weather.manifest.latest,
    size: { width: 2048, height: 1024 },
    bbox: null,
    signal: undefined,
  });
  const box = weather.images[1].bbox;
  assert.equal(box.east - box.west, 2 * (box.north - box.south), '2:1');
  for (const edge of Object.values(box))
    assert.equal(Math.abs(edge % 0.25), 0, '0.25° steps');
  assert.ok(box.west <= AUSTIN.lon && AUSTIN.lon <= box.east);
  assert.ok(box.south <= AUSTIN.lat && AUSTIN.lat <= box.north);
  assert.equal(filesOf(await feed('weather-radar').poll(ctx())).length, 0);
  weather.manifest.latest = '2026-10-13T18:15:00.000Z';
  assert.equal(filesOf(await feed('weather-radar').poll(ctx())).length, 2);

  // Satellite: GOES regional with windows, the global mosaic whole only.
  const sat = fakeWeather();
  const satellite = await feed('weather-satellite').poll(
    context({ services: { weatherMaps: sat.service }, areas: [AUSTIN] }),
  );
  assert.deepEqual(
    satellite.files.map((file) => [file.record.product, file.record.area]),
    [
      ['clouds-regional', null],
      ['clouds-regional', 'Austin'],
      ['clouds', null],
    ],
  );

  // A product that is down is the feed's error.
  const down = fakeWeather();
  down.manifest.unavailable = true;
  await assert.rejects(
    feed('weather-lightning').poll(
      context({ services: { weatherMaps: down.service } }),
    ),
    /unavailable/i,
  );
  // An area outside the product, or a window that cannot fit, has none.
  assert.equal(
    weatherWindow(PARIS, { west: -130, south: 20, east: -60, north: 55 }),
    null,
  );
});

test('wind: int16 grids with scale and offset, each cycle step and field once', async () => {
  const grid = { nx: 4, ny: 3, lo1: 0, la1: 90, dx: 90, dy: 90 };
  const values = (seed) =>
    Float32Array.from({ length: 12 }, (_, i) => Math.sin(i + seed) * 20);
  const pressure = Float32Array.from({ length: 12 }, (_, i) => 990 + i * 2.5);
  const humidity = Float32Array.from(
    { length: 12 },
    (_, i) => 0.002 + i * 0.0015,
  );
  const rate = Float32Array.from({ length: 12 }, (_, i) => (i % 4) * 1.25);
  const scalars = {
    temperature: { units: '°C', level: '2 m above ground', values: values(3) },
    pressure: { units: 'hPa', level: 'mean sea level', values: pressure },
    humidity: { units: 'kg/kg', level: '2 m above ground', values: humidity },
    precipitation: {
      units: 'mm/h',
      level: 'surface',
      window: { fromHour: 0, toHour: 6 },
      values: rate,
    },
  };
  let ifsUp = false;
  const services = {
    wind: {
      async getSnapshot({ model, overlay }) {
        if (model === 'ifs' && !ifsUp)
          return {
            model,
            unavailable: true,
            reason: 'Wind upstream unavailable',
          };
        // IFS has no 2 m specific humidity or precipitation rate: wind alone.
        const windOnly =
          model === 'ifs' && ['humidity', 'precipitation'].includes(overlay);
        return {
          model,
          overlay,
          cycle: {
            date: '20261013',
            hour: 12,
            forecastHour: 6,
            runIso: '2026-10-13T12:00:00.000Z',
            validIso: '2026-10-13T18:00:00.000Z',
          },
          level: '10 m above ground',
          units: 'm/s',
          grid,
          u: values(1),
          v: values(2),
          ...(windOnly
            ? { scalarError: `${overlay} field unavailable` }
            : { scalar: { kind: overlay, ...scalars[overlay] } }),
        };
      },
    },
  };
  const state = {};
  const first = await feed('wind').poll(context({ services, state }));
  assert.deepEqual(
    first.files.map((file) => file.record.var),
    ['u10', 'v10', 't2m', 'msl', 'q2m', 'prate'],
  );
  const sources = {
    u10: values(1),
    v10: values(2),
    t2m: values(3),
    msl: pressure,
    q2m: humidity,
    prate: rate,
  };
  for (const { record, bytes, name } of first.files) {
    assertFields(record, ['model', 'cycle', 'step', 'var', 'scale', 'offset']);
    assert.equal(record.model, 'gfs');
    assert.equal(record.cycle, '2026-10-13T12:00:00.000Z');
    assert.equal(record.step, 6);
    assert.equal(record.dtype, 'int16le');
    assert.equal(bytes.length, 24);
    assert.match(
      name,
      /^gfs-20261013T120000-f006-(u10|v10|t2m|msl|q2m|prate)\.i16$/,
    );
    const source = sources[record.var];
    for (let i = 0; i < 12; i += 1) {
      const decoded = bytes.readInt16LE(i * 2) * record.scale + record.offset;
      assert.ok(Math.abs(decoded - source[i]) <= record.scale / 2 + 1e-9);
    }
  }
  const records = Object.fromEntries(
    first.files.map(({ record }) => [record.var, record]),
  );
  assert.equal(records.q2m.units, 'kg/kg');
  assert.equal(records.q2m.level, '2 m above ground');
  assert.equal(records.prate.units, 'mm/h');
  assert.equal(records.prate.level, 'surface');
  // The rate is a time mean: its window in forecast hours and as times.
  assert.deepEqual(records.prate.window, { fromHour: 0, toHour: 6 });
  assert.equal(records.prate.windowStartIso, '2026-10-13T12:00:00.000Z');
  assert.equal(records.prate.windowEndIso, '2026-10-13T18:00:00.000Z');
  for (const name of ['u10', 'v10', 't2m', 'msl', 'q2m'])
    assert.equal(Object.hasOwn(records[name], 'window'), false, name);
  assert.equal(
    filesOf(await feed('wind').poll(context({ services, state }))).length,
    0,
  );
  ifsUp = true;
  const ifs = await feed('wind').poll(context({ services, state }));
  assert.deepEqual(
    ifs.files.map((file) => `${file.record.model} ${file.record.var}`),
    ['ifs u10', 'ifs v10', 'ifs t2m', 'ifs msl'],
  );
  await assert.rejects(
    feed('wind').poll(
      context({
        services: {
          wind: { getSnapshot: async () => ({ unavailable: true }) },
        },
      }),
    ),
  );
});

test('cyclones: each storm once per advisory, again when revised', async () => {
  const storm = {
    id: 'al092026',
    name: 'Ida',
    classification: 'HU',
    basin: 'AL',
    position: { latitude: 25.1, longitude: -88.2 },
    positionAt: '2026-10-13T15:00:00.000Z',
    advisoryNumber: '12',
    issuedAt: '2026-10-13T15:00:00.000Z',
    windKt: 85,
    pressureHpa: 970,
    movement: { directionDegrees: 315, speedKt: 10 },
    geometryStatus: 'current',
    geometryAdvisoryNumber: '12',
    forecastPoints: [
      { position: { latitude: 26, longitude: -89 }, tauHours: 12, windKt: 95 },
    ],
  };
  let snapshot = { unavailable: false, storms: [storm] };
  const services = { cyclones: { getSnapshot: async () => snapshot } };
  const state = {};
  const first = await feed('weather-cyclones').poll(
    context({ services, state }),
  );
  assertFields(first.records[0], [
    'id',
    'name',
    'basin',
    'lat',
    'lon',
    'windKt',
    'pressure',
    'advisory',
  ]);
  assert.deepEqual(first.records[0].forecast, [[12, 26, -89, 95]]);
  assert.equal(
    recordsOf(await feed('weather-cyclones').poll(context({ services, state })))
      .length,
    0,
  );
  snapshot = { ...snapshot, storms: [{ ...storm, advisoryNumber: '12A' }] };
  assert.equal(
    recordsOf(await feed('weather-cyclones').poll(context({ services, state })))
      .length,
    1,
  );
  snapshot = { unavailable: true, reason: 'NHC unavailable', storms: [] };
  await assert.rejects(
    feed('weather-cyclones').poll(context({ services, state })),
    /NHC unavailable/,
  );
});

test('FIRMS: granules once, a new one alone, and no key says so', async () => {
  const fire = (satellite, acqTime, lat, frp) => ({
    lat,
    lon: 10,
    frp,
    confidence: 'n',
    satellite,
    instrument: 'VIIRS',
    acqDate: '2026-10-13',
    acqTime,
    daynight: 'D',
    brightness: 330,
  });
  let fires = [
    fire('N20', '1006', 1, 5),
    fire('N20', '1006', 2, 6),
    fire('N21', '45', 3, 7),
  ];
  const services = {
    fires: { getSnapshot: async () => ({ fires, sources: [], stale: false }) },
  };
  const state = {};
  const first = await feed('local-firms').poll(context({ services, state }));
  assert.equal(first.records.length, 3);
  assertFields(first.records[0], [
    'lat',
    'lon',
    'frp',
    'confidence',
    'satellite',
    'acq',
  ]);
  assert.equal(first.records[0].acq, Date.UTC(2026, 9, 13, 10, 6));
  assert.equal(first.records[2].acq, Date.UTC(2026, 9, 13, 0, 45));
  assert.equal(
    recordsOf(await feed('local-firms').poll(context({ services, state })))
      .length,
    0,
  );
  fires = [...fires, fire('MODIS', '1210', 4, 9)];
  const next = await feed('local-firms').poll(context({ services, state }));
  assert.deepEqual(
    next.records.map((record) => record.satellite),
    ['MODIS'],
  );
  await assert.rejects(
    feed('local-firms').poll(
      context({
        services: {
          fires: { getSnapshot: async () => ({ keyRequired: true }) },
        },
      }),
    ),
    /NO FIRMS MAP KEY/,
  );
});

test('fire perimeters: each incident once per revision, with centroid and box', async () => {
  const row = {
    stableId: '2026-CA-XYZ-001',
    name: 'Ridge',
    acres: 1234.56,
    containedPct: 40,
    state: 'US-CA',
    county: 'Kern',
    updatedTime: T0 - HOUR,
    polygons: [
      [
        [
          [-118, 35],
          [-117, 35],
          [-117, 36],
          [-118, 35],
        ],
      ],
    ],
  };
  let rows = [row];
  const services = { perimeters: { getSnapshot: async () => rows } };
  const state = {};
  const first = await feed('fire-perimeters').poll(
    context({ services, state }),
  );
  assertFields(first.records[0], [
    'id',
    'name',
    'acres',
    'contained',
    'centroid',
    'bbox',
  ]);
  assert.deepEqual(first.records[0].bbox, [-118, 35, -117, 36]);
  assert.deepEqual(first.records[0].centroid, [-117.5, 35.25]);
  assert.equal(
    recordsOf(await feed('fire-perimeters').poll(context({ services, state })))
      .length,
    0,
  );
  rows = [{ ...row, updatedTime: T0, containedPct: 55 }];
  assert.equal(
    recordsOf(await feed('fire-perimeters').poll(context({ services, state })))
      .length,
    1,
  );
});

const ISS = [
  'ISS (ZARYA)',
  '1 25544U 98067A   26286.50000000  .00016717  00000-0  10270-3 0  9005',
  '2 25544  51.6400 208.9163 0006317  69.9862 290.2104 15.50000000 12345',
].join('\n');

test('satellites: each element set once, a group down is skipped', async () => {
  let text = ISS;
  const services = {
    satellites: {
      readGroup: async (group) =>
        group === 'stations'
          ? { ok: true, status: 200, text, stale: false }
          : { ok: false, status: 503, text: '', stale: false },
    },
  };
  const state = {};
  const first = await feed('satellites').poll(context({ services, state }));
  assert.equal(first.records.length, 1);
  assertFields(first.records[0], ['group', 'name', 'norad', 'tle1', 'tle2']);
  assert.equal(first.records[0].norad, 25544);
  assert.equal(first.records[0].epoch, Date.UTC(2026, 0, 1) + 285.5 * DAY);
  assert.equal(
    recordsOf(await feed('satellites').poll(context({ services, state })))
      .length,
    0,
  );
  text = ISS.replace('26286.50000000', '26286.75000000');
  assert.equal(
    recordsOf(await feed('satellites').poll(context({ services, state })))
      .length,
    1,
  );
  await assert.rejects(
    feed('satellites').poll(
      context({
        services: {
          satellites: { readGroup: async () => ({ ok: false, status: 500 }) },
        },
      }),
    ),
  );
});

test('rocket launches: each launch once, again when its status changes', async () => {
  const launch = {
    id: 'f0f0f0f0-0000-4000-8000-000000000001',
    name: 'Falcon 9 | Starlink',
    net: '2026-10-14T03:00:00Z',
    status: { abbrev: 'Go', name: 'Go for Launch' },
    last_updated: '2026-10-13T10:00:00Z',
    pad: {
      name: 'SLC-40',
      latitude: '28.5618571',
      longitude: '-80.577366',
      location: { name: 'Cape Canaveral' },
    },
    launch_service_provider: { name: 'SpaceX' },
    rocket: { configuration: { full_name: 'Falcon 9 Block 5' } },
    mission: { name: 'Starlink', orbit: { name: 'Low Earth Orbit' } },
  };
  let payload = { results: [launch] };
  const services = {
    launches: { getLaunchSnapshot: async () => ({ payload, stale: false }) },
  };
  const state = {};
  const first = await feed('rocket-launches').poll(
    context({ services, state }),
  );
  assertFields(first.records[0], [
    'id',
    'name',
    'net',
    'status',
    'pad',
    'lat',
    'lon',
  ]);
  assert.equal(first.records[0].lat, 28.5618571);
  assert.equal(first.records[0].status, 'Go');
  assert.equal(
    recordsOf(await feed('rocket-launches').poll(context({ services, state })))
      .length,
    0,
  );
  payload = { results: [{ ...launch, status: { abbrev: 'Success' } }] };
  assert.equal(
    recordsOf(await feed('rocket-launches').poll(context({ services, state })))
      .length,
    1,
  );
});

test('bikeshare: a station snapshot each poll, positions reread hourly', async () => {
  const urls = [];
  const services = {
    bikeshare: {
      systems: [
        {
          id: 'austin-bcycle',
          stationInformationUrl:
            'https://gbfs.bcycle.com/bcycle_austin/station_information.json',
          stationStatusUrl:
            'https://gbfs.bcycle.com/bcycle_austin/station_status.json',
        },
      ],
      async getStations(url) {
        urls.push(url);
        return url.endsWith('station_information.json')
          ? {
              data: {
                stations: [
                  {
                    station_id: 's1',
                    name: 'Congress',
                    lat: 30.26,
                    lon: -97.74,
                    capacity: 12,
                  },
                ],
              },
            }
          : {
              data: {
                stations: [
                  {
                    station_id: 's1',
                    num_bikes_available: 4,
                    num_docks_available: 8,
                    last_reported: 1760380000,
                  },
                  { station_id: 'unknown', num_bikes_available: 1 },
                ],
              },
            };
      },
    },
  };
  const state = {};
  const first = await feed('bikeshare').poll(context({ services, state }));
  assert.equal(first.records.length, 1);
  assertFields(first.records[0], [
    'system',
    'station',
    'lat',
    'lon',
    'bikes',
    'docks',
  ]);
  assert.deepEqual(
    [first.records[0].bikes, first.records[0].docks, first.records[0].reported],
    [4, 8, 1760380000000],
  );
  await feed('bikeshare').poll(
    context({ services, state, now: () => T0 + 5 * MINUTE }),
  );
  assert.equal(urls.filter((url) => url.includes('information')).length, 1);
  await feed('bikeshare').poll(
    context({ services, state, now: () => T0 + 2 * HOUR }),
  );
  assert.equal(urls.filter((url) => url.includes('information')).length, 2);
});

test('radio: station metadata once, never a stream address', async () => {
  const station = {
    id: '96062a7b-0601-11e8-ae97-52543be04c81',
    name: 'KUTX',
    country: 'United States',
    state: 'Texas',
    lat: 30.2849,
    lon: -97.7341,
    tags: ['music'],
    languages: ['english'],
    codec: 'MP3',
    bitrate: 128,
    streamUrl: 'https://streams.example/kutx.mp3',
    homepage: 'https://kutx.org',
  };
  let stations = [station];
  const services = { radio: { getDirectory: async () => ({ stations }) } };
  const state = {};
  const first = await feed('radio').poll(context({ services, state }));
  assertFields(first.records[0], [
    'id',
    'name',
    'country',
    'lat',
    'lon',
    'tags',
    'codec',
    'bitrate',
  ]);
  assert.equal(
    JSON.stringify(first.records).includes('streams.example'),
    false,
  );
  assert.equal(JSON.stringify(first.records).includes('kutx.org'), false);
  assert.equal(
    recordsOf(await feed('radio').poll(context({ services, state }))).length,
    0,
  );
  stations = [{ ...station, bitrate: 256 }];
  assert.equal(
    recordsOf(await feed('radio').poll(context({ services, state }))).length,
    1,
  );
});

test('recent imagery: the newest clear image of each area, once', async () => {
  let candidate = {
    product: 'S30',
    day: '2026-10-11',
    cloud: { min: 1, max: 4 },
  };
  const snapshots = [];
  const services = {
    imagery: {
      latest: async ({ box }) => {
        assert.ok(box.west < AUSTIN.lon && AUSTIN.lon < box.east);
        return { candidate, reason: 'clear', errors: [] };
      },
      getSnapshot: async (args) => {
        snapshots.push(args);
        return { contentType: 'image/png', bytes: new Uint8Array([1, 2, 3]) };
      },
    },
  };
  await assert.rejects(
    feed('recent-imagery').poll(context({ services })),
    /NO AREA SELECTED/,
  );
  const state = {};
  const first = await feed('recent-imagery').poll(
    context({ services, state, areas: [AUSTIN] }),
  );
  assert.equal(first.files.length, 1);
  assertFields(first.files[0].record, [
    'area',
    'product',
    'day',
    'quality',
    'bbox',
  ]);
  assert.equal(snapshots[0].width, 1024);
  assert.equal(
    filesOf(
      await feed('recent-imagery').poll(
        context({ services, state, areas: [AUSTIN] }),
      ),
    ).length,
    0,
  );
  candidate = { ...candidate, day: '2026-10-13' };
  assert.equal(
    filesOf(
      await feed('recent-imagery').poll(
        context({ services, state, areas: [AUSTIN] }),
      ),
    ).length,
    1,
  );
});

test('AIS vessels: each vessel at most once a minute, on a new position', async () => {
  let observed = T0 - 1000;
  const services = {
    vessels: {
      getSnapshot: async (query) => {
        assert.equal(query.maxRows, 1_000_000);
        return {
          records: [
            {
              id: '366999712',
              name: 'EVER GIVEN',
              type: 'Cargo',
              latitude: 29.9,
              longitude: 32.55,
              speedMps: 12 * 0.514444,
              courseDeg: 181.4,
              headingDeg: 180,
              observedAtMs: observed,
            },
          ],
        };
      },
    },
  };
  const state = {};
  const at = (ms) =>
    feed('ais-live-vessels').poll(context({ services, state, now: () => ms }));
  const first = await at(T0);
  assertFields(first.records[0], [
    'mmsi',
    'name',
    'type',
    'lat',
    'lon',
    'sog',
    'cog',
    'heading',
  ]);
  assert.equal(first.records[0].sog, 12);
  observed += 20_000;
  assert.equal(
    recordsOf(await at(T0 + 30_000)).length,
    0,
    'not twice a minute',
  );
  assert.equal(recordsOf(await at(T0 + 60_000)).length, 1);
  assert.equal(recordsOf(await at(T0 + 125_000)).length, 0, 'no new position');
});

test('traffic: nothing without a TomTom key, a share of the budget, flow per area', async () => {
  let status = { hasKey: false };
  const zooms = [];
  const services = {
    traffic: {
      getStatus: async () => status,
      async fetchFlowDetail(box, { zoom }) {
        zooms.push(zoom);
        if (zoom === 12)
          throw Object.assign(new Error('too wide'), {
            code: 'TILE_VIEW_TOO_WIDE',
          });
        return {
          partial: false,
          segments: [
            {
              coords: [
                [-97.75, 30.26],
                [-97.74, 30.27],
              ],
              trafficLevel: 0.4,
              roadCategory: 'primary',
              closure: false,
            },
          ],
        };
      },
    },
  };
  await assert.rejects(
    feed('traffic').poll(context({ services, areas: [AUSTIN] })),
    (error) => error.message === 'NO TOMTOM KEY: SIMULATED ONLY',
  );
  status = { hasKey: true, dailyCount: 3000, budget: 6000 };
  await assert.rejects(
    feed('traffic').poll(context({ services, areas: [AUSTIN] })),
    /SHARE/,
  );
  assert.deepEqual(zooms, [], 'no tile asked for');
  status = { hasKey: true, dailyCount: 10, budget: 6000 };
  const result = await feed('traffic').poll(
    context({ services, areas: [AUSTIN] }),
  );
  assert.deepEqual(zooms, [12, 11]);
  const [segment, summary] = result.records;
  assertFields(segment, ['area', 'kind', 'level', 'closure', 'coords']);
  assert.equal(segment.kind, 'segment');
  assert.equal(summary.kind, 'area');
  assert.equal(summary.zoom, 11);
  assert.equal(summary.speedShare, 0.4);
});

// ------------------------------------------------------------------ CCTV

/** A camera `km` north of Austin. */
function camera(id, km, extra = {}) {
  return {
    id,
    name: `Lamar Blvd at ${id}`,
    lat: AUSTIN.lat + km / 111.2,
    lon: AUSTIN.lon,
    provider: 'City of Austin',
    pack: 'austin',
    feedType: 'image',
    license: 'City of Austin Open Data',
    ...extra,
  };
}

function fakeCctv(sources) {
  const catalogCalls = [];
  const frameCalls = [];
  let answer = () =>
    response({
      headers: {
        'content-type': 'image/jpeg',
        'x-cctv-source': 'upstream-image',
        'x-cctv-cache': 'miss',
      },
      bytes: new Uint8Array([0xff, 0xd8, frameCalls.length % 256, 7]),
    });
  return {
    catalogCalls,
    frameCalls,
    answerWith(fn) {
      answer = fn;
    },
    services: {
      cctv: {
        async getCatalog(options) {
          catalogCalls.push(options);
          return { sources, area: { pending: [] } };
        },
        getFrame: async () => {
          throw new Error('frames are read through ctx.fetch');
        },
      },
    },
    async fetch(url, init) {
      const match = /^\/api\/cctv\/frame\/([^?]+)\?ts=\d+$/.exec(url);
      assert.ok(match, `only the app's frame route, as a card: ${url}`);
      assert.equal(init?.cache, 'no-store');
      const id = decodeURIComponent(match[1]);
      frameCalls.push({ id, at: this.now });
      return answer(id);
    },
  };
}

/** Poll the cctv feed every minute from `start` for `minutes` minutes. */
async function everyMinute(cctv, { state, areas, start, minutes }) {
  const results = [];
  for (let m = 0; m <= minutes; m += 1) {
    const t = start + m * MINUTE;
    cctv.now = t;
    results.push(
      await feed('cctv').poll(
        context({
          services: cctv.services,
          fetch: (url, init) => cctv.fetch(url, init),
          areas,
          state,
          now: () => t,
        }),
      ),
    );
  }
  return results;
}

test('cctv: school, university, college and library cameras are never asked for', async () => {
  const sources = [
    camera('ok-1', 1),
    camera('school', 2, { name: 'Beacon Middle School' }),
    camera('university', 3, { name: 'University of Texas Campus' }),
    camera('college', 4, { name: 'Austin Community College' }),
    camera('library', 5, { name: 'Central Library' }),
    camera('road', 6, { name: 'Highway 85 at University Avenue' }),
  ];
  const cctv = fakeCctv(sources);
  const state = {};
  const results = await everyMinute(cctv, {
    state,
    areas: [AUSTIN],
    start: T0,
    minutes: 31,
  });
  const asked = cctv.frameCalls.map((call) => call.id);
  for (const id of ['school', 'university', 'college', 'library'])
    assert.equal(asked.includes(id), false, `${id} is never fetched`);
  assert.ok(asked.includes('ok-1') && asked.includes('road'));
  const stored = results.flatMap((result) =>
    filesOf(result).map((file) => file.record.camera),
  );
  assert.ok(stored.length > 0);
  for (const id of stored) assert.ok(['ok-1', 'road'].includes(id), id);
  // Each camera at most once every 15 minutes.
  for (const id of ['ok-1', 'road']) {
    const times = cctv.frameCalls
      .filter((call) => call.id === id)
      .map((call) => call.at);
    assert.ok(times.length >= 2, `${id} stays in the rotation`);
    for (let i = 1; i < times.length; i += 1)
      assert.ok(times[i] - times[i - 1] >= CCTV_PERIOD_MS, `${id} spacing`);
  }
  const frame = results.flatMap(filesOf)[0];
  assertFields(frame.record, [
    'camera',
    'lat',
    'lon',
    'area',
    'sha1',
    'operatorLicence',
  ]);
  assert.match(frame.name, /^\d{6}-(ok-1|road)\.jpg$/);
  // The filter runs again right before a request: a camera the catalogue now
  // names a library is never asked for, even before the next catalogue read.
  sources[5].name = 'Central Library';
  const asked1 = cctv.frameCalls.length;
  await everyMinute(cctv, {
    state,
    areas: [AUSTIN],
    start: T0 + 32 * MINUTE,
    minutes: 16,
  });
  const later = cctv.frameCalls.slice(asked1).map((call) => call.id);
  assert.ok(later.includes('ok-1'));
  assert.equal(later.includes('road'), false);
  assert.equal(state.cameras.has('road'), false);
});

test('cctv: at most the nearest 1,000 cameras within 50 km of an area', async () => {
  const sources = [];
  for (let i = 0; i < 1100; i += 1)
    sources.push(camera(`near-${i}`, 0.04 + i * 0.044));
  for (let i = 0; i < 20; i += 1) sources.push(camera(`far-${i}`, 55 + i));
  // Farthest first, so nearness is the adapter's own doing.
  sources.reverse();
  const cctv = fakeCctv(sources);
  const state = {};
  await everyMinute(cctv, {
    state,
    areas: [{ ...AUSTIN, radiusKm: 80 }],
    start: T0,
    minutes: 16,
  });
  assert.equal(
    cctv.catalogCalls[0].radiusKm,
    CCTV_RADIUS_KM,
    'never past 50 km',
  );
  const asked = new Set(cctv.frameCalls.map((call) => call.id));
  assert.equal(asked.size, CCTV_AREA_CAP);
  const nearest = sources
    .filter((source) => haversineKm(AUSTIN, source) <= 50)
    .sort((a, b) => haversineKm(AUSTIN, a) - haversineKm(AUSTIN, b))
    .slice(0, CCTV_AREA_CAP)
    .map((source) => source.id);
  assert.deepEqual([...asked].sort(), nearest.sort());
  assert.ok(state.cameras.size <= CCTV_AREA_CAP);
  // A smaller area radius holds too.
  const small = fakeCctv(sources);
  await everyMinute(small, {
    state: {},
    areas: [{ ...AUSTIN, radiusKm: 10 }],
    start: T0,
    minutes: 16,
  });
  for (const call of small.frameCalls) {
    const source = sources.find((s) => s.id === call.id);
    assert.ok(haversineKm(AUSTIN, source) <= 10);
  }
});

test('cctv: a host over budget is skipped, never dropped, and other hosts go on', async () => {
  const budgeted = { frameRefreshMs: 900_000, pack: 'us' };
  const cctv = fakeCctv([
    camera('ak-1', 1, { ...budgeted, provider: 'Alaska 511' }),
    camera('ak-2', 2, { ...budgeted, provider: 'Alaska 511' }),
    camera('ak-3', 3, { ...budgeted, provider: 'Alaska 511' }),
    camera('az-1', 4, { ...budgeted, provider: 'AZ511' }),
    camera('az-2', 5, { ...budgeted, provider: 'AZ511' }),
  ]);
  const alaska = cctvHostKey({ pack: 'us', provider: 'Alaska 511' });
  // The catalogue's budgetHost, when it names one, is the key.
  assert.equal(
    cctvHostKey({
      pack: 'us',
      provider: 'Alaska 511',
      budgetHost: '511.Alaska.gov',
    }),
    '511.alaska.gov',
  );
  let limited = false;
  cctv.answerWith((id) => {
    if (id.startsWith('ak-') && !limited) {
      limited = true;
      // The server's 511 budget refusal: a placeholder and Retry-After.
      return response({
        headers: {
          'content-type': 'image/svg+xml',
          'x-cctv-source': 'synthetic',
          'retry-after': '3600',
        },
        bytes: new TextEncoder().encode('<svg/>'),
      });
    }
    return response({
      headers: { 'content-type': 'image/jpeg', 'x-cctv-cache': 'miss' },
      bytes: new Uint8Array([0xff, 0xd8, cctv.frameCalls.length % 256]),
    });
  });
  const state = {};
  const results = await everyMinute(cctv, {
    state,
    areas: [AUSTIN],
    start: T0,
    minutes: 50,
  });
  const refusedAt = cctv.frameCalls.find((call) =>
    call.id.startsWith('ak-'),
  ).at;
  const afterRefusal = cctv.frameCalls.filter(
    (call) => call.id.startsWith('ak-') && call.at > refusedAt,
  );
  assert.deepEqual(
    afterRefusal,
    [],
    'no more requests to that host for the hour',
  );
  assert.ok(state.hosts.get(alaska).holdUntil >= refusedAt + HOUR);
  assert.equal(state.cameras.size, 5, 'skipped cameras stay in the rotation');
  assert.ok(
    cctv.frameCalls.filter((call) => call.id.startsWith('az-')).length >= 6,
    'the other host goes on',
  );
  assert.ok(
    results.flatMap(recordsOf).some((record) => record.status === 'limited'),
  );
  // After the hold the host is asked again.
  await everyMinute(cctv, {
    state,
    areas: [AUSTIN],
    start: refusedAt + HOUR + MINUTE,
    minutes: 15,
  });
  assert.ok(
    cctv.frameCalls.filter((call) => call.id.startsWith('ak-')).length > 1,
  );
});

test("cctv: the recorder's share of a 511 host is spent a minute at a time", async () => {
  const sources = Array.from({ length: 10 }, (_, i) =>
    camera(`ia-${i}`, 1 + i, {
      frameRefreshMs: 900_000,
      pack: 'us',
      provider: 'Iowa 511',
    }),
  );
  const cctv = fakeCctv(sources);
  const state = {};
  // Read the catalogue, then let every camera's slot pass.
  await everyMinute(cctv, { state, areas: [AUSTIN], start: T0, minutes: 0 });
  const before = cctv.frameCalls.length;
  await everyMinute(cctv, {
    state,
    areas: [AUSTIN],
    start: T0 + CCTV_PERIOD_MS,
    minutes: 0,
  });
  const inOneMinute = cctv.frameCalls.length - before;
  assert.ok(inOneMinute <= CCTV_HOST_SHARE.perMinute);
  await everyMinute(cctv, {
    state,
    areas: [AUSTIN],
    start: T0 + CCTV_PERIOD_MS + MINUTE,
    minutes: 0,
  });
  assert.equal(new Set(cctv.frameCalls.map((call) => call.id)).size, 10);
});

test('cctv: an unreachable camera stays in the rotation; an unchanged frame is not stored', async () => {
  const cctv = fakeCctv([camera('down', 1), camera('frozen', 2)]);
  cctv.answerWith((id) =>
    id === 'down'
      ? response({
          status: 502,
          headers: { 'content-type': 'application/json' },
        })
      : response({
          headers: { 'content-type': 'image/jpeg', 'x-cctv-cache': 'miss' },
          bytes: new Uint8Array([0xff, 0xd8, 1, 2]),
        }),
  );
  const state = {};
  const results = await everyMinute(cctv, {
    state,
    areas: [AUSTIN],
    start: T0,
    minutes: 46,
  });
  assert.ok(cctv.frameCalls.filter((call) => call.id === 'down').length >= 3);
  const records = results.flatMap(recordsOf);
  assert.deepEqual(
    records.filter((record) => record.camera === 'down').map((r) => r.status),
    ['http-502'],
    'a status is recorded when it changes',
  );
  assert.deepEqual(
    records.filter((record) => record.camera === 'frozen').map((r) => r.status),
    ['unchanged'],
  );
  assert.equal(
    results.flatMap(filesOf).filter((file) => file.record.camera === 'frozen')
      .length,
    1,
  );
  await assert.rejects(
    feed('cctv').poll(context({ services: cctv.services })),
    /NO AREA SELECTED/,
  );
});

// ------------------------------------------------------- the rest of phase 2

test('street level: Mapillary sequences around an area, once each', async () => {
  const z = 12;
  const centre = {
    x: lonToTileX(AUSTIN.lon, z),
    y: latToTileY(AUSTIN.lat, z),
    z,
  };
  const asked = [];
  let answer = (tile) =>
    tile.x === centre.x && tile.y === centre.y
      ? response({
          bytes: encodeCoverageTile(tile, {
            sequences: [
              {
                id: 'seq-1',
                capturedAt: T0 - DAY,
                isPano: true,
                parts: [
                  [
                    [AUSTIN.lon, AUSTIN.lat],
                    [AUSTIN.lon + 0.002, AUSTIN.lat + 0.001],
                  ],
                ],
              },
            ],
          }),
        })
      : response({ status: 204 });
  const fetch = async (url) => {
    if (url.startsWith('/api/mapillary/images?'))
      return response({ json: { images: [], truncated: false } });
    const match =
      /^\/api\/mapillary\/tiles\/coverage\/(\d+)\/(\d+)\/(\d+)$/.exec(url);
    assert.ok(match, url);
    const tile = { z: +match[1], x: +match[2], y: +match[3] };
    asked.push(tile);
    return answer(tile);
  };
  const state = {};
  const first = await feed('street-level').poll(
    context({ fetch, state, areas: [AUSTIN] }),
  );
  assert.ok(asked.length > 1 && asked.length <= 25);
  assert.equal(first.records.length, 1);
  assertFields(first.records[0], [
    'sequence',
    'capturedAt',
    'pano',
    'bbox',
    'start',
    'end',
  ]);
  assert.equal(first.records[0].pano, true);
  assert.equal(first.records[0].kind, undefined, 'a sequence has no kind');
  assert.equal(
    recordsOf(
      await feed('street-level').poll(
        context({ fetch, state, areas: [AUSTIN] }),
      ),
    ).length,
    0,
  );
  answer = () =>
    response({ status: 503, json: { error: 'no_key', keyRequired: true } });
  await assert.rejects(
    feed('street-level').poll(context({ fetch, state: {}, areas: [AUSTIN] })),
    /NO MAPILLARY TOKEN/,
  );
});

/**
 * The app API for street level: coverage tiles answer `tile(tile)` (empty
 * by default) and image searches `images(bbox)`; both are logged.
 */
function streetLevelApi({
  tile = () => response({ status: 204 }),
  images = () => response({ json: { images: [], truncated: false } }),
} = {}) {
  const tiles = [];
  const searches = [];
  const fetch = async (url) => {
    const coverage =
      /^\/api\/mapillary\/tiles\/coverage\/(\d+)\/(\d+)\/(\d+)$/.exec(url);
    if (coverage) {
      const at = { z: +coverage[1], x: +coverage[2], y: +coverage[3] };
      tiles.push(at);
      return tile(at);
    }
    const search = /^\/api\/mapillary\/images\?bbox=([-\d.,]+)$/.exec(url);
    assert.ok(search, url);
    searches.push(search[1]);
    return images(search[1]);
  };
  return { fetch, tiles, searches };
}

/** A box's width and height in degrees, to 1e-4. */
const sides = (bbox) => {
  const [west, south, east, north] = bbox.split(',').map(Number);
  return [east - west, north - south].map((d) => Math.round(d * 1e4) / 1e4);
};

const mlyImage = (id, lon, lat, extra = {}) => ({
  id,
  capturedAt: T0 - DAY,
  lat,
  lon,
  compass: 12.5,
  sequence: 'seq-1',
  isPano: false,
  cameraType: 'perspective',
  ...extra,
});

test('street level: per-image metadata in 0.05° cells, each image once, truncated cells split', async () => {
  const centre = '-97.75,30.25,-97.7,30.3'; // the cell Austin is in
  const quarter = '-97.75,30.25,-97.725,30.275'; // its quarter Austin is in
  const dup = mlyImage('dup', AUSTIN.lon + 0.001, AUSTIN.lat);
  const answers = {
    [centre]: {
      images: [
        mlyImage('i1', AUSTIN.lon, AUSTIN.lat, {
          isPano: true,
          cameraType: 'spherical',
        }),
        mlyImage('far', -97.705, 30.295), // in the cell, not the area's box
        dup,
      ],
      truncated: true,
    },
    [quarter]: {
      images: [
        mlyImage('i1', AUSTIN.lon, AUSTIN.lat),
        mlyImage('i2', -97.74, 30.26),
      ],
      truncated: true,
    },
  };
  // Every other cell holds `dup` again; the smallest come back truncated,
  // which cannot split them further.
  const api = streetLevelApi({
    images: (bbox) =>
      response({
        json: answers[bbox] ?? {
          images: [dup],
          truncated: sides(bbox)[0] < 0.02,
        },
      }),
  });
  const area = { ...AUSTIN, radiusKm: 2 };
  const state = {};
  const first = await feed('street-level').poll(
    context({ fetch: api.fetch, state, areas: [area] }),
  );
  assert.ok(api.tiles.length > 0, 'the sequences are still read');
  // Four cells, nearest first; the truncated one's quarters, then the
  // truncated quarter's quarters.
  assert.equal(api.searches[0], centre);
  assert.deepEqual(
    api.searches.map((bbox) => sides(bbox)[0]),
    [0.05, 0.05, 0.05, 0.05, 0.025, 0.025, 0.025, 0.025].concat(
      Array(4).fill(0.0125),
    ),
  );
  for (const bbox of api.searches) {
    assert.deepEqual(sides(bbox)[0], sides(bbox)[1], bbox);
    // The search route takes every box the walk asks for.
    assert.equal(normalizeImagesBbox(bbox).key, bbox);
  }
  assert.equal(api.searches[4], quarter);
  const images = first.records.filter((record) => record.kind === 'image');
  assert.equal(images.length, first.records.length);
  assert.deepEqual(
    images.map((record) => record.id),
    ['i1', 'dup', 'i2'],
    'each image once, only inside the box',
  );
  assertFields(images[0], [
    'kind',
    'id',
    'capturedAt',
    'lat',
    'lon',
    'compass',
    'sequence',
    'isPano',
    'cameraType',
    'area',
  ]);
  assert.deepEqual(images[0], {
    kind: 'image',
    id: 'i1',
    capturedAt: T0 - DAY,
    lat: 30.2672,
    lon: -97.7431,
    compass: 12.5,
    sequence: 'seq-1',
    isPano: true,
    cameraType: 'spherical',
    area: 'Austin',
  });
  // A finished walk starts again the next day, and finds nothing new.
  const searched = api.searches.length;
  const second = await feed('street-level').poll(
    context({ fetch: api.fetch, state, areas: [area], now: () => T0 + DAY }),
  );
  assert.equal(api.searches.length, 2 * searched);
  assert.equal(recordsOf(second).length, 0);
  // A token the search route refuses ends the poll, as for tiles.
  const refused = streetLevelApi({
    images: () =>
      response({ status: 503, json: { error: 'no_key', keyRequired: true } }),
  });
  await assert.rejects(
    feed('street-level').poll(
      context({ fetch: refused.fetch, state: {}, areas: [area] }),
    ),
    /NO MAPILLARY TOKEN/,
  );
});

test('street level: at most 32 image searches an area a day, the walk carrying on', async () => {
  assert.equal(IMAGE_SEARCHES_PER_AREA_DAY, 32);
  let limitAt = null; // the search number answered 429
  const api = streetLevelApi({
    images: () =>
      api.searches.length === limitAt
        ? response({
            status: 429,
            json: {
              error: 'Mapillary is rate-limiting image searches',
              retryAfter: 30,
            },
          })
        : response({ json: { images: [], truncated: false } }),
  });
  // 25 km around Austin is 120 cells: four days of searches.
  const area = { ...AUSTIN, radiusKm: 25 };
  const state = {};
  const poll = (t) =>
    feed('street-level').poll(
      context({ fetch: api.fetch, state, areas: [area], now: () => t }),
    );
  await poll(T0);
  const day1 = api.searches.splice(0);
  assert.equal(day1.length, IMAGE_SEARCHES_PER_AREA_DAY);
  assert.equal(day1[0], '-97.75,30.25,-97.7,30.3', 'nearest the area first');
  const tilesAsked = api.tiles.length;
  await poll(T0 + HOUR);
  assert.equal(api.searches.length, 0, 'the day’s searches are spent');
  assert.ok(api.tiles.length > tilesAsked, 'the sequences are still read');
  // The next day carries on; a 429 ends the searches, and with nothing new
  // the poll fails so the recorder asks again soon.
  limitAt = 5;
  await assert.rejects(poll(T0 + DAY), /rate-limiting/);
  const day2 = api.searches.splice(0);
  assert.equal(day2.length, 5);
  limitAt = null;
  await poll(T0 + DAY + 30 * MINUTE);
  const retry = api.searches.splice(0);
  assert.equal(retry[0], day2[4], 'the refused cell is asked first');
  assert.equal(retry.length, IMAGE_SEARCHES_PER_AREA_DAY - 5);
  const all = [...day1, ...day2, ...retry];
  assert.equal(new Set(all).size, all.length - 1, 'no cell asked twice');
});

test('street level: a poll cut short records its images on the next one', async () => {
  let cut = true;
  const api = streetLevelApi({
    images: () => {
      if (cut && api.searches.length === 2) throw new Error('aborted');
      return response({
        json: { images: [mlyImage('i1', AUSTIN.lon, AUSTIN.lat)] },
      });
    },
  });
  const state = {};
  const poll = () =>
    feed('street-level').poll(
      context({ fetch: api.fetch, state, areas: [AUSTIN] }),
    );
  await assert.rejects(poll(), /aborted/);
  cut = false;
  const again = await poll();
  assert.deepEqual(
    again.records.map((record) => record.id),
    ['i1'],
  );
  assert.equal(api.searches[2], api.searches[0], 'the walk starts again');
});

test('street level: a search refusing the token stops the images, not the sequences', async () => {
  const z = 12;
  const centre = {
    x: lonToTileX(AUSTIN.lon, z),
    y: latToTileY(AUSTIN.lat, z),
  };
  const rejected = () =>
    response({
      status: 403,
      json: { error: 'Mapillary rejected the access token', keyRejected: true },
    });
  const api = streetLevelApi({
    tile: (tile) =>
      tile.x === centre.x && tile.y === centre.y
        ? response({
            bytes: encodeCoverageTile(tile, {
              sequences: [
                {
                  id: 'seq-1',
                  capturedAt: T0 - DAY,
                  parts: [
                    [
                      [AUSTIN.lon, AUSTIN.lat],
                      [AUSTIN.lon + 0.002, AUSTIN.lat + 0.001],
                    ],
                  ],
                },
              ],
            }),
          })
        : response({ status: 204 }),
    images: rejected,
  });
  const state = {};
  const poll = (t) =>
    feed('street-level').poll(
      context({ fetch: api.fetch, state, areas: [AUSTIN], now: () => t }),
    );
  const first = await poll(T0);
  assert.deepEqual(
    first.records.map((record) => record.sequence),
    ['seq-1'],
  );
  assert.equal(api.searches.length, 1, 'one refusal ends the searches');
  // With nothing new, the refusal is the poll's error.
  await assert.rejects(poll(T0 + DAY), /MAPILLARY REJECTED THE TOKEN/);
  assert.equal(api.searches[1], api.searches[0], 'the refused cell again');
  // Tiles refusing the token still end the poll at once.
  const tiles = streetLevelApi({ tile: rejected });
  await assert.rejects(
    feed('street-level').poll(
      context({ fetch: tiles.fetch, state: {}, areas: [AUSTIN] }),
    ),
    /MAPILLARY REJECTED THE TOKEN/,
  );
  assert.equal(tiles.searches.length, 0);
});

test('news: headlines per area, open for GDELT and non-commercial for Google News', async () => {
  const services = {
    regional: {
      getBrief: async (lat) =>
        lat === AUSTIN.lat
          ? {
              newsSource: 'Google News RSS',
              place: { label: 'Austin, Texas' },
              articles: [
                {
                  title: 'Flooding on Lamar',
                  url: 'https://news.example/a',
                  domain: 'KXAN',
                  publishedAt: '2026-10-13T17:00:00.000Z',
                },
              ],
            }
          : {
              newsSource: 'GDELT fallback',
              articles: [
                {
                  title: 'Grève à Paris',
                  url: 'https://news.example/b',
                  domain: 'lemonde.fr',
                },
              ],
            },
    },
  };
  const state = {};
  const first = await feed('news').poll(
    context({ services, state, areas: [AUSTIN, PARIS] }),
  );
  assert.equal(first.records.length, 2);
  const [google, gdelt] = first.records;
  assertFields(google, [
    'source',
    'title',
    'url',
    'place',
    'lat',
    'lon',
    'published',
  ]);
  assert.equal(google.class, 'nc');
  assert.match(google.licence, /non-commercial/);
  assert.equal(google.place, 'Austin, Texas');
  assert.equal(google.published, Date.UTC(2026, 9, 13, 17));
  assert.equal(gdelt.class, 'open');
  assert.equal(gdelt.source, 'GDELT');
  assert.equal(
    recordsOf(
      await feed('news').poll(
        context({ services, state, areas: [AUSTIN, PARIS] }),
      ),
    ).length,
    0,
  );
  await assert.rejects(feed('news').poll(context({ services })), /NO AREA/);
});

test('military travel never reaches the tape: listed aircraft and military ships are left out, and no list holds the poll', async () => {
  resetMilitaryList();
  let asked = 0;
  let list = ['ae1234'];
  const military = {
    getIdentities: async () => {
      asked += 1;
      if (!list) throw new Error('down');
      return list;
    },
  };
  let t = T0;
  let observed = T0;
  const services = {
    military,
    aircraft: {
      getSnapshot: async () => ({
        source: 'OpenSky Network',
        observedAtMs: (observed += 1000),
        records: [
          { id: 'AE1234', latitude: 38.8, longitude: -77.0 },
          { id: 'a1b2c3', latitude: 30.1, longitude: -97.7 },
        ],
      }),
    },
  };
  const state = {};
  const flights = () =>
    feed('flights').poll(context({ services, state, now: () => t }));
  assert.deepEqual(
    recordsOf(await flights()).map((r) => r.hex),
    ['a1b2c3'],
    'the military airframe is dropped, whatever its case',
  );
  // The receiver's aircraft are screened by the same list, asked once.
  const fetch = async () =>
    response({
      json: {
        configured: true,
        records: [
          { icao: 'ae1234', lat: 30.3, lon: -97.7, band: '1090' },
          { icao: 'abc123', lat: 30.3, lon: -97.7, band: '1090' },
        ],
      },
    });
  const heard = await feed('local-adsb').poll(
    context({ fetch, services, now: () => t }),
  );
  assert.deepEqual(
    heard.records.map((r) => r.hex),
    ['abc123'],
  );
  assert.equal(asked, 1, 'one list for the whole recorder');
  // The list cannot be had: an old one still screens, a too-old one holds.
  list = null;
  t += 30 * MINUTE;
  assert.equal(recordsOf(await flights()).length, 1);
  t = T0 + MILITARY_LIST_MAX_AGE_MS + MINUTE;
  await assert.rejects(flights(), /HELD: NO MILITARY LIST/);
  await assert.rejects(
    feed('local-adsb').poll(context({ fetch, services, now: () => t })),
    /HELD: NO MILITARY LIST/,
  );
  // AIS ship type 35 (military) is never kept; a tanker is.
  const ships = await feed('ais-live-vessels').poll(
    context({
      services: {
        vessels: {
          getSnapshot: async () => ({
            records: [
              { id: '1', type: '35', latitude: 1, longitude: 2 },
              { id: '2', type: 'Military', latitude: 1, longitude: 2 },
              { id: '3', type: '80', latitude: 1, longitude: 2 },
            ],
          }),
        },
      },
    }),
  );
  assert.deepEqual(
    ships.records.map((r) => r.mmsi),
    ['3'],
  );
  resetMilitaryList();
});

test("local ADS-B: the owner's receiver, an aircraft when it moves", async () => {
  let body = { configured: false, feeds: [], records: [] };
  const fetch = async (url) => {
    assert.equal(url, '/api/local-receivers/aircraft');
    return response({ json: body });
  };
  await assert.rejects(
    feed('local-adsb').poll(context({ fetch })),
    /NO LOCAL RECEIVER/,
  );
  body = {
    configured: true,
    records: [
      {
        icao: 'abc123',
        callsign: 'N123AB',
        lat: 30.3,
        lon: -97.7,
        altitudeFt: 3500,
        groundSpeedKt: 120,
        trackDeg: 90,
        verticalRateFpm: 500,
        onGround: false,
        lastPositionAt: T0 - 500,
        band: '1090',
        rssiDbfs: -12.34,
      },
      { icao: 'def456', lat: null, lon: null, band: '1090' },
    ],
  };
  const state = {};
  const first = await feed('local-adsb').poll(context({ fetch, state }));
  assert.equal(first.records.length, 1);
  assertFields(first.records[0], [
    'hex',
    'callsign',
    'lat',
    'lon',
    'alt',
    'speed',
    'track',
  ]);
  assert.deepEqual(
    [first.records[0].alt, first.records[0].speed, first.records[0].vrate],
    [1067, 61.7, 2.5],
  );
  assert.equal(
    recordsOf(await feed('local-adsb').poll(context({ fetch, state }))).length,
    0,
  );
});

test("device feeds: new recording lines since the last poll, and the owner's devices only", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-devices-'));
  try {
    const dir = path.join(root, 'config', 'device-recordings', 'phone');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(
      dir,
      `${new Date(T0).toISOString().slice(0, 10)}.jsonl`,
    );
    const line = (at, lat) =>
      `${JSON.stringify({
        device: 'Tracker',
        kind: 'security',
        at: new Date(at).toISOString(),
        target: { lat, lon: -66.04, altM: 5, headingDeg: null, speedMps: 1.5 },
        radiusKm: 1,
        layers: { flights: [{ id: 'x' }, { id: 'y' }] },
        route: true,
      })}\n`;
    fs.writeFileSync(file, line(T0 - HOUR, 45.28));
    let devices = [
      {
        id: 'device-phone',
        name: 'Tracker',
        kind: 'security',
        lat: 45.288,
        lon: -66.045,
        live: true,
        at: T0 - 1000,
      },
      {
        id: 'ultra-network:friend',
        kind: 'help',
        lat: 45.1,
        lon: -66.1,
        live: true,
      },
    ];
    const asked = [];
    const fetch = async (url) => {
      asked.push(url);
      return response({ json: { devices } });
    };
    const state = {};
    const poll = (t) =>
      feed('device-feeds').poll(context({ fetch, state, root, now: () => t }));
    const first = await poll(T0);
    assert.deepEqual(asked, ['/api/device-feeds/positions']);
    assert.deepEqual(
      first.records.map((record) => [record.device, record.source]),
      [['device-phone', 'positions']],
      'what was already written is not new; help pins are never recorded',
    );
    fs.appendFileSync(file, line(T0 + 10_000, 45.29));
    fs.appendFileSync(file, line(T0 + 20_000, 45.3).slice(0, 40));
    const second = await poll(T0 + MINUTE);
    assert.equal(second.records.length, 1, 'one complete new line');
    assertFields(second.records[0], ['device', 'at', 'lat', 'lon', 'source']);
    assert.deepEqual(second.records[0].around, { flights: 2 });
    assert.equal(second.records[0].at, T0 + 10_000);
    fs.appendFileSync(file, line(T0 + 20_000, 45.3).slice(40));
    devices = [{ ...devices[0], lat: 45.3, at: T0 + 20_000 }];
    const third = await poll(T0 + 2 * MINUTE);
    assert.deepEqual(third.records.map((record) => record.source).sort(), [
      'positions',
      'recording',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('private cameras: only through the private-camera routes, a changed picture once', async () => {
  const asked = [];
  let porch = new Uint8Array([0xff, 0xd8, 1]);
  const fetch = async (url) => {
    asked.push(url);
    if (url === '/api/private-cams/sources')
      return response({
        json: {
          sources: [
            { id: 'private-home--porch', name: 'Porch', lat: 45.2, lon: -66.1 },
            { id: 'private-home--yard', name: 'Yard', lat: 45.2, lon: -66.1 },
          ],
        },
      });
    if (url === '/api/private-cams/frame/private-home--porch')
      return response({
        headers: { 'content-type': 'image/jpeg', 'x-private-camera': 'relay' },
        bytes: porch,
      });
    return response({
      headers: {
        'content-type': 'image/svg+xml',
        'x-private-camera': 'offline',
      },
      bytes: new TextEncoder().encode('<svg/>'),
    });
  };
  const state = {};
  const first = await feed('private-cctv').poll(context({ fetch, state }));
  assert.equal(first.files.length, 1);
  assertFields(first.files[0].record, ['camera', 'lat', 'lon', 'via', 'sha1']);
  assert.deepEqual(first.records, [
    { camera: 'private-home--yard', status: 'offline' },
  ]);
  const second = await feed('private-cctv').poll(context({ fetch, state }));
  assert.equal(filesOf(second).length, 0);
  assert.deepEqual(second.records, [
    { camera: 'private-home--porch', status: 'unchanged' },
  ]);
  porch = new Uint8Array([0xff, 0xd8, 2]);
  assert.equal(
    filesOf(await feed('private-cctv').poll(context({ fetch, state }))).length,
    1,
  );
  for (const url of asked) assert.match(url, /^\/api\/private-cams\//);
});

test('flight enrichment: adsbdb types for recorded aircraft, a few at a time, once a day', async () => {
  const TE = T0 + 10 * DAY;
  noteFlightHexes(
    Array.from({ length: 70 }, (_, i) => (0xa00000 + i).toString(16)),
    TE,
  );
  const lookups = [];
  const services = {
    aircraft: {
      getSnapshot: async () => ({
        records: [{ id: 'c0ffee' }],
      }),
      getEnrichment: async (query) => {
        lookups.push(query);
        return {
          found: true,
          typeCode: 'B738',
          typeName: 'Boeing 737-800',
          registration: 'N1',
        };
      },
    },
  };
  const state = {};
  const first = await feed('flight-enrichment').poll(
    context({ services, state, now: () => TE }),
  );
  assert.equal(first.records.length, 60);
  assert.ok(
    lookups.every((query) => query.kind === 'type'),
    'types only, never routes',
  );
  assertFields(first.records[0], [
    'hex',
    'found',
    'typeCode',
    'typeName',
    'registration',
  ]);
  const second = await feed('flight-enrichment').poll(
    context({ services, state, now: () => TE + 30 * MINUTE }),
  );
  assert.equal(second.records.length, 10);
  // Nothing recorded lately: one snapshot of the flights source instead.
  const later = await feed('flight-enrichment').poll(
    context({ services, state, now: () => TE + 3 * HOUR }),
  );
  assert.deepEqual(
    later.records.map((record) => record.hex),
    ['c0ffee'],
  );
});

// ---------------------------------------------------------------- statics

test('static snapshots: recorded when changed, never a field that hides the licence class', async () => {
  // ALPR around each area; outside coverage, nothing.
  let alprRecords = [
    {
      id: 'n1',
      latitude: 30.27,
      longitude: -97.74,
      operator: 'APD',
      directionDeg: 90,
    },
  ];
  const alpr = {
    fetch: async (box) =>
      box.west < 0
        ? { records: alprRecords, saturated: false }
        : { records: [], noCoverage: true },
  };
  const alprState = {};
  const alprPoll = () =>
    feed('alpr-cameras').poll(
      context({ services: { alpr }, state: alprState, areas: [AUSTIN, PARIS] }),
    );
  const firstAlpr = await alprPoll();
  assert.equal(firstAlpr.records.length, 1);
  assertFields(firstAlpr.records[0], ['area', 'id', 'lat', 'lon', 'operator']);
  assert.equal(recordsOf(await alprPoll()).length, 0);
  alprRecords = [
    ...alprRecords,
    { id: 'n2', latitude: 30.28, longitude: -97.73 },
  ];
  assert.equal(recordsOf(await alprPoll()).length, 2);

  // Installations: the site's class is not the record's licence class.
  const installations = {
    getMappedSites: async () => ({
      records: [
        {
          id: 'way/1',
          name: 'Camp Mabry',
          kind: 'military',
          class: 'base',
          latitude: 30.31,
          longitude: -97.76,
        },
      ],
      saturated: false,
    }),
  };
  const sites = await feed('military-installations').poll(
    context({ services: { installations }, areas: [AUSTIN] }),
  );
  assert.equal(sites.records[0].siteClass, 'base');
  assert.equal(Object.hasOwn(sites.records[0], 'class'), false);

  // Cables: the bundled GeoJSON as gzip files.
  const cables = {
    type: 'FeatureCollection',
    features: [{ properties: { id: 'c1' } }],
  };
  const landingPoints = { type: 'FeatureCollection', features: [] };
  const cableState = {};
  const cableServices = {
    cables: { fetch: async () => ({ cables, landingPoints }) },
  };
  const cableFiles = await feed('telegeography-submarine-cables').poll(
    context({ services: cableServices, state: cableState }),
  );
  assert.equal(cableFiles.files.length, 2);
  assert.deepEqual(JSON.parse(gunzipSync(cableFiles.files[0].bytes)), cables);
  assert.deepEqual(
    await feed('telegeography-submarine-cables').poll(
      context({ services: cableServices, state: cableState }),
    ),
    {},
  );

  // Datacenters and dams.
  const infrastructure = {
    getRecords: async (layer) =>
      layer === 'local-datacenters'
        ? [
            {
              id: 'dc',
              name: 'DC1',
              operator: 'Op',
              capacity: '10 MW',
              lat: 1,
              lon: 2,
            },
          ]
        : [
            {
              id: 'dam',
              name: 'Mansfield',
              river: 'Colorado',
              output: '108 MW',
              lat: 30.39,
              lon: -97.9,
            },
          ],
  };
  const dcState = {};
  const dc = await feed('local-datacenters').poll(
    context({ services: { infrastructure }, state: dcState }),
  );
  assert.equal(dc.records[0].capacity, '10 MW');
  assert.deepEqual(
    await feed('local-datacenters').poll(
      context({ services: { infrastructure }, state: dcState }),
    ),
    {},
  );
  const dams = await feed('local-dams').poll(
    context({ services: { infrastructure } }),
  );
  assert.equal(dams.records[0].river, 'Colorado');

  // The Bhote Koshi pack and its locator.
  const event = {
    id: 'bhote-koshi-2026',
    title: 'Bhote Koshi outburst flood',
    observedDate: '2026-08-26',
    evidenceSpine: [
      {
        id: 'e1',
        sequence: 1,
        phase: 'collapse',
        title: 'Collapse',
        lat: 28.36,
        lon: 85.44,
        timing: { capturedAt: null },
      },
    ],
  };
  const pack = await feed('bhote-koshi-2026').poll(
    context({ services: { events: { getEvent: async () => event } } }),
  );
  assert.equal(pack.files.length, 1);
  assert.deepEqual(JSON.parse(gunzipSync(pack.files[0].bytes)), event);
  assert.equal(pack.records[0].kind, 'evidence');
  const locatorState = {};
  const locator = await feed('bhote-koshi-locator').poll(
    context({ state: locatorState }),
  );
  assert.ok(locator.records.some((record) => record.kind === 'flood-path'));
  assert.ok(
    locator.records.filter((record) => record.kind === 'place').length > 5,
  );
  assert.deepEqual(
    await feed('bhote-koshi-locator').poll(context({ state: locatorState })),
    {},
  );

  // Every static and feed record set leaves the store's fields alone.
  for (const result of [firstAlpr, sites, dc, dams, pack, locator])
    for (const record of recordsOf(result)) {
      assert.equal(Object.hasOwn(record, 't'), false);
      assert.equal(Object.hasOwn(record, 'feed'), false);
      assert.equal(Object.hasOwn(record, 'class'), false);
      assert.equal(Object.hasOwn(record, 'licence'), false);
    }
});

test('through the recorder: frames and their records land in the tape, a missing key is the feed error', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-tape-feeds-'));
  try {
    const store = createTapeStore({ root, now: () => T0 });
    const weather = fakeWeather();
    const recorder = createRecorder({
      store,
      adapters: feedMap(),
      now: () => T0,
      timers: { setTimeout: () => null, clearTimeout: () => {} },
      contextFor: () => ({
        services: {
          weatherMaps: weather.service,
          traffic: { getStatus: async () => ({ hasKey: false }) },
        },
        areas: [AUSTIN],
      }),
    });
    recorder.setFeeds(['weather-radar', 'traffic']);
    recorder.start();
    await recorder.pollNow('weather-radar');
    await recorder.pollNow('traffic');
    const day = path.join(root, 'weather-radar', '2026', '10', '13');
    const records = gunzipSync(fs.readFileSync(path.join(day, '18.ndjson.gz')))
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(records.length, 2);
    for (const record of records) {
      assert.equal(record.feed, 'weather-radar');
      assert.equal(record.class, 'open');
      assert.ok(fs.existsSync(path.join(root, record.file)));
    }
    const status = new Map(recorder.status().map((feed) => [feed.id, feed]));
    assert.equal(status.get('weather-radar').state, 'recording');
    assert.equal(status.get('traffic').state, 'error');
    assert.equal(status.get('traffic').error, 'NO TOMTOM KEY: SIMULATED ONLY');
    assert.equal(
      fs.existsSync(path.join(root, 'traffic')),
      false,
      'nothing recorded',
    );
    recorder.stop();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ------------------------------------- the real tool services, a fake app API

/** The app's own routes as fixed answers (real Response objects). */
function fakeAppApi(now) {
  const sec = Math.floor(now / 1000);
  const minute = (ms) =>
    new Date(Math.floor(ms / MINUTE) * MINUTE).toISOString();
  const json = (body, headers = {}) =>
    new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json', ...headers },
    });
  const grid = { nx: 4, ny: 3, lo1: 0, la1: 90, dx: 90, dy: 90 };
  const asked = [];
  const opensky = ['a1b2c3', 'UAL1    ', 'United States', sec - 5, sec - 4];
  const routes = {
    '/api/flights': () =>
      json(
        {
          time: sec - 3,
          states: [
            [...opensky, -97.7, 30.2, 10668, false, 230.4, 271.2, -1.2, null],
          ],
        },
        { 'x-feed-source': 'OpenSky Network' },
      ),
    '/api/military': () =>
      json(
        {
          ac: [
            {
              hex: 'ae1234',
              flight: 'RCH123',
              lat: 36.5,
              lon: -76.2,
              t: 'C17',
            },
          ],
        },
        { 'x-feed-age-ms': '1500', 'x-feed-cache': 'HIT' },
      ),
    '/api/weather/manifest': (q) => {
      const times = [minute(now - 10 * MINUTE), minute(now - 5 * MINUTE)];
      return json({
        schemaVersion: 1,
        product: q.get('product'),
        bounds: { west: -130, south: 20, east: -60, north: 55 },
        times,
        latest: times[1],
        tileSize: 256,
        maxLevel: 6,
        tilingScheme: 'geographic',
        unavailable: false,
      });
    },
    '/api/weather/image': () =>
      new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        headers: { 'content-type': 'image/png' },
      }),
    '/api/wind/manifest': (q) => {
      const [model, overlay] = [q.get('model'), q.get('overlay')];
      const scalar = {
        temperature: { units: '°C', level: '2 m above ground' },
        pressure: { units: 'hPa', level: 'mean sea level' },
        humidity: { units: 'kg/kg', level: '2 m above ground' },
        precipitation: {
          units: 'mm/h',
          level: 'surface',
          window: { fromHour: 0, toHour: 6 },
        },
      }[overlay];
      // IFS has no 2 m specific humidity or precipitation rate: wind alone.
      const windOnly =
        model === 'ifs' && ['humidity', 'precipitation'].includes(overlay);
      return json({
        schemaVersion: 1,
        model,
        overlay,
        cycle: { forecastHour: 6, runIso: '2026-10-13T12:00:00.000Z' },
        ...(windOnly
          ? {
              scalarError:
                overlay === 'humidity'
                  ? 'Specific humidity field unavailable'
                  : 'Precipitation rate field unavailable',
            }
          : { scalar: { kind: overlay, ...scalar } }),
        level: '10 m above ground',
        units: 'm/s',
        grid,
        gridUrl: `/api/wind/grid/${model}-f6${windOnly ? '-wind-only' : ''}.bin?model=${model}&overlay=${overlay}`,
      });
    },
    '/api/cyclones': () =>
      json({
        schemaVersion: 1,
        source: 'NHC',
        attribution: 'NOAA/NWS NHC',
        coverage: 'Atlantic',
        fetchedAt: now,
        stale: false,
        unavailable: false,
        reason: null,
        storms: [
          {
            id: 'al092026',
            name: 'Ida',
            classification: 'HU',
            basin: 'AL',
            position: { longitude: -88.2, latitude: 25.1 },
            positionAt: '2026-10-13T15:00:00.000Z',
            advisoryNumber: '12',
            issuedAt: '2026-10-13T15:00:00.000Z',
            windKt: 85,
            pressureHpa: 970,
            movement: { directionDegrees: 315, speedKt: 10 },
            advisoryUrl: null,
            outlookUrl: null,
            geometryStatus: 'pending',
            geometryAdvisoryNumber: null,
            forecastPoints: [],
            track: null,
            cone: null,
          },
        ],
      }),
    '/api/celestrak/stations': () => new Response(ISS),
    '/api/launches': () =>
      json({ results: [{ id: 'l1', name: 'Falcon 9', net: '2026-10-14' }] }),
    '/api/radio/stations': () =>
      json({ stations: [{ id: 'r1', name: 'KUTX', lat: 30.3, lon: -97.7 }] }),
    '/api/firms': () =>
      json({
        fires: [
          { lat: 1, lon: 2, frp: 3, satellite: 'N20', acqDate: '2026-10-13' },
        ],
      }),
    '/api/fire-perimeters': () =>
      json({
        rows: [
          {
            stableId: 'X',
            polygons: [
              [
                [
                  [-118, 35],
                  [-117, 35],
                  [-117, 36],
                  [-118, 35],
                ],
              ],
            ],
          },
        ],
      }),
    '/api/vessels': () =>
      json({
        rows: [{ mmsi: '366999712', lat: 29.9, lon: 32.55, speed: 12 }],
        status: 'live',
      }),
    '/api/tomtom/status': () => json({ hasKey: false }),
    '/api/cctv/sources': () =>
      json({
        sources: [{ id: 'c1', name: 'Lamar at 5th', lat: 30.27, lon: -97.75 }],
        area: { pending: [] },
      }),
    '/api/cctv/frame/c1': () =>
      new Response(new Uint8Array([0xff, 0xd8, 1]), {
        headers: { 'content-type': 'image/jpeg', 'x-cctv-cache': 'miss' },
      }),
    '/api/regional-brief': () =>
      json({
        newsSource: 'GDELT fallback',
        articles: [{ title: 'Hello', url: 'https://n.example/1' }],
      }),
    '/api/adsbdb/type/a1b2c3': () =>
      json({ found: true, typeCode: 'B738', typeName: 'Boeing 737-800' }),
    '/events/bhote-koshi-2026/event.json': () =>
      json({
        id: 'bhote-koshi-2026',
        evidenceSpine: [{ lat: 28.3, lon: 85.4 }],
      }),
  };
  const fetchImpl = async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    // Bundled data (cables, datacenters, dams) is read from disk.
    if (url.startsWith('file:'))
      return new Response(fs.readFileSync(new URL(url)));
    const { pathname, searchParams } = new URL(url, 'http://localhost');
    asked.push(pathname);
    if (pathname.startsWith('/api/wind/grid/'))
      return new Response(
        new Uint8Array(
          Float32Array.from(
            { length: pathname.includes('-wind-only') ? 24 : 36 },
            (_, i) => i,
          ).buffer,
        ),
      );
    if (pathname.startsWith('/api/gbfs/'))
      return decodeURIComponent(pathname).endsWith('information.json')
        ? json({
            data: { stations: [{ station_id: 's1', lat: 30, lon: -97 }] },
          })
        : json({
            data: { stations: [{ station_id: 's1', num_bikes_available: 3 }] },
          });
    const route = routes[pathname];
    return route ? route(searchParams) : new Response('{}', { status: 404 });
  };
  return { fetchImpl, asked };
}

test('the adapters run on the real tool services, through the app API only', async () => {
  // The flights source ages a snapshot against the real clock.
  const now = Date.now();
  const api = fakeAppApi(now);
  const services = createToolServices({
    fetchImpl: api.fetchImpl,
    appUrl: 'http://localhost:4173',
  });
  const expected = [
    ['flights', 'records', 1],
    ['military', 'records', 1],
    ['weather-radar', 'files', 2],
    ['weather-satellite', 'files', 3],
    ['weather-lightning', 'files', 2],
    ['wind', 'files', 10],
    ['weather-cyclones', 'records', 1],
    ['local-firms', 'records', 1],
    ['fire-perimeters', 'records', 1],
    ['rocket-launches', 'records', 1],
    ['radio', 'records', 1],
    ['ais-live-vessels', 'records', 1],
    ['news', 'records', 1],
    ['flight-enrichment', 'records', 1],
    ['bhote-koshi-2026', 'records', 1],
    ['telegeography-submarine-cables', 'files', 2],
  ];
  for (const [id, kind, count] of expected) {
    const result = await feed(id).poll(
      context({
        services,
        fetch: api.fetchImpl,
        areas: [AUSTIN],
        now: () => now,
      }),
    );
    assert.equal((result?.[kind] ?? []).length, count, id);
  }
  // The wind source carries the new fields' units and the rate's window.
  const wind = await feed('wind').poll(context({ services }));
  const windRecords = Object.fromEntries(
    wind.files.map(({ record }) => [`${record.model} ${record.var}`, record]),
  );
  assert.equal(windRecords['gfs q2m'].units, 'kg/kg');
  assert.equal(windRecords['gfs prate'].units, 'mm/h');
  assert.deepEqual(windRecords['gfs prate'].window, { fromHour: 0, toHour: 6 });
  assert.equal(windRecords['ifs q2m'], undefined);
  assert.equal(windRecords['ifs prate'], undefined);
  const satellites = await feed('satellites').poll(context({ services }));
  assert.equal(satellites.records[0].norad, 25544);
  const bikes = await feed('bikeshare').poll(context({ services }));
  assert.ok(bikes.records.length > 0);
  const datacenters = await feed('local-datacenters').poll(
    context({ services }),
  );
  assert.ok(datacenters.records.length > 1000);
  const dams = await feed('local-dams').poll(context({ services }));
  assert.ok(dams.records.length > 100);
  await assert.rejects(
    feed('traffic').poll(context({ services, areas: [AUSTIN] })),
    /NO TOMTOM KEY/,
  );
  const cctvState = {};
  for (const t of [now, now + 16 * MINUTE])
    await feed('cctv').poll(
      context({
        services,
        fetch: api.fetchImpl,
        areas: [AUSTIN],
        state: cctvState,
        now: () => t,
      }),
    );
  assert.ok(api.asked.includes('/api/cctv/frame/c1'));
  // Every request went to the app's own routes or its own event pack.
  for (const route of api.asked) assert.match(route, /^\/(api|events)\//);
});

test('flights: the OpenSky auth mode the proxy names reaches the feed through the real source', async () => {
  const now = Date.now();
  const api = fakeAppApi(now);
  const fetchImpl = async (input, init) => {
    const answer = await api.fetchImpl(input, init);
    if (!String(input).startsWith('/api/flights')) return answer;
    const headers = new Headers(answer.headers);
    headers.set('X-OpenSky-Auth-Mode-Used', 'anon');
    return new Response(await answer.text(), {
      status: answer.status,
      headers,
    });
  };
  const services = createToolServices({
    fetchImpl,
    appUrl: 'http://localhost:4173',
  });
  const state = {};
  const first = await feed('flights').poll(
    context({ services, state, now: () => now }),
  );
  assert.equal(first.records.length, 1);
  assert.equal(first.records[0].auth, 'anon');
  assert.equal(state.holdUntil, now + HOUR, 'the next snapshot in an hour');
});
