import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BIN_GROUPS,
  binDay,
  placeIndex,
  pointOf,
  sampleGrid,
  weatherFromGrids,
} from './worldTapeBin.mjs';

const places = [
  { lat: 42.36, lon: -71.06 }, // Boston
  { lat: 60.17, lon: 24.94 }, // Helsinki
];
const at = (bins, group, h, k, channel) => {
  const C = BIN_GROUPS[group].length;
  const c = BIN_GROUPS[group].indexOf(channel);
  return bins[group].data[(h * places.length + k) * C + c];
};

test('the nearest place within reach, across the antimeridian too', () => {
  const index = placeIndex([
    { lat: 0, lon: 179.9 },
    { lat: 10, lon: 10 },
  ]);
  assert.equal(index.nearest({ lat: 0, lon: -179.9 }, 50), 0);
  assert.equal(index.nearest({ lat: 10.2, lon: 10.1 }, 50), 1);
  assert.equal(index.nearest({ lat: 40, lon: 40 }, 50), -1);
  assert.deepEqual(pointOf({ centroid: [24.9, 60.1] }), {
    lat: 60.1,
    lon: 24.9,
  });
  assert.equal(pointOf({}), null);
});

test('binning a day: counts by place and hour; an hour no feed observed is NaN, a quiet one is zero', () => {
  const hours = {
    flights: Array.from({ length: 24 }, () => []),
    transit: Array.from({ length: 24 }, () => []),
    earthquakes: Array.from({ length: 24 }, () => []),
  };
  hours.flights[3] = [
    { hex: 'a1', lat: 42.4, lon: -71.0, ground: true },
    { hex: 'b2', lat: 42.3, lon: -71.1, ground: false },
  ];
  hours.flights[4] = [{ hex: 'a1', lat: 42.5, lon: -71.0, ground: false }];
  hours.transit[3] = [
    {
      region: 'mbta',
      id: 'v1',
      lat: 42.35,
      lon: -71.05,
      mode: 'bus',
      speed: 5,
    },
    { region: 'hsl', id: 'v2', lat: 60.2, lon: 24.9, mode: 'rail', speed: 20 },
  ];
  hours.earthquakes[5] = [{ id: 'q', lat: 61, lon: 25, mag: 3.2 }];
  const observed = (feed, h) =>
    (feed === 'flights' && (h === 3 || h === 4)) ||
    (feed === 'transit' && h === 3) ||
    (feed === 'earthquakes' && h >= 5);
  const bins = binDay({ places, hours, observed });
  assert.deepEqual(bins.mobility.shape, [24, 2, BIN_GROUPS.mobility.length]);
  assert.equal(at(bins, 'mobility', 3, 0, 'aircraft'), 2);
  assert.equal(at(bins, 'mobility', 3, 0, 'aircraftOnGround'), 1);
  assert.equal(
    at(bins, 'mobility', 4, 0, 'aircraftDepartures'),
    1,
    'a1 took off',
  );
  assert.equal(at(bins, 'mobility', 3, 0, 'transitBuses'), 1);
  assert.equal(at(bins, 'mobility', 3, 0, 'transitMeanSpeed'), 5);
  assert.equal(at(bins, 'trains', 3, 1, 'railVehicles'), 1);
  assert.equal(at(bins, 'trains', 3, 1, 'railMeanSpeed'), 20);
  assert.equal(
    at(bins, 'mobility', 3, 1, 'aircraft'),
    0,
    'observed, none there',
  );
  assert.ok(
    Number.isNaN(at(bins, 'mobility', 10, 0, 'aircraft')),
    'not observed',
  );
  assert.equal(at(bins, 'hazards', 5, 1, 'quakes'), 1);
  assert.equal(at(bins, 'hazards', 5, 1, 'quakeMaxMag'), Math.fround(3.2));
  assert.equal(at(bins, 'hazards', 6, 1, 'quakes'), 0, 'observed, quiet');
  assert.ok(Number.isNaN(at(bins, 'news', 3, 0, 'articles')));
});

test('weather comes from the recorded grids through weatherAt', () => {
  const bins = binDay({
    places,
    hours: {},
    observed: () => false,
    weatherAt: (place, h) =>
      h === 0 ? { t2m: 280 + place.lat / 100, humidity: 0.004 } : null,
  });
  assert.ok(Math.abs(at(bins, 'weather', 0, 0, 't2m') - 280.4236) < 1e-3);
  assert.ok(Number.isNaN(at(bins, 'weather', 1, 0, 't2m')));
});

