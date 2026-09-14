// Contacts subject across a location switch, end to end through the real
// DataLayerManager. The manager runs every leave hook synchronously in
// registration order, and src/standalone/data.js registers AIS, then
// installations, then Contacts. The source layers release their own selection
// for the place being left; the Contacts subject must survive that whichever
// hook runs first, so FOCUS can return to it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DataLayerManager } from './manager.js';
import aisLiveVesselsLayer, { _setVesselStateForTest } from './aisLiveVessels.js';
import militaryInstallationsLayer from './militaryInstallations.js';
import militaryAwarenessLayer from './militaryAwareness.js';
import flightsLayer from './flights.js';
import militaryFlightsLayer from './militaryFlights.js';
import { getContextStore, registerEntityContext, selectEntityContext } from './contextStore.js';

const FROM = { key: 'CA-ON', region: 'CA-ON', country: 'CA', lat: 43.65, lon: -79.38 };
const TO = { key: 'CA-QC', region: 'CA-QC', country: 'CA', lat: 45.5, lon: -73.57 };
/** The order src/standalone/data.js registers these three layers in. */
const DATA_JS_ORDER = ['ais-live-vessels', 'military-installations', 'military-awareness'];
const MODULES = {
  'ais-live-vessels': aisLiveVesselsLayer,
  'military-installations': militaryInstallationsLayer,
  'military-awareness': militaryAwarenessLayer,
};
const AWARENESS_DEPENDENCIES = ['flights', 'military', 'ais-live-vessels', 'military-installations'];

class FakeElement {
  constructor() {
    this.classList = { contains: () => false, add() {}, remove() {} };
    this.style = { setProperty() {} };
    this.hidden = false;
    this.innerHTML = '';
    this.textContent = '';
  }

  setAttribute() {}
  addEventListener() {}
  removeEventListener() {}
  appendChild() {}
  append() {}
  remove() {}
  replaceChildren() {}
}

/**
 * Register the three real layers on a real DataLayerManager in `order`, with
 * Contacts on and a browser-shaped window the context store dispatches on.
 * @param {string[]} order Layer ids in registration order.
 */
function installSwitchHarness(order) {
  const restores = [];
  const replace = (target, name, value) => {
    const had = Object.hasOwn(target, name);
    const original = target[name];
    target[name] = value;
    restores.push(() => {
      if (had) target[name] = original;
      else delete target[name];
    });
  };

  const warnings = [];
  replace(console, 'warn', (...args) => { warnings.push(args.map(String).join(' ')); });

  const win = new EventTarget();
  win.location = { origin: 'http://localhost:4173' };
  win.setInterval = () => 1;
  win.clearInterval = () => {};
  win.requestAnimationFrame = () => 1;
  win.cancelAnimationFrame = () => {};
  replace(globalThis, 'window', win);
  const hud = new FakeElement();
  replace(globalThis, 'document', {
    body: new FakeElement(),
    getElementById: (id) => (id === 'hud-ais-vessel' ? hud : null),
    createElement: () => new FakeElement(),
    addEventListener() {},
    removeEventListener() {},
  });

  const viewer = {
    camera: { flyToBoundingSphere() {}, cancelFlight() {} },
    scene: {
      requestRenderMode: false,
      maximumRenderTimeChange: 0,
      requestRender() {},
      preRender: { addEventListener: () => () => {} },
    },
    entities: { add: (entity) => entity, remove() {} },
    container: new FakeElement(),
  };

  // No aircraft owns the camera, and the proximity cohorts stay empty: this
  // test is about the subject, not the scan.
  replace(flightsLayer, 'stopTracking', () => true);
  replace(militaryFlightsLayer, 'stopTracking', () => true);
  replace(flightsLayer, 'getNearby', () => []);
  replace(flightsLayer, 'getAllPositions', () => []);
  replace(militaryFlightsLayer, 'getNearby', () => []);
  replace(militaryFlightsLayer, 'getAllPositions', () => []);
  replace(aisLiveVesselsLayer, 'getNearby', () => []);
  replace(militaryInstallationsLayer, 'getNearby', () => []);

  // Contacts reads dependency readiness through this; the switch itself runs
  // on the real manager below.
  militaryAwarenessLayer.attachDataManager({
    isEnabled: () => true,
    isEffectivelyEnabled: () => true,
    setEnabled: async () => true,
    getLayerLifecycleState: () => ({ enabled: true, lifecycleState: 'enabled', uncertain: false }),
    layers: new Map(AWARENESS_DEPENDENCIES.map((id) => [
      id,
      { module: { getStats: () => ({ count: 1, status: 'ready', stale: false, error: null }) } },
    ])),
  });
  militaryAwarenessLayer.setParams({ passive: true });
  militaryAwarenessLayer.init(viewer);
  militaryAwarenessLayer.enable();
  restores.push(() => militaryAwarenessLayer.destroy());
  restores.push(() => aisLiveVesselsLayer.destroy());

  const manager = new DataLayerManager(viewer);
  for (const id of order) manager.register(MODULES[id]);
  for (const entry of manager.layers.values()) {
    entry.initialized = true;
    entry.enabled = true;
    entry.lifecycleState = 'enabled';
  }

  return {
    manager,
    warnings,
    restore() {
      for (const restore of restores.reverse()) restore();
    },
  };
}

