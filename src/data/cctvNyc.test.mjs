import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  loadNycSourcesFromOpenData,
  nycCameraIsOnline,
  nycCameraName,
  nycCameraToSource,
} from '../../server/providers/cctv/sources.js';
import {
  NYC_CAMERAS_URL,
  NYC_GROUND_ELEVATION_M,
  NYC_IMAGE_ORIGIN,
  NYC_IMAGE_URL,
  NYC_MAX_CATALOG_BYTES,
} from '../../server/providers/cctv/constants.js';
import {
  CAMERA_CODE_MAX_CHARS,
  isLikelyNycCoordinate,
} from '../../server/providers/cctv/normalize.js';
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
      controller.enqueue(new TextEncoder().encode('['));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { response: new Response(body, init), state };
};

const MIDTOWN_ID = '8a6bc417-4877-4ebe-8052-88c1b261baf1';
const BROOKLYN_ID = '11111111-2222-3333-4444-555555555555';

/** One TMC camera row, shaped like the live `webcams.nyctmc.org` payload. */
const row = (overrides = {}) => ({
  id: MIDTOWN_ID,
  name: 'Central Park West @ 86 St',
  latitude: 40.785302,
  longitude: -73.969353,
  area: 'Manhattan',
  isOnline: 'true',
  imageUrl: NYC_IMAGE_URL(MIDTOWN_ID),
  ...overrides,
});

test('a NYC row maps to a source on the pinned HTTPS frame host', () => {
  const source = nycCameraToSource(row());
  assert.equal(source.id, `nyc-${MIDTOWN_ID}`);
  assert.equal(source.name, 'Central Park West @ 86 St');
  assert.equal(source.city, 'Manhattan');
  assert.equal(source.cityId, 'nyc');
  assert.equal(source.provider, 'NYC DOT Traffic Management Center');
  assert.equal(source.lat, 40.785302);
  assert.equal(source.lon, -73.969353);
  assert.equal(source.feedType, 'image');
  assert.equal(source.sourceKind, 'nyc-dot-tmc');
  assert.equal(
    source.license,
    'Public NYC DOT Traffic Management Center traffic camera',
  );
  assert.equal(source.groundElevationM, NYC_GROUND_ELEVATION_M);
  assert.equal(source.url, NYC_IMAGE_URL(MIDTOWN_ID));
  assert.equal(source.url, source.snapshotUrl);
  assert.ok(source.url.startsWith(NYC_IMAGE_ORIGIN));
  assert.equal(source.headingConfidence, 'low');
  assert.ok(Number.isFinite(source.headingDeg));
});

test('frame URLs are synthesized from the UUID; the payload URL is ignored', () => {
  const source = nycCameraToSource(
    row({ imageUrl: 'https://evil.example/cameras/x/image' }),
  );
  assert.equal(source.url, NYC_IMAGE_URL(MIDTOWN_ID));
  assert.equal(source.snapshotUrl, source.url);
});

test('offline cameras, off-city geometry and unusable ids are dropped', () => {
  assert.equal(nycCameraToSource(row({ isOnline: 'false' })), null);
  assert.equal(nycCameraToSource(row({ isOnline: false })), null);
  assert.equal(
    nycCameraToSource(row({ isOnline: 'TRUE' })).id,
    `nyc-${MIDTOWN_ID}`,
  );
  assert.equal(
    nycCameraToSource(row({ isOnline: true })).id,
    `nyc-${MIDTOWN_ID}`,
  );
  // Austin: a plausible lat/lon, but not a New York camera.
  assert.equal(
    nycCameraToSource(row({ latitude: 30.2672, longitude: -97.7431 })),
    null,
  );
  assert.equal(nycCameraToSource(row({ latitude: 0, longitude: 0 })), null);
  assert.equal(nycCameraToSource(row({ id: '../etc/passwd' })), null);
  assert.equal(nycCameraToSource(row({ id: 'not-a-uuid' })), null);
  assert.equal(nycCameraToSource(row({ id: `${MIDTOWN_ID}/../x` })), null);
  assert.equal(nycCameraToSource(null), null);
});

