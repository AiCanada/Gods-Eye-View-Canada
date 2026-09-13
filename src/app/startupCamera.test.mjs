import test from 'node:test';
import assert from 'node:assert/strict';
import { flyToAustin, flyToStartupLocation } from '../camera.js';
import { CITY_POIS } from '../locations.js';
import { STARTUP_LOCATION_ID } from '../startupDefaults.js';

test('launch fly-in keeps the same teardown contract and centres the POI', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flights = [];
  let cancelled = 0;
  const viewer = {
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
  };
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

test('teardown before the initial camera delay prevents a late flight', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let flights = 0;
  let cancelled = 0;
  const stop = flyToAustin({
    isDestroyed: () => false,
    camera: {
      setView() {},
      flyTo() {
        flights++;
      },
      cancelFlight() {
        cancelled++;
      },
    },
  });
  stop();
  t.mock.timers.tick(1000);
  assert.equal(flights, 0);
  assert.equal(cancelled, 1);
});
