import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  loadVegvesenSourcesFromOpenData,
  vegvesenCameraToSource,
} from '../../server/providers/cctv/sources.js';
import {
  DEFAULT_VEGVESEN_CCTV_URL,
  VEGVESEN_IMAGE_ORIGIN,
} from '../../server/providers/cctv/constants.js';
import { createCctvCatalog } from '../../server/providers/cctv/catalog.js';
import { CCTV_LIVE_PACKS } from '../../server/providers/cctv/live-packs.js';

/** One `datex_3_1:CctvSimple` feature, shaped like the live OGC payload. */
const feature = (props = {}, coordinates = [5.459189, 61.832706]) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates },
  properties: {
    stillImageUrl: 'https://kamera.atlas.vegvesen.no/api/images/3000063_1',
    cameraId: '3000063_1',
    roadNumber: 'F614',
    'status.stillImageAvailability': 'videoOrImagesAvailable',
    orientationDescription: 'Svelgen',
    description: 'Langesi',
    ...props,
  },
});

test('a Vegvesen feature maps to a source on the pinned frame host', () => {
  const source = vegvesenCameraToSource(feature());
  assert.equal(source.id, 'no-vegvesen-3000063_1');
  assert.equal(source.name, 'F614 Langesi → Svelgen');
  assert.equal(source.city, 'Norway');
  assert.equal(source.cityId, 'norway');
  assert.equal(source.provider, 'Statens vegvesen');
  assert.equal(source.lat, 61.832706);
  assert.equal(source.lon, 5.459189);
  assert.equal(source.headingConfidence, 'low');
  assert.equal(source.sourceKind, 'vegvesen-datex');
  assert.equal(source.code, 'LANGESI');
  assert.ok(source.url.startsWith(VEGVESEN_IMAGE_ORIGIN));
  assert.equal(source.snapshotUrl, source.url);
});

test('cameras that publish HLS get live video with the still as fallback', (t) => {
  const video = {
    videoServiceLevel: 1,
    videoEncodingStandard: 'hls',
    videoUrl: 'https://kamera.vegvesen.no/public/3000063_1/manifest.m3u8',
  };
  const source = vegvesenCameraToSource(feature(video));
  assert.equal(source.feedType, 'hls');
  assert.equal(source.url, video.videoUrl);
  assert.equal(
    source.snapshotUrl,
    'https://kamera.atlas.vegvesen.no/api/images/3000063_1',
  );
  // A manifest anywhere but the camera's own path stays a still.
  const offPath = vegvesenCameraToSource(
    feature({ ...video, videoUrl: 'https://evil.test/x/manifest.m3u8' }),
  );
  assert.equal(offPath.feedType, 'image');
  assert.equal(offPath.url, offPath.snapshotUrl);
  // The kill switch keeps every camera on stills.
  const saved = process.env.CCTV_VEGVESEN_VIDEO;
  t.after(() => {
    if (saved === undefined) delete process.env.CCTV_VEGVESEN_VIDEO;
    else process.env.CCTV_VEGVESEN_VIDEO = saved;
  });
  process.env.CCTV_VEGVESEN_VIDEO = '0';
  assert.equal(vegvesenCameraToSource(feature(video)).feedType, 'image');
});

test('a faulty camera is kept; off-host frames and bad geometry are dropped', () => {
  // Cameras come back: one the feed reports as faulty stays in the pack.
  assert.equal(
    vegvesenCameraToSource(
      feature({
        'status.stillImageAvailability':
          'videoOrImagesUnavailableDueToCameraFault',
      }),
    )?.id,
    'no-vegvesen-3000063_1',
  );
  assert.equal(
    vegvesenCameraToSource(
      feature({ stillImageUrl: 'https://evil.test/api/images/3000063_1' }),
    ),
    null,
  );
  // The frame URL must be exactly the camera's own image path.
  assert.equal(
    vegvesenCameraToSource(
      feature({
        stillImageUrl: 'https://kamera.atlas.vegvesen.no/api/images/999_1',
      }),
    ),
    null,
  );
  assert.equal(vegvesenCameraToSource(feature({ cameraId: '../x' })), null);
  // Copenhagen: a plausible coordinate, but outside the Norway box.
  assert.equal(vegvesenCameraToSource(feature({}, [12.57, 55.68])), null);
  assert.equal(vegvesenCameraToSource(feature({}, [5.4])), null);
  assert.equal(vegvesenCameraToSource(null), null);
});

