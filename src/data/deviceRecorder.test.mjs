import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { changedRecordsOnly, collectNearbyRecords, createDeviceRecorder } from './deviceRecorder.js';
import { DEVICE_FEEDS_LAYER_ID, createDeviceFeedsLayer } from './deviceFeeds.js';

const TARGET = { id: 'device-security-van', lat: 45.2733, lon: -66.0633, record: true };

function manager(layers, off = []) {
  return {
    layers: new Map(Object.entries(layers).map(([id, module]) => [id, { module }])),
    isEnabled: (id) => !off.includes(id),
  };
}

test('every layer that is on gives what it holds within 50 km', () => {
  const dataManager = manager({
    flights: { getAnalystRecords: () => [{ id: 'NEAR', lat: 45.3, lon: -66.0 }, { id: 'FAR', lat: 46.5, lon: -66.0 }, { id: 'NOPOS' }] },
    satellites: { getDetectableObjects: () => [{ sourceId: 25544, type: 'SAT', position: { lat: 45.2, lon: -66.1, altM: 408000 } }, { id: 'X', position: null }] },
    earthquakes: { getAnalystRecords: () => [{ id: 'q', lat: 45.27, lon: -66.06 }] },
    broken: { getAnalystRecords: () => { throw new Error('boom'); } },
    silent: {},
  }, ['earthquakes']);
  const found = collectNearbyRecords(dataManager, TARGET, { toLatLon: (position) => position });
  assert.deepEqual(Object.keys(found), ['flights', 'satellites']);
  assert.deepEqual(found.flights.map((record) => record.id), ['NEAR']);
  assert.deepEqual(found.satellites, [{ id: '25544', type: 'SAT', label: null, lat: 45.2, lon: -66.1, altM: 408000 }]);
  assert.deepEqual(collectNearbyRecords(dataManager, { lat: null, lon: 0 }), {});
  assert.deepEqual(Object.keys(collectNearbyRecords(dataManager, TARGET, { toLatLon: (p) => p, skip: ['flights'] })), ['satellites']);
});

test('only what changed is saved; what left and came back is saved again', () => {
  const memory = new Map();
  const camera = { id: 'cam-1', lat: 45.27, lon: -66.06 };
  const plane = (lat) => ({ id: 'ACA1', lat, lon: -66 });
  assert.deepEqual(changedRecordsOnly({ cctv: [camera], flights: [plane(45.3)] }, memory), { cctv: [camera], flights: [plane(45.3)] });
  assert.deepEqual(changedRecordsOnly({ cctv: [camera], flights: [plane(45.31)] }, memory), { flights: [plane(45.31)] }, 'the camera has not moved');
  assert.deepEqual(changedRecordsOnly({ flights: [plane(45.31)] }, memory), {}, 'the camera left the radius');
  assert.deepEqual(changedRecordsOnly({ cctv: [camera], flights: [plane(45.31)] }, memory), { cctv: [camera] }, 'and came back');
});

test('the recorder: recording devices only, paced, and a failed save is tried again in full', async () => {
  let time = 1_000_000;
  const posts = [];
  let fail = true;
  const recorder = createDeviceRecorder({
    now: () => time,
    intervalMs: 30_000,
    fetchImpl: async (url, options) => {
      posts.push({ url, body: JSON.parse(options.body) });
      if (fail) return new Response('', { status: 500 });
      const saved = Object.values(posts.at(-1).body.layers).reduce((sum, records) => sum + records.length, 0);
      return new Response(JSON.stringify({ saved }), { status: 200 });
    },
  });
  const dataManager = manager({ cctv: { getAnalystRecords: () => [{ id: 'cam-1', lat: 45.27, lon: -66.06 }] } });
  const devices = [TARGET, { id: 'device-tracker-quiet', lat: 45.27, lon: -66.06, record: false }, { id: 'device-nopos', lat: null, lon: null, record: true }];

  assert.deepEqual(await recorder.tick(devices, dataManager), [{ id: TARGET.id, error: 'HTTP 500' }]);
  assert.equal(posts[0].url, '/api/device-feeds/record/device-security-van');
  assert.equal(recorder.stats().failing, 1);
  assert.deepEqual(await recorder.tick(devices, dataManager), [], 'not before the interval');

  fail = false;
  time += 30_000;
  assert.deepEqual(await recorder.tick(devices, dataManager), [{ id: TARGET.id, saved: 1 }]);
  assert.deepEqual(posts[1].body.layers.cctv.map((record) => record.id), ['cam-1'], 'the failed save is sent again');

  time += 30_000;
  await recorder.tick(devices, dataManager);
  assert.deepEqual(posts[2].body.layers, {}, 'nothing changed: only the device’s own track is saved');
  assert.deepEqual(recorder.stats(), { recording: 1, saved: 1, failing: 0 });

  await recorder.tick([{ ...TARGET, record: false }], dataManager);
  assert.equal(recorder.stats().recording, 0, 'switched off: forgotten');
});