test('ids lower-case the UUID and unknown boroughs fall back to New York', () => {
  const mixed = nycCameraToSource(
    row({ id: MIDTOWN_ID.toUpperCase(), area: 'Long Island' }),
  );
  assert.equal(mixed.id, `nyc-${MIDTOWN_ID}`);
  assert.equal(mixed.city, 'New York');
  assert.equal(
    mixed.url,
    NYC_IMAGE_URL(MIDTOWN_ID.toUpperCase()),
    'the registered frame path keeps the catalog UUID spelling',
  );
});

test('a nameless row still gets a label', () => {
  assert.equal(
    nycCameraName({ name: '  FDR Drive @ 23 St ' }, 'nyc-x'),
    'FDR Drive @ 23 St',
  );
  assert.equal(nycCameraName({}, `nyc-${MIDTOWN_ID}`), 'NYC Camera 8a6bc417');
  assert.equal(nycCameraIsOnline('true'), true);
  assert.equal(nycCameraIsOnline('false'), false);
});

test('the unselected label is the intersection, trimmed to the code width', () => {
  assert.equal(nycCameraToSource(row()).code, 'CENTRAL PARK WEST @ 86 ST');
  const long = nycCameraToSource(
    row({
      name: 'Brooklyn Queens Expressway @ Atlantic Avenue / Flatbush Avenue Extension',
    }),
  );
  assert.ok(long.code.length <= CAMERA_CODE_MAX_CHARS);
  assert.ok(long.code.endsWith('…'));
  assert.ok(long.code.startsWith('BROOKLYN'));
});

test('the loader reads the keyless catalog and collapses duplicate ids', async (t) => {
  t.mock.method(console, 'log', () => {});
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requested.push([String(url), init.redirect]);
    return Response.json([
      row({ latitude: 40.758, longitude: -73.9855 }),
      row({
        name: 'Central Park West @ 86 St (duplicate)',
        latitude: 40.758,
        longitude: -73.9855,
      }),
      row({
        id: BROOKLYN_ID,
        name: 'Atlantic Ave @ Flatbush Ave',
        latitude: 40.65,
        longitude: -73.96,
        area: 'Brooklyn',
        imageUrl: NYC_IMAGE_URL(BROOKLYN_ID),
      }),
      row({ isOnline: 'false', name: 'Offline camera' }),
      row({ id: 'https://evil.example/x' }),
    ]);
  });
  const cameras = await loadNycSourcesFromOpenData();
  assert.deepEqual(requested, [[NYC_CAMERAS_URL, 'manual']]);
  assert.deepEqual(
    cameras.map((camera) => camera.id),
    // Nearest to a borough anchor first: the Times Square camera before Brooklyn.
    [`nyc-${MIDTOWN_ID}`, `nyc-${BROOKLYN_ID}`],
  );
  assert.equal(cameras[0].name, 'Central Park West @ 86 St');
  assert.equal(cameras[1].city, 'Brooklyn');
});

test('an upstream failure yields an empty pack and releases the response', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const failed = streamingResponse({ status: 503 });
  t.mock.method(globalThis, 'fetch', async () => failed.response);
  assert.deepEqual(await loadNycSourcesFromOpenData(), []);
  assert.equal(failed.state.cancelled, true, 'the failed body is cancelled');

  t.mock.restoreAll();
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('network down');
  });
  assert.deepEqual(await loadNycSourcesFromOpenData(), []);
});

test('the catalog fetch refuses redirects and oversized bodies', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const seen = [];
  const redirected = streamingResponse({
    status: 302,
    headers: { location: 'https://evil.example/cameras.json' },
  });
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    seen.push([String(url), init.redirect]);
    return redirected.response;
  });
  assert.deepEqual(await loadNycSourcesFromOpenData(), []);
  assert.deepEqual(seen, [[NYC_CAMERAS_URL, 'manual']]);
  assert.equal(
    redirected.state.cancelled,
    true,
    'the redirect body is cancelled',
  );

  t.mock.restoreAll();
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => {
    const body = JSON.stringify([row()]);
    return new Response(body, {
      headers: {
        'Content-Type': 'application/json',
        'content-length': String(NYC_MAX_CATALOG_BYTES + 1),
      },
    });
  });
  assert.deepEqual(await loadNycSourcesFromOpenData(), []);

  t.mock.restoreAll();
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => {
    const oversized = 'x'.repeat(NYC_MAX_CATALOG_BYTES + 1024);
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(oversized));
          controller.close();
        },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  });
  assert.deepEqual(await loadNycSourcesFromOpenData(), []);
});

