import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bandEndKm,
  bandOf,
  bandStartKm,
  bandsLitByHour,
  bandsReached,
  hourBandEnd,
  hourBandOf,
  hourBandStart,
  buildRailGraph,
  buildTransportNetwork,
  mergeRailOverlay,
  networkTiles,
  numberHeap,
  packRailGraph,
  railComponents,
  railDistances,
  railGraphPieces,
  railPlaceLinks,
  railTimedReach,
  railVertexIndex,
  tileBounds,
  tileDistanceKm,
  tileOf,
  unpackRailGraph,
  walkCells,
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
  // Bands 0-2 end by 30 km; band 3 (30-40 km) waits for 40 km.
  assert.equal(bandsReached(net, 30), 3);
  assert.equal(bandsReached(net, 39.9), 3);
  assert.equal(bandsReached(net, 40), 4);
  assert.equal(bandsReached(net, 5), 0, 'nothing a band early');
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
  // lights its own end first. Each band lights at its end (2026-10-12):
  // nothing before the first hour is over.
  assert.equal(lit(0.5), 0, 'nothing lit before its band ends');
  assert.ok(lit(1) > 0 && lit(1) < all);
  assert.ok(lit(11) > lit(5), 'the second landing lights its end');
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

test('bands light at their end, never early (owner report 2026-10-12: rail lit before the spread got there)', () => {
  // A piece first reached at 5.9 h is in band 5, which ends at hour 6: lit
  // from its start it showed at hour 5, nearly an hour early.
  assert.equal(hourBandOf(5.9), 5);
  assert.equal(hourBandEnd(5), 6);
  assert.deepEqual(
    [hourBandEnd(47), hourBandEnd(48), hourBandEnd(79), hourBandEnd(80)],
    [48, 54, 240, 264],
  );
  for (const h of [0, 0.4, 1, 5.9, 47.5, 48, 53.9, 100, 239, 241, 500]) {
    const band = hourBandOf(h);
    // The end is never before the hour the piece is reached...
    assert.ok(hourBandEnd(band) > h, `hour ${h}`);
    // ...and a band is counted lit by an hour only once its end is there.
    for (let b = 0; b < band + 3; b += 1)
      assert.equal(b < bandsLitByHour(h), hourBandEnd(b) <= h, `${b} at ${h}`);
  }
  assert.equal(bandsLitByHour(0), 0, 'nothing at the start');
  assert.equal(bandsLitByHour(-1), 0);
  // The same by distance: a piece 19 km along is in band 1, lit at 20 km.
  assert.equal(bandOf(19), 1);
  assert.equal(bandEndKm(1), 20);
  for (const km of [0, 5, 19, 999, 1000, 1049, 4999, 5000, 5300])
    assert.ok(bandEndKm(bandOf(km)) > km, `${km} km`);
  assert.deepEqual(
    [bandEndKm(99), bandEndKm(100), bandEndKm(179), bandEndKm(180)],
    [1000, 1050, 5000, 5250],
  );
  assert.equal(bandEndKm(3), bandStartKm(4));
});

