import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  houstonCameraName,
  houstonCameraToSource,
  loadHoustonSourcesFromOpenData,
} from '../../server/providers/cctv/sources.js';
import {
  HOUSTON_BOX,
  HOUSTON_CAMERAS_URL,
  HOUSTON_GROUND_ELEVATION_M,
  HOUSTON_IMAGE_ORIGIN,
  HOUSTON_IMAGE_URL,
  HOUSTON_MAX_CATALOG_BYTES,
} from '../../server/providers/cctv/constants.js';
import { CAMERA_CODE_MAX_CHARS } from '../../server/providers/cctv/normalize.js';
import { areaOverlapsBox } from '../../server/providers/cctv/area.js';
import { CCTV_LIVE_PACKS } from '../../server/providers/cctv/live-packs.js';
import { createCctvCatalog } from '../../server/providers/cctv/catalog.js';

/**
 * A response whose body is a live stream, plus a flag that flips when the
 * stream is cancelled. A rejection path that returns without cancelling holds
 * the transport open, so the flag is what the refusal tests actually assert.
 */
const streamingResponse = (init = {}) => {
  const state = { cancelled: false };
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{'));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { response: new Response(body, init), state };
};

const DOWNTOWN_ID = '1002';
const GALLERIA_ID = '2001';

/** One TranStar camera row, shaped like the live `cctvSnapshots_json.js` payload. */
const row = (overrides = {}) => ({
  location: '10 EAST @ SAN JACINTO',
  id: DOWNTOWN_ID,
  lat: '29.76824',
  lng: '-95.355711',
  dir: 'South',
  fc: '6',
  fp: '300',
  url: "showWin('/layers/gc.aspx?cam=1002&loc=IH-10_East_at_SAN_JACINTO')",
  ...overrides,
});

const quiet = (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
};

test('a Houston row maps to a source on the pinned HTTPS frame host', () => {
  const source = houstonCameraToSource(row());
  assert.equal(source.id, `houston-${DOWNTOWN_ID}`);
  assert.equal(source.name, '10 EAST @ SAN JACINTO');
  assert.equal(source.city, 'Houston');
  assert.equal(source.cityId, 'houston');
  assert.equal(source.provider, 'Houston TranStar');
  assert.equal(source.lat, 29.76824);
  assert.equal(source.lon, -95.355711);
  assert.equal(source.feedType, 'image');
  assert.equal(source.sourceKind, 'houston-transtar');
  assert.equal(
    source.license,
    'TranStar disclaimer — redistribution and external framing need TxDOT written permission',
  );
  assert.equal(source.groundElevationM, HOUSTON_GROUND_ELEVATION_M);
  assert.equal(source.url, HOUSTON_IMAGE_URL(DOWNTOWN_ID));
  assert.equal(source.url, source.snapshotUrl);
  assert.ok(source.url.startsWith(HOUSTON_IMAGE_ORIGIN));
  // dir South = the camera sits south of I-10; the nearest lanes run east.
  assert.equal(source.headingConfidence, 'low');
  assert.equal(source.headingDeg, 90);
});

test('frame URLs are synthesized from the numeric id; the payload URL is ignored', () => {
  const source = houstonCameraToSource(
    row({ url: 'https://evil.example/cameras/x/image' }),
  );
  assert.equal(source.url, HOUSTON_IMAGE_URL(DOWNTOWN_ID));
  assert.equal(source.snapshotUrl, source.url);
});

test('a camera stays wherever TranStar lists it; a row with no snapshot id or no position has nothing to show', () => {
  // Id 0 is another operator's PTZ camera that TranStar's map opens in a
  // different viewer: no still, and no identity of its own.
  assert.equal(houstonCameraToSource(row({ id: '0' })), null);
  assert.equal(houstonCameraToSource(row({ id: '00' })), null);
  assert.equal(houstonCameraToSource(row({ id: '../etc/passwd' })), null);
  assert.equal(houstonCameraToSource(row({ id: '12' })), null);
  assert.equal(houstonCameraToSource(row({ id: '1002/../x' })), null);
  assert.equal(houstonCameraToSource(row({ lat: '0', lng: '0' })), null);
  assert.equal(houstonCameraToSource(row({ lat: '', lng: '' })), null);
  assert.equal(houstonCameraToSource(null), null);
  // Out along IH-45 past Conroe and IH-10 toward Sealy, beyond Greater
  // Houston: still TranStar cameras, and never dropped for where they are.
  assert.equal(
    houstonCameraToSource(
      row({ id: '289', lat: '30.477976', lng: '-95.496789' }),
    ).id,
    'houston-289',
  );
  assert.equal(
    houstonCameraToSource(
      row({ id: '374', lat: '29.754549', lng: '-96.254431' }),
    ).id,
    'houston-374',
  );
  // 3-digit and 5-digit snapshot ids stay.
  assert.equal(houstonCameraToSource(row({ id: '102' })).id, 'houston-102');
  assert.equal(houstonCameraToSource(row({ id: '13711' })).id, 'houston-13711');
});

test('dir is the side of the road: it gives a low-confidence travel heading', () => {
  // TranStar's map reads dir as "Traffic closest to the camera is traveling":
  // South -> Eastbound, North -> Westbound, West -> Southbound, East -> Northbound.
  const expected = { South: 90, North: 270, West: 180, East: 0, south: 90 };
  for (const [dir, heading] of Object.entries(expected)) {
    const source = houstonCameraToSource(row({ dir }));
    assert.equal(source.headingDeg, heading, `dir ${dir}`);
    assert.equal(source.headingConfidence, 'low', `dir ${dir}`);
    assert.equal(source.pitchDeg, -18, `dir ${dir}`);
    assert.equal(source.fovDeg, 44, `dir ${dir}`);
    assert.equal(source.rangeM, 145, `dir ${dir}`);
    assert.equal(source.mountHeightM, 8, `dir ${dir}`);
  }

  const none = houstonCameraToSource(row({ dir: 'None' }));
  assert.equal(none.headingConfidence, 'low');
  assert.ok(Number.isFinite(none.headingDeg));
  assert.equal(
    none.headingDeg,
    houstonCameraToSource(row({ dir: '' })).headingDeg,
  );
  for (const dir of ['Northeast', 'constructor', '__proto__', undefined]) {
    assert.equal(
      houstonCameraToSource(row({ dir })).headingDeg,
      none.headingDeg,
      `dir ${dir} falls back to the id hash`,
    );
  }
});

test('a nameless row still gets a label', () => {
  assert.equal(
    houstonCameraName({ location: '  45 GULF @ WEST DALLAS ' }, 'houston-102'),
    '45 GULF @ WEST DALLAS',
  );
  assert.equal(houstonCameraName({}, 'houston-102'), 'Houston Camera 102');
  assert.equal(houstonCameraName({}, ''), 'Houston Camera');
});

test('the unselected label is the interchange, trimmed to the code width', () => {
  assert.equal(houstonCameraToSource(row()).code, '10 EAST @ SAN JACINTO');
  const long = houstonCameraToSource(
    row({
      location:
        'IH-10 Katy Managed Lanes Eastbound at a very long interchange name that must truncate',
    }),
  );
  assert.equal(long.code.length, CAMERA_CODE_MAX_CHARS);
  assert.ok(long.code.endsWith('…'));
});

test('the loader reads the keyless catalog in list order and collapses duplicate ids', async (t) => {
  quiet(t);
  const requested = [];
  const fetchImpl = async (url, init) => {
    requested.push([String(url), init.headers.Accept, init.redirect]);
    return Response.json({
      cameras: [
        row(),
        row({ location: '10 EAST @ SAN JACINTO (duplicate)' }),
        row({
          id: GALLERIA_ID,
          location: '610 WEST LOOP @ SAN FELIPE',
          lat: '29.749',
          lng: '-95.461',
          dir: 'North',
        }),
        row({ url: 'https://evil.example/x.jpg', id: '0' }),
      ],
    });
  };
  const cameras = await loadHoustonSourcesFromOpenData({ fetchImpl, env: {} });
  assert.deepEqual(requested, [[HOUSTON_CAMERAS_URL, '*/*', 'manual']]);
  assert.deepEqual(
    cameras.map((camera) => camera.id),
    [`houston-${DOWNTOWN_ID}`, `houston-${GALLERIA_ID}`],
  );
  assert.equal(cameras[0].name, '10 EAST @ SAN JACINTO');

  requested.length = 0;
  await loadHoustonSourcesFromOpenData({
    fetchImpl,
    env: { CCTV_HOUSTON_CAMERAS_URL: 'https://cameras.example/list.js' },
  });
  assert.equal(requested[0][0], 'https://cameras.example/list.js');
});

test('every listed camera loads: no pack cap and no metro-anchor order', async (t) => {
  quiet(t);
  const rows = [
    ...[29.32, 29.322, 29.324, 29.326, 29.328, 29.33].map((lat, i) =>
      row({
        id: String(3000 + i),
        lat: String(lat),
        lng: '-94.80',
        location: `Galveston ${i}`,
        dir: 'East',
      }),
    ),
    ...[29.76, 29.759, 29.758, 29.757, 29.756, 29.755].map((lat, i) =>
      row({
        id: String(4000 + i),
        lat: String(lat),
        lng: '-95.3698',
        location: `Downtown ${i}`,
        dir: 'North',
      }),
    ),
    row({
      id: '289',
      lat: '30.477976',
      lng: '-95.496789',
      location: 'IH-45 North @ Shepard Hill',
    }),
  ];
  const cameras = await loadHoustonSourcesFromOpenData({
    fetchImpl: async () => Response.json({ cameras: rows }),
    // Upstream's cap setting; the fork has no pack cap, so it changes nothing.
    env: { CCTV_HOUSTON_MAX_SOURCES: '8' },
  });
  assert.deepEqual(
    cameras.map((camera) => camera.name),
    rows.map((r) => r.location),
  );
});

test('an upstream failure yields an empty pack and releases the response', async (t) => {
  quiet(t);
  const failed = streamingResponse({ status: 503 });
  assert.deepEqual(
    await loadHoustonSourcesFromOpenData({
      fetchImpl: async () => failed.response,
      env: {},
    }),
    [],
  );
  assert.equal(failed.state.cancelled, true, 'the failed body is cancelled');
  assert.deepEqual(
    await loadHoustonSourcesFromOpenData({
      fetchImpl: async () => {
        throw new Error('network down');
      },
      env: {},
    }),
    [],
  );
});

test('the catalog fetch refuses redirects and oversized bodies', async (t) => {
  quiet(t);
  const seen = [];
  const redirected = streamingResponse({
    status: 302,
    headers: { location: 'https://evil.example/cameras.js' },
  });
  assert.deepEqual(
    await loadHoustonSourcesFromOpenData({
      fetchImpl: async (url, init) => {
        seen.push([String(url), init.redirect]);
        return redirected.response;
      },
      env: {},
    }),
    [],
  );
  assert.deepEqual(seen, [[HOUSTON_CAMERAS_URL, 'manual']]);
  assert.equal(
    redirected.state.cancelled,
    true,
    'the redirect body is cancelled',
  );

  assert.deepEqual(
    await loadHoustonSourcesFromOpenData({
      fetchImpl: async () =>
        new Response(JSON.stringify({ cameras: [row()] }), {
          headers: {
            'Content-Type': 'application/javascript',
            'content-length': String(HOUSTON_MAX_CATALOG_BYTES + 1),
          },
        }),
      env: {},
    }),
    [],
  );

  // Valid JSON with a usable camera, so only the byte cap can refuse it.
  const oversized = JSON.stringify({
    cameras: [row()],
    padding: 'x'.repeat(HOUSTON_MAX_CATALOG_BYTES + 1024),
  });
  assert.deepEqual(
    await loadHoustonSourcesFromOpenData({
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(oversized));
              controller.close();
            },
          }),
          { headers: { 'Content-Type': 'application/javascript' } },
        ),
      env: {},
    }),
    [],
  );
});

