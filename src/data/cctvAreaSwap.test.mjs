// src/data/cctvAreaSwap.test.mjs — area-scoped CCTV loading.
//
// The layer holds the cameras nearest one selected place (at most 2,500 within
// 50 km) plus this machine's private cameras. A place outside the loaded area
// swaps it by id: kept cameras keep their record objects, cameras that left
// release everything built for them, and only added cameras cost ground
// priors and geometry. Stale responses never land, a covered selection costs
// no request, and a layer that is off only remembers the place.
//
// Real layer paths under node:test (cctvTestHarness.mjs); no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import cctvLayer, {
  _cctvRecordForTest,
  _reloadCctvPrivateCamerasForTest,
  _setCctvGroundPriorResolverForTest,
  cctvAreaCovers,
  setActiveCamera,
} from './cctv.js';
import {
  ATLANTA,
  AUSTIN,
  LOOKUP_CAMERA,
  OFFSHORE,
  SAN_MARCOS,
  TORONTO,
  areaAnswer,
  areaReport,
  cardIds,
  deferred,
  installDomFakes,
  installPriorResolver,
  jsonResponse,
  makeBillboards,
  makeCameraServer,
  makeRecord,
  makeSource,
  makeViewer,
  moveViewer,
  primeLayer,
  sleep,
  waitFor,
} from './cctvTestHarness.mjs';

const cameraIds = () => cctvLayer.getUIState().cameras.map((camera) => camera.id);

test('cctvAreaCovers keeps a selection within max(cover·0.5, cover − 10 km) of the area centre', () => {
  const area = { lat: AUSTIN.lat, lon: AUSTIN.lon, radiusKm: 50, reachKm: 50, capped: false };
  const east = (km) => ({ lat: AUSTIN.lat, lon: AUSTIN.lon + km / 96.1 });
  assert.equal(cctvAreaCovers(area, east(39)), true);
  assert.equal(cctvAreaCovers(area, east(41)), false);
  // A capped area covers only its reach: 20 km → max(10, 10) = 10 km.
  const dense = { ...area, capped: true, reachKm: 20 };
  assert.equal(cctvAreaCovers(dense, east(9)), true);
  assert.equal(cctvAreaCovers(dense, east(12)), false);
  assert.equal(cctvAreaCovers(null, AUSTIN), false);
  assert.equal(cctvAreaCovers(area, null), false);
});

test('an area swap keeps shared cameras as the same records, releases the rest, and fetches priors only for new ones', async (t) => {
  const server = makeCameraServer({
    areas: ({ lat }) => (lat > 30
      ? areaAnswer(AUSTIN, [
        makeSource('a0', AUSTIN, 0.012),
        makeSource('a1', AUSTIN, 0.024),
        makeSource('shared', AUSTIN, 0.036),
      ])
      : areaAnswer(SAN_MARCOS, [
        makeSource('shared', AUSTIN, 0.036),
        makeSource('s0', SAN_MARCOS, 0.012),
        makeSource('s1', SAN_MARCOS, 0.024),
      ])),
  });
  installDomFakes(t, { fetch: server.handler });
  const priors = installPriorResolver(t);
  const viewer = makeViewer(AUSTIN);
  const billboards = makeBillboards();
  const home = makeRecord('home-front', AUSTIN, -0.012, { sourceKind: 'private' });
  const host = primeLayer(t, { viewer, records: [home], billboards, coverageMode: 'on' });

  assert.equal(await cctvLayer.onLocationSelect({ point: AUSTIN, enabled: true }), true);
  assert.deepEqual(cameraIds(), ['a0', 'a1', 'shared', 'home-front'], 'the area nearest first, then private cameras');
  assert.equal(billboards.live.size, 3);
  assert.deepEqual(priors.map((batch) => batch.length), [3]);
  assert.equal(cctvLayer.getUIState().area.ready, true);
  assert.equal(cctvLayer.getUIState().area.loaded, 3);

  assert.equal(setActiveCamera('a1'), 'activated');
  const a0 = _cctvRecordForTest('a0');
  const a1 = _cctvRecordForTest('a1');
  const shared = _cctvRecordForTest('shared');
  const a1Runtime = a1.projection;
  const a1Billboard = a1.billboard;
  assert.ok(a1Runtime.planeEntity, 'activation built a monitor plane');
  assert.equal(a0.coverageEntities.length, 5);
  assert.ok(cardIds(host).includes('a0'));

  moveViewer(viewer, SAN_MARCOS);
  assert.equal(await cctvLayer.onLocationSelect({ point: SAN_MARCOS, enabled: true }), true);
  assert.equal(server.calls.sources.length, 2);
  assert.deepEqual(cameraIds(), ['shared', 's0', 's1', 'home-front']);
  assert.equal(_cctvRecordForTest('shared'), shared, 'a kept camera keeps its record object');
  assert.equal(shared.coverageEntities.length, 5, 'and what was built for it');
  assert.equal(_cctvRecordForTest('home-front'), home, 'private cameras are never swapped out');
  assert.deepEqual(priors.map((batch) => batch.length), [3, 2], 'ground priors only for the cameras the swap adds');

  // Everything built for the cameras that left is released.
  assert.equal(_cctvRecordForTest('a1'), null);
  assert.equal(a1.destroyed, true);
  assert.equal(cctvLayer.getUIState().activeCameraId, null, 'the active camera left with its area');
  assert.equal(a1.projection, null);
  assert.equal(a1Runtime.planeEntity, null);
  assert.equal(viewer.entities.getById('cctv-a1-plane'), undefined);
  assert.equal(viewer.entities.getById('cctv-a0-cap'), undefined);
  assert.equal(a0.coverageEntities.length, 0);
  assert.equal(billboards.live.has(a1Billboard), false);
  assert.equal(billboards.live.size, 3);
  assert.ok(cardIds(host).every((id) => id !== 'a0' && id !== 'a1'), 'their map cards are gone');
});

