// src/data/cctvLookupActivation.test.mjs — Road511 lookups and frame requests.
//
// A camera with no public still (feedType 'none', lookup 'road511') costs no
// request until the user explicitly opens it: a world or card click, a private
// select, selectCamera, PREV/NEXT or NEAREST sends one POST
// /api/cctv/lookup/:id. AUTO HOP, arrival, defaults and restored params never
// do. Such a camera never creates an Image or requests a frame from cards or
// the monitor plane; only the active plane and panel preview ask as active;
// and no card frame is fetched once cards have faded out with altitude.
//
// Real layer paths under node:test (cctvTestHarness.mjs); no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cctvLayer, {
  _cctvRecordForTest,
  deactivateActiveCamera,
  maybeAutoHop,
  setActiveCamera,
} from './cctv.js';
import { keySetupRequirement } from '../keySetupCore.mjs';
import {
  AUSTIN,
  LOOKUP_CAMERA,
  TEXAS,
  ONTARIO,
  areaReport,
  cardIds,
  deferred,
  installDomFakes,
  makeCameraServer,
  makeRecord,
  makeViewer,
  moveViewer,
  primeLayer,
  sleep,
  waitFor,
} from './cctvTestHarness.mjs';

const CCTV_SOURCE = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'cctv.js'),
  'utf8',
);

/**
 * Two cameras with a still and two lookup cameras, 200+ px apart on screen.
 * `enabled: false` primes the layer off so a test can run the real enable()
 * (which starts the card pacer).
 */
function primeLookupLayer(t, { lookup, enabled = true, heightM = 4_000 } = {}) {
  const server = makeCameraServer({ lookup });
  const { images } = installDomFakes(t, { fetch: server.handler });
  const viewer = makeViewer(AUSTIN, heightM);
  const records = [
    makeRecord('still-0', AUSTIN),
    makeRecord('lookup-0', AUSTIN, 0.02, LOOKUP_CAMERA),
    makeRecord('still-1', AUSTIN, 0.04),
    makeRecord('lookup-1', AUSTIN, -0.02, LOOKUP_CAMERA),
  ];
  const host = primeLayer(t, { viewer, records, enabled, area: areaReport(AUSTIN, records) });
  t.after(() => cctvLayer.setParams({ autoHop: false }));
  return { server, images, viewer, host };
}

test('AUTO HOP, arrival, defaults and restored params never send a Road511 lookup', async (t) => {
  const { server } = primeLookupLayer(t);

  cctvLayer.setParams({ autoHop: true, autoHopSec: 8 });
  const hopped = new Set();
  for (let hop = 1; hop <= 6; hop++) {
    maybeAutoHop(Date.now() + hop * 1e9);
    hopped.add(cctvLayer.getUIState().activeCameraId);
  }
  assert.deepEqual([...hopped].sort(), ['still-0', 'still-1'], 'AUTO HOP only lands on cameras with a still');
  cctvLayer.setParams({ autoHop: false });

  cctvLayer.setParams({ selectedCameraId: 'lookup-0' });
  assert.equal(cctvLayer.getUIState().activeCameraId, 'lookup-0', 'a restored selection still selects');

  assert.equal(deactivateActiveCamera(), true);
  const site = { ...TEXAS, selectCamera: true };
  cctvLayer.onLocationLeave({ from: ONTARIO, to: site, enabled: true });
  await cctvLayer.onLocationArrive({ from: ONTARIO, to: site });
  assert.equal(cctvLayer.getUIState().activeCameraId, 'still-0', 'arrival picks a camera with a still');

  assert.equal(deactivateActiveCamera(), true);
  assert.equal(cctvLayer.focusNearest({ focus: false, explicit: false }), 'still-0');
  assert.equal(deactivateActiveCamera(), true);
  cctvLayer.disable();
  cctvLayer.enable();
  assert.equal(cctvLayer.getUIState().activeCameraId, 'still-0', 'the enable default');

  assert.equal(server.calls.lookups.length, 0);
});

test('selectCamera sends exactly one lookup POST per camera, and a resolved still reaches the plane and panel', async (t) => {
  const answer = deferred();
  const { server } = primeLookupLayer(t, { lookup: () => answer.promise });

  assert.equal(cctvLayer.selectCamera('lookup-0'), true);
  assert.deepEqual(server.calls.lookups, [{
    id: 'lookup-0',
    method: 'POST',
    body: '{}',
    headers: { 'Content-Type': 'application/json' },
  }]);
  let active = cctvLayer.getUIState().activeCamera;
  assert.equal(active.id, 'lookup-0');
  assert.equal(active.frameUrl, null, 'no panel frame for a camera with no still');
  assert.equal(active.lookupPending, true);
  assert.equal(active.lookupBadge, 'LOOKING UP');
  assert.equal(_cctvRecordForTest('lookup-0').projection.image, null, 'the plane creates no Image');

  assert.equal(cctvLayer.selectCamera('lookup-0'), true);
  cctvLayer.cycleCamera(1);
  cctvLayer.cycleCamera(-1);
  assert.equal(cctvLayer.getUIState().activeCameraId, 'lookup-0');
  assert.equal(server.calls.lookups.length, 1, 'one request per camera while it is in flight');

  answer.resolve({ id: 'lookup-0', lookupState: 'resolved', feedType: 'image', retryAfterMs: 0 });
  await waitFor(() => cctvLayer.getCameraState('lookup-0').lookupState === 'resolved');
  active = cctvLayer.getUIState().activeCamera;
  assert.equal(active.feedType, 'image');
  assert.match(active.frameUrl, /^\/api\/cctv\/frame\/lookup-0\?ts=\d+&active=1$/);
  const planeImage = _cctvRecordForTest('lookup-0').projection.image;
  assert.match(planeImage.src, /^\/api\/cctv\/frame\/lookup-0\?ts=\d+&active=1&projTs=\d+$/);

  assert.equal(cctvLayer.selectCamera('lookup-0'), true);
  assert.equal(server.calls.lookups.length, 1, 'a resolved camera is never looked up again');
});