test('timed pieces past 100 km are never lit before their far end is reached (2026-10-12)', () => {
  // A straight line east along the equator from a landing at hour 2: 60 km/h
  // for the first 100 km, then a quarter of it, 15 km/h, so a 100 km piece
  // took 6.7 h to cross and its far end lit hours before it was reached.
  // A point every 5 km, as rail lines come.
  const kmPerDeg = 111.195;
  const line = Array.from({ length: 67 }, (_, i) => [(i * 5) / kmPerDeg, 0]);
  const timing = { speedKmh: 60, fastKm: 100, onwardShare: 0.25 };
  const hourAt = (lon) => {
    const km = lon * kmPerDeg;
    return 2 + (km <= 100 ? km / 60 : 100 / 60 + (km - 100) / 15);
  };
  const check = (bands, what, lit) => {
    let pieces = 0;
    for (const [band, list] of Object.entries(bands))
      list.forEach((flat, i) => {
        pieces += 1;
        let first = Infinity;
        let last = -Infinity;
        for (let i = 0; i < flat.length; i += 2) {
          const t = hourAt(flat[i]);
          first = Math.min(first, t);
          last = Math.max(last, t);
        }
        const b = Number(band);
        // Lit at the band end: never before its far end is reached...
        assert.ok(
          last <= hourBandEnd(b) + 0.05,
          `${what}: band ${b} lit at ${hourBandEnd(b)}, far end at ${last.toFixed(2)} h`,
        );
        // ...and never much more than a band late.
        assert.ok(
          first >= hourBandStart(b) - 0.6,
          `${what}: band ${b}, near end at ${first.toFixed(2)} h`,
        );
        // Each piece's own hour (owner report 2026-10-12: the spread paused
        // on the map, a band at a time): in its band, never before its far
        // end is reached.
        const at = lit[band][i];
        assert.ok(
          at > hourBandStart(b) && at <= hourBandEnd(b),
          `${what}: piece hour ${at} in band ${b}`,
        );
        assert.ok(
          last <= at + 0.05,
          `${what}: piece lit at ${at} h, far end at ${last.toFixed(2)} h`,
        );
      });
    return pieces;
  };
  const graph = buildRailGraph([line]);
  const [vertex, startKm] = railVertexIndex(graph).nearest(
    { lat: 0, lon: 0 },
    5,
  );
  const { time, dist } = railTimedReach(
    graph,
    [{ vertex, startKm, hour: 2 }],
    timing,
  );
  const rail = railGraphPieces(graph, time, { dist, timed: true });
  assert.ok(check(rail.bands, 'rail', rail.lit) > 15, 'cut by the hour band');
  const road = buildTransportNetwork(
    [line],
    { lat: 0, lon: 0 },
    { sources: [{ lat: 0, lon: 0, hour: 2 }], timing },
  );
  assert.ok(check(road.bands, 'road', road.lit) > 15);
  // Banded by the far end, by distance too: a 5 km piece from 25 km is in
  // the 30 km band, lit once the reach is 40 km.
  const byKm = railGraphPieces(
    graph,
    railDistances(graph, [{ vertex, startKm: 25 }]),
  );
  assert.equal(Math.min(...Object.keys(byKm.bands).map(Number)), 3);
  // Each piece by its own km, beside its band, so pieces light one by one
  // as the reach moves through a band.
  const kms = [];
  for (const [band, list] of Object.entries(byKm.bands)) {
    assert.equal(byKm.lit[band].length, list.length, `band ${band}`);
    for (const km of byKm.lit[band]) {
      assert.ok(
        km >= bandStartKm(Number(band)) && km <= bandEndKm(Number(band)),
        `${km} km in band ${band}`,
      );
      kms.push(km);
    }
  }
  assert.ok(new Set(kms).size > Object.keys(byKm.bands).length);
});

test('rail split into pieces is one network: ends 120 km apart and a T-junction end 20 m off a line', () => {
  // Measured 2026-10-12: the rail round Paris, Chicago, Toronto, Mexico City
  // and Irkutsk builds whole (nothing unreached); this locks in the joins
  // that make it so.
  const kmLon = 111.2 * Math.cos((50 * Math.PI) / 180);
  const run = (lon0, lat0, dLonKm, dLatKm, km) =>
    Array.from({ length: km / 5 + 1 }, (_, i) => [
      lon0 + ((dLonKm * i * 5) / km) * (1 / kmLon),
      lat0 + ((dLatKm * i * 5) / km) * (1 / 111.2),
    ]);
  // West piece: 100 km east from the outbreak.
  const west = run(0, 50, 100, 0, 100);
  // East piece: starts 120 km past the west piece's end.
  const east = run(220 / kmLon, 50, 100, 0, 100);
  // A branch north whose end sits 20 m off the middle of the west piece
  // (between two of its points, not on one).
  const branch = run(52.5 / kmLon, 50 + 0.02 / 111.2, 0, 50, 50);
  const network = buildTransportNetwork(
    [west, east, branch],
    { lat: 50, lon: 0 },
    { startKm: 30, joinKm: 200 },
  );
  assert.ok(network);
  assert.deepEqual(network.unreached, [], 'every piece reached');
  assert.ok(Math.abs(network.lengthKm - 250) <= 3, `${network.lengthKm} km`);
  const points = Object.values(network.bands)
    .flat()
    .flatMap((flat) => flat.filter((_, i) => i % 2 === 0));
  assert.ok(Math.max(...points) > 319 / kmLon, 'the east piece is lit');
  // Its far end: 100 km, the 120 km gap at the same speed, then 100 km.
  assert.ok(
    Math.abs(network.reachedKm - 320) <= 3,
    `${network.reachedKm} km along`,
  );
  const lats = Object.values(network.bands)
    .flat()
    .flatMap((flat) => flat.filter((_, i) => i % 2 === 1));
  assert.ok(Math.max(...lats) > 50 + 49 / 111.2, 'the branch is lit');
});

/* ---- The world rail network (owner ruling 2026-10-12) ---- */

