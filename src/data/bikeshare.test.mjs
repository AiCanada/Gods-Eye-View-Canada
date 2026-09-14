import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import bikeshareLayer, {
  BIKESHARE_SELECTED_OVERLAY_SOURCE_OPTIONS,
  _clearBikeshareSelectionForTest,
  _getBikeshareLocationStateForTest,
  _notifyBikeshareCameraChangedForTest,
  _seedBikeshareCityForTest,
  _selectBikeshareStationForTest,
  _setBikeshareLocationStateForTest,
  _setBikeshareSelectionStateForTest,
  createBikeshareSelectedOverlayEntry,
} from './bikeshare.js';

function makeRecord() {
  return {
    stationId: '3790',
    stationName: 'Congress & 6th',
    bikesAvailable: 7,
    docksAvailable: 4,
    capacity: 11,
    isInstalled: true,
    isRenting: false,
    isReturning: true,
    point: {
      position: Cesium.Cartesian3.fromDegrees(-97.7431, 30.2672, 2),
      show: true,
    },
  };
}

test('selected bikeshare entry preserves source copy and protected-lane policy', () => {
  const record = makeRecord();
  const entry = createBikeshareSelectedOverlayEntry('austin-capmetro:3790', record);
  assert.equal(entry.position, record.point.position);
  assert.equal(entry.title, 'Congress & 6th');
  assert.deepEqual(entry.details, [
    '🚲 7 avail · 4 docks · 11 cap',
    '⚠️ Not renting',
  ]);
  assert.equal(entry.variant, 'selected');
  assert.equal(entry.selected, true);
  assert.equal(entry.protected, true);
  assert.equal(entry.paintLane, 'selected');
  assert.equal(entry.collisionGroup, 'ambient-card');
  assert.equal(entry.edgeFade, 'keyhole');
  assert.equal(entry.horizonCull, true);
});

test('real station select/clear path publishes one card and creates no native label graphic', () => {
  const calls = [];
  const overlayHost = {
    setEntries: (...args) => calls.push(['entries', ...args]),
    setVisible: (...args) => calls.push(['visible', ...args]),
    clearSource: (...args) => calls.push(['clear', ...args]),
  };
  const key = 'austin-capmetro:3790';
  const record = makeRecord();
  const viewer = { entities: new Cesium.EntityCollection() };
  _setBikeshareSelectionStateForTest({ viewer, key, record, overlayHost });
  try {
    _selectBikeshareStationForTest(key);
    assert.equal(record.point.show, false);
    assert.equal(viewer.entities.values.length, 1, 'runtime guard requires a real selected entity');
    assert.equal(viewer.entities.values[0].label, undefined);
    assert.ok(viewer.entities.values[0].point, 'selected point highlight remains native');

    const publication = calls.find(([type]) => type === 'entries');
    assert.ok(publication);
    assert.equal(publication[1], 'bikeshare-selected');
    assert.equal(publication[2].length, 1);
    assert.equal(publication[2][0].position, record.point.position);
    assert.deepEqual(publication[3], BIKESHARE_SELECTED_OVERLAY_SOURCE_OPTIONS);

    _clearBikeshareSelectionForTest();
    assert.equal(record.point.show, true);
    assert.equal(viewer.entities.values.length, 0);
    assert.deepEqual(calls.at(-1), ['clear', 'bikeshare-selected']);
  } finally {
    _clearBikeshareSelectionForTest();
  }
});

// ── Location switch hooks ────────────────────────────────────────────────────

const BOSTON = 'boston-bluebikes';
const CHICAGO = 'chicago-divvy';
const NYC = 'nyc-citibike';
const PHILLY = 'philadelphia-indego';

const BOSTON_PLACE = { key: 'US-MA', region: 'Massachusetts', country: 'US', lat: 42.3601, lon: -71.0589 };
const NYC_PLACE = { key: 'US-NY', region: 'New York', country: 'US', lat: 40.7484, lon: -73.9967 };
// ~66 km from Boston (range 100 km), ~246 km from New York (range 140 km).
const PROVIDENCE_PLACE = { key: 'US-RI', region: 'Rhode Island', country: 'US', lat: 41.824, lon: -71.4128 };
// ~133 km from New York (range 140 km), so Citi Bike stays in range.
const PHILADELPHIA_PLACE = { key: 'US-PA', region: 'Pennsylvania', country: 'US', lat: 39.9526, lon: -75.1652 };
const LONDON_PLACE = { key: 'GB-ENG', region: 'England', country: 'GB', lat: 51.5072, lon: -0.1276 };

