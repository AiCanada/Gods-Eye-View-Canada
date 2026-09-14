// src/data/cctvLocationSwitch.test.mjs — CCTV location-switch hooks.
//
// Selecting a place in another region calls cctvLayer.onLocationLeave as the
// flight starts and onLocationArrive once it lands. Leave releases everything
// built for the view being left (map cards, monitor-plane runtimes, the active
// camera, wireframes and viewshed volumes away from the destination); the
// loaded camera records stay until an area swap replaces them. Arrival waits
// for the destination's area load, then reloads for the destination without
// flying. The layer stays enabled throughout.
//
// Runs the real layer paths under plain node:test with a fake viewer, overlay
// host, canvas/Image/document seams and a network-free fetch
// (cctvTestHarness.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cctvLayer, {
  _cctvRecordForTest,
  cctvRecordsWithinKm,
  deactivateActiveCamera,
  maybeAutoHop,
  setActiveCamera,
} from './cctv.js';
import {
  AUSTIN,
  LOOKUP_CAMERA,
  OFFSHORE,
  ONTARIO,
  TEXAS,
  TORONTO,
  areaAnswer,
  areaReport,
  cardIds,
  deferred,
  installDomFakes,
  installPriorResolver,
  lastCards,
  makeCameraServer,
  makeRecord,
  makeSource,
  makeViewer,
  moveViewer,
  place,
  primeLayer,
  sleep,
} from './cctvTestHarness.mjs';

const CCTV_SOURCE = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'cctv.js'),
  'utf8',
);

test('cctvRecordsWithinKm lists cameras inside the radius, nearest first', () => {
  const records = [
    makeRecord('far', TORONTO),
    makeRecord('mid', AUSTIN, 0.3), // ~29 km east
    makeRecord('near', AUSTIN, 0.01), // ~1 km east
    { camera: { id: 'no-coordinates' } },
  ];
  const within = cctvRecordsWithinKm(records, AUSTIN.lat, AUSTIN.lon, 50);
  assert.deepEqual(within.map(({ record }) => record.camera.id), ['near', 'mid']);
  assert.ok(within[0].distKm > 0.9 && within[0].distKm < 1.1);
  assert.ok(within[1].distKm > 28 && within[1].distKm < 30);
  assert.equal(cctvRecordsWithinKm(records, AUSTIN.lat, AUSTIN.lon, 0.5).length, 0);
  assert.equal(cctvRecordsWithinKm(records, AUSTIN.lat, AUSTIN.lon, Infinity).length, 3);
  assert.deepEqual(cctvRecordsWithinKm(records, Number.NaN, AUSTIN.lon, 50), []);
  assert.deepEqual(cctvRecordsWithinKm(records, AUSTIN.lat, AUSTIN.lon, -1), []);
  assert.deepEqual(cctvRecordsWithinKm(null, AUSTIN.lat, AUSTIN.lon, 50), []);
});