test('the pack box holds every place TranStar has a camera, and only Houston areas reach it', () => {
  const pack = CCTV_LIVE_PACKS.find((entry) => entry.name === 'houston');
  assert.ok(pack, 'Houston is a live pack');
  assert.deepEqual(
    [pack.country, pack.region, pack.box],
    ['US', 'TX', HOUSTON_BOX],
  );
  const inBox = ({ lat, lon }) =>
    lat >= HOUSTON_BOX.south &&
    lat <= HOUSTON_BOX.north &&
    lon >= HOUSTON_BOX.west &&
    lon <= HOUSTON_BOX.east;
  // The list's far ends (2026-11-04): the Galveston causeway, the Bolivar
  // ferry, IH-45 at Shepard Hill and IH-10 at Beckendorff Rd.
  for (const point of [
    { lat: 29.287241, lon: -94.869577 },
    { lat: 29.372139, lon: -94.75537 },
    { lat: 30.477976, lon: -95.496789 },
    { lat: 29.754549, lon: -96.254431 },
  ])
    assert.ok(inBox(point), JSON.stringify(point));
  const area = (lat, lon) => ({ lat, lon, radiusKm: 50 });
  assert.equal(areaOverlapsBox(area(29.7604, -95.3698), HOUSTON_BOX), true); // Downtown
  assert.equal(areaOverlapsBox(area(29.3013, -94.7977), HOUSTON_BOX), true); // Galveston
  assert.equal(areaOverlapsBox(area(30.2672, -97.7431), HOUSTON_BOX), false); // Austin
  assert.equal(areaOverlapsBox(area(32.7767, -96.797), HOUSTON_BOX), false); // Dallas
});