// ---- follow ---------------------------------------------------------------

function followFixture(answers) {
  const tracked = { listeners: [], addEventListener(fn) { this.listeners.push(fn); }, removeEventListener(fn) { this.listeners = this.listeners.filter((item) => item !== fn); } };
  const entities = [];
  const viewer = {
    dataSources: { add: (source) => source, remove: () => true },
    entities: { add: (options) => { const entity = { ...options }; entities.push(entity); return entity; }, remove: (entity) => entities.splice(entities.indexOf(entity), 1) },
    trackedEntityChanged: tracked,
    _tracked: undefined,
    get trackedEntity() { return this._tracked; },
    set trackedEntity(value) { this._tracked = value; for (const fn of [...tracked.listeners]) fn(value); },
  };
  const frames = [];
  const ticks = [];
  const layer = createDeviceFeedsLayer({
    overlayHost: { setEntries: (...args) => ticks.push(args), setVisible() {}, clearSource() {} },
    windowRef: null,
    createImage: () => null,
    applyFollowFrame: (...args) => { frames.push(args); return () => frames.push('stopped'); },
    refreshReadout: () => {},
    recorder: { tick: async (rows) => { ticks.push(['record', rows.filter((row) => row.record).map((row) => row.id)]); return []; }, forget() {}, stats: () => ({}) },
    fetchImpl: async () => new Response(JSON.stringify({ devices: answers.shift() }), { status: 200 }),
  });
  layer.init(viewer);
  layer.enable(viewer);
  return { layer, viewer, entities, frames, ticks };
}

const van = (extra = {}) => ({ id: 'device-security-van', kind: 'security', kindLabel: 'PACKAGE', color: '#ff4d4d', name: 'Van', lat: 45.27, lon: -66.06, altM: null, headingDeg: null, speedMps: 5, live: true, follow: true, record: true, ...extra });

test('the map follows the marked device, moves with it, and lets go when its owner goes elsewhere', async () => {
  const { layer, viewer, entities, frames, ticks } = followFixture([[van()], [van({ lat: 45.28 })], [van({ lat: 45.29 })], [van({ lat: 45.3, follow: false })]]);
  await layer.update(viewer);
  assert.equal(entities.length, 1);
  assert.equal(viewer.trackedEntity, entities[0]);
  assert.equal(entities[0].gevTrackedId, `${DEVICE_FEEDS_LAYER_ID}:device-security-van`);
  assert.deepEqual([entities[0].gevLabelModel.title, entities[0].gevLabelModel.details[0]], ['VAN', 'PACKAGE · REC']);
  assert.equal(typeof entities[0].gevDisplayPosition, 'function');
  assert.equal(frames.length, 1, 'the shared follow camera frames it once');
  assert.equal(layer.getTrackedInfo().id, 'device-security-van');
  assert.equal(layer.getStats().following, 'device-security-van');
  assert.deepEqual(ticks.filter((tick) => tick[0] === 'record').at(-1), ['record', ['device-security-van']]);
  // The followed device's card is the tracked readout, not a second label.
  assert.deepEqual(ticks.filter((tick) => tick[0] !== 'record').at(-1)[1], []);

  await layer.update(viewer);
  assert.equal(entities.length, 1, 'the same follow, a new place to glide to');
  assert.equal(frames.length, 1);

  // A flight is selected: the camera is theirs now and is left alone.
  const flight = { id: 'flight' };
  viewer.trackedEntity = flight;
  assert.equal(viewer.trackedEntity, flight);
  assert.equal(entities.length, 0);
  assert.equal(frames.at(-1), 'stopped');
  assert.equal(layer.getTrackedInfo(), null);

  await layer.update(viewer);
  assert.equal(viewer.trackedEntity, flight, 'walked away from: not grabbed back');

  // Asked for again by hand, then unticked on the card.
  assert.equal(layer.trackById('device-security-van'), true);
  assert.equal(viewer.trackedEntity, entities[0]);
  await layer.update(viewer);
  assert.equal(viewer.trackedEntity, undefined, 'FOLLOW unticked: let go');
  assert.equal(layer.trackById('device-nope'), false);
  layer.destroy(viewer);
});

test('turning the layer off lets go of the camera', async () => {
  const { layer, viewer, entities } = followFixture([[van()]]);
  await layer.update(viewer);
  assert.equal(viewer.trackedEntity, entities[0]);
  layer.disable(viewer);
  assert.equal(viewer.trackedEntity, undefined);
  assert.equal(entities.length, 0);
});

test('the layer never flies the camera itself', () => {
  const source = readFileSync(new URL('./deviceFeeds.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /camera\.(flyTo|setView|lookAt)\b/);
  assert.match(source, /applyTrackedCameraFrame/);
});