test('a capped area holds at most 2,500 cameras and the loading total stays within it', async (t) => {
  const sources = Array.from({ length: 2_600 }, (_, index) => makeSource(`atl-${index}`, ATLANTA, index * 0.00005));
  const server = makeCameraServer({
    areas: () => areaAnswer(ATLANTA, sources, { inArea: 2_817, loaded: 2_500, dropped: 317, capped: true, reachKm: 44 }),
  });
  installDomFakes(t, { fetch: server.handler });
  installPriorResolver(t);
  primeLayer(t, { viewer: makeViewer(ATLANTA), billboards: makeBillboards() });

  assert.equal(await cctvLayer.onLocationSelect({ point: ATLANTA }), true);
  const state = cctvLayer.getUIState();
  assert.equal(state.cameras.length, 2_500, 'the client never holds more than the cap');
  assert.equal(state.area.capped, true);
  assert.equal(state.area.loaded, 2_500);
  assert.equal(state.area.dropped, 317);
  const stats = cctvLayer.getStats();
  assert.ok(stats.loadingTotal > 0 && stats.loadingTotal <= 2_500, `loadingTotal ${stats.loadingTotal}`);

  // The cap cut the area at 44 km, so it covers max(22, 34) = 34 km: 20 km away loads nothing.
  assert.equal(await cctvLayer.onLocationSelect({ point: { lat: ATLANTA.lat + 0.18, lon: ATLANTA.lon } }), false);
  assert.equal(server.calls.sources.length, 1);
});

test('re-enabling queues only cameras still unresolved and never refetches a loaded area', async (t) => {
  const server = makeCameraServer({
    areas: () => areaAnswer(AUSTIN, [
      makeSource('a0', AUSTIN, 0.012),
      makeSource('a1', AUSTIN, 0.024),
      makeSource('a2', AUSTIN, 0.036),
    ]),
  });
  installDomFakes(t, { fetch: server.handler });
  installPriorResolver(t);
  primeLayer(t, { viewer: makeViewer(AUSTIN), billboards: makeBillboards() });

  await cctvLayer.onLocationSelect({ point: AUSTIN });
  assert.equal(cctvLayer.getStats().loadingTotal, 3, 'only the added cameras are queued');
  await waitFor(() => !cctvLayer.getStats().loading);

  cctvLayer.disable();
  cctvLayer.enable();
  const stats = cctvLayer.getStats();
  assert.equal(stats.loading, false, 'every camera already resolved');
  assert.equal(stats.loadingTotal, 0);
  assert.equal(server.calls.sources.length, 1);
});