/**
 * A catalog with the Houston pack's flag, the TxDOT pack (which also covers
 * Houston) off and an optional US pack file, after one Houston area is
 * selected. Only TranStar's list answers.
 */
const DOWNTOWN = { lat: 29.7604, lon: -95.3698, radiusKm: 50 };
const runCatalogWithHoustonFlag = async (t, flag, { packFile } = {}) => {
  quiet(t);
  const sourceRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gev-cctv-houston-'),
  );
  t.after(() => fs.rmSync(sourceRoot, { recursive: true, force: true }));
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const href = String(url);
    requested.push(href);
    return href === HOUSTON_CAMERAS_URL
      ? Response.json({
          cameras: [
            row(),
            row({
              id: GALLERIA_ID,
              location: '610 WEST LOOP @ SAN FELIPE',
              lat: '29.749',
              lng: '-95.461',
              dir: 'West',
            }),
          ],
        })
      : new Response('unavailable', { status: 503 });
  });
  const file = path.join(sourceRoot, 'us.json');
  if (packFile) fs.writeFileSync(file, JSON.stringify(packFile));
  const env = {
    CCTV_SOURCES_FILE: file,
    CCTV_COUNTRIES: '*',
    CCTV_TXDOT_ENABLED: '0',
  };
  if (flag !== undefined) env.CCTV_HOUSTON_ENABLED = flag;
  const catalog = createCctvCatalog({ sourceRoot, env });
  await catalog.snapshot();
  assert.deepEqual(requested, [], 'no download before an area is selected');
  await catalog.ensureArea(DOWNTOWN);
  const { sources } = await catalog.snapshot();
  return { requested, sources };
};