test('a missing key shows the POWER UP note, and NEAREST is explicit unless the enable transition says otherwise', async (t) => {
  const server = makeCameraServer({
    lookup: (id) => ({ id, lookupState: 'no-key', feedType: 'none', retryAfterMs: 0 }),
  });
  installDomFakes(t, { fetch: server.handler });
  const records = [
    makeRecord('lookup-0', AUSTIN, 0.001, LOOKUP_CAMERA),
    makeRecord('lookup-1', AUSTIN, 0.03, LOOKUP_CAMERA),
  ];
  primeLayer(t, { viewer: makeViewer(AUSTIN), records, area: areaReport(AUSTIN, records) });

  assert.equal(cctvLayer.focusNearest({ focus: false, explicit: false }), 'lookup-0');
  assert.equal(server.calls.lookups.length, 0, 'the enable-transition pick sends nothing');
  assert.equal(deactivateActiveCamera(), true);
  assert.equal(cctvLayer.focusNearest({ focus: false }), 'lookup-0');
  assert.equal(server.calls.lookups.length, 1, 'the NEAREST button is an explicit open');

  await waitFor(() => cctvLayer.getCameraState('lookup-0').lookupState === 'no-key');
  const active = cctvLayer.getUIState().activeCamera;
  assert.equal(active.lookupNote, keySetupRequirement('road511') || 'Road511 key not set');
  assert.equal(active.lookupBadge, 'KEY NOT SET');
  assert.equal(active.frameUrl, null);

  assert.equal(deactivateActiveCamera(), true);
  assert.equal(cctvLayer.selectCamera('lookup-0'), true);
  assert.equal(server.calls.lookups.length, 1, 'no second request inside the retry window');
});

test('a camera with no public still never creates an Image or requests a frame from cards or the plane', async (t) => {
  const { images, host } = primeLookupLayer(t, { enabled: false });

  cctvLayer.enable();
  assert.equal(cctvLayer.getUIState().activeCameraId, 'still-0', 'the enable default has a still');
  assert.equal(setActiveCamera('still-0'), 'activated');
  assert.deepEqual(cardIds(host), ['lookup-0', 'lookup-1', 'still-1'], 'lookup cameras keep their card');
  await sleep(700);
  const requested = images.map((image) => image.src).filter(Boolean);
  assert.ok(
    requested.some((src) => /^\/api\/cctv\/frame\/still-1\?ts=\d+$/.test(src)),
    `the card pacer fetched still-1 without active=1 (${requested.join(', ')})`,
  );
  assert.ok(requested.every((src) => !src.includes('lookup-')), 'nothing is requested for a camera with no still');
  assert.ok(
    requested.filter((src) => src.includes('active=1')).every((src) => src.includes('/frame/still-0')),
    'only the active plane asks as active',
  );

  assert.equal(setActiveCamera('lookup-1'), 'activated');
  const runtime = _cctvRecordForTest('lookup-1').projection;
  assert.equal(runtime.mode, 'none');
  assert.equal(runtime.image, null);
  assert.equal(cctvLayer.getCameraState('lookup-1').frameUrl, null);
  assert.equal(cctvLayer.getCameraState('lookup-1').mediaUrl, null);
  assert.ok(images.every((image) => !image.src.includes('lookup-')));
  // The hover-summoned card takes the same placeholder path.
  assert.match(CCTV_SOURCE, /function hoverFetchCardFrame\(record\) \{[\s\S]*?if \(!cameraHasStill\(record\.camera\)\)/);
});

test('the card pacer fetches nothing at or above the card fade-out altitude', async (t) => {
  const { images, viewer, host } = primeLookupLayer(t, { enabled: false, heightM: 9_500 });
  cctvLayer.enable();
  assert.equal(setActiveCamera('still-0'), 'activated');
  assert.ok(cardIds(host).includes('still-1'));
  const cardRequests = () => images.map((image) => image.src).filter((src) => src && !src.includes('active=1'));

  await sleep(700);
  assert.deepEqual(cardRequests(), []);
  moveViewer(viewer, AUSTIN, 4_000);
  await sleep(700);
  assert.ok(cardRequests().some((src) => src.includes('/frame/still-1')));
});