test('world rail: the packed network measures the same distances as the network round one place', () => {
  const graph = buildRailGraph(LINES, { joinKm: 200 });
  const index = railVertexIndex(graph);
  const start = index.nearest({ lat: 0, lon: 0 }, 30);
  assert.equal(start[1], 0);
  const dist = railDistances(graph, [{ vertex: start[0], startKm: 0 }]);
  let farthest = 0;
  let unreached = 0;
  for (const d of dist)
    if (Number.isFinite(d)) farthest = Math.max(farthest, d);
    else unreached += 1;
  const old = buildTransportNetwork(
    LINES,
    { lat: 0, lon: 0 },
    { pieceKm: 5, bandKm: 10, joinKm: 200 },
  );
  assert.ok(
    Math.abs(farthest - old.reachedKm) <= 1,
    `${farthest} vs ${old.reachedKm}`,
  );
  assert.equal(unreached, 2, 'the unconnected road, 330 km off, stays apart');
  // The pieces, banded as the old answer bands them.
  const pieces = railGraphPieces(graph, dist);
  assert.ok(Math.abs(pieces.reachedKm - old.reachedKm) <= 1);
  assert.deepEqual(
    Object.keys(pieces.bands)
      .map(Number)
      .sort((a, b) => a - b),
    Object.keys(old.bands)
      .map(Number)
      .sort((a, b) => a - b),
  );
  assert.deepEqual(
    pieces.unreached,
    [],
    'not asked for: the world layer draws them',
  );
  assert.ok(
    railGraphPieces(graph, dist, { unreached: true }).unreached.length > 0,
  );
  assert.ok(Math.abs(graph.lengthKm - old.lengthKm) <= 1);
});

test('world rail: packed to bytes and back, nothing changes', () => {
  const graph = buildRailGraph(LINES, {
    joinKm: 200,
    countryAt: (lat) => (lat > 1 ? 'BB' : 'AA'),
  });
  const bytes = packRailGraph(graph, { version: 1, builtAt: 7 });
  // A Node Buffer's slice is a view: reading from one must still copy.
  const back = unpackRailGraph(Buffer.from(bytes));
  assert.deepEqual(back.meta, { version: 1, builtAt: 7 });
  for (const name of [
    'lon',
    'lat',
    'offsets',
    'targets',
    'edgeKm',
    'pathOffsets',
    'pathVerts',
    'country',
  ])
    assert.deepEqual([...back[name]], [...graph[name]], name);
  assert.deepEqual(back.countries, graph.countries);
  assert.deepEqual(back.byCountry, graph.byCountry);
  assert.equal(back.lengthKm, graph.lengthKm);
  assert.ok(back.byCountry.AA > 0 && back.byCountry.BB > 0);
  assert.throws(() => unpackRailGraph(new Uint8Array(16)));
});

test('world rail: points are one by their own latitude, far from any origin', () => {
  // Two lines meeting at 75° N, one end 30 m east of the other's: one
  // point at that latitude (0.15 km), where the equator's grid would part
  // them.
  const kmLon = 111.2 * Math.cos((75 * Math.PI) / 180);
  const a = [
    [10, 75],
    [10.5, 75],
  ];
  const b = [
    [10.5 + 0.03 / kmLon, 75],
    [11, 75],
  ];
  const graph = buildRailGraph([a, b], { joinKm: 0.001 });
  assert.equal(graph.lon.length, 3, 'the shared end is one point');
  const far = buildRailGraph(
    [
      a,
      [
        [10.5 + 2 / kmLon, 75],
        [11, 75],
      ],
    ],
    { joinKm: 0.001 },
  );
  assert.equal(far.lon.length, 4, '2 km apart: two points');
  assert.equal(new Set(railComponents(far)).size, 2);
  assert.equal(new Set(railComponents(graph)).size, 1);
});

test('world rail: crossings meet, loose ends join up to 200 km, and separate networks join their closest', () => {
  const graph = buildRailGraph(
    [
      // A cross, no shared point.
      [
        [0, 0],
        [1, 0],
      ],
      [
        [0.5, -0.5],
        [0.5, 0.5],
      ],
      // 150 km east of the cross's east end: joined.
      [
        [2.35, 0],
        [3, 0],
      ],
      // 300 km north: too far for rail.
      [
        [0.5, 3.2],
        [1, 3.2],
      ],
    ],
    { joinKm: 200 },
  );
  const comp = railComponents(graph);
  const index = railVertexIndex(graph);
  const at = (lat, lon) => comp[index.nearest({ lat, lon }, 5)[0]];
  assert.equal(at(0, 0), at(0.5, 0.5), 'the crossing joins the cross');
  assert.equal(at(0, 0), at(0, 3), 'the loose end joins the line 150 km on');
  assert.notEqual(at(0, 0), at(3.2, 0.5), '300 km is past the rail join');
  assert.ok(graph.joinedKm >= 140);
});