test('leaving a region releases the old view but keeps the layer on and the catalogue', (t) => {
  const { images } = installDomFakes(t);
  const viewer = makeViewer(AUSTIN);
  const records = [
    makeRecord('austin-0', AUSTIN),
    makeRecord('austin-1', AUSTIN, 0.02),
    makeRecord('austin-2', AUSTIN, -0.02),
    makeRecord('toronto-0', TORONTO),
  ];
  const host = primeLayer(t, { viewer, records, coverageMode: 'on' });
  t.after(() => cctvLayer.setParams({ autoHop: false }));

  assert.equal(setActiveCamera('austin-0'), 'activated');
  const runtime = records[0].projection;
  const planeCanvas = runtime.canvas;
  const frameImage = runtime.image;
  assert.ok(runtime.planeEntity, 'activation built a monitor plane');
  assert.match(frameImage.src, /\/api\/cctv\/frame\/austin-0/);
  assert.deepEqual(cardIds(host), ['austin-1', 'austin-2']);
  assert.ok(records.every((record) => record.coverageEntities.length === 5));
  records[1].viewshedPrimitive = { id: 'austin-1-volume' };
  const volume = records[1].viewshedPrimitive;
  const states = [];
  const unsubscribe = cctvLayer.subscribe((state) => states.push(state));
  t.after(unsubscribe);
  const baselineStates = states.length;
  const visibilityCalls = host.calls.filter((call) => call.type === 'visible' && call.sourceId === 'cctv').length;
  const imagesBeforeLeave = images.length;

  cctvLayer.onLocationLeave({
    from: TEXAS,
    to: ONTARIO,
    signal: new AbortController().signal,
    enabled: true,
  });

  // The panel hears one null-active state; the layer and catalogue stay.
  assert.equal(states.length, baselineStates + 1);
  const state = states.at(-1);
  assert.equal(state.enabled, true);
  assert.equal(state.activeCameraId, null);
  assert.equal(state.activeCamera, null);
  assert.equal(state.autoHopSuspended, false, 'a switch is not an empty-space deselect');
  assert.equal(state.calibrationMode, false);
  assert.equal(state.cameras.length, 4);
  assert.equal(state.ambientCards.count, 0);
  assert.equal(state.ambientCards.hoverId, null);
  assert.equal(state.ambientCards.fetchesInFlight, 0);
  assert.equal(state.loading.active, false);
  assert.deepEqual(lastCards(host), [], 'an empty card ring is published');
  assert.equal(
    host.calls.filter((call) => call.type === 'visible' && call.sourceId === 'cctv').length,
    visibilityCalls,
    'the card source visibility is untouched',
  );

  // Monitor plane: entity gone, frame request cancelled, canvas pixels freed.
  assert.equal(records[0].projection, null);
  assert.equal(runtime.planeEntity, null);
  assert.equal(viewer.entities.getById('cctv-austin-0-plane'), undefined);
  assert.equal(frameImage.src, '', 'the in-flight frame request is detached');
  assert.equal(planeCanvas.width, 0);
  assert.equal(planeCanvas.height, 0);

  // Wireframes and volumes away from Toronto go; Toronto's stay.
  assert.ok(records.slice(0, 3).every((record) => record.coverageEntities.length === 0));
  assert.equal(viewer.entities.getById('cctv-austin-1-cap'), undefined);
  assert.equal(records[3].coverageEntities.length, 5);
  assert.ok(viewer.entities.getById('cctv-toronto-0-cap'));
  assert.equal(records[1].viewshedPrimitive, null);
  assert.ok(viewer.removedPrimitives.includes(volume));

  // Idempotent and throw-free, whatever the manager passes.
  assert.doesNotThrow(() => cctvLayer.onLocationLeave({ from: TEXAS, to: ONTARIO }));
  assert.doesNotThrow(() => cctvLayer.onLocationLeave());
  assert.doesNotThrow(() => cctvLayer.onLocationLeave(null));
  assert.equal(cctvLayer.getUIState().activeCameraId, null);
  assert.deepEqual(lastCards(host), []);

  // Mid-flight: AUTO HOP holds and an activation reselects no ring.
  cctvLayer.setParams({ autoHop: true, autoHopSec: 8 });
  maybeAutoHop(Date.now() + 1e9);
  assert.equal(cctvLayer.getUIState().activeCameraId, null, 'AUTO HOP holds while the camera flies');
  assert.equal(setActiveCamera('austin-1'), 'activated');
  assert.deepEqual(lastCards(host), [], 'no cards for the ground the flight passes over');
  assert.ok(
    images.slice(imagesBeforeLeave).every((image) => !image.src.includes('austin-2')),
    'no card frame is fetched for the old view',
  );
});

test('arrival selects the destination camera without flying and reloads its cards and geometry', async (t) => {
  const { images } = installDomFakes(t);
  const viewer = makeViewer(AUSTIN);
  const records = [
    makeRecord('austin-0', AUSTIN),
    makeRecord('austin-1', AUSTIN, 0.02),
    makeRecord('toronto-0', TORONTO),
    makeRecord('toronto-1', TORONTO, 0.02),
    makeRecord('toronto-2', TORONTO, -0.02),
  ];
  const host = primeLayer(t, { viewer, records });
  setActiveCamera('austin-0');
  const states = [];
  t.after(cctvLayer.subscribe((state) => states.push(state)));

  cctvLayer.onLocationLeave({ from: TEXAS, to: ONTARIO, enabled: true });
  const imagesAtLeave = images.length;
  moveViewer(viewer, TORONTO);
  const statesBeforeArrival = states.length;
  cctvLayer.onLocationArrive({ from: TEXAS, to: ONTARIO, signal: new AbortController().signal });

  assert.equal(cctvLayer.getUIState().activeCameraId, 'toronto-0');
  assert.equal(viewer.camera.flyCalls, 0, 'arrival selects without flying');
  assert.equal(states.length, statesBeforeArrival + 1, 'the panel hears the arrival once');
  assert.ok(records[2].projection?.planeEntity, 'the destination camera gets its monitor plane');
  assert.deepEqual(cardIds(host), ['toronto-1', 'toronto-2']);

  // Let the card pacer tick and the geometry queue drain.
  await new Promise((resolve) => setTimeout(resolve, 400));
  const fetched = images.slice(imagesAtLeave).map((image) => image.src);
  assert.ok(
    fetched.some((src) => /\/api\/cctv\/frame\/toronto-[12]/.test(src)),
    `the card pacer restarted for Toronto (fetched: ${fetched.join(', ')})`,
  );
  assert.ok(fetched.every((src) => !src.includes('austin')), 'nothing is fetched for Austin');
  assert.equal(records[3].groundResolved['terrain-globe'], true);
  assert.equal(records[4].groundResolved['terrain-globe'], true);
  assert.notEqual(records[1].groundResolved['terrain-globe'], true, 'far cameras are not queued');
  assert.deepEqual(cardIds(host), ['toronto-1', 'toronto-2'], 'the drain completion re-anchors the ring');
});

