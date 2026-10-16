import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Q_REFERENCE,
  driversFromBins,
  humidityR0,
} from './outbreakEpiDrivers.mjs';
import { BIN_GROUPS } from './worldTapeBin.mjs';
import { epiParameters, presetValues } from './outbreakEpi.mjs';
import { hashOf, runScenario } from './testSupport/outbreakEpiMatrix.mjs';

const nodes = [
  { id: 'A', lat: 10, lon: 10, population: 1e6 },
  { id: 'B', lat: 20, lon: 20, population: 1e6 },
  { id: 'C', lat: 10.1, lon: 10.1, population: 1e5 }, // not tracked: takes A's
];
const tracked = [0, 1];

/** Bins for one day: humidity per place, departures per place. */
function bins(humidity, departures) {
  const K = 2;
  const make = (names) => new Float32Array(24 * K * names.length).fill(NaN);
  const weather = make(BIN_GROUPS.weather);
  const mobility = make(BIN_GROUPS.mobility);
  const trains = make(BIN_GROUPS.trains);
  for (let h = 0; h < 24; h += 1)
    for (let k = 0; k < K; k += 1) {
      weather[(h * K + k) * BIN_GROUPS.weather.length + 1] = humidity[k];
      mobility[(h * K + k) * BIN_GROUPS.mobility.length + 2] =
        h === 0 ? departures[k] : 0;
    }
  return {
    weather: { data: weather },
    mobility: { data: mobility },
    trains: { data: trains },
  };
}

test('humidity: drier air spreads more; the reference day is the model’s own season', () => {
  assert.ok(humidityR0(0.003) > humidityR0(0.015));
  const days = [
    bins([0.003, 0.016], [100, 50]),
    bins([Q_REFERENCE, 0.016], [50, 50]),
    null,
  ];
  const drivers = driversFromBins({
    nodes,
    tracked,
    binsFor: (d) => days[d],
    days: 3,
  });
  assert.ok(drivers.season(0, 0, 1) > 1, 'a dry day at A');
  assert.ok(drivers.season(1, 0, 1) < 1, 'a humid day at B');
  assert.ok(
    Math.abs(drivers.season(0, 1, 1) - 1) < 1e-5,
    'the reference humidity (stored as float32)',
  );
  assert.equal(
    drivers.season(0, 2, 0.77),
    0.77,
    'nothing recorded: the formula',
  );
  assert.equal(drivers.season(2, 0, 1), drivers.season(0, 0, 1), 'C takes A’s');
  // Travel: A flew 100 then 50 departures; its typical day is the upper
  // median, 100, so day 0 is as ever and day 1 is half.
  assert.equal(drivers.travel(0, 0, 'air'), 1);
  assert.equal(drivers.travel(0, 1, 'air'), 0.5);
  assert.equal(drivers.travel(0, 2, 'air'), 1, 'nothing recorded: as ever');
  assert.equal(drivers.travel(0, 0, 'rail'), 1, 'no trains recorded');
});

test('the engine follows the drivers: no season, no spread; no travel, no arrival; unset, as ever', () => {
  const base = runScenario('world-default');
  assert.equal(
    hashOf(runScenario('world-default', { drivers: null })),
    hashOf(base),
  );
  assert.equal(
    hashOf(runScenario('world-default', { drivers: {} })),
    hashOf(base),
  );
  const grounded = runScenario('world-default', {
    drivers: { travel: () => 0 },
  });
  assert.deepEqual(
    grounded.places.map((p) => p.id),
    ['A'],
    'nobody flies',
  );
  const still = runScenario('world-default', { drivers: { season: () => 0 } });
  assert.ok(
    still.summary.infectedP50 < base.summary.infectedP50,
    'no transmission season',
  );
});

test('commuting follows the commute driver: none keeps everyone at home; 1 is as ever', () => {
  const base = runScenario('daytime-mixing');
  assert.equal(
    hashOf(runScenario('daytime-mixing', { drivers: { commute: () => 1 } })),
    hashOf(base),
    'factors of 1 change nothing',
  );
  const home = runScenario('daytime-mixing', {
    drivers: { commute: () => 0 },
  });
  assert.deepEqual(
    home.places.map((p) => p.id),
    ['P'],
    'nobody commutes: the towns around are never reached',
  );
  assert.notEqual(
    hashOf(runScenario('daytime-mixing', { drivers: { commute: () => 2 } })),
    hashOf(base),
  );
  // One-way (home) mixing follows it too, and only on the days it says.
  const homeMixing = epiParameters({
    ...presetValues('covid2020'),
    initialCases: 500,
  });
  const oneWay = runScenario('daytime-mixing', { params: homeMixing });
  assert.equal(
    hashOf(
      runScenario('daytime-mixing', {
        params: homeMixing,
        drivers: { commute: () => 1 },
      }),
    ),
    hashOf(oneWay),
  );
  const shut = runScenario('daytime-mixing', {
    params: homeMixing,
    drivers: { commute: () => 0 },
  });
  assert.deepEqual(
    shut.places.map((p) => p.id),
    ['P'],
  );
});

test('the commute driver reads transit vehicles in service against a place’s typical day', () => {
  const K = 2;
  const day = (vehicles) => {
    const mobility = new Float32Array(24 * K * BIN_GROUPS.mobility.length).fill(
      NaN,
    );
    const c = BIN_GROUPS.mobility.indexOf('transitVehicles');
    for (let h = 0; h < 24; h += 1)
      mobility[(h * K + 0) * BIN_GROUPS.mobility.length + c] = vehicles;
    return { mobility: { data: mobility } };
  };
  const days = [day(100), day(100), day(25)];
  const drivers = driversFromBins({
    nodes,
    tracked,
    binsFor: (d) => days[d] || null,
    days: 4,
  });
  assert.equal(drivers.commute(0, 0), 1);
  assert.equal(drivers.commute(0, 2), 0.25, 'a quarter of the service');
  assert.equal(drivers.commute(0, 3), 1, 'nothing recorded: as ever');
  assert.equal(drivers.commute(1, 0), 1, 'no transit there');
  assert.equal(drivers.commute(2, 2), 0.25, 'C takes A’s');
});
