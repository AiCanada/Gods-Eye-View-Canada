import test from 'node:test';
import assert from 'node:assert/strict';
import { applyStartView, flyToStartupLocation, START_VIEW } from '../camera.js';
import { bindFakeCesiumCamera } from '../testSupport/fakeCameraPort.mjs';
import { CITY_POIS } from '../cityPois.js';
import { STARTUP_LOCATION_ID } from '../startupDefaults.js';

function viewerRecording(views) {
  return bindFakeCesiumCamera({
    isDestroyed: () => false,
    camera: {
      setView(view) {
        views.push(view);
      },
      flyTo() {
        assert.fail('a start view is set, not flown to');
      },
    },
  });
}

test('the camera starts over the whole planet, looking straight down', () => {
  const views = [];
  applyStartView(viewerRecording(views));
  assert.equal(views.length, 1);
  assert.ok(START_VIEW.height >= 20000000, 'the whole planet is in view');
  assert.ok(Math.abs(views[0].orientation.pitch + Math.PI / 2) < 1e-9);
  assert.equal(views[0].orientation.heading, 0);
});

test('a host can start the camera at a city instead', () => {
  const views = [];
  applyStartView(viewerRecording(views), {
    lon: 2.35,
    lat: 48.86,
    height: 5000,
    heading: 90,
    pitch: -30,
  });
  assert.equal(views.length, 1);
  assert.ok(Math.abs(views[0].orientation.heading - Math.PI / 2) < 1e-9);
  assert.ok(Math.abs(views[0].orientation.pitch + Math.PI / 6) < 1e-9);
});

test('launch fly-in keeps the same teardown contract and centres the POI', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flights = [];
  let cancelled = 0;
  const viewer = bindFakeCesiumCamera({
    isDestroyed: () => false,
    camera: {
      setView() {},
      flyTo(options) {
        flights.push(options);
      },
      cancelFlight() {
        cancelled++;
      },
    },
  });
  const poi = CITY_POIS[STARTUP_LOCATION_ID].pois[0];
  const stop = flyToStartupLocation(viewer, poi);
  t.mock.timers.tick(600);
  assert.equal(flights.length, 1, 'the arrival flight starts after the pause');
  assert.ok(flights[0].orientation.pitch < 0);
  stop();
  assert.equal(cancelled, 1);

  const early = flyToStartupLocation(viewer, poi);
  early();
  t.mock.timers.tick(1000);
  assert.equal(
    flights.length,
    1,
    'teardown before the pause prevents a late flight',
  );
});