test('a camera at the destination survives the switch; none is picked far from every camera', (t) => {
  installDomFakes(t);
  const viewer = makeViewer(TORONTO);
  const records = [
    makeRecord('austin-0', AUSTIN),
    makeRecord('toronto-0', TORONTO),
    makeRecord('toronto-1', TORONTO, 0.02),
  ];
  const host = primeLayer(t, { viewer, records });
  setActiveCamera('toronto-0');
  const runtime = records[1].projection;
  const cardSlot = lastCards(host).find((entry) => entry.id === 'toronto-1')?.image;
  assert.ok(cardSlot, 'the neighbour has a card before the switch');

  // The map click that starts a switch lands on the camera the user picked.
  cctvLayer.onLocationLeave({ from: TEXAS, to: ONTARIO, enabled: true });
  assert.equal(cctvLayer.getUIState().activeCameraId, 'toronto-0');
  assert.equal(records[1].projection, runtime);
  assert.ok(runtime.planeEntity);
  cctvLayer.onLocationArrive({ from: TEXAS, to: ONTARIO });
  assert.equal(cctvLayer.getUIState().activeCameraId, 'toronto-0');
  assert.equal(
    lastCards(host).find((entry) => entry.id === 'toronto-1')?.image,
    cardSlot,
    'thumbnails near the destination are kept, so the card does not flash',
  );

  cctvLayer.onLocationLeave({ from: ONTARIO, to: place('BM', OFFSHORE), enabled: true });
  assert.equal(cctvLayer.getUIState().activeCameraId, null);
  assert.equal(runtime.planeEntity, null);
  moveViewer(viewer, OFFSHORE);
  cctvLayer.onLocationArrive({ from: ONTARIO, to: place('BM', OFFSHORE) });
  assert.equal(cctvLayer.getUIState().activeCameraId, null, 'no camera within 50 km, so none is active');

  // That arrival settled the released camera; the next switch releases none,
  // so its arrival has nothing to replace.
  cctvLayer.onLocationLeave({ from: place('BM', OFFSHORE), to: TEXAS, enabled: true });
  moveViewer(viewer, AUSTIN);
  cctvLayer.onLocationArrive({ from: place('BM', OFFSHORE), to: TEXAS });
  assert.equal(cctvLayer.getUIState().activeCameraId, null, 'no camera was released, so none is picked');
});