function makeStations(prefix, lat, lon, count = 2) {
  return new Map(Array.from({ length: count }, (_, index) => {
    const stationId = `${prefix}-${index}`;
    return [stationId, {
      stationId,
      name: `${prefix} dock ${index}`,
      lat: lat + index * 0.001,
      lon,
      capacity: 10,
      isInstalled: true,
      isRenting: true,
      isReturning: true,
    }];
  }));
}

function makeStatus(stations, bikes) {
  return new Map(Array.from(stations.keys(), (stationId) => [stationId, {
    stationId,
    bikesAvailable: bikes,
    docksAvailable: 10 - bikes,
    isInstalled: true,
    isRenting: true,
    isReturning: true,
    lastReported: null,
  }]));
}

function gbfsInformationPayload(stations) {
  return {
    data: {
      stations: Array.from(stations.values(), (station) => ({
        station_id: station.stationId,
        name: station.name,
        lat: station.lat,
        lon: station.lon,
        capacity: station.capacity,
      })),
    },
  };
}

function gbfsStatusPayload(stations, bikes) {
  return {
    data: {
      stations: Array.from(stations.keys(), (stationId) => ({
        station_id: stationId,
        num_bikes_available: bikes,
        num_docks_available: 10 - bikes,
        is_installed: 1,
        is_renting: 1,
        is_returning: 1,
      })),
    },
  };
}

/** Camera looking straight down at a place from the given height. */
function makeViewer(place, heightM) {
  const viewer = {
    entities: new Cesium.EntityCollection(),
    scene: { globe: { ellipsoid: Cesium.Ellipsoid.WGS84 } },
    camera: {
      positionCartographic: null,
      computeViewRectangle: () => {
        const { lat, lon } = viewer.camera.lookAt;
        return Cesium.Rectangle.fromDegrees(lon - 0.2, lat - 0.2, lon + 0.2, lat + 0.2);
      },
    },
  };
  moveCamera(viewer, place, heightM);
  return viewer;
}

function moveCamera(viewer, place, heightM) {
  viewer.camera.lookAt = place;
  viewer.camera.positionCartographic = Cesium.Cartographic.fromDegrees(place.lon, place.lat, heightM);
}

function makeOverlayHost() {
  const calls = [];
  return {
    calls,
    setEntries: (...args) => calls.push(['entries', ...args]),
    setVisible: (...args) => calls.push(['visible', ...args]),
    clearSource: (...args) => calls.push(['clear', ...args]),
  };
}

/**
 * Replace fetch with a GBFS proxy fake. `respond(upstreamUrl)` returns a
 * payload to answer at once; anything else stays open until aborted.
 */
function installFetch(respond = () => null) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = (url, init = {}) => {
    const upstream = decodeURIComponent(String(url).replace('/api/gbfs/', ''));
    calls.push({ upstream, signal: init.signal });
    const payload = respond(upstream);
    if (payload) {
      return Promise.resolve({ ok: true, status: 200, json: async () => payload });
    }
    return new Promise((resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      }, { once: true });
    });
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

function detectionIds() {
  return bikeshareLayer.getDetectableObjects().map((entry) => entry.id).sort();
}