test('a response for an older selection never lands', async (t) => {
  const austin = deferred();
  const toronto = deferred();
  const server = makeCameraServer({ areas: ({ lat }) => (lat > 40 ? toronto.promise : austin.promise) });
  installDomFakes(t, { fetch: server.handler });
  installPriorResolver(t);
  primeLayer(t, { viewer: makeViewer(AUSTIN), billboards: makeBillboards() });

  const first = cctvLayer.onLocationSelect({ point: AUSTIN });
  const second = cctvLayer.onLocationSelect({ point: TORONTO });
  assert.equal(cctvLayer.getUIState().area.loading, true);
  toronto.resolve(areaAnswer(TORONTO, [makeSource('t0', TORONTO, 0.012)]));
  assert.equal(await second, true);
  austin.resolve(areaAnswer(AUSTIN, [makeSource('a0', AUSTIN, 0.012)]));
  assert.equal(await first, false);
  assert.deepEqual(cameraIds(), ['t0']);
  assert.equal(cctvLayer.getUIState().area.lat, TORONTO.lat);
  assert.equal(cctvLayer.getUIState().area.loading, false);
});

test('a selection inside the area fetches nothing, outside it fetches once, and a layer that is off fetches nothing', async (t) => {
  const server = makeCameraServer({
    areas: (query) => areaAnswer(query, [makeSource(`cam-${query.lat.toFixed(2)}`, query, 0.012)]),
  });
  installDomFakes(t, { fetch: server.handler });
  installPriorResolver(t);
  primeLayer(t, { viewer: makeViewer(AUSTIN), billboards: makeBillboards() });

  assert.equal(await cctvLayer.onLocationSelect({ point: AUSTIN }), true);
  assert.deepEqual(server.calls.sources, [{ lat: AUSTIN.lat, lon: AUSTIN.lon, radiusKm: 50 }]);
  // ~30 km east is inside max(50·0.5, 50 − 10) = 40 km.
  assert.equal(await cctvLayer.onLocationSelect({ point: { lat: AUSTIN.lat, lon: AUSTIN.lon + 0.31 } }), false);
  assert.equal(server.calls.sources.length, 1);
  // Same state, outside the area: the cameras move.
  assert.equal(await cctvLayer.onLocationSelect({ point: SAN_MARCOS }), true);
  assert.equal(server.calls.sources.length, 2);

  cctvLayer.disable();
  assert.equal(cctvLayer.onLocationSelect({ point: TORONTO, enabled: false }), undefined);
  assert.equal(server.calls.sources.length, 2, 'off: the place is only remembered');
  cctvLayer.enable();
  await waitFor(() => !cctvLayer.getUIState().area.loading);
  assert.equal(server.calls.sources.length, 3, 'enable loads the place selected while off');
  assert.equal(cctvLayer.getUIState().area.lat, TORONTO.lat);
});

test('uiState cameras are light entries rebuilt only when the camera set changes', async (t) => {
  const server = makeCameraServer({
    areas: (query) => areaAnswer(query, [makeSource(`cam-${query.lat.toFixed(2)}`, query, 0.012)]),
  });
  installDomFakes(t, { fetch: server.handler });
  installPriorResolver(t);
  primeLayer(t, { viewer: makeViewer(AUSTIN), billboards: makeBillboards() });

  await cctvLayer.onLocationSelect({ point: AUSTIN });
  const first = cctvLayer.getUIState().cameras;
  assert.equal(cctvLayer.getUIState().cameras, first, 'the same list between notifications');
  assert.deepEqual(Object.keys(first[0]).sort(), [
    'city', 'feedType', 'id', 'lat', 'lon', 'lookup', 'lookupState', 'name', 'provider', 'sourceKind',
  ]);
  assert.equal(setActiveCamera(first[0].id), 'activated');
  assert.equal(cctvLayer.getUIState().cameras, first, 'an activation keeps the list');
  assert.match(cctvLayer.getCameraState(first[0].id).frameUrl, /active=1/, 'full state stays one call away');

  await cctvLayer.onLocationSelect({ point: SAN_MARCOS });
  assert.notEqual(cctvLayer.getUIState().cameras, first);
});