test('an empty-map deselect survives the switch its click starts, and AUTO HOP stays held', (t) => {
  installDomFakes(t);
  const viewer = makeViewer(TORONTO);
  const records = [
    makeRecord('toronto-0', TORONTO),
    makeRecord('austin-0', AUSTIN),
    makeRecord('austin-1', AUSTIN, 0.02),
  ];
  primeLayer(t, { viewer, records });
  t.after(() => cctvLayer.setParams({ autoHop: false }));
  cctvLayer.setParams({ autoHop: true, autoHopSec: 8 });
  assert.equal(setActiveCamera('toronto-0'), 'activated');

  // CCTV's click handler deselects first. The same click lands in another
  // region, and a map click has no flight, so arrival follows leave at once.
  moveViewer(viewer, AUSTIN);
  assert.equal(deactivateActiveCamera(), true);
  cctvLayer.onLocationLeave({ from: ONTARIO, to: TEXAS, enabled: true });
  cctvLayer.onLocationArrive({ from: ONTARIO, to: TEXAS, signal: new AbortController().signal });

  let state = cctvLayer.getUIState();
  assert.equal(state.activeCameraId, null, 'the deselect is not undone');
  assert.equal(state.autoHopSuspended, true);
  assert.ok(records.every((record) => !record.projection), 'no monitor plane is built');
  maybeAutoHop(Date.now() + 1e9);
  assert.equal(cctvLayer.getUIState().activeCameraId, null, 'AUTO HOP stays held');

  // A later pill or search into another region keeps the earlier deselect too.
  cctvLayer.onLocationLeave({ from: TEXAS, to: ONTARIO, enabled: true });
  moveViewer(viewer, TORONTO);
  cctvLayer.onLocationArrive({ from: TEXAS, to: ONTARIO });
  state = cctvLayer.getUIState();
  assert.equal(state.activeCameraId, null);
  assert.equal(state.autoHopSuspended, true);
  maybeAutoHop(Date.now() + 2e9);
  assert.equal(cctvLayer.getUIState().activeCameraId, null);
});

test('arrival replaces the camera the switch released, even after a newer leave supersedes it', (t) => {
  installDomFakes(t);
  const viewer = makeViewer(AUSTIN);
  const records = [
    makeRecord('austin-0', AUSTIN),
    makeRecord('toronto-0', TORONTO),
    makeRecord('toronto-1', TORONTO, 0.02),
  ];
  primeLayer(t, { viewer, records });
  assert.equal(setActiveCamera('austin-0'), 'activated');

  cctvLayer.onLocationLeave({ from: TEXAS, to: place('BM', OFFSHORE), enabled: true });
  assert.equal(cctvLayer.getUIState().activeCameraId, null);
  // A newer selection supersedes the flight. Its leave finds no camera left to
  // release, and the aborted arrival leaves the resume to the newer switch.
  const superseded = new AbortController();
  superseded.abort();
  cctvLayer.onLocationLeave({ from: TEXAS, to: ONTARIO, enabled: true });
  cctvLayer.onLocationArrive({ from: TEXAS, to: place('BM', OFFSHORE), signal: superseded.signal });
  assert.equal(cctvLayer.getUIState().activeCameraId, null);

  moveViewer(viewer, TORONTO);
  cctvLayer.onLocationArrive({ from: TEXAS, to: ONTARIO, signal: new AbortController().signal });
  const state = cctvLayer.getUIState();
  assert.equal(state.activeCameraId, 'toronto-0', 'the nearest destination camera takes over');
  assert.equal(state.autoHopSuspended, false);
  assert.ok(records[1].projection?.planeEntity, 'the destination camera gets its monitor plane');
  assert.equal(viewer.camera.flyCalls, 0, 'arrival selects without flying');
});

test('a destination that asks for a camera gets its nearest one, even after a deliberate deselect', (t) => {
  installDomFakes(t);
  const viewer = makeViewer(TORONTO);
  const records = [
    makeRecord('toronto-0', TORONTO),
    makeRecord('austin-far', AUSTIN, 0.3), // ~29 km east
    makeRecord('austin-site', AUSTIN, 0.01), // ~1 km east
  ];
  primeLayer(t, { viewer, records });
  t.after(() => cctvLayer.setParams({ autoHop: false }));
  cctvLayer.setParams({ autoHop: true, autoHopSec: 8 });
  assert.equal(setActiveCamera('toronto-0'), 'activated');
  assert.equal(deactivateActiveCamera(), true);

  // A private security-site pill passes selectCamera on the destination.
  const site = { ...TEXAS, selectCamera: true };
  cctvLayer.onLocationLeave({ from: ONTARIO, to: site, enabled: true });
  moveViewer(viewer, AUSTIN);
  cctvLayer.onLocationArrive({ from: ONTARIO, to: site, signal: new AbortController().signal });

  const state = cctvLayer.getUIState();
  assert.equal(state.activeCameraId, 'austin-site');
  assert.equal(state.autoHopSuspended, false, 'selecting the site camera re-arms AUTO HOP');
  assert.ok(records[2].projection?.planeEntity, 'the site camera gets its monitor plane');
  assert.equal(viewer.camera.flyCalls, 0);
});