test('location leave cancels old feeds, releases far cities and their caches, and keeps cities near the destination', async () => {
  const overlayHost = makeOverlayHost();
  const viewer = makeViewer(BOSTON_PLACE, 12_000);
  const boston = makeStations('BOS', BOSTON_PLACE.lat, BOSTON_PLACE.lon, 3);
  const nyc = makeStations('NYC', NYC_PLACE.lat, NYC_PLACE.lon, 2);
  const chicago = makeStations('CHI', 41.8781, -87.6298, 2);
  const fetchFake = installFetch();
  _setBikeshareLocationStateForTest({ viewer, overlayHost, altitudeGateEnabled: true });
  try {
    _seedBikeshareCityForTest(BOSTON, { stations: boston, status: makeStatus(boston, 5) });
    _seedBikeshareCityForTest(NYC, { stations: nyc, status: makeStatus(nyc, 2) });
    // Chicago was visited earlier in the session: cached, no longer rendered.
    _seedBikeshareCityForTest(CHICAGO, { stations: chicago, status: makeStatus(chicago, 3), render: false });
    _selectBikeshareStationForTest(`${NYC}:NYC-0`);
    _notifyBikeshareCameraChangedForTest();
    const poll = bikeshareLayer.update();
    assert.equal(fetchFake.calls.length, 2, 'the poll is in flight for both rendered cities');
    const before = _getBikeshareLocationStateForTest();
    assert.equal(before.debouncePending, true);
    assert.equal(before.selectedKey, `${NYC}:NYC-0`);

    bikeshareLayer.onLocationLeave({ from: BOSTON_PLACE, to: PROVIDENCE_PLACE, enabled: true });

    const after = _getBikeshareLocationStateForTest();
    assert.equal(after.switching, true);
    assert.equal(after.enabled, true, 'the layer stays enabled');
    assert.equal(after.generation, before.generation + 1);
    assert.equal(after.debouncePending, false, 'the pending camera check is cancelled');
    assert.ok(fetchFake.calls.every((call) => call.signal.aborted), 'every in-flight GBFS request is aborted');
    assert.deepEqual(after.inFlightCityIds, []);
    assert.deepEqual(after.activeCityIds, [BOSTON], 'Boston serves Providence and is kept');
    assert.deepEqual(after.renderedCityIds, [BOSTON]);
    assert.deepEqual(after.stationInfoCacheCityIds, [BOSTON], 'far caches, including Chicago, are released');
    assert.deepEqual(after.statusCacheCityIds, [BOSTON]);
    assert.equal(after.pointCount, 3);
    assert.equal(after.count, 3);
    assert.equal(after.selectedKey, null, 'a selection in a released city is cleared');
    assert.equal(viewer.entities.values.length, 0);
    assert.deepEqual(overlayHost.calls.at(-1), ['clear', 'bikeshare-selected']);
    await poll;

    // Mid-flight: camera changes and status polls do nothing.
    _notifyBikeshareCameraChangedForTest();
    await bikeshareLayer.update();
    assert.equal(_getBikeshareLocationStateForTest().debouncePending, false);
    assert.equal(fetchFake.calls.length, 2, 'no request goes out mid-flight');

    // A second leave for the same switch changes nothing else.
    bikeshareLayer.onLocationLeave({ from: BOSTON_PLACE, to: PROVIDENCE_PLACE, enabled: true });
    const again = _getBikeshareLocationStateForTest();
    assert.deepEqual({ ...again, generation: after.generation }, after);
  } finally {
    fetchFake.restore();
    _setBikeshareLocationStateForTest();
  }
});

test('location leave releases every city when the destination is outside all ranges or unplaced', () => {
  const viewer = makeViewer(NYC_PLACE, 12_000);
  const nyc = makeStations('NYC', NYC_PLACE.lat, NYC_PLACE.lon, 2);
  _setBikeshareLocationStateForTest({ viewer, overlayHost: makeOverlayHost(), altitudeGateEnabled: true });
  try {
    _seedBikeshareCityForTest(NYC, { stations: nyc, status: makeStatus(nyc, 4) });
    bikeshareLayer.onLocationLeave({ from: NYC_PLACE, to: LONDON_PLACE, enabled: true });
    let state = _getBikeshareLocationStateForTest();
    assert.deepEqual(state.activeCityIds, []);
    assert.deepEqual(state.renderedCityIds, []);
    assert.deepEqual(state.stationInfoCacheCityIds, []);
    assert.deepEqual(state.statusCacheCityIds, []);
    assert.equal(state.pointCount, 0);
    assert.equal(state.count, 0);

    _seedBikeshareCityForTest(NYC, { stations: nyc });
    assert.doesNotThrow(() => bikeshareLayer.onLocationLeave({ from: NYC_PLACE, to: null }));
    assert.doesNotThrow(() => bikeshareLayer.onLocationLeave());
    state = _getBikeshareLocationStateForTest();
    assert.deepEqual(state.renderedCityIds, [], 'no destination point releases everything');
    assert.deepEqual(state.stationInfoCacheCityIds, []);
    assert.equal(state.switching, true);
  } finally {
    _setBikeshareLocationStateForTest();
  }
});