/**
 * The NYC lane is a live pack like the others
 * (server/providers/cctv/live-packs.js): a New York area downloads its
 * catalog, and only when CCTV_NYC_ENABLED=1, because NYC DOT asks for a
 * data-sharing agreement. Every other live pack is down here; only NYC
 * answers.
 */
const MANHATTAN = { lat: 40.758, lon: -73.9855, radiusKm: 50 };
const runCatalogWithNycFlag = async (t, flag) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-cctv-nyc-'));
  t.after(() => fs.rmSync(sourceRoot, { recursive: true, force: true }));
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const href = String(url);
    requested.push(href);
    return href === NYC_CAMERAS_URL
      ? Response.json([
          row({ latitude: 40.758, longitude: -73.9855 }),
          row({
            id: BROOKLYN_ID,
            name: 'Atlantic Ave @ Flatbush Ave',
            latitude: 40.65,
            longitude: -73.96,
            area: 'Brooklyn',
          }),
        ])
      : new Response('unavailable', { status: 503 });
  });
  const env = {
    CCTV_SOURCES_FILE: path.join(sourceRoot, 'none.json'),
    CCTV_COUNTRIES: '*',
  };
  if (flag !== undefined) env.CCTV_NYC_ENABLED = flag;
  const catalog = createCctvCatalog({ sourceRoot, env });
  assert.equal((await catalog.snapshot()).total, 0, 'nothing at startup');
  assert.deepEqual(requested, [], 'no download before an area is selected');
  await catalog.ensureArea(MANHATTAN);
  const { sources } = await catalog.snapshot();
  return { requested, sources };
};

test('CCTV_NYC_ENABLED=1 wires the NYC lane into the catalog', async (t) => {
  const { requested, sources } = await runCatalogWithNycFlag(t, '1');
  assert.deepEqual(
    requested,
    [NYC_CAMERAS_URL],
    'a New York area downloads the NYC catalog and nothing else',
  );
  assert.deepEqual(
    sources
      .filter((s) => s.cityId === 'nyc')
      .map((s) => s.id)
      .sort(),
    [`nyc-${MIDTOWN_ID}`, `nyc-${BROOKLYN_ID}`].sort(),
    'NYC cameras reach the served catalog through the registered lane',
  );
  assert.ok(
    sources.every((s) => s.pack === 'nyc'),
    'every camera served here is the NYC pack',
  );
});

// NYC DOT requires a data-sharing agreement for this feed, so an install that
// has not opted in must never contact it, whatever else the flag holds.
for (const [label, flag] of [
  ['an unset CCTV_NYC_ENABLED', undefined],
  ['an empty CCTV_NYC_ENABLED', ''],
  ['CCTV_NYC_ENABLED=0', '0'],
  ['CCTV_NYC_ENABLED=true', 'true'],
]) {
  test(`${label} makes no NYC request`, async (t) => {
    const { requested, sources } = await runCatalogWithNycFlag(t, flag);
    assert.equal(
      requested.some((href) => href.includes('nyctmc.org')),
      false,
      'the lane never reaches its upstream',
    );
    assert.deepEqual(
      sources.filter((s) => s.cityId === 'nyc'),
      [],
    );
  });
}

test('isLikelyNycCoordinate spans the five boroughs and rejects the rest', () => {
  assert.equal(isLikelyNycCoordinate(40.758, -73.9855), true); // Times Square
  assert.equal(isLikelyNycCoordinate(40.5795, -74.1502), true); // Staten Island
  assert.equal(isLikelyNycCoordinate(40.8448, -73.8648), true); // Bronx
  assert.equal(isLikelyNycCoordinate(40.5077, -74.2304), true); // southern SI slack
  assert.equal(isLikelyNycCoordinate(30.2672, -97.7431), false); // Austin
  assert.equal(isLikelyNycCoordinate(0, 0), false);
  assert.equal(isLikelyNycCoordinate(NaN, -73.98), false);
});