test('a recorded grid is sampled bilinearly, wraps round the globe, and is NaN outside', () => {
  // 4 columns of 90° from 0°E, 3 rows of 45° from 45°N southward.
  const grid = { nx: 4, ny: 3, lo1: 0, la1: 45, dx: 90, dy: 45 };
  const values = [0, 10, 20, 30, 100, 110, 120, 130, 200, 210, 220, 230];
  assert.equal(sampleGrid({ values, grid }, { lat: 45, lon: 0 }), 0);
  assert.equal(sampleGrid({ values, grid }, { lat: 0, lon: 45 }), 105);
  assert.equal(sampleGrid({ values, grid }, { lat: 22.5, lon: 0 }), 50);
  // Between 270°E and 0°E again: the grid spans the globe.
  assert.equal(sampleGrid({ values, grid }, { lat: 45, lon: -45 }), 15);
  assert.ok(Number.isNaN(sampleGrid({ values, grid }, { lat: 60, lon: 0 })));
  const regional = { nx: 2, ny: 2, lo1: 0, la1: 10, dx: 1, dy: 1 };
  assert.ok(
    Number.isNaN(
      sampleGrid(
        { values: [1, 2, 3, 4], grid: regional },
        { lat: 9.5, lon: 5 },
      ),
    ),
  );
});

test('weather from the day’s grids: the field valid nearest each hour, GFS first, in the bin’s units', () => {
  const dayStart = Date.UTC(2026, 9, 12);
  const grid = { nx: 360, ny: 181, lo1: 0, la1: 90, dx: 1, dy: 1 };
  const filled = (v) => new Float32Array(360 * 181).fill(v);
  const record = (model, field, units, hour, value) => ({
    model,
    var: field,
    units,
    valid: new Date(dayStart + hour * 3_600_000).toISOString(),
    grid,
    value,
  });
  const records = [
    record('gfs', 't2m', '°C', 6, 12),
    record('ifs', 't2m', '°C', 6, 99), // GFS first
    record('gfs', 't2m', 'K', 12, 290.15), // converted to °C
    record('gfs', 'msl', 'Pa', 6, 101_300), // to hPa
    record('gfs', 'q2m', 'kg/kg', 6, 0.007),
    record('gfs', 'prate', 'mm/h', 6, 1.5),
    record('ifs', 'u10', 'm/s', 6, 3),
    record('gfs', 'v10', 'furlongs', 6, 9), // a unit not listed: left out
  ];
  const loads = [];
  const weatherAt = weatherFromGrids({
    records,
    load: (r) => {
      loads.push(r);
      return filled(r.value);
    },
    dayStart,
  });
  const boston = { lat: 42.36, lon: -71.06 };
  const six = weatherAt(boston, 6);
  assert.equal(six.t2m, 12);
  assert.ok(Math.abs(six.mslp - 1013) < 1e-6);
  assert.ok(Math.abs(six.humidity - 0.007) < 1e-9);
  assert.equal(six.precip, 1.5);
  assert.equal(six.u10, 3, 'IFS when it is the only one');
  assert.equal(six.v10, undefined);
  // 11:00–12:00 is nearer the 12:00 field; 3 h either side at most.
  assert.ok(Math.abs(weatherAt(boston, 11).t2m - 17) < 1e-4);
  assert.equal(weatherAt(boston, 20), null, 'nothing valid within 3 h');
  // A time mean counts at the middle of the hours it averages: a 0–6 h
  // rate from the 12:00 run sits at 15:00, not at 18:00.
  const mean = weatherFromGrids({
    records: [
      {
        ...record('gfs', 'prate', 'mm/h', 18, 2),
        windowStartIso: new Date(dayStart + 12 * 3_600_000).toISOString(),
        windowEndIso: new Date(dayStart + 18 * 3_600_000).toISOString(),
      },
    ],
    load: (r) => filled(r.value),
    dayStart,
  });
  assert.equal(mean(boston, 12).precip, 2, '12:30 is within 3 h of 15:00');
  assert.equal(mean(boston, 19), null, '19:30 is not');
  // Each file is read once.
  weatherAt({ lat: 60.17, lon: 24.94 }, 6);
  assert.equal(new Set(loads).size, loads.length);
});