test('CCTV_HOUSTON_ENABLED=1 wires the Houston pack into the catalog for a Houston area', async (t) => {
  const { requested, sources } = await runCatalogWithHoustonFlag(t, '1');
  assert.deepEqual(requested, [HOUSTON_CAMERAS_URL]);
  assert.deepEqual(
    sources
      .filter((s) => s.cityId === 'houston')
      .map((s) => s.id)
      .sort(),
    [`houston-${DOWNTOWN_ID}`, `houston-${GALLERIA_ID}`].sort(),
  );
  assert.ok(sources.every((s) => s.pack === 'houston'));
});

test('a camera the US pack file already holds is served once, as the file camera, beside the ones only the live list has', async (t) => {
  const camera = (id, name, lat, lon, still) => ({
    id,
    name,
    city: 'Texas',
    region: 'TX',
    lat,
    lon,
    p: 'drivetexas',
    feedType: 'image',
    url: HOUSTON_IMAGE_URL(still),
    feedFrom: 'inventory',
  });
  const { sources } = await runCatalogWithHoustonFlag(t, '1', {
    packFile: {
      format: 'gev-cctv-pack/1',
      defaults: {
        country: 'US',
        sourceKind: 'configured',
        headingConfidence: 'unknown',
      },
      providers: {
        drivetexas: {
          provider: 'DriveTexas',
          license: 'Texas Department of Transportation (listing: Road511)',
        },
      },
      cameras: [
        // TranStar camera 1002, as the pack file lists it.
        camera(
          'us511-TX-cam-downtown',
          'IH-10 East @ San Jacinto',
          29.76824,
          -95.355711,
          DOWNTOWN_ID,
        ),
        // No longer in TranStar's list: a switched-off camera stays.
        camera(
          'us511-TX-cam-retired',
          'IH-45 Gulf @ Retired',
          29.7,
          -95.3,
          '9999',
        ),
      ],
    },
  });
  assert.deepEqual(
    sources
      .filter((s) => String(s.url).startsWith(HOUSTON_IMAGE_ORIGIN))
      .map((s) => s.id)
      .sort(),
    [
      `houston-${GALLERIA_ID}`,
      'us511-TX-cam-downtown',
      'us511-TX-cam-retired',
    ].sort(),
  );
});

// TranStar's Content Usage terms need TxDOT's written permission, so an
// install that has not opted in must never contact it.
for (const [label, flag] of [
  ['an unset CCTV_HOUSTON_ENABLED', undefined],
  ['an empty CCTV_HOUSTON_ENABLED', ''],
  ['CCTV_HOUSTON_ENABLED=0', '0'],
  ['CCTV_HOUSTON_ENABLED=true', 'true'],
]) {
  test(`${label} makes no TranStar request`, async (t) => {
    const { requested, sources } = await runCatalogWithHoustonFlag(t, flag);
    assert.equal(
      requested.some((href) => href.includes('houstontranstar.org')),
      false,
    );
    assert.deepEqual(
      sources.filter((s) => s.cityId === 'houston'),
      [],
    );
  });
}
