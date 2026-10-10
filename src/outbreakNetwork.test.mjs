import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bandsLitByHour,
  bandsReached,
  hourBandOf,
  hourBandStart,
  buildTransportNetwork,
  networkTiles,
  tileBounds,
  tileDistanceKm,
  tileOf,
} from './outbreakNetwork.mjs';

test('tiles: zoom-8 slippy tiles round a point, nearest first, wrapped at the antimeridian', () => {
  const at = tileOf(52.29, 104.3, 8);
  const b = tileBounds(8, at.x, at.y);
  assert.ok(
    b.west <= 104.3 && 104.3 < b.east && b.south <= 52.29 && 52.29 < b.north,
  );
  const tiles = networkTiles({ lat: 52.29, lon: 104.3 }, 500);
  assert.equal(tiles[0].km, 0, 'its own tile first');
  assert.ok(tiles.length > 50 && tiles.length < 200);
  assert.ok(tiles.every((t) => t.km <= 500));
  const wrapped = networkTiles({ lat: 65, lon: 179.5 }, 150);
  assert.ok(
    wrapped.some((t) => t.x === 0),
    'over the antimeridian',
  );
  assert.equal(
    tileDistanceKm(
      { lat: 52, lon: 104 },
      { south: 51, north: 54, west: 102, east: 105 },
    ),
    0,
  );
});

/**
 * A west–east road through the town; a road crossing it at x=0.5 with no
 * shared point; a road ending 300 m short of the first; an unconnected road.
 */
const LINES = [
  [
    [0, 0],
    [0.25, 0],
    [1, 0],
  ],
  [
    [0.5, -0.5],
    [0.5, 0.5],
    [0.5, 1],
  ],
  [
    [1.003, 0.4],
    [1.003, 0.003],
  ],
  [
    [3, 3],
    [3.2, 3],
  ],
];

test('the network: joined where lines cross and where one ends near another; distances along it', () => {
  const net = buildTransportNetwork(
    LINES,
    { lat: 0, lon: 0 },
    { pieceKm: 5, bandKm: 10, joinKm: 200 },
  );
  assert.equal(net.startKm, 0);
  // The crossing road is reached at ~55.6 km and its far end ~111 km on.
  assert.ok(Math.abs(net.reachedKm - 167) < 3, `reached ${net.reachedKm}`);
  const bands = Object.keys(net.bands).map(Number);
  assert.equal(Math.min(...bands), 0);
  assert.ok(Math.max(...bands) >= 15, 'the far end of the crossing road');
  assert.ok(
    net.unreached.length > 0 && net.unreached.every((flat) => flat[0] >= 3),
    'only the unconnected road never turns red',
  );
  assert.equal(bandsReached(net, 30), 4);
  assert.equal(bandsReached(net, 0), 0);
  assert.equal(
    buildTransportNetwork(LINES, { lat: 10, lon: 10 }),
    null,
    'too far to start',
  );
});

test('where a road seems to end, the spread carries on along the closest road, the gap at the same speed', () => {
  // The road from the town stops at x=0.4; the closest road runs north–south
  // at x=0.5, its nearest point (0.5, 0) about 11 km away.
  const apart = [
    [
      [0, 0],
      [0.25, 0],
      [0.4, 0],
    ],
    [
      [0.5, -0.5],
      [0.5, 0],
      [0.5, 0.5],
    ],
  ];
  const net = buildTransportNetwork(apart, { lat: 0, lon: 0 });
  assert.equal(net.unreached.length, 0, 'the closest road is reached');
  // 44.5 km of road, the 11.1 km gap, then up to 55.6 km along it.
  // Its own loose end joins the closest road too, so a little sooner.
  assert.ok(
    net.reachedKm > 95 && net.reachedKm < 115,
    `reached ${net.reachedKm}`,
  );
  // A road farther than the join limit stays apart.
  const far = buildTransportNetwork(apart, { lat: 0, lon: 0 }, { joinKm: 5 });
  assert.ok(
    far.unreached.length > 0 && far.unreached.every((f) => f[0] === 0.5),
  );
});

test('roads join across gaps up to 500 km; rail up to 200 km', () => {
  const gap = [
    [
      [0, 0],
      [0.5, 0],
    ],
    // About 330 km past the end of the first.
    [
      [3.5, 0],
      [3.8, 0],
    ],
  ];
  const road = buildTransportNetwork(gap, { lat: 0, lon: 0 });
  assert.equal(road.unreached.length, 0, 'roads: 330 km is within 500');
  const rail = buildTransportNetwork(gap, { lat: 0, lon: 0 }, { joinKm: 200 });
  assert.ok(rail.unreached.length > 0, 'rail: 330 km is past 200');
});

test('timed: roads out of each landing airport, lit by the hour each is first reached', () => {
  const road = [
    [
      [0, 0],
      [0.5, 0],
      [1, 0],
      [3, 0],
    ],
  ];
  const timing = { speedKmh: 100, fastKm: 100, onwardShare: 0.25 };
  const net = buildTransportNetwork(
    road,
    { lat: 0, lon: 0 },
    {
      sources: [
        { lat: 0, lon: 0, hour: 0 },
        { lat: 0, lon: 3, hour: 10 },
        { lat: 40, lon: 40, hour: 0 }, // No road near: left out.
      ],
      timing,
    },
  );
  assert.equal(net.bandsBy, 'hour');
  assert.equal(net.unreached.length, 0);
  const lit = (h) => {
    let pieces = 0;
    for (const [band, list] of Object.entries(net.bands))
      if (Number(band) < bandsLitByHour(h)) pieces += list.length;
    return pieces;
  };
  const all = Object.values(net.bands).reduce((n, list) => n + list.length, 0);
  // The first 100 km in an hour; then 25 km/h. The far landing at hour 10
  // lights its own end first.
  assert.ok(lit(0.5) > 0 && lit(0.5) < all);
  assert.ok(lit(10.5) > lit(5), 'the second landing lights its end');
  assert.equal(lit(net.lastHour + 1), all, 'all lit by the last hour');
  // The far end, 333 km from the first landing, at 1 h + 233/25 h = 10.3 h at
  // most, or 10 h from its own landing: lit by hour 11.
  assert.ok(net.lastHour <= 11.5);
  assert.deepEqual(
    [hourBandOf(5.5), hourBandOf(60), hourBandOf(300)],
    [5, 50, 82],
  );
  assert.deepEqual(
    [hourBandStart(5), hourBandStart(50), hourBandStart(82)],
    [5, 60, 288],
  );
});