test('the enable default is the nearest camera with a still within 50 km, never the first or a lookup camera', (t) => {
  const server = makeCameraServer();
  installDomFakes(t, { fetch: server.handler });
  const records = [
    makeRecord('toronto-still', TORONTO),
    makeRecord('austin-lookup', AUSTIN, 0.001, LOOKUP_CAMERA),
    makeRecord('austin-still', AUSTIN, 0.2),
  ];
  primeLayer(t, { viewer: makeViewer(AUSTIN), records, enabled: false, area: areaReport(AUSTIN, records) });

  cctvLayer.enable();
  assert.equal(cctvLayer.getUIState().activeCameraId, 'austin-still');
  assert.equal(server.calls.lookups.length, 0, 'a default sends no lookup');
  assert.equal(server.calls.sources.length, 0, 'the loaded area is not fetched again');
});

test('the first area loads only below 400 km and, with no camera near the view, picks its nearest camera with a still', async (t) => {
  const server = makeCameraServer({
    areas: (query) => areaAnswer(query, [
      makeSource('austin-lookup', AUSTIN, 0.001, LOOKUP_CAMERA),
      makeSource('austin-still', AUSTIN, 0.012),
    ]),
  });
  installDomFakes(t, { fetch: server.handler });
  installPriorResolver(t);
  const viewer = makeViewer(AUSTIN, 10_000_000);
  primeLayer(t, { viewer, billboards: makeBillboards(), enabled: false });

  cctvLayer.enable();
  assert.equal(server.calls.sources.length, 0, 'never at globe view');
  cctvLayer.disable();
  moveViewer(viewer, AUSTIN);
  cctvLayer.enable();
  assert.equal(server.calls.sources.length, 1);
  assert.equal(cctvLayer.getUIState().area.loading, true);
  await waitFor(() => cctvLayer.getUIState().area.ready);
  assert.equal(cctvLayer.getUIState().activeCameraId, 'austin-still');
  assert.equal(server.calls.lookups.length, 0);
});

test('NEAREST and the enable default load no area from globe altitude, so a later low view still loads', async (t) => {
  const server = makeCameraServer({
    areas: (query) => areaAnswer(query, [makeSource(`cam-${query.lat.toFixed(2)}`, query, 0.012)]),
  });
  installDomFakes(t, { fetch: server.handler });
  installPriorResolver(t);
  const viewer = makeViewer(OFFSHORE, 20_000_000);
  primeLayer(t, { viewer, billboards: makeBillboards(), enabled: false });

  // The shell's enable transition, then the NEAREST button, over open water.
  cctvLayer.enable();
  assert.equal(cctvLayer.focusNearest({ focus: false, explicit: false }), null);
  assert.equal(cctvLayer.focusNearest({ focus: false }), null);
  await sleep(10);
  assert.equal(server.calls.sources.length, 0, 'the point under a globe view is not a place');
  assert.equal(cctvLayer.getUIState().area.ready, false);

  // Zoomed in over Toronto: the next settle loads it.
  moveViewer(viewer, TORONTO);
  cctvLayer.disable();
  cctvLayer.enable();
  await waitFor(() => cctvLayer.getUIState().area.ready && !cctvLayer.getUIState().area.loading);
  assert.deepEqual(server.calls.sources, [{ lat: TORONTO.lat, lon: TORONTO.lon, radiusKm: 50 }]);
  assert.equal(cctvLayer.getUIState().cameras.length, 1);
});