test('world rail: timed from many landings, the same hours as the network round the landings', () => {
  const road = [
    [
      [0, 0],
      [0.5, 0],
      [1, 0],
      [3, 0],
    ],
  ];
  const timing = { speedKmh: 100, fastKm: 100, onwardShare: 0.25 };
  const sources = [
    { lat: 0, lon: 0, hour: 0 },
    { lat: 0, lon: 3, hour: 10 },
  ];
  const old = buildTransportNetwork(
    road,
    { lat: 0, lon: 0 },
    { sources, timing },
  );
  const graph = buildRailGraph(road);
  const index = railVertexIndex(graph);
  const seeds = sources.map((s) => {
    const [vertex, startKm] = index.nearest(s, 50);
    return { vertex, startKm, hour: s.hour };
  });
  const { time, dist } = railTimedReach(graph, seeds, timing);
  const pieces = railGraphPieces(graph, time, { dist, timed: true });
  assert.ok(
    Math.abs(pieces.reachedKm - old.lastHour) <= 0.2,
    `${pieces.reachedKm} vs ${old.lastHour}`,
  );
  assert.ok(Object.keys(pieces.bands).length > 1);
});

test('world rail: places joined along the rail, the finer lines laid over, a box of lines, a heap', () => {
  // A line west to east, 0° to 3°; places at 0°, 1° and 3°.
  const line = [
    [0, 0],
    [1, 0],
    [2, 0],
    [3, 0],
  ];
  const graph = buildRailGraph([line]);
  const index = railVertexIndex(graph);
  const seeds = Int32Array.from(
    [0, 1, 3],
    (lon) => index.nearest({ lat: 0, lon }, 5)[0],
  );
  const links = railPlaceLinks(graph, seeds);
  const neighbours = (p) =>
    [...links.targets.subarray(links.offsets[p], links.offsets[p + 1])].sort();
  assert.deepEqual(neighbours(0), [1]);
  assert.deepEqual(neighbours(1), [0, 2]);
  const k = links.offsets[1] + [...neighbours(1)].indexOf(2);
  assert.ok(
    Math.abs(links.km[links.offsets[1] + 1] - 222.4) < 1 ||
      Math.abs(links.km[k] - 222.4) < 1,
  );
  // A branch 40 km north of the line's middle, its end 20 km off it: laid
  // over, it joins the world at its loose end.
  const branch = [
    [1.5, 0.18],
    [1.5, 0.5],
  ];
  const merged = mergeRailOverlay(graph, [branch], { index });
  assert.equal(merged.lon.length, graph.lon.length + 2);
  assert.equal(new Set(railComponents(merged)).size, 1);
  assert.ok(merged.lengthKm > graph.lengthKm);
  assert.equal(merged.pathOffsets.length, graph.pathOffsets.length + 1);
  // The heap gives the smallest first.
  const heap = numberHeap();
  for (const k2 of [5, 1, 4, 2, 3]) heap.push(k2, k2 * 10);
  const out = [];
  while (heap.size) out.push(heap.pop());
  assert.deepEqual(out, [10, 20, 30, 40, 50]);
});

/** A closed loop through the points: no loose end, so no end join. */
const loop = (points) => [...points, points[0]];

test('world rail: a network joins twice across rounds; a cell cut short by a closer find of a sibling is not taken as lonely (2026-10-12)', () => {
  // R: one corner 5 km from the small loop S, the opposite corner 150 km
  // from the bigger loop B; nothing else near R.
  const r = loop([
    [0, 0],
    [0.5, 0.3],
    [1, 0],
  ]);
  const s = loop([
    [-0.05, 0],
    [-0.1, 0.05],
    [-0.1, -0.05],
  ]);
  const b = loop(
    Array.from({ length: 10 }, (_, i) => {
      const a = (i / 10) * 2 * Math.PI;
      return [2.5 - 0.15 * Math.cos(a), 0.15 * Math.sin(a)];
    }),
  );
  const graph = buildRailGraph([r, s, b], { joinKm: 200 });
  const comp = railComponents(graph);
  const index = railVertexIndex(graph);
  const at = (lat, lon) => comp[index.nearest({ lat, lon }, 1)[0]];
  assert.equal(at(0, 0), at(0, -0.05), 'R joins S, 5 km off');
  assert.equal(at(0, 1), at(0, 2.35), 'then R and S join B, 150 km off');
  assert.equal(new Set(comp).size, 1);
  assert.ok(graph.joinedKm >= 150, `${graph.joinedKm} km of joins`);
});