test('transit vehicles count as trains by their mode, with GTFS speeds; traffic areas give the ratio and their segments', () => {
  const hours = {
    transit: Array.from({ length: 24 }, () => []),
    traffic: Array.from({ length: 24 }, () => []),
  };
  hours.transit[2] = [
    { id: 'r1', lat: 42.35, lon: -71.05, mode: 'rail', speedMps: 20 },
    { id: 'b1', lat: 42.36, lon: -71.06, mode: 'bus', speedMps: 10 },
    { id: 's1', lat: 42.37, lon: -71.07, mode: 'subway', speedMps: null },
  ];
  hours.traffic[2] = [
    { area: 'Boston', kind: 'segment', level: 0.5, coords: [] },
    { area: 'Boston', kind: 'segment', level: 0.9, coords: [] },
    { area: 'Boston', kind: 'area', lat: 42.36, lon: -71.06, speedShare: 0.7 },
  ];
  const bins = binDay({ places, hours });
  assert.equal(at(bins, 'trains', 2, 0, 'railVehicles'), 2);
  assert.equal(at(bins, 'trains', 2, 0, 'railMeanSpeed'), 20);
  assert.equal(at(bins, 'mobility', 2, 0, 'transitBuses'), 1);
  assert.equal(at(bins, 'mobility', 2, 0, 'transitMeanSpeed'), 15);
  assert.ok(Math.abs(at(bins, 'traffic', 2, 0, 'speedRatio') - 0.7) < 1e-6);
  assert.equal(at(bins, 'traffic', 2, 0, 'segments'), 2);
});

test('counts do not grow with polling: each aircraft, vessel and vehicle once an hour; bikes a station’s mean', () => {
  const polls = (n, make) => Array.from({ length: n }, (_, j) => make(j));
  const hours = {
    flights: Array.from({ length: 24 }, () => []),
    'ais-live-vessels': Array.from({ length: 24 }, () => []),
    transit: Array.from({ length: 24 }, () => []),
    bikeshare: Array.from({ length: 24 }, () => []),
    traffic: Array.from({ length: 24 }, () => []),
  };
  // Twelve 5-minute snapshots of one aircraft taking off, and another.
  hours.flights[5] = [
    ...polls(12, (j) => ({
      hex: 'a1',
      lat: 42.36,
      lon: -71.06,
      ground: j < 6,
    })),
    ...polls(12, () => ({ hex: 'b2', lat: 42.4, lon: -71.0, ground: false })),
  ];
  hours['ais-live-vessels'][5] = polls(60, () => ({
    mmsi: 3,
    lat: 42.35,
    lon: -71.05,
  }));
  hours.transit[5] = polls(120, (j) => ({
    region: 'mbta',
    id: 'v1',
    mode: 'rail',
    lat: 42.36,
    lon: -71.06,
    speedMps: j % 2 ? 10 : 20,
  }));
  hours.bikeshare[5] = polls(12, (j) => ({
    system: 's',
    station: 'x',
    lat: 42.36,
    lon: -71.06,
    bikes: j < 6 ? 4 : 8,
  }));
  hours.traffic[5] = [1, 2].flatMap(() => [
    { area: 'Boston', kind: 'segment', coords: [] },
    { area: 'Boston', kind: 'segment', coords: [] },
    { area: 'Boston', kind: 'area', lat: 42.36, lon: -71.06, speedShare: 0.5 },
  ]);
  const bins = binDay({ places, hours });
  assert.equal(at(bins, 'mobility', 5, 0, 'aircraft'), 2);
  assert.equal(
    at(bins, 'mobility', 5, 0, 'aircraftOnGround'),
    0,
    'a1 last seen flying',
  );
  assert.equal(at(bins, 'mobility', 5, 0, 'aircraftDepartures'), 1);
  assert.equal(at(bins, 'mobility', 5, 0, 'vessels'), 1);
  assert.equal(at(bins, 'mobility', 5, 0, 'transitVehicles'), 1);
  assert.equal(at(bins, 'trains', 5, 0, 'railVehicles'), 1);
  assert.equal(
    at(bins, 'trains', 5, 0, 'railMeanSpeed'),
    15,
    'every report’s speed',
  );
  assert.equal(at(bins, 'mobility', 5, 0, 'bikesAvailable'), 6);
  assert.equal(
    at(bins, 'traffic', 5, 0, 'segments'),
    2,
    'per poll, not per record',
  );
});

test('military flights are not counted and have no column, and another feed is one count group', () => {
  const blank = () => Array.from({ length: 24 }, () => []);
  const hours = {
    flights: blank(),
    military: blank(),
    satellites: blank(),
  };
  hours.flights[3] = [
    { hex: 'abc123', lat: 42.36, lon: -71.06, ground: false },
  ];
  hours.military[3] = [{ hex: 'mil001', lat: 42.36, lon: -71.06 }];
  hours.satellites[3] = [{ id: 's1', lat: 42.36, lon: -71.06 }];
  const withFlights = binDay({
    places,
    hours,
    countFeeds: ['satellites', 'military', 'local-dams'],
  });
  assert.equal(at(withFlights, 'mobility', 3, 0, 'aircraft'), 1);
  assert.equal(
    BIN_GROUPS.mobility.includes('military'),
    false,
    'military travel is not a channel',
  );
  assert.equal(withFlights.satellites.data[(3 * places.length + 0) * 2], 1);
  assert.equal(withFlights.military, undefined);
  assert.equal(withFlights['local-dams'], undefined);
  const onlyMilitary = binDay({
    places,
    hours: { military: hours.military },
    observed: (feed) => feed === 'military',
  });
  assert.ok(Number.isNaN(at(onlyMilitary, 'mobility', 3, 0, 'aircraft')));
});