/** Select a vessel the way selectVessel() publishes it. @returns {string} Its MMSI. */
function selectVesselSubject() {
  const position = { x: 918000, y: -4346000, z: 4561000 };
  const record = {
    name: 'LAKER',
    mmsi: '316001234',
    type: 'Cargo',
    destination: '',
    speed: 9,
    course: 90,
    heading: 90,
    lastPositionUtc: '',
    missedRefreshes: 0,
    lat: 43.6,
    lon: -79.3,
    position,
    billboard: null,
  };
  _setVesselStateForTest({
    records: [record],
    selectedRecord: record,
    trail: { clear() {}, setPositions() {}, destroy() {} },
    trailMmsi: record.mmsi,
    trailPositions: [position],
  });
  registerEntityContext(record, {
    id: `ais-${record.mmsi}`,
    layerId: 'ais-live-vessels',
    layerName: 'Live AIS Vessels',
    source: 'AISStream',
    label: record.name,
    latitude: record.lat,
    longitude: record.lon,
    properties: { mmsi: record.mmsi, type: record.type, speedKt: record.speed },
  });
  selectEntityContext(record);
  return record.mmsi;
}

/** Select a mapped site the way the installations renderer publishes it. @returns {string} Its id. */
function selectInstallationSubject() {
  const site = {};
  registerEntityContext(site, {
    id: 'osm:node:42',
    layerId: 'military-installations',
    layerName: 'Mapped Military Installations',
    label: 'CFB Test',
    latitude: 43.7,
    longitude: -79.4,
    properties: { class: 'base' },
  });
  selectEntityContext(site);
  return 'osm:node:42';
}

for (const [orderName, order] of [
  ['data.js order', DATA_JS_ORDER],
  ['Contacts first', [...DATA_JS_ORDER].reverse()],
]) {
  test(`a vessel Contact subject survives beginLocationSwitch (${orderName})`, async () => {
    const harness = installSwitchHarness(order);
    try {
      const mmsi = selectVesselSubject();
      assert.equal(militaryAwarenessLayer.getContextSnapshot()?.subject.id, mmsi, 'precondition: vessel subject');
      assert.equal(aisLiveVesselsLayer.getSelectedInfo()?.mmsi, mmsi, 'precondition: AIS holds the selection');

      await harness.manager.beginLocationSwitch({ from: FROM, to: TO, signal: new AbortController().signal });

      const snapshot = militaryAwarenessLayer.getContextSnapshot();
      assert.equal(snapshot?.subject.id, mmsi, 'the subject survives so FOCUS can return to it');
      assert.equal(snapshot.subjectPresent, true, 'no CONTACT LOST cue: the vessel never left the feed');
      assert.equal(aisLiveVesselsLayer.getSelectedInfo(), null, 'AIS still releases its own selection');
      assert.equal(getContextStore().selectedEntityId, null);
      assert.deepEqual(harness.warnings, []);
    } finally {
      harness.restore();
    }
  });

  test(`an installation Contact subject survives beginLocationSwitch (${orderName})`, async () => {
    const harness = installSwitchHarness(order);
    try {
      const id = selectInstallationSubject();
      assert.equal(militaryAwarenessLayer.getContextSnapshot()?.subject.id, id, 'precondition: installation subject');

      await harness.manager.beginLocationSwitch({ from: FROM, to: TO, signal: new AbortController().signal });

      const snapshot = militaryAwarenessLayer.getContextSnapshot();
      assert.equal(snapshot?.subject.id, id, 'the subject survives the release of its site records');
      assert.equal(snapshot.subjectPresent, true, 'no CONTACT LOST cue');
      assert.equal(getContextStore().selectedEntityId, null, 'installations still releases its own selection');
      assert.deepEqual(harness.warnings, []);
    } finally {
      harness.restore();
    }
  });
}