test('a seeded area follows a low settle outside it; a chosen place or an explicit NEAREST stays put', async (t) => {
  const server = makeCameraServer({
    areas: (query) => areaAnswer(query, [makeSource(`cam-${query.lat.toFixed(2)}`, query, 0.012)]),
  });
  installDomFakes(t, { fetch: server.handler });
  installPriorResolver(t);
  const viewer = makeViewer(AUSTIN);
  primeLayer(t, { viewer, billboards: makeBillboards(), enabled: false });
  const areaLat = () => cctvLayer.getUIState().area.lat;
  const idle = () => cctvLayer.getUIState().area.ready && !cctvLayer.getUIState().area.loading;
  // No moveEnd seam under node:test: a disable/enable cycle runs the same settle check.
  const settle = async (point, heightM = 4_000) => {
    moveViewer(viewer, point, heightM);
    cctvLayer.disable();
    cctvLayer.enable();
    await waitFor(idle);
  };

  cctvLayer.enable();
  await waitFor(idle);
  assert.equal(server.calls.sources.length, 1, 'the first low settle seeds the area');
  await settle({ lat: AUSTIN.lat, lon: AUSTIN.lon + 0.31 });
  assert.equal(server.calls.sources.length, 1, 'a settle the seeded area covers fetches nothing');
  await settle(SAN_MARCOS);
  assert.equal(server.calls.sources.length, 2, 'a settle outside a seeded area moves it');
  assert.equal(areaLat(), SAN_MARCOS.lat);
  await settle(TORONTO, 20_000_000);
  assert.equal(server.calls.sources.length, 2, 'never from globe altitude');

  // A chosen place is kept when the view wanders off.
  moveViewer(viewer, TORONTO);
  assert.equal(await cctvLayer.onLocationSelect({ point: TORONTO }), true);
  assert.equal(server.calls.sources.length, 3);
  await settle(AUSTIN);
  assert.equal(server.calls.sources.length, 3, 'a selected area stays');
  assert.equal(areaLat(), TORONTO.lat);

  // An explicit NEAREST outside it re-centres, and that area stays too.
  assert.equal(cctvLayer.focusNearest({ focus: false }), null);
  await waitFor(() => idle() && areaLat() === AUSTIN.lat);
  assert.equal(server.calls.sources.length, 4);
  await settle(SAN_MARCOS);
  assert.equal(server.calls.sources.length, 4, 'an explicit NEAREST area stays');

  // The enable default (not explicit) re-centres like a seed, so a later settle may move it.
  moveViewer(viewer, ATLANTA);
  assert.equal(cctvLayer.focusNearest({ focus: false, explicit: false }), null);
  await waitFor(() => idle() && areaLat() === ATLANTA.lat);
  assert.equal(server.calls.sources.length, 5);
  await settle(TORONTO);
  assert.equal(server.calls.sources.length, 6);
  assert.equal(areaLat(), TORONTO.lat);
});

test('a private camera reload swaps its records before it notifies, and a second reload queues behind it', async (t) => {
  let gate = deferred();
  const priorBatches = [];
  _setCctvGroundPriorResolverForTest(async (coords) => {
    priorBatches.push(coords.length);
    await gate.promise;
    return coords.map(() => ({ ellipsoid: 120, source: 'reearth' }));
  });
  t.after(() => _setCctvGroundPriorResolverForTest(null));
  const privateSource = (dLon) => makeSource('home-1', AUSTIN, dLon, {
    sourceKind: 'private',
    frameUrl: '/api/private-cams/frame/home-1',
  });
  let listed = [privateSource(0.01)];
  let listFetches = 0;
  installDomFakes(t, {
    fetch: async (url) => {
      if (new URL(url, 'http://localhost').pathname !== '/api/private-cams/sources') return undefined;
      listFetches += 1;
      return jsonResponse({ sources: listed });
    },
  });
  primeLayer(t, { viewer: makeViewer(AUSTIN), billboards: makeBillboards(), enabled: false });
  const notified = [];
  const unsubscribe = cctvLayer.subscribe((state) => notified.push(state.cameras.map((camera) => camera.id)));
  t.after(unsubscribe);
  notified.length = 0;

  // SAVE SITE, then a second save moving the same camera before the first swap lands.
  const first = _reloadCctvPrivateCamerasForTest();
  await waitFor(() => priorBatches.length === 1);
  listed = [privateSource(0.02)];
  const second = _reloadCctvPrivateCamerasForTest();
  await sleep(20);
  assert.equal(listFetches, 1, 'the second reload waits for the first swap');
  assert.deepEqual(notified, [], 'no notification before the records change');

  gate.resolve();
  await first;
  assert.deepEqual(notified.at(-1), ['home-1'], 'the notification carries the new camera');
  await second;
  assert.equal(listFetches, 2);
  const record = _cctvRecordForTest('home-1');
  assert.ok(record, 'the camera is listed');
  assert.ok(Math.abs(record.camera.basePose.lon - (AUSTIN.lon + 0.02)) < 1e-9, 'the second save wins');
  assert.equal(cctvLayer.getStats().error, null);
  gate = null;
});