test('location arrival loads the arrived view at once, refreshes kept cities, and loads inside the altitude hysteresis band', async () => {
  const viewer = makeViewer(NYC_PLACE, 12_000);
  const nyc = makeStations('NYC', NYC_PLACE.lat, NYC_PLACE.lon, 2);
  const philly = makeStations('PHL', PHILADELPHIA_PLACE.lat, PHILADELPHIA_PLACE.lon, 2);
  const fetchFake = installFetch((upstream) => {
    if (upstream.endsWith('bcycle_indego/station_information.json')) return gbfsInformationPayload(philly);
    if (upstream.endsWith('bcycle_indego/station_status.json')) return gbfsStatusPayload(philly, 4);
    if (upstream.endsWith('/bkn/en/station_status.json')) return gbfsStatusPayload(nyc, 9);
    return null;
  });
  // The camera came from a high view, so the hysteresis gate is closed.
  _setBikeshareLocationStateForTest({ viewer, overlayHost: makeOverlayHost(), altitudeGateEnabled: false });
  try {
    _seedBikeshareCityForTest(NYC, { stations: nyc, status: makeStatus(nyc, 1) });
    const signal = new AbortController().signal;
    const change = { from: NYC_PLACE, to: PHILADELPHIA_PLACE, signal };
    bikeshareLayer.onLocationLeave({ ...change, enabled: true });
    assert.deepEqual(_getBikeshareLocationStateForTest().renderedCityIds, [NYC]);

    // Arrive 50.5 km up: inside the 48-52 km band, above the enter threshold.
    moveCamera(viewer, PHILADELPHIA_PLACE, 50_500);
    await bikeshareLayer.onLocationArrive(change);

    const state = _getBikeshareLocationStateForTest();
    assert.equal(state.switching, false);
    assert.equal(state.altitudeGateEnabled, true);
    assert.deepEqual(state.activeCityIds, [NYC, PHILLY]);
    assert.deepEqual(state.renderedCityIds, [NYC, PHILLY]);
    assert.deepEqual(
      fetchFake.calls.map((call) => call.upstream.split('/').slice(-2).join('/')).sort(),
      ['bcycle_indego/station_information.json', 'bcycle_indego/station_status.json', 'en/station_status.json'],
      'one info and status load for the new city, one status refresh for the kept city',
    );
    assert.deepEqual(detectionIds(), [
      '🚲 NYC dock 0 [9/10]',
      '🚲 NYC dock 1 [9/10]',
      '🚲 PHL dock 0 [4/10]',
      '🚲 PHL dock 1 [4/10]',
    ]);

    // Camera-driven checks are live again.
    _notifyBikeshareCameraChangedForTest();
    assert.equal(_getBikeshareLocationStateForTest().debouncePending, true);
  } finally {
    fetchFake.restore();
    _setBikeshareLocationStateForTest();
  }
});

test('location arrival above the exit altitude loads nothing but still resumes camera checks', async () => {
  const viewer = makeViewer(NYC_PLACE, 12_000);
  const fetchFake = installFetch();
  _setBikeshareLocationStateForTest({ viewer, overlayHost: makeOverlayHost(), altitudeGateEnabled: true });
  try {
    const change = { from: BOSTON_PLACE, to: NYC_PLACE, signal: new AbortController().signal };
    bikeshareLayer.onLocationLeave({ ...change, enabled: true });
    moveCamera(viewer, NYC_PLACE, 400_000);
    await bikeshareLayer.onLocationArrive(change);
    const state = _getBikeshareLocationStateForTest();
    assert.equal(state.switching, false);
    assert.equal(state.altitudeGateEnabled, false);
    assert.deepEqual(state.activeCityIds, []);
    assert.equal(fetchFake.calls.length, 0);
  } finally {
    fetchFake.restore();
    _setBikeshareLocationStateForTest();
  }
});

test('a superseded arrival leaves the newer switch paused', async () => {
  const viewer = makeViewer(NYC_PLACE, 12_000);
  const fetchFake = installFetch();
  _setBikeshareLocationStateForTest({ viewer, overlayHost: makeOverlayHost() });
  try {
    const controller = new AbortController();
    const change = { from: BOSTON_PLACE, to: NYC_PLACE, signal: controller.signal };
    bikeshareLayer.onLocationLeave({ ...change, enabled: true });
    controller.abort();
    await bikeshareLayer.onLocationArrive(change);
    assert.equal(_getBikeshareLocationStateForTest().switching, true);
    assert.equal(fetchFake.calls.length, 0);
  } finally {
    fetchFake.restore();
    _setBikeshareLocationStateForTest();
  }
});

test('disabling the layer clears a switch pause whose arrival never came', () => {
  const originalDocument = globalThis.document;
  globalThis.document = { addEventListener() {}, removeEventListener() {} };
  const viewer = makeViewer(NYC_PLACE, 12_000);
  _setBikeshareLocationStateForTest({ viewer, overlayHost: makeOverlayHost() });
  try {
    bikeshareLayer.onLocationLeave({ from: BOSTON_PLACE, to: NYC_PLACE, enabled: true });
    assert.equal(_getBikeshareLocationStateForTest().switching, true);
    bikeshareLayer.disable(viewer);
    assert.equal(_getBikeshareLocationStateForTest().switching, false);
  } finally {
    _setBikeshareLocationStateForTest();
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});