test('a switch while the layer is off frees its monitor plane and enable picks a camera near the view', (t) => {
  installDomFakes(t);
  const viewer = makeViewer(AUSTIN);
  const records = [
    makeRecord('austin-0', AUSTIN),
    makeRecord('toronto-0', TORONTO),
    makeRecord('toronto-1', TORONTO, 0.02),
  ];
  primeLayer(t, { viewer, records });
  setActiveCamera('austin-0');
  const runtime = records[0].projection;
  cctvLayer.disable();
  assert.ok(runtime.planeEntity, 'disable only hides the plane');

  cctvLayer.onLocationLeave({ from: TEXAS, to: ONTARIO, enabled: false });
  assert.equal(runtime.planeEntity, null);
  assert.equal(records[0].projection, null);
  assert.equal(cctvLayer.getUIState().activeCameraId, null);
  assert.equal(cctvLayer.getUIState().enabled, false, 'the hook never enables the layer');

  moveViewer(viewer, TORONTO);
  cctvLayer.enable();
  assert.equal(
    cctvLayer.getUIState().activeCameraId,
    'toronto-0',
    'not the first catalogue camera, which is in Austin',
  );
});

test('a switch whose arrival never comes stops holding the card ring after the stale window', (t) => {
  installDomFakes(t);
  const viewer = makeViewer(AUSTIN);
  const records = [
    makeRecord('austin-0', AUSTIN),
    makeRecord('austin-1', AUSTIN, 0.02),
    makeRecord('austin-2', AUSTIN, -0.02),
  ];
  const host = primeLayer(t, { viewer, records });
  setActiveCamera('austin-0');
  cctvLayer.onLocationLeave({ from: TEXAS, to: ONTARIO, enabled: true });
  setActiveCamera('austin-1');
  assert.deepEqual(lastCards(host), [], 'held while the switch is fresh');

  const realNow = Date.now.bind(Date);
  t.mock.method(Date, 'now', () => realNow() + 13_000);
  deactivateActiveCamera();
  assert.deepEqual(cardIds(host), ['austin-0', 'austin-1', 'austin-2']);
});

test('arrival waits for the destination area load, then picks its nearest camera with a still', async (t) => {
  const answer = deferred();
  const server = makeCameraServer({ areas: () => answer.promise });
  installDomFakes(t, { fetch: server.handler });
  installPriorResolver(t);
  const viewer = makeViewer(AUSTIN);
  const records = [makeRecord('austin-0', AUSTIN)];
  primeLayer(t, { viewer, records, area: areaReport(AUSTIN, records) });
  assert.equal(setActiveCamera('austin-0'), 'activated');

  // A pill starts the flight: the area request goes out now, the switch leaves.
  const flight = deferred();
  const selecting = cctvLayer.onLocationSelect({ point: TORONTO, arrival: flight.promise, enabled: true });
  cctvLayer.onLocationLeave({ from: TEXAS, to: ONTARIO, enabled: true });
  moveViewer(viewer, TORONTO);
  const arriving = cctvLayer.onLocationArrive({ from: TEXAS, to: ONTARIO, signal: new AbortController().signal });
  assert.equal(cctvLayer.getUIState().activeCameraId, null, 'arrival waits for the destination cameras');

  answer.resolve(areaAnswer(TORONTO, [
    makeSource('toronto-lookup', TORONTO, 0.001, LOOKUP_CAMERA),
    makeSource('toronto-still', TORONTO, 0.02),
  ]));
  await sleep(20);
  assert.ok(_cctvRecordForTest('austin-0'), 'the response waits for the flight to land');
  assert.equal(cctvLayer.getUIState().activeCameraId, null);

  flight.resolve();
  await arriving;
  assert.equal(await selecting, true);
  assert.equal(_cctvRecordForTest('austin-0'), null, 'the old area left');
  assert.equal(cctvLayer.getUIState().activeCameraId, 'toronto-still', 'the nearest camera with a still');
  assert.equal(server.calls.lookups.length, 0, 'arrival is not an explicit open');
  assert.equal(viewer.camera.flyCalls, 0);
});

test('hover cards and the tiles-ready geometry pass hold during a location switch', () => {
  assert.match(
    CCTV_SOURCE,
    /function handleHoverMove\(position\) \{\r?\n\s+if \(!_enabled \|\| _cameraMoving \|\| _locationSwitching \|\|/,
  );
  assert.match(
    cctvLayer.update.toString(),
    /!_tilesReadyReenqueued && !_locationSwitching && projectionTilesReady\(\)/,
  );
  assert.equal(cctvLayer.refreshOnLocationArrive, undefined, 'arrival reloads itself; no extra update()');
});