test('the loader dedupes, and failures degrade to an empty pack', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const requested = [];
  const fetchMock = t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    return Response.json({
      type: 'FeatureCollection',
      features: [
        feature(),
        feature(),
        feature(
          {
            cameraId: '0629001_1',
            stillImageUrl:
              'https://kamera.atlas.vegvesen.no/api/images/0629001_1',
            description: 'Oslo S',
          },
          [10.752, 59.911],
        ),
      ],
    });
  });
  const cameras = await loadVegvesenSourcesFromOpenData();
  assert.deepEqual(requested, [DEFAULT_VEGVESEN_CCTV_URL]);
  // Every camera, in the feed's order: no cap, no city ranking.
  assert.deepEqual(
    cameras.map((c) => c.id),
    ['no-vegvesen-3000063_1', 'no-vegvesen-0629001_1'],
  );

  fetchMock.mock.mockImplementation(
    async () => new Response('nope', { status: 503 }),
  );
  assert.deepEqual(await loadVegvesenSourcesFromOpenData(), []);
  fetchMock.mock.mockImplementation(async () => {
    throw new Error('offline');
  });
  assert.deepEqual(await loadVegvesenSourcesFromOpenData(), []);
});

test('a Norwegian area loads the Vegvesen live pack, and CCTV_VEGVESEN_ENABLED=0 skips the request', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const sourceRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gev-cctv-catalog-'),
  );
  t.after(() => fs.rmSync(sourceRoot, { recursive: true, force: true }));
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    // Every other live pack is down; only Vegvesen answers.
    return String(url) === DEFAULT_VEGVESEN_CCTV_URL
      ? Response.json({ type: 'FeatureCollection', features: [feature()] })
      : new Response('unavailable', { status: 503 });
  });
  const env = {
    CCTV_SOURCES_FILE: path.join(sourceRoot, 'none.json'),
    CCTV_COUNTRIES: '*',
  };
  const SVELGEN = { lat: 61.83, lon: 5.46, radiusKm: 50 };

  const catalog = createCctvCatalog({ sourceRoot, env });
  assert.equal((await catalog.snapshot()).total, 0, 'nothing at startup');
  assert.deepEqual(requested, [], 'no download before an area is selected');
  await catalog.ensureArea(SVELGEN);
  assert.deepEqual(requested, [DEFAULT_VEGVESEN_CCTV_URL]);
  const { sources } = await catalog.snapshot();
  assert.deepEqual(
    sources.map((source) => source.id),
    ['no-vegvesen-3000063_1'],
  );
  assert.equal(sources[0].pack, 'vegvesen');

  requested.length = 0;
  const off = createCctvCatalog({
    sourceRoot,
    cacheDir: path.join(sourceRoot, 'other-cache'),
    env: { ...env, CCTV_VEGVESEN_ENABLED: '0' },
  });
  await off.ensureArea(SVELGEN);
  assert.deepEqual((await off.snapshot()).sources, []);
  assert.equal(
    requested.includes(DEFAULT_VEGVESEN_CCTV_URL),
    false,
    'a disabled pack makes no request',
  );
});

test('the Vegvesen pack covers Norway and carries no cap', () => {
  const pack = CCTV_LIVE_PACKS.find((entry) => entry.name === 'vegvesen');
  assert.equal(pack.country, 'NO');
  assert.ok(pack.box.south <= 58 && pack.box.north >= 71);
  assert.ok(pack.box.west <= 5 && pack.box.east >= 31);
});