test('world rail: a join refused (open sea) is never made, and the closest join allowed is made instead (2026-10-12)', () => {
  // A strait along 0.5° N: no join may cross it.
  const joinOk = (lat1, lon1, lat2) =>
    Math.min(lat1, lat2) > 0.5 || Math.max(lat1, lat2) < 0.5;
  const lines = [
    // The island's line, 111 km south of the far shore's.
    [
      [0, 0],
      [0.5, 0],
    ],
    // The far shore.
    [
      [0, 1],
      [0.5, 1],
    ],
    // The island's own shore, 150 km east.
    [
      [1.85, 0],
      [2.5, 0],
    ],
  ];
  const graph = buildRailGraph(lines, { joinKm: 200, joinOk });
  const comp = railComponents(graph);
  const index = railVertexIndex(graph);
  const at = (lat, lon) => comp[index.nearest({ lat, lon }, 1)[0]];
  assert.equal(at(0, 0), at(0, 2.5), 'the join on this side is made');
  assert.notEqual(at(0, 0), at(1, 0), 'none across the strait');
  assert.ok(graph.refusedJoins > 0);
  // Without joinOk every join is allowed, as before.
  const open = buildRailGraph(lines, { joinKm: 200 });
  assert.equal(new Set(railComponents(open)).size, 1);
  assert.equal(open.refusedJoins, 0);
});

test('world rail: a crossing on a long straight run in the far north is found (2026-10-12)', () => {
  // At 65° N a 2 km cell is under a km wide: this run spans some 1,500
  // cells of its box, past the cap that used to skip it.
  const graph = buildRailGraph(
    [
      [
        [20, 65],
        [21.5, 65.3],
      ],
      [
        [20.75, 65],
        [20.75, 65.3],
      ],
    ],
    { joinKm: 0.001 },
  );
  assert.equal(graph.lon.length, 5, 'the crossing is a point of its own');
  const index = railVertexIndex(graph);
  const [x] = index.nearest({ lat: 65.15, lon: 20.75 }, 1);
  assert.equal(graph.offsets[x + 1] - graph.offsets[x], 4);
  assert.equal(new Set(railComponents(graph)).size, 1);
});

test('walkCells: every cell a segment passes, in order, both cells beside a corner', () => {
  const cells = [];
  walkCells(0.5, 0.5, 3.5, 1.9, (x, y) => cells.push([x, y]));
  assert.deepEqual(cells, [
    [0, 0],
    [1, 0],
    [1, 1],
    [2, 1],
    [3, 1],
  ]);
  const diagonal = [];
  walkCells(0.5, 0.5, 2.5, 2.5, (x, y) => diagonal.push([x, y]));
  assert.deepEqual(diagonal, [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
    [2, 1],
    [1, 2],
    [2, 2],
  ]);
  const backwards = [];
  walkCells(2.5, 0.5, 0.5, 0.5, (x, y) => backwards.push([x, y]));
  assert.deepEqual(backwards, [
    [2, 0],
    [1, 0],
    [0, 0],
  ]);
});

test('world rail: the finer lines laid over count and draw only the branch lines, each point with its country (2026-10-12)', () => {
  const world = buildRailGraph(
    [
      [
        [0, 0],
        [1, 0],
        [2, 0],
        [3, 0],
      ],
    ],
    { countryAt: () => 'FR' },
  );
  const index = railVertexIndex(world);
  // The finer tiles carry the main line again (one point 55 m off it) and
  // a branch 0.3° north.
  const main = [
    [0.5, 0],
    [0.75, 0.0005],
    [1, 0],
    [1.5, 0],
  ];
  const branch = [
    [1.5, 0],
    [1.5, 0.3],
  ];
  const merged = mergeRailOverlay(world, [main, branch], { index });
  const branchKm = 0.3 * 111.19;
  assert.ok(
    Math.abs(merged.overlayKm - branchKm) < 0.5,
    `${merged.overlayKm} km`,
  );
  assert.ok(Math.abs(merged.lengthKm - world.lengthKm - branchKm) < 0.5);
  assert.equal(
    merged.pathOffsets.length,
    world.pathOffsets.length + 1,
    'only the branch is drawn again',
  );
  for (let v = world.lon.length; v < merged.lon.length; v += 1)
    assert.equal(merged.countries[merged.country[v]], 'FR');
  // With countryAt, its own codes.
  const told = mergeRailOverlay(world, [branch], {
    index,
    countryAt: () => 'BE',
  });
  assert.equal(told.countries[told.country[told.lon.length - 1]], 'BE');
  assert.deepEqual(world.countries, ['', 'FR'], 'the world is not changed');
});