test('a temperature record keeps its mean, and a market quote is copied to every place', () => {
  const blank = () => Array.from({ length: 24 }, () => []);
  const hours = { 'sea-surface-temperature': blank(), markets: blank() };
  hours['sea-surface-temperature'][4] = [
    { lat: 42.36, lon: -71.06, value: 10 },
    { lat: 42.36, lon: -71.06, value: 14 },
  ];
  hours.markets[4] = [{ series: 'gold', value: 2400 }];
  const bins = binDay({
    places,
    hours,
    countFeeds: ['sea-surface-temperature'],
  });
  const count =
    bins['sea-surface-temperature'].data[(4 * places.length + 0) * 2];
  const mean =
    bins['sea-surface-temperature'].data[(4 * places.length + 0) * 2 + 1];
  assert.equal(count, 2);
  assert.equal(mean, 12);
  assert.equal(bins.markets.channels[0], 'gold');
  assert.equal(bins.markets.data[(4 * places.length + 0) * 1], 2400);
  assert.equal(bins.markets.data[(4 * places.length + 1) * 1], 2400);
  hours.markets[5] = [{ series: 'gold' }];
  const blankGold = binDay({ places, hours: { markets: hours.markets } });
  assert.ok(Number.isNaN(blankGold.markets.data[(5 * places.length + 0) * 1]));
});

test('rain stays its own channel, and a tanker is not labeled as food', () => {
  const blank = () => Array.from({ length: 24 }, () => []);
  const hours = { 'observed-weather': blank(), 'ais-live-vessels': blank() };
  hours['observed-weather'][4] = [
    { lat: 42.36, lon: -71.06, value: 20, precipitationMm: 4 },
    { lat: 42.36, lon: -71.06, value: 10 },
  ];
  hours['ais-live-vessels'][4] = [
    { mmsi: '1', lat: 42.36, lon: -71.06, type: '80' },
    {
      mmsi: '2',
      lat: 42.36,
      lon: -71.06,
      type: 'Cargo',
      destination: 'wheat berth',
    },
    { mmsi: '3', lat: 42.36, lon: -71.06, type: 'Cargo' },
    { mmsi: '4', lat: 42.36, lon: -71.06, type: '35' },
  ];
  const bins = binDay({
    places,
    hours,
    countFeeds: ['observed-weather'],
  });
  const weather = bins['observed-weather'];
  assert.deepEqual(weather.channels, ['count', 'value', 'precipitationMm']);
  const reading = (channel) => {
    const c = weather.channels.indexOf(channel);
    return weather.data[(4 * places.length + 0) * weather.channels.length + c];
  };
  assert.equal(reading('count'), 2);
  assert.equal(reading('value'), 15);
  assert.equal(reading('precipitationMm'), 4);
  const supply = bins.supply;
  const ships = (channel) => {
    const c = supply.channels.indexOf(channel);
    return supply.data[(4 * places.length + 0) * supply.channels.length + c];
  };
  assert.equal(ships('tankers'), 1);
  assert.equal(ships('cargoFood'), 1);
  assert.equal(ships('cargo'), 1);
  assert.equal(ships('cargoMetal'), 0);
});

test('a headline that names oil is counted on crude, and Europe is not the euro', () => {
  const blank = () => Array.from({ length: 24 }, () => []);
  const hours = { news: blank(), 'news-urls': blank() };
  hours.news[2] = [
    { title: 'WTI crude falls', lat: 42.36, lon: -71.06 },
    { title: 'Europe stays warm', lat: 42.36, lon: -71.06 },
  ];
  hours['news-urls'][2] = [{ title: 'Gold rally' }];
  const bins = binDay({ places, hours });
  const channels = bins['news-markets'].channels;
  const atChannel = (channel, place) => {
    const c = channels.indexOf(channel);
    return bins['news-markets'].data[
      (2 * places.length + place) * channels.length + c
    ];
  };
  assert.equal(atChannel('crude', 0), 1);
  assert.equal(atChannel('crude', 1), 0);
  assert.equal(atChannel('eurusd', 0), 0);
  assert.equal(atChannel('gold', 0), 1);
  assert.equal(atChannel('gold', 1), 1);
});
