/**
 * ROAD AND RAIL SPREAD (owner ruling, 2026-10-09): instead of a circle, the
 * spread by road follows the main roads and the spread by train the rail
 * lines, lighting them up (blue, orange) as it reaches them. No DOM and no network: the
 * server fetches the lines (OpenStreetMap data, as OpenFreeMap's vector
 * tiles) and builds the network here; the page and the map read the result.
 *
 *  - The roads: motorways and trunk roads within NETWORK_RADIUS_KM.road of an
 *    outbreak location, and primary roads within NETWORK_PRIMARY_KM.
 *  - The rail: main lines within NETWORK_RADIUS_KM.rail.
 *  - Tile lines carry no junctions of their own, so lines are joined where
 *    their points meet (within NETWORK_SNAP_KM), where one ends near another
 *    (up to NETWORK_JOIN_KM: 500 km for roads, 200 km for rail), and where
 *    two cross.
 *  - From the nearest point of the network to the location, the distance
 *    along it to every point (Dijkstra). Each line is cut into pieces of
 *    about NETWORK_PIECE_KM; a piece turns red once the reach (speed × hours)
 *    passes where it starts, in bands of NETWORK_BAND_KM, so a step of the
 *    hour redraws little.
 */
import { distanceKm, validPoint } from './outbreakCore.mjs';

export const NETWORK_MODES = Object.freeze(['road', 'rail']);
/** How far round an outbreak location the network is fetched, by mode. */
export const NETWORK_RADIUS_KM = Object.freeze({ road: 500, rail: 500 });
/** Primary roads only this close: there are many more of them. */
export const NETWORK_PRIMARY_KM = 150;
/** The network starts at its nearest point, if it is at most this far. */
export const NETWORK_START_KM = Object.freeze({ road: 50, rail: 30 });
/** Vector tiles at this zoom: about 90 km across at 50°, main roads and rail. */
export const NETWORK_TILE_ZOOM = 8;
export const NETWORK_BAND_KM = 10;
export const NETWORK_PIECE_KM = 5;

/**
 * Roads keep spreading to the end of the forecast (owner ruling, 2026-10-09):
 * fetched in levels, each farther and coarser, each replacing the last.
 * Past the first, motorways and trunk roads only (the farthest, motorways
 * only), and only beyond the last level's reach (`innerKm`), where the
 * finer lines already are.
 */
export const NETWORK_ROAD_LEVELS = Object.freeze([
  Object.freeze({ level: 1, zoom: 8, radiusKm: 500, innerKm: 0 }),
  Object.freeze({ level: 2, zoom: 6, radiusKm: 2500, innerKm: 500 }),
  Object.freeze({
    level: 3,
    zoom: 5,
    radiusKm: 8000,
    innerKm: 2500,
    trunk: false,
  }),
]);

/**
 * Bands of distance along the network: 10 km to 1,000 km, then 50 km to
 * 5,000 km, then 250 km, so a continent of roads is a few hundred bands.
 */
export function bandOf(km) {
  const d = Math.max(0, km);
  if (d < 1000) return Math.floor(d / 10);
  if (d < 5000) return 100 + Math.floor((d - 1000) / 50);
  return 180 + Math.floor((d - 5000) / 250);
}

/**
 * Bands of time for roads reached after a landing: each hour to 48 h, then
 * every 6 hours to 10 days, then a day at a time.
 */
export function hourBandOf(hours) {
  const h = Math.max(0, hours);
  if (h < 48) return Math.floor(h);
  if (h < 240) return 48 + Math.floor((h - 48) / 6);
  return 80 + Math.floor((h - 240) / 24);
}

/** Where hour band `b` starts, in hours. */
export function hourBandStart(b) {
  if (b < 48) return b;
  if (b < 80) return 48 + (b - 48) * 6;
  return 240 + (b - 80) * 24;
}

/** The hour bands lit by `hour`: band numbers below this. */
export function bandsLitByHour(hour) {
  return hour >= 0 ? hourBandOf(hour) + 1 : 0;
}

/** Where band `b` starts, in km along the network. */
export function bandStartKm(b) {
  if (b < 100) return b * 10;
  if (b < 180) return 1000 + (b - 100) * 50;
  return 5000 + (b - 180) * 250;
}

/**
 * Pieces: half a band near the outbreak, as long as a band farther out, so a
 * continent of roads stays a few tens of thousands of pieces.
 */
function pieceKmAt(d, base) {
  if (!(d < 1000)) return d < 5000 ? base * 10 : base * 50;
  return base;
}

/** The faint not-yet-reached roads are drawn only this near the outbreak. */
export const NETWORK_WAITING_KM = 500;
/** Points this close are one point (tile coordinates are rounded). */
export const NETWORK_SNAP_KM = 0.15;
/**
 * A line that seems to end joins the closest other line up to this far, by
 * mode (owner rulings, 2026-10-09: switch to the closest road; roads up to
 * 500 km), the gap crossed at the same speed.
 */
export const NETWORK_JOIN_KM = Object.freeze({ road: 500, rail: 200 });
/** Points closer than this to the line between their neighbours are dropped. */
export const NETWORK_SIMPLIFY_KM = 0.05;

/** Slippy-map tile of a point. */
export function tileOf(lat, lon, z) {
  const n = 2 ** z;
  const rad = (lat * Math.PI) / 180;
  return {
    x: Math.min(n - 1, Math.max(0, Math.floor(((lon + 180) / 360) * n))),
    y: Math.min(
      n - 1,
      Math.max(
        0,
        Math.floor(
          ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n,
        ),
      ),
    ),
  };
}

/** A tile's bounds in degrees. */
export function tileBounds(z, x, y) {
  const n = 2 ** z;
  const lat = (row) =>
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / n))) * 180) / Math.PI;
  return {
    west: (x / n) * 360 - 180,
    east: ((x + 1) / n) * 360 - 180,
    north: lat(y),
    south: lat(y + 1),
  };
}

/** The nearest distance from `point` to a tile, in km (0 inside it). */
export function tileDistanceKm(point, tile) {
  const lat = Math.min(tile.north, Math.max(tile.south, point.lat));
  const lon = Math.min(tile.east, Math.max(tile.west, point.lon));
  return distanceKm(point, { lat, lon });
}

/** The tiles at `z` within `radiusKm` of `point`, nearest first. */
export function networkTiles(point, radiusKm, z = NETWORK_TILE_ZOOM) {
  const p = validPoint(point?.lat, point?.lon);
  if (!p) return [];
  const dLat = radiusKm / 111.2;
  const dLon =
    radiusKm / (111.2 * Math.max(0.05, Math.cos((p.lat * Math.PI) / 180)));
  // Longitudes wrapped, so a reach over the antimeridian keeps its tiles.
  const wrap = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;
  const nw = tileOf(Math.min(85, p.lat + dLat), wrap(p.lon - dLon), z);
  const se = tileOf(Math.max(-85, p.lat - dLat), wrap(p.lon + dLon), z);
  const n = 2 ** z;
  const tiles = [];
  const span = (se.x - nw.x + n) % n;
  for (let dx = 0; dx <= span; dx += 1)
    for (let y = nw.y; y <= se.y; y += 1) {
      const x = (nw.x + dx) % n;
      const bounds = tileBounds(z, x, y);
      const tile = { z, x, y, ...bounds };
      const km = tileDistanceKm(p, tile);
      if (km <= radiusKm) tiles.push({ ...tile, km });
    }
  return tiles.sort((a, b) => a.km - b.km);
}

/** A small binary heap of [distance, vertex]. */
function heap() {
  const items = [];
  return {
    get size() {
      return items.length;
    },
    push(d, v) {
      items.push([d, v]);
      let i = items.length - 1;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (items[parent][0] <= items[i][0]) break;
        [items[parent], items[i]] = [items[i], items[parent]];
        i = parent;
      }
    },
    pop() {
      const top = items[0];
      const last = items.pop();
      if (items.length) {
        items[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1;
          const r = l + 1;
          let m = i;
          if (l < items.length && items[l][0] < items[m][0]) m = l;
          if (r < items.length && items[r][0] < items[m][0]) m = r;
          if (m === i) break;
          [items[m], items[i]] = [items[i], items[m]];
          i = m;
        }
      }
      return top;
    },
  };
}

/** The hour part-way along a stretch: between its ends, or its one known end. */
function blendHours(a, b, f) {
  if (Number.isFinite(a) && Number.isFinite(b)) return a + f * (b - a);
  return Number.isFinite(a) ? a : b;
}

/** Drop points within `tolKm` of the straight line between their neighbours. */
function simplify(points, tolKm) {
  if (points.length <= 2) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const A = points[a];
    const B = points[b];
    const cos = Math.cos((A[1] * Math.PI) / 180);
    const ax = A[0] * cos * 111.2;
    const ay = A[1] * 111.2;
    const bx = B[0] * cos * 111.2 - ax;
    const by = B[1] * 111.2 - ay;
    const len2 = bx * bx + by * by || 1e-12;
    let worst = -1;
    let at = -1;
    for (let i = a + 1; i < b; i += 1) {
      const px = points[i][0] * cos * 111.2 - ax;
      const py = points[i][1] * 111.2 - ay;
      const t = Math.max(0, Math.min(1, (px * bx + py * by) / len2));
      const dx = px - t * bx;
      const dy = py - t * by;
      const d = dx * dx + dy * dy;
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (at > 0 && worst > tolKm * tolKm) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * The network as the map draws it: from the nearest point to `origin`, the
 * distance along the lines to every point; each line cut into pieces, each
 * piece in the band of NETWORK_BAND_KM its start is reached in.
 *
 * @param {[number, number][][]} lines Each a run of [lon, lat] points.
 * @param {{lat: number, lon: number}} origin
 * @returns {?{bandKm: number, startKm: number, bands: Object<string, number[][]>,
 *   unreached: number[][], reachedKm: number, lengthKm: number}} Null when no
 *   part of the network is within `startKm`. reachedKm is the farthest
 *   distance along the network from the start, not the km reached: every
 *   piece in `bands` is reached, those in `unreached` are not; lengthKm is
 *   the sum of every line. Timed (with `sources`): bandsBy 'hour', lastHour,
 *   lengthKm and `seeded`, the sources with a point within `startKm`.
 */
export function buildTransportNetwork(
  lines,
  origin,
  {
    startKm = NETWORK_START_KM.road,
    bandKm = NETWORK_BAND_KM,
    pieceKm = NETWORK_PIECE_KM,
    snapKm = NETWORK_SNAP_KM,
    joinKm = NETWORK_JOIN_KM.road,
    simplifyKm = NETWORK_SIMPLIFY_KM,
    sources = null,
    timing = null,
  } = {},
) {
  // Timed: many starting points, each with its hour (a landing), and the
  // network measured in hours, not km (the road after a flight).
  const timed = Array.isArray(sources) && sources.length > 0 && timing;
  // Timed: how many sources had a point of the network within startKm.
  let seeded = 0;
  // Vertices: points within snapKm (a grid) are one point.
  const cos0 = Math.cos((origin.lat * Math.PI) / 180);
  const gx = snapKm / (111.2 * Math.max(0.05, cos0));
  const gy = snapKm / 111.2;
  const ids = new Map();
  const lon = [];
  const lat = [];
  const vertex = (x, y) => {
    const key = `${Math.round(x / gx)},${Math.round(y / gy)}`;
    let v = ids.get(key);
    if (v === undefined) {
      v = lon.length;
      ids.set(key, v);
      lon.push(x);
      lat.push(y);
    }
    return v;
  };
  const paths = [];
  for (const line of lines) {
    const path = [];
    for (const [x, y] of line) {
      if (!validPoint(y, x)) continue;
      const v = vertex(x, y);
      if (path[path.length - 1] !== v) path.push(v);
    }
    if (path.length >= 2) paths.push(path);
  }
  if (!lon.length) return null;
  const km = (a, b) =>
    distanceKm({ lat: lat[a], lon: lon[a] }, { lat: lat[b], lon: lon[b] });
  const adjacency = [];
  const link = (a, b, d) => {
    (adjacency[a] ||= []).push(b, d);
    (adjacency[b] ||= []).push(a, d);
  };
  let lengthKm = 0;
  // Segments, by grid cell of about 2 km, to find crossings and near ends.
  const cell = 2 / 111.2;
  const cells = new Map();
  const segments = [];
  // Crossings found part-way along a segment: segment -> [[u, vertex]].
  const splits = new Map();
  for (const path of paths)
    for (let k = 1; k < path.length; k += 1) {
      const a = path[k - 1];
      const b = path[k];
      const d = km(a, b);
      lengthKm += d;
      link(a, b, d);
      const s = segments.push([a, b]) - 1;
      const x0 = Math.floor(Math.min(lon[a], lon[b]) / cell);
      const x1 = Math.floor(Math.max(lon[a], lon[b]) / cell);
      const y0 = Math.floor(Math.min(lat[a], lat[b]) / cell);
      const y1 = Math.floor(Math.max(lat[a], lat[b]) / cell);
      // Long straight runs touch many cells; a cap keeps it bounded.
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > 400) continue;
      for (let x = x0; x <= x1; x += 1)
        for (let y = y0; y <= y1; y += 1) {
          const key = `${x},${y}`;
          if (!cells.has(key)) cells.set(key, []);
          cells.get(key).push(s);
        }
    }
  // Where two lines cross: a junction joining all four ends.
  const crossing = (s, t) => {
    const [a, b] = segments[s];
    const [c, d] = segments[t];
    if (a === c || a === d || b === c || b === d) return null;
    const x1 = lon[a];
    const y1 = lat[a];
    const x2 = lon[b];
    const y2 = lat[b];
    const x3 = lon[c];
    const y3 = lat[c];
    const x4 = lon[d];
    const y4 = lat[d];
    const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if (Math.abs(den) < 1e-15) return null;
    const u = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den;
    const w = ((x1 - x3) * (y1 - y2) - (y1 - y3) * (x1 - x2)) / den;
    if (u <= 0 || u >= 1 || w <= 0 || w >= 1) return null;
    return { point: [x1 + u * (x2 - x1), y1 + u * (y2 - y1)], u, w };
  };
  const done = new Set();
  for (const list of cells.values())
    for (let i = 0; i < list.length; i += 1)
      for (let j = i + 1; j < list.length; j += 1) {
        const s = Math.min(list[i], list[j]);
        const t = Math.max(list[i], list[j]);
        const pair = s * segments.length + t;
        if (done.has(pair)) continue;
        done.add(pair);
        const hit = crossing(s, t);
        if (!hit) continue;
        const x = vertex(hit.point[0], hit.point[1]);
        for (const end of [...segments[s], ...segments[t]])
          if (end !== x) link(end, x, km(end, x));
        // The crossing goes into both lines too, so each is measured right.
        (splits.get(s) || splits.set(s, []).get(s)).push([hit.u, x]);
        (splits.get(t) || splits.set(t, []).get(t)).push([hit.w, x]);
      }
  // Each line with its crossings in order, for cutting into pieces.
  let segment = 0;
  const drawn = paths.map((path) => {
    const out = [path[0]];
    for (let k = 1; k < path.length; k += 1) {
      for (const [, x] of (splits.get(segment) || []).sort(
        (a, b) => a[0] - b[0],
      ))
        if (out[out.length - 1] !== x) out.push(x);
      if (out[out.length - 1] !== path[k]) out.push(path[k]);
      segment += 1;
    }
    return out;
  });
  // Where a line seems to end (owner ruling, 2026-10-09): the spread carries
  // on along the closest other line, however far, crossing the gap at the
  // same speed (its length counts as distance travelled). Points by grid
  // cell of about 10 km, searched ring by ring outward from the end.
  const degree = (v) => (adjacency[v]?.length || 0) / 2;
  const pathOf = new Int32Array(lon.length).fill(-1);
  paths.forEach((path, p) => {
    for (const v of path) if (pathOf[v] < 0) pathOf[v] = p;
  });
  const wide = 10 / 111.2;
  const pointCells = new Map();
  for (let v = 0; v < lon.length; v += 1) {
    if (!adjacency[v]) continue;
    const key = `${Math.floor(lon[v] / wide)},${Math.floor(lat[v] / wide)}`;
    if (!pointCells.has(key)) pointCells.set(key, []);
    pointCells.get(key).push(v);
  }
  // A cell is 10 km tall and narrower east to west toward the poles.
  const shrink = (y) => Math.max(0.05, Math.cos((y * Math.PI) / 180));
  /**
   * The nearest point to v that `accept` takes, within `limit` km: ring by
   * ring of cells outward, each ring's edge only, stopping once no farther
   * ring can hold a closer point.
   */
  const ringSearch = (v, limit, accept) => {
    const cx = Math.floor(lon[v] / wide);
    const cy = Math.floor(lat[v] / wide);
    const s = shrink(lat[v]);
    let best = -1;
    let bestKm = limit;
    const visit = (x, y) => {
      for (const u of pointCells.get(`${x},${y}`) || []) {
        if (!accept(u)) continue;
        const d = km(v, u);
        if (d < bestKm) {
          best = u;
          bestKm = d;
        }
      }
    };
    const maxRing = Math.ceil(limit / (10 * s)) + 1;
    for (let ring = 0; ring <= maxRing; ring += 1) {
      if ((ring - 1) * 10 * s > bestKm) break;
      if (ring === 0) {
        visit(cx, cy);
        continue;
      }
      for (let dx = -ring; dx <= ring; dx += 1) {
        visit(cx + dx, cy - ring);
        visit(cx + dx, cy + ring);
      }
      for (let dy = -ring + 1; dy <= ring - 1; dy += 1) {
        visit(cx - ring, cy + dy);
        visit(cx + ring, cy + dy);
      }
    }
    return best >= 0 ? [best, bestKm] : null;
  };
  paths.forEach((path, p) => {
    for (const end of [path[0], path[path.length - 1]]) {
      if (degree(end) > 1) continue;
      const hit = ringSearch(end, joinKm, (u) => u !== end && pathOf[u] !== p);
      if (hit) link(end, hit[0], hit[1]);
    }
  });
  const n = lon.length;
  // Where it starts: the nearest point, reached straight from the location.
  let start = -1;
  let startDist = Infinity;
  for (let v = 0; v < n; v += 1) {
    if (!adjacency[v]) continue;
    const d = distanceKm(origin, { lat: lat[v], lon: lon[v] });
    if (d < startDist) {
      startDist = d;
      start = v;
    }
  }
  if (!timed && !(startDist <= startKm)) return null;
  // A whole network of lines that never meets the outbreak's (a rail line
  // the tiles show as separate): joined at its closest point to another,
  // the gap crossed at the same speed, until every one within joinKm is.
  const parent = new Int32Array(n);
  for (let v = 0; v < n; v += 1) parent[v] = v;
  const root = (v) => {
    while (parent[v] !== v) {
      parent[v] = parent[parent[v]];
      v = parent[v];
    }
    return v;
  };
  const unite = (a, b) => {
    parent[root(a)] = root(b);
  };
  for (let v = 0; v < n; v += 1) {
    const list = adjacency[v] || [];
    for (let k = 0; k < list.length; k += 2) unite(v, list[k]);
  }
  const groups = new Map();
  for (let v = 0; v < n; v += 1) {
    if (!adjacency[v]) continue;
    const r = root(v);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(v);
  }
  // Nearest the outbreak first, so each joins toward it.
  const nearestTo = (members) => {
    let best = Infinity;
    for (const v of members) best = Math.min(best, km(start, v));
    return best;
  };
  const others = [...groups.values()]
    .filter((members) => root(members[0]) !== root(start))
    .map((members) => [nearestTo(members), members])
    .sort((a, b) => a[0] - b[0])
    .map(([, members]) => members);
  for (const members of others) {
    if (root(members[0]) === root(start)) continue;
    // From its loose ends and every tenth point: a network's closest point
    // to another is almost always among them.
    const from =
      members.length <= 50
        ? members
        : members.filter((v, i) => degree(v) <= 1 || i % 10 === 0);
    let pair = null;
    for (const v of from) {
      const own = root(v);
      const hit = ringSearch(
        v,
        pair ? pair[2] : joinKm,
        (u) => root(u) !== own,
      );
      if (hit) pair = [v, hit[0], hit[1]];
    }
    if (!pair) continue;
    link(pair[0], pair[1], pair[2]);
    unite(pair[0], pair[1]);
  }
  const dist = new Float64Array(n).fill(Infinity);
  const time = timed ? new Float64Array(n).fill(Infinity) : null;
  const queue = heap();
  if (!timed) {
    dist[start] = startDist;
    queue.push(startDist, start);
    while (queue.size) {
      const [d, v] = queue.pop();
      if (d > dist[v]) continue;
      const list = adjacency[v] || [];
      for (let k = 0; k < list.length; k += 2) {
        const u = list[k];
        const next = d + list[k + 1];
        if (next < dist[u]) {
          dist[u] = next;
          queue.push(next, u);
        }
      }
    }
  } else {
    // Fast for the first stretch, then slower: hours for d km from a landing.
    const speed = Math.max(1, timing.speedKmh || 100);
    const fastKm = timing.fastKm ?? 100;
    const share = Math.max(0.01, timing.onwardShare ?? 0.25);
    const hoursFor = (d) =>
      d <= fastKm ? d / speed : fastKm / speed + (d - fastKm) / (speed * share);
    const fromHour = new Float64Array(n);
    // The nearest point to each source, within startKm.
    const nearestPoint = (point) => {
      let best = -1;
      let bestKm = startKm;
      const cx = Math.floor(point.lon / wide);
      const cy = Math.floor(point.lat / wide);
      const span = Math.ceil(startKm / (10 * shrink(point.lat))) + 1;
      for (let dx = -span; dx <= span; dx += 1)
        for (let dy = -span; dy <= span; dy += 1)
          for (const u of pointCells.get(`${cx + dx},${cy + dy}`) || []) {
            const d = distanceKm(point, { lat: lat[u], lon: lon[u] });
            if (d < bestKm) {
              best = u;
              bestKm = d;
            }
          }
      return best >= 0 ? [best, bestKm] : null;
    };
    for (const source of sources) {
      const hit = nearestPoint(source);
      if (!hit) continue;
      seeded += 1;
      const [v, d0] = hit;
      const t = source.hour + hoursFor(d0);
      if (t < time[v]) {
        time[v] = t;
        dist[v] = d0;
        fromHour[v] = source.hour;
        queue.push(t, v);
      }
    }
    if (!queue.size) return null;
    while (queue.size) {
      const [t, v] = queue.pop();
      if (t > time[v]) continue;
      const list = adjacency[v] || [];
      for (let k = 0; k < list.length; k += 2) {
        const u = list[k];
        const d = dist[v] + list[k + 1];
        const next = fromHour[v] + hoursFor(d);
        if (next < time[u]) {
          time[u] = next;
          dist[u] = d;
          fromHour[u] = fromHour[v];
          queue.push(next, u);
        }
      }
    }
  }
  // What each point is banded by: km along, or the hour it is reached.
  const value = timed ? time : dist;
  // Pieces: runs of about `pieceKm` along each line, banded by where the
  // spread first reaches them.
  const bands = {};
  const unreached = [];
  let reachedKm = 0;
  const flush = (points, first) => {
    if (points.length < 2) return;
    const flat = [];
    for (const [x, y] of simplify(points, timed ? simplifyKm * 10 : simplifyKm))
      flat.push(Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4);
    if (!Number.isFinite(first)) {
      unreached.push(flat);
      return;
    }
    const band = timed
      ? hourBandOf(first)
      : bandKm === NETWORK_BAND_KM
        ? bandOf(first)
        : Math.floor(first / bandKm);
    (bands[band] ||= []).push(flat);
  };
  for (const path of drawn) {
    // Every point of the line with its distance along the network; a long
    // straight stretch is cut so each piece is measured where it lies.
    const points = [[lon[path[0]], lat[path[0]], value[path[0]]]];
    for (let k = 1; k < path.length; k += 1) {
      const a = path[k - 1];
      const b = path[k];
      const length = km(a, b);
      const steps = Math.max(
        1,
        Math.ceil(length / pieceKmAt(Math.min(dist[a], dist[b]), pieceKm)),
      );
      for (let i = 1; i <= steps; i += 1) {
        const f = i / steps;
        points.push([
          lon[a] + f * (lon[b] - lon[a]),
          lat[a] + f * (lat[b] - lat[a]),
          i === steps
            ? value[b]
            : timed
              ? blendHours(value[a], value[b], f)
              : Math.min(dist[a] + f * length, dist[b] + (1 - f) * length),
        ]);
      }
    }
    let piece = [points[0]];
    let run = 0;
    for (let k = 1; k < points.length; k += 1) {
      const [x0, y0] = points[k - 1];
      const [x1, y1, d] = points[k];
      run += distanceKm({ lat: y0, lon: x0 }, { lat: y1, lon: x1 });
      piece.push(points[k]);
      if (Number.isFinite(d)) reachedKm = Math.max(reachedKm, d);
      // The roads after landings span continents: long, plain pieces.
      const cut = timed ? pieceKm * 20 : pieceKmAt(d, pieceKm);
      if (run >= cut || k === points.length - 1) {
        flush(
          piece.map(([x, y]) => [x, y]),
          Math.min(...piece.map((p) => p[2])),
        );
        piece = [points[k]];
        run = 0;
      }
    }
  }
  if (timed)
    return {
      bandsBy: 'hour',
      bands,
      unreached,
      lastHour: Math.round(reachedKm * 10) / 10,
      lengthKm: Math.round(lengthKm),
      seeded,
    };
  return {
    bandKm,
    startKm: Math.round(startDist * 10) / 10,
    bands,
    unreached,
    reachedKm: Math.round(reachedKm),
    lengthKm: Math.round(lengthKm),
  };
}

/** The bands reached by `reachKm` along the network: band numbers below this. */
export function bandsReached(network, reachKm) {
  if (!network || !(reachKm > 0)) return 0;
  if (network.bandKm && network.bandKm !== NETWORK_BAND_KM)
    return Math.floor(reachKm / network.bandKm) + 1;
  return bandOf(reachKm) + 1;
}

/* ---------------------------------------------------------------------------
 * THE WORLD RAIL NETWORK (owner ruling 2026-10-12: every rail line on the
 * globe, in the outbreak sim). One network of every rail line the zoom-8
 * tiles carry, built once in the background (server/providers/
 * outbreakRailWorld.js) with the same joins as buildTransportNetwork: points
 * within NETWORK_SNAP_KM are one, lines that cross meet, a loose end joins
 * the closest other line up to NETWORK_JOIN_KM.rail, and a whole network
 * that never meets another joins its closest one up to the same. Kept packed
 * (typed arrays), so it crosses to worker threads and to disk whole; reach
 * from any number of starting points is a Dijkstra over it.
 * buildTransportNetwork itself is unchanged: it still answers every request
 * until the world network is ready, and stays the fallback after.
 * ------------------------------------------------------------------------- */

/** A growable list of numbers, as a typed array once done. */
function numbers() {
  let items = new Float64Array(1024);
  let size = 0;
  return {
    get size() {
      return size;
    },
    push(v) {
      if (size === items.length) {
        const next = new Float64Array(items.length * 2);
        next.set(items);
        items = next;
      }
      items[size] = v;
      size += 1;
      return size - 1;
    },
    get(i) {
      return items[i];
    },
    done(Type) {
      return Type.from(items.subarray(0, size));
    },
  };
}

/** A binary heap of (key, vertex) on typed arrays: big networks, few objects. */
export function numberHeap() {
  let keys = new Float64Array(1024);
  let values = new Int32Array(1024);
  let size = 0;
  return {
    get size() {
      return size;
    },
    push(key, value) {
      if (size === keys.length) {
        const k = new Float64Array(size * 2);
        k.set(keys);
        keys = k;
        const v = new Int32Array(size * 2);
        v.set(values);
        values = v;
      }
      let i = size;
      size += 1;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (keys[parent] <= key) break;
        keys[i] = keys[parent];
        values[i] = values[parent];
        i = parent;
      }
      keys[i] = key;
      values[i] = value;
    },
    /** The smallest key's vertex; its key is `lastKey` after. */
    pop() {
      const topValue = values[0];
      this.lastKey = keys[0];
      size -= 1;
      if (size > 0) {
        const key = keys[size];
        const value = values[size];
        let i = 0;
        for (;;) {
          const l = 2 * i + 1;
          if (l >= size) break;
          const r = l + 1;
          const m = r < size && keys[r] < keys[l] ? r : l;
          if (keys[m] >= key) break;
          keys[i] = keys[m];
          values[i] = values[m];
          i = m;
        }
        keys[i] = key;
        values[i] = value;
      }
      return topValue;
    },
    lastKey: 0,
  };
}

const KM_PER_DEG = 111.2;
/** Grid cells of about 10 km, numbered: rows by latitude, columns by longitude. */
const WIDE_DEG = 10 / KM_PER_DEG;
const cellKey = (cx, cy) => (cy + 2000) * 100_000 + (cx + 50_000);

/** km between two points given as raw degrees. */
function kmBetween(lat1, lon1, lat2, lon2) {
  return distanceKm({ lat: lat1, lon: lon1 }, { lat: lat2, lon: lon2 });
}

/**
 * Every grid cell a straight segment passes through, in cell units (a
 * cell is 1 by 1): visit(x, y) for each, in order from (x0, y0). Where it
 * passes through a corner both cells beside it are visited too.
 */
export function walkCells(x0, y0, x1, y1, visit) {
  let cx = Math.floor(x0);
  let cy = Math.floor(y0);
  const ex = Math.floor(x1);
  const ey = Math.floor(y1);
  const dx = x1 - x0;
  const dy = y1 - y0;
  const sx = dx > 0 ? 1 : -1;
  const sy = dy > 0 ? 1 : -1;
  const stepX = dx ? 1 / Math.abs(dx) : Infinity;
  const stepY = dy ? 1 / Math.abs(dy) : Infinity;
  let nextX = dx ? (sx > 0 ? cx + 1 - x0 : x0 - cx) * stepX : Infinity;
  let nextY = dy ? (sy > 0 ? cy + 1 - y0 : y0 - cy) * stepY : Infinity;
  visit(cx, cy);
  let left = Math.abs(ex - cx) + Math.abs(ey - cy);
  while (left > 0 && (cx !== ex || cy !== ey)) {
    if (nextX < nextY) {
      cx += sx;
      nextX += stepX;
      left -= 1;
    } else if (nextY < nextX) {
      cy += sy;
      nextY += stepY;
      left -= 1;
    } else {
      visit(cx + sx, cy);
      visit(cx, cy + sy);
      cx += sx;
      cy += sy;
      nextX += stepX;
      nextY += stepY;
      left -= 2;
    }
    visit(cx, cy);
  }
  if (cx !== ex || cy !== ey) visit(ex, ey);
}

/**
 * Build the world rail network from its lines.
 *
 * @param {[number, number][][]} lines Each a run of [lon, lat] points.
 * @param {object} [options]
 * @param {number} [options.snapKm] Points this close are one.
 * @param {number} [options.joinKm] Loose ends and separate networks join
 *   the closest other line up to this far (NETWORK_JOIN_KM.rail).
 * @param {(lat: number, lon: number) => string} [options.countryAt] Each
 *   point's country, for the counts by country.
 * @param {(lat1: number, lon1: number, lat2: number, lon2: number) =>
 *   boolean} [options.joinOk] Whether a straight join between two points is
 *   allowed (the world build refuses a join mostly over open sea); every
 *   join is allowed without it.
 * @returns {object} The packed network: lon and lat per point (Float64),
 *   `offsets`/`targets`/`edgeKm` (each point's neighbours, CSR), the drawn
 *   lines (`pathOffsets`/`pathVerts`, crossings in order), `country` (an
 *   index into `countries`, per point), and `lengthKm` (the lines' own
 *   length, joins apart), `joinedKm` (the length of the joins), `byCountry`,
 *   `refusedJoins` (the closest joins `joinOk` refused).
 */
export function buildRailGraph(
  lines,
  {
    snapKm = NETWORK_SNAP_KM,
    joinKm = NETWORK_JOIN_KM.rail,
    countryAt = null,
    joinOk = null,
  } = {},
) {
  // Points within snapKm are one: rows by latitude, columns by each row's
  // own width (owner ruling 2026-10-12: a world network is snapped by each
  // point's latitude, not one origin's).
  const gy = snapKm / KM_PER_DEG;
  const ids = new Map();
  const lonList = numbers();
  const latList = numbers();
  const vertex = (x, y) => {
    const row = Math.round(y / gy);
    const gx =
      snapKm /
      (KM_PER_DEG * Math.max(0.05, Math.cos((row * gy * Math.PI) / 180)));
    const col = Math.round(x / gx);
    const key = (row + 70_000) * 300_000 + (col + 150_000);
    let v = ids.get(key);
    if (v === undefined) {
      v = lonList.push(x);
      latList.push(y);
      ids.set(key, v);
    }
    return v;
  };
  const paths = [];
  for (const line of lines) {
    const path = [];
    for (const point of line) {
      const [x, y] = point;
      if (!validPoint(y, x)) continue;
      const v = vertex(x, y);
      if (path[path.length - 1] !== v) path.push(v);
    }
    if (path.length >= 2) paths.push(path);
  }
  const lonAt = (v) => lonList.get(v);
  const latAt = (v) => latList.get(v);
  const km = (a, b) => kmBetween(latAt(a), lonAt(a), latAt(b), lonAt(b));
  const eA = numbers();
  const eB = numbers();
  const eKm = numbers();
  const degree = new Map();
  const deg = (v) => degree.get(v) || 0;
  const link = (a, b, d) => {
    if (a === b) return;
    eA.push(a);
    eB.push(b);
    eKm.push(d);
    degree.set(a, deg(a) + 1);
    degree.set(b, deg(b) + 1);
  };
  let lengthKm = 0;
  // Segments by grid cell of about 2 km, to find crossings. A pair is
  // tested once: in the cell at the low corner of where their cells meet,
  // so no list of pairs already tested is kept (a world of rail has
  // millions).
  const cell = 2 / KM_PER_DEG;
  const cells = new Map();
  const segA = numbers();
  const segB = numbers();
  const box = numbers();
  const lengthByVertex = new Map();
  // Segments whose box spans many cells: each is in the cells it passes
  // through, and its pairs are tested once by a list of pairs (few).
  const long = new Set();
  const tested = new Set();
  const addToCell = (x, y, s) => {
    const key = (y + 50_000) * 400_000 + (x + 200_000);
    let list = cells.get(key);
    if (!list) cells.set(key, (list = []));
    if (list[list.length - 1] !== s) list.push(s);
  };
  for (const path of paths)
    for (let k = 1; k < path.length; k += 1) {
      const a = path[k - 1];
      const b = path[k];
      const d = km(a, b);
      lengthKm += d;
      lengthByVertex.set(a, (lengthByVertex.get(a) || 0) + d);
      link(a, b, d);
      const s = segA.push(a);
      segB.push(b);
      const x0 = Math.floor(Math.min(lonAt(a), lonAt(b)) / cell);
      const x1 = Math.floor(Math.max(lonAt(a), lonAt(b)) / cell);
      const y0 = Math.floor(Math.min(latAt(a), latAt(b)) / cell);
      const y1 = Math.floor(Math.max(latAt(a), latAt(b)) / cell);
      box.push(x0);
      box.push(y0);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) <= 400) {
        for (let x = x0; x <= x1; x += 1)
          for (let y = y0; y <= y1; y += 1) addToCell(x, y, s);
        continue;
      }
      // A long straight run (2026-10-12: the zoom-8 main lines of Siberia,
      // Canada or the Sahara, where a cell is under a km wide): walked
      // through the cells it passes, never skipped, so every crossing on it
      // is found.
      long.add(s);
      walkCells(
        lonAt(a) / cell,
        latAt(a) / cell,
        lonAt(b) / cell,
        latAt(b) / cell,
        (x, y) => addToCell(x, y, s),
      );
    }
  const splits = new Map();
  for (const [key, list] of cells) {
    if (list.length < 2) continue;
    const cy = Math.floor(key / 400_000) - 50_000;
    const cx = (key % 400_000) - 200_000;
    for (let i = 0; i < list.length; i += 1)
      for (let j = i + 1; j < list.length; j += 1) {
        const s = Math.min(list[i], list[j]);
        const t = Math.max(list[i], list[j]);
        if (long.has(s) || long.has(t)) {
          const pair = s * 2 ** 27 + t;
          if (tested.has(pair)) continue;
          tested.add(pair);
        } else if (
          Math.max(box.get(s * 2), box.get(t * 2)) !== cx ||
          Math.max(box.get(s * 2 + 1), box.get(t * 2 + 1)) !== cy
        )
          continue;
        const a = segA.get(s);
        const b = segB.get(s);
        const c = segA.get(t);
        const d = segB.get(t);
        if (a === c || a === d || b === c || b === d) continue;
        const x1 = lonAt(a);
        const y1 = latAt(a);
        const x2 = lonAt(b);
        const y2 = latAt(b);
        const x3 = lonAt(c);
        const y3 = latAt(c);
        const x4 = lonAt(d);
        const y4 = latAt(d);
        const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
        if (Math.abs(den) < 1e-15) continue;
        const u = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den;
        const w = ((x1 - x3) * (y1 - y2) - (y1 - y3) * (x1 - x2)) / den;
        if (u <= 0 || u >= 1 || w <= 0 || w >= 1) continue;
        const x = vertex(x1 + u * (x2 - x1), y1 + u * (y2 - y1));
        for (const end of [a, b, c, d]) if (end !== x) link(end, x, km(end, x));
        (splits.get(s) || splits.set(s, []).get(s)).push([u, x]);
        (splits.get(t) || splits.set(t, []).get(t)).push([w, x]);
      }
  }
  cells.clear();
  tested.clear();
  long.clear();
  // The drawn lines: each with its crossings in order.
  let segment = 0;
  const drawn = paths.map((path) => {
    const out = [path[0]];
    for (let k = 1; k < path.length; k += 1) {
      for (const [, x] of (splits.get(segment) || []).sort(
        (p, q) => p[0] - q[0],
      ))
        if (out[out.length - 1] !== x) out.push(x);
      if (out[out.length - 1] !== path[k]) out.push(path[k]);
      segment += 1;
    }
    return out;
  });
  splits.clear();
  const n = lonList.size;
  const lon = lonList.done(Float64Array);
  const lat = latList.done(Float64Array);
  const pathOf = new Int32Array(n).fill(-1);
  paths.forEach((path, p) => {
    for (const v of path) if (pathOf[v] < 0) pathOf[v] = p;
  });
  // Points by cell of about 10 km, for the joins.
  const pointCells = new Map();
  for (let v = 0; v < n; v += 1) {
    if (!deg(v)) continue;
    const key = cellKey(
      Math.floor(lon[v] / WIDE_DEG),
      Math.floor(lat[v] / WIDE_DEG),
    );
    let list = pointCells.get(key);
    if (!list) pointCells.set(key, (list = []));
    list.push(v);
  }
  const shrink = (y) => Math.max(0.05, Math.cos((y * Math.PI) / 180));
  // Whether a join is allowed (2026-10-12: the world build refuses one
  // mostly over open sea), asked once per pair.
  const okPairs = new Map();
  let refusedJoins = 0;
  const pairOk = (v, u) => {
    if (typeof joinOk !== 'function') return true;
    const key = v < u ? v * n + u : u * n + v;
    let ok = okPairs.get(key);
    if (ok === undefined) {
      ok = Boolean(joinOk(lat[v], lon[v], lat[u], lon[u]));
      okPairs.set(key, ok);
      if (!ok) refusedJoins += 1;
    }
    return ok;
  };
  const ringSearch = (v, limit, accept) => {
    const cx = Math.floor(lon[v] / WIDE_DEG);
    const cy = Math.floor(lat[v] / WIDE_DEG);
    const s = shrink(lat[v]);
    let best = -1;
    let bestKm = limit;
    const visit = (x, y) => {
      for (const u of pointCells.get(cellKey(x, y)) || []) {
        if (!accept(u)) continue;
        const d = kmBetween(lat[v], lon[v], lat[u], lon[u]);
        if (d < bestKm && pairOk(v, u)) {
          best = u;
          bestKm = d;
        }
      }
    };
    const maxRing = Math.ceil(limit / (10 * s)) + 1;
    for (let ring = 0; ring <= maxRing; ring += 1) {
      if ((ring - 1) * 10 * s > bestKm) break;
      if (ring === 0) {
        visit(cx, cy);
        continue;
      }
      for (let dx = -ring; dx <= ring; dx += 1) {
        visit(cx + dx, cy - ring);
        visit(cx + dx, cy + ring);
      }
      for (let dy = -ring + 1; dy <= ring - 1; dy += 1) {
        visit(cx - ring, cy + dy);
        visit(cx + ring, cy + dy);
      }
    }
    return best >= 0 ? [best, bestKm] : null;
  };
  // Where a line seems to end: on along the closest other line.
  let joinedKm = 0;
  paths.forEach((path, p) => {
    for (const end of [path[0], path[path.length - 1]]) {
      if (deg(end) > 1) continue;
      const hit = ringSearch(end, joinKm, (u) => u !== end && pathOf[u] !== p);
      if (hit) {
        link(end, hit[0], hit[1]);
        joinedKm += hit[1];
      }
    }
  });
  // Whole networks that never meet another: each joins the closest other
  // up to joinKm, round after round, until none is left with one in reach.
  // Searched cell by cell: a cell with no other network within joinKm of
  // it (by a join allowed) never gets one later (networks only merge), so
  // it is skipped after. Only a search that ran out to joinKm says so
  // (2026-10-12): one cut short by a closer find of a sibling cell keeps
  // going, out to joinKm, until it sees any other network at all.
  const parent = new Int32Array(n);
  for (let v = 0; v < n; v += 1) parent[v] = v;
  const root = (v) => {
    while (parent[v] !== v) {
      parent[v] = parent[parent[v]];
      v = parent[v];
    }
    return v;
  };
  for (let e = 0; e < eA.size; e += 1) {
    const a = root(eA.get(e));
    const b = root(eB.get(e));
    if (a !== b) parent[a] = b;
  }
  const lonely = new Set();
  for (let round = 0; round < 64; round += 1) {
    // The biggest network is left to be found by the others.
    const size = new Map();
    for (const list of pointCells.values())
      for (const v of list) {
        const r = root(v);
        size.set(r, (size.get(r) || 0) + 1);
      }
    if (size.size < 2) break;
    let biggest = -1;
    for (const [r, count] of size)
      if (biggest < 0 || count > size.get(biggest)) biggest = r;
    const best = new Map();
    for (const [key, list] of pointCells) {
      if (lonely.has(key)) continue;
      const cy = Math.floor(key / 100_000) - 2000;
      const cx = (key % 100_000) - 50_000;
      const own = new Set();
      for (const v of list) own.add(root(v));
      own.delete(biggest);
      if (!own.size) continue;
      let found = false;
      const s = shrink((cy + 0.5) * WIDE_DEG);
      const maxRing = Math.ceil(joinKm / (10 * s)) + 1;
      // The closest point of another network to this cell's points.
      for (const r of own) {
        const mine = list.filter((v) => root(v) === r);
        let pair = best.get(r) || null;
        let limit = pair ? pair[2] : joinKm;
        // Any other network within joinKm by an allowed join, seen here.
        let seen = false;
        for (let ring = 0; ring <= maxRing; ring += 1) {
          if ((ring - 1) * 10 * s > (seen ? limit : joinKm)) break;
          // The closest pair to each other cell of this ring, closest
          // first, each asked whether it is allowed.
          const near = [];
          for (let dy = -ring; dy <= ring; dy += 1)
            for (let dx = -ring; dx <= ring; dx += 1) {
              if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
              const other = pointCells.get(cellKey(cx + dx, cy + dy));
              if (!other) continue;
              let closest = null;
              for (const u of other) {
                if (root(u) === r) continue;
                for (const v of mine) {
                  const d = kmBetween(lat[v], lon[v], lat[u], lon[u]);
                  if (d < joinKm && (!closest || d < closest[2]))
                    closest = [v, u, d];
                }
              }
              if (closest) near.push(closest);
            }
          near.sort((p, q) => p[2] - q[2]);
          for (const candidate of near) {
            if (seen && candidate[2] >= limit) break;
            if (!pairOk(candidate[0], candidate[1])) continue;
            seen = true;
            if (candidate[2] < limit) {
              limit = candidate[2];
              pair = candidate;
            }
          }
        }
        if (pair) best.set(r, pair);
        if (seen) found = true;
      }
      if (!found) lonely.add(key);
    }
    if (!best.size) break;
    let joined = 0;
    for (const [v, u, d] of best.values()) {
      const a = root(v);
      const b = root(u);
      if (a === b) continue;
      link(v, u, d);
      joinedKm += d;
      parent[a] = b;
      joined += 1;
    }
    if (!joined) break;
  }
  pointCells.clear();
  okPairs.clear();
  // Each point's neighbours, packed (CSR).
  const m = eA.size;
  const offsets = new Int32Array(n + 1);
  for (let e = 0; e < m; e += 1) {
    offsets[eA.get(e) + 1] += 1;
    offsets[eB.get(e) + 1] += 1;
  }
  for (let v = 0; v < n; v += 1) offsets[v + 1] += offsets[v];
  const fill = offsets.slice(0, n);
  const targets = new Int32Array(2 * m);
  const edgeKm = new Float32Array(2 * m);
  for (let e = 0; e < m; e += 1) {
    const a = eA.get(e);
    const b = eB.get(e);
    const d = eKm.get(e);
    targets[fill[a]] = b;
    edgeKm[fill[a]] = d;
    fill[a] += 1;
    targets[fill[b]] = a;
    edgeKm[fill[b]] = d;
    fill[b] += 1;
  }
  let total = 0;
  for (const path of drawn) total += path.length;
  const pathOffsets = new Int32Array(drawn.length + 1);
  const pathVerts = new Int32Array(total);
  let at = 0;
  drawn.forEach((path, p) => {
    pathOffsets[p] = at;
    pathVerts.set(path, at);
    at += path.length;
  });
  pathOffsets[drawn.length] = at;
  // Each point's country, and the lines' length by country.
  const countries = [''];
  const countryIndex = new Map([['', 0]]);
  const country = new Uint16Array(n);
  const byCountry = {};
  if (typeof countryAt === 'function')
    for (let v = 0; v < n; v += 1) {
      const code = countryAt(lat[v], lon[v]) || '';
      let i = countryIndex.get(code);
      if (i === undefined) {
        i = countries.push(code) - 1;
        countryIndex.set(code, i);
      }
      country[v] = i;
    }
  for (const [v, d] of lengthByVertex) {
    const code = countries[country[v]];
    byCountry[code] = (byCountry[code] || 0) + d;
  }
  for (const code of Object.keys(byCountry))
    byCountry[code] = Math.round(byCountry[code]);
  return {
    lon,
    lat,
    offsets,
    targets,
    edgeKm,
    pathOffsets,
    pathVerts,
    country,
    countries,
    lengthKm: Math.round(lengthKm),
    joinedKm: Math.round(joinedKm),
    byCountry,
    refusedJoins,
  };
}

/** The typed arrays of a world rail network, by name and type. */
const RAIL_GRAPH_ARRAYS = Object.freeze([
  ['lon', Float64Array],
  ['lat', Float64Array],
  ['offsets', Int32Array],
  ['targets', Int32Array],
  ['edgeKm', Float32Array],
  ['pathOffsets', Int32Array],
  ['pathVerts', Int32Array],
  ['country', Uint16Array],
]);
const RAIL_GRAPH_MAGIC = 'GEVRAIL1';

/**
 * The network as one buffer for disk: a magic word, the length of a JSON
 * header (every field that is not an array, and where each array is), the
 * header, then each array on an 8-byte boundary.
 *
 * @returns {Uint8Array}
 */
export function packRailGraph(graph, meta = {}) {
  const header = { meta, fields: {}, arrays: [] };
  for (const [key, value] of Object.entries(graph))
    if (key !== 'meta' && !RAIL_GRAPH_ARRAYS.some(([name]) => name === key))
      header.fields[key] = value;
  let offset = 0;
  for (const [name] of RAIL_GRAPH_ARRAYS) {
    const array = graph[name];
    header.arrays.push({ name, offset, length: array.length });
    offset += Math.ceil(array.byteLength / 8) * 8;
  }
  const json = new TextEncoder().encode(JSON.stringify(header));
  const start = Math.ceil((8 + 4 + json.length) / 8) * 8;
  const out = new Uint8Array(start + offset);
  out.set(new TextEncoder().encode(RAIL_GRAPH_MAGIC), 0);
  new DataView(out.buffer).setUint32(8, json.length, true);
  out.set(json, 12);
  for (const [i, [name]] of RAIL_GRAPH_ARRAYS.entries()) {
    const array = graph[name];
    out.set(
      new Uint8Array(array.buffer, array.byteOffset, array.byteLength),
      start + header.arrays[i].offset,
    );
  }
  return out;
}

/** The network back from packRailGraph's buffer, with its `meta`. */
export function unpackRailGraph(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (new TextDecoder().decode(buf.subarray(0, 8)) !== RAIL_GRAPH_MAGIC)
    throw new Error('Not a world rail network');
  const length = new DataView(buf.buffer, buf.byteOffset).getUint32(8, true);
  const header = JSON.parse(
    new TextDecoder().decode(buf.subarray(12, 12 + length)),
  );
  const start = Math.ceil((8 + 4 + length) / 8) * 8;
  const graph = { ...header.fields, meta: header.meta };
  for (const [i, [name, Type]] of RAIL_GRAPH_ARRAYS.entries()) {
    const { offset, length: count } = header.arrays[i];
    const from = start + offset;
    // Copied, so each array starts on its own aligned buffer.
    // (Uint8Array's own slice: a Node Buffer's slice is a view.)
    graph[name] = new Type(
      Uint8Array.prototype.slice.call(
        buf,
        from,
        from + count * Type.BYTES_PER_ELEMENT,
      ).buffer,
    );
  }
  return graph;
}

/**
 * The points of the network by cell of about 10 km, to find the nearest
 * point to anywhere: `nearest(point, maxKm)` is [vertex, km] or null.
 */
export function railVertexIndex(graph) {
  const n = graph.lon.length;
  const keys = new Float64Array(n);
  const order = new Int32Array(n);
  for (let v = 0; v < n; v += 1) {
    order[v] = v;
    keys[v] = cellKey(
      Math.floor(graph.lon[v] / WIDE_DEG),
      Math.floor(graph.lat[v] / WIDE_DEG),
    );
  }
  order.sort((a, b) => keys[a] - keys[b]);
  const start = new Map();
  for (let i = 0; i < n; i += 1) {
    const key = keys[order[i]];
    const range = start.get(key);
    if (!range) start.set(key, [i, i + 1]);
    else range[1] = i + 1;
  }
  return {
    nearest(point, maxKm) {
      const cx = Math.floor(point.lon / WIDE_DEG);
      const cy = Math.floor(point.lat / WIDE_DEG);
      const s = Math.max(0.05, Math.cos((point.lat * Math.PI) / 180));
      const span = Math.ceil(maxKm / (10 * s)) + 1;
      const spanY = Math.ceil(maxKm / 10) + 1;
      let best = -1;
      let bestKm = maxKm;
      for (let dy = -spanY; dy <= spanY; dy += 1)
        for (let dx = -span; dx <= span; dx += 1) {
          const range = start.get(cellKey(cx + dx, cy + dy));
          if (!range) continue;
          for (let i = range[0]; i < range[1]; i += 1) {
            const v = order[i];
            const d = kmBetween(
              point.lat,
              point.lon,
              graph.lat[v],
              graph.lon[v],
            );
            if (d <= bestKm) {
              best = v;
              bestKm = d;
            }
          }
        }
      return best >= 0 ? [best, bestKm] : null;
    },
  };
}

/**
 * Distance along the network from the nearest of many starting points
 * (multi-source Dijkstra).
 *
 * @param {{vertex: number, startKm?: number}[]} sources
 * @returns {Float64Array} km per point; Infinity where never reached.
 */
export function railDistances(graph, sources) {
  const n = graph.lon.length;
  const dist = new Float64Array(n).fill(Infinity);
  const queue = numberHeap();
  for (const { vertex, startKm = 0 } of sources) {
    if (!(vertex >= 0 && vertex < n)) continue;
    if (startKm < dist[vertex]) {
      dist[vertex] = startKm;
      queue.push(startKm, vertex);
    }
  }
  const { offsets, targets, edgeKm } = graph;
  while (queue.size) {
    const v = queue.pop();
    const d = queue.lastKey;
    if (d > dist[v]) continue;
    for (let k = offsets[v]; k < offsets[v + 1]; k += 1) {
      const u = targets[k];
      const next = d + edgeKm[k];
      if (next < dist[u]) {
        dist[u] = next;
        queue.push(next, u);
      }
    }
  }
  return dist;
}

/**
 * Hours to every point from many timed starting points (the landings), each
 * stretch reached first by whichever gets there soonest: fast for the first
 * `fastKm` from the landing, then at `onwardShare` of the speed, the timing
 * of buildTransportNetwork's timed mode.
 *
 * @param {{vertex: number, startKm?: number, hour: number}[]} seeds
 * @returns {{time: Float64Array, dist: Float64Array}}
 */
export function railTimedReach(
  graph,
  seeds,
  { speedKmh = 60, fastKm = 100, onwardShare = 0.25 } = {},
) {
  const n = graph.lon.length;
  const speed = Math.max(1, speedKmh || 60);
  const share = Math.max(0.01, onwardShare ?? 0.25);
  const hoursFor = (d) =>
    d <= fastKm ? d / speed : fastKm / speed + (d - fastKm) / (speed * share);
  const time = new Float64Array(n).fill(Infinity);
  const dist = new Float64Array(n).fill(Infinity);
  const fromHour = new Float64Array(n);
  const queue = numberHeap();
  for (const { vertex, startKm = 0, hour } of seeds) {
    if (!(vertex >= 0 && vertex < n) || !Number.isFinite(hour)) continue;
    const t = hour + hoursFor(startKm);
    if (t < time[vertex]) {
      time[vertex] = t;
      dist[vertex] = startKm;
      fromHour[vertex] = hour;
      queue.push(t, vertex);
    }
  }
  const { offsets, targets, edgeKm } = graph;
  while (queue.size) {
    const v = queue.pop();
    const t = queue.lastKey;
    if (t > time[v]) continue;
    for (let k = offsets[v]; k < offsets[v + 1]; k += 1) {
      const u = targets[k];
      const d = dist[v] + edgeKm[k];
      const next = fromHour[v] + hoursFor(d);
      if (next < time[u]) {
        time[u] = next;
        dist[u] = d;
        fromHour[u] = fromHour[v];
        queue.push(next, u);
      }
    }
  }
  return { time, dist };
}

/**
 * The network cut into pieces and banded, as buildTransportNetwork answers:
 * by km along it (`value` the distance) or, timed, by the hour (`value` the
 * hour, `dist` the km). Lines never reached go to `unreached` only when
 * asked: the world's rail away from a reach is drawn by the world layer.
 *
 * @returns {{bands: Object<string, number[][]>, unreached: number[][],
 *   reachedKm: number}} reachedKm is the farthest value reached (km, or
 *   the last hour when timed).
 */
export function railGraphPieces(
  graph,
  value,
  {
    dist = value,
    timed = false,
    pieceKm = NETWORK_PIECE_KM,
    simplifyKm = NETWORK_SIMPLIFY_KM,
    unreached: keepUnreached = false,
  } = {},
) {
  const { lon, lat, pathOffsets, pathVerts } = graph;
  const km = (a, b) => kmBetween(lat[a], lon[a], lat[b], lon[b]);
  const bands = {};
  const unreached = [];
  let reachedKm = 0;
  const flush = (points, first) => {
    if (points.length < 2) return;
    if (!Number.isFinite(first) && !keepUnreached) return;
    const flat = [];
    for (const [x, y] of simplify(points, timed ? simplifyKm * 10 : simplifyKm))
      flat.push(Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4);
    if (!Number.isFinite(first)) {
      unreached.push(flat);
      return;
    }
    const band = timed ? hourBandOf(first) : bandOf(first);
    (bands[band] ||= []).push(flat);
  };
  for (let p = 0; p + 1 < pathOffsets.length; p += 1) {
    const from = pathOffsets[p];
    const to = pathOffsets[p + 1];
    if (to - from < 2) continue;
    let any = false;
    for (let i = from; i < to && !any; i += 1)
      any = Number.isFinite(value[pathVerts[i]]);
    if (!any && !keepUnreached) continue;
    const first = pathVerts[from];
    const points = [[lon[first], lat[first], value[first]]];
    for (let i = from + 1; i < to; i += 1) {
      const a = pathVerts[i - 1];
      const b = pathVerts[i];
      const length = km(a, b);
      const steps = Math.max(
        1,
        Math.ceil(length / pieceKmAt(Math.min(dist[a], dist[b]), pieceKm)),
      );
      for (let s = 1; s <= steps; s += 1) {
        const f = s / steps;
        points.push([
          lon[a] + f * (lon[b] - lon[a]),
          lat[a] + f * (lat[b] - lat[a]),
          s === steps
            ? value[b]
            : timed
              ? blendHours(value[a], value[b], f)
              : Math.min(value[a] + f * length, value[b] + (1 - f) * length),
        ]);
      }
    }
    let piece = [points[0]];
    let run = 0;
    for (let k = 1; k < points.length; k += 1) {
      const [x0, y0] = points[k - 1];
      const [x1, y1, d] = points[k];
      run += kmBetween(y0, x0, y1, x1);
      piece.push(points[k]);
      if (Number.isFinite(d)) reachedKm = Math.max(reachedKm, d);
      const cut = timed ? pieceKm * 20 : pieceKmAt(d, pieceKm);
      if (run >= cut || k === points.length - 1) {
        let least = Infinity;
        for (const q of piece) if (q[2] < least) least = q[2];
        flush(
          piece.map(([x, y]) => [x, y]),
          least,
        );
        piece = [points[k]];
        run = 0;
      }
    }
  }
  return { bands, unreached, reachedKm };
}

/**
 * Each drawn line's box, [west, south, east, north] by line, so the world
 * rail layer's tiles skip the lines nowhere near them.
 */
export function railPathBoxes(graph) {
  const { lon, lat, pathOffsets, pathVerts } = graph;
  const paths = pathOffsets.length - 1;
  const boxes = new Float64Array(Math.max(0, paths) * 4);
  for (let p = 0; p < paths; p += 1) {
    let west = Infinity;
    let south = Infinity;
    let east = -Infinity;
    let north = -Infinity;
    for (let i = pathOffsets[p]; i < pathOffsets[p + 1]; i += 1) {
      const v = pathVerts[i];
      if (lon[v] < west) west = lon[v];
      if (lon[v] > east) east = lon[v];
      if (lat[v] < south) south = lat[v];
      if (lat[v] > north) north = lat[v];
    }
    boxes.set([west, south, east, north], p * 4);
  }
  return boxes;
}

/**
 * The network's lines inside a box, simplified to `tolKm` (the world rail
 * layer's tiles): flat [lon, lat, ...] runs, four decimals. `boxes`
 * (railPathBoxes) skips the lines whose own box misses it.
 */
export function railGraphLinesIn(graph, box, tolKm = 1, boxes = null) {
  const { lon, lat, pathOffsets, pathVerts } = graph;
  const inside = (v) =>
    lon[v] >= box.west &&
    lon[v] <= box.east &&
    lat[v] >= box.south &&
    lat[v] <= box.north;
  const out = [];
  const flush = (run) => {
    if (run.length < 2) return;
    const flat = [];
    for (const [x, y] of simplify(run, tolKm))
      flat.push(Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4);
    out.push(flat);
  };
  for (let p = 0; p + 1 < pathOffsets.length; p += 1) {
    // A line wholly outside, by its own box with a little room, is skipped
    // (a point just outside is kept only beside one inside).
    if (
      boxes &&
      (boxes[p * 4] > box.east + 1 ||
        boxes[p * 4 + 2] < box.west - 1 ||
        boxes[p * 4 + 1] > box.north + 1 ||
        boxes[p * 4 + 3] < box.south - 1)
    )
      continue;
    let run = [];
    for (let i = pathOffsets[p]; i < pathOffsets[p + 1]; i += 1) {
      const v = pathVerts[i];
      const prev = i > pathOffsets[p] ? pathVerts[i - 1] : -1;
      const next = i + 1 < pathOffsets[p + 1] ? pathVerts[i + 1] : -1;
      // A point just outside is kept when its neighbour is inside, so a
      // line crossing the edge reaches it.
      if (
        inside(v) ||
        (prev >= 0 && inside(prev)) ||
        (next >= 0 && inside(next))
      )
        run.push([lon[v], lat[v]]);
      else if (run.length) {
        flush(run);
        run = [];
      }
    }
    flush(run);
  }
  return out;
}

/**
 * The places on the network joined by rail: each place starts from its
 * point (`seeds`, a vertex per place, -1 for none); every point of the
 * network goes to its nearest place along it, and two places whose shares
 * of the network touch are neighbours, as far apart as the way between them
 * through that touch (a network Voronoi diagram). Distances along these
 * links are distances along the rail between the places.
 *
 * @param {Int32Array|number[]} seeds A vertex per place, or -1.
 * @returns {{offsets: Int32Array, targets: Int32Array, km: Float64Array}}
 *   Each place's neighbours (CSR over the places).
 */
export function railPlaceLinks(graph, seeds) {
  const n = graph.lon.length;
  const label = new Int32Array(n).fill(-1);
  const dist = new Float64Array(n).fill(Infinity);
  const queue = numberHeap();
  const places = seeds.length;
  const pairs = new Map();
  const addPair = (a, b, d) => {
    if (a === b) return;
    const key = a < b ? a * places + b : b * places + a;
    const was = pairs.get(key);
    if (was === undefined || d < was) pairs.set(key, d);
  };
  // Places on the same point: the first takes it; the others link to it.
  for (let p = 0; p < places; p += 1) {
    const v = seeds[p];
    if (!(v >= 0 && v < n)) continue;
    if (label[v] >= 0) {
      addPair(label[v], p, 0);
      continue;
    }
    label[v] = p;
    dist[v] = 0;
    queue.push(0, v);
  }
  const { offsets, targets, edgeKm } = graph;
  while (queue.size) {
    const v = queue.pop();
    const d = queue.lastKey;
    if (d > dist[v]) continue;
    for (let k = offsets[v]; k < offsets[v + 1]; k += 1) {
      const u = targets[k];
      const next = d + edgeKm[k];
      if (next < dist[u]) {
        dist[u] = next;
        label[u] = label[v];
        queue.push(next, u);
      }
    }
  }
  for (let v = 0; v < n; v += 1) {
    if (label[v] < 0) continue;
    for (let k = offsets[v]; k < offsets[v + 1]; k += 1) {
      const u = targets[k];
      if (u < v || label[u] < 0 || label[u] === label[v]) continue;
      addPair(label[v], label[u], dist[v] + edgeKm[k] + dist[u]);
    }
  }
  const offsetsOut = new Int32Array(places + 1);
  for (const key of pairs.keys()) {
    offsetsOut[Math.floor(key / places) + 1] += 1;
    offsetsOut[(key % places) + 1] += 1;
  }
  for (let p = 0; p < places; p += 1) offsetsOut[p + 1] += offsetsOut[p];
  const fill = offsetsOut.slice(0, places);
  const targetsOut = new Int32Array(offsetsOut[places]);
  const kmOut = new Float64Array(offsetsOut[places]);
  for (const [key, d] of pairs) {
    const a = Math.floor(key / places);
    const b = key % places;
    targetsOut[fill[a]] = b;
    kmOut[fill[a]] = d;
    fill[a] += 1;
    targetsOut[fill[b]] = a;
    kmOut[fill[b]] = d;
    fill[b] += 1;
  }
  return { offsets: offsetsOut, targets: targetsOut, km: kmOut };
}

/**
 * The world network with finer lines laid over it near a source (the
 * zoom-10 tiles, which carry the branch lines the zoom-8 ones leave out):
 * the finer lines are built as their own network, then joined to the world
 * where they touch it (within `touchKm`), at their loose ends (the closest
 * world point up to `joinKm`), and, a finer network that touched nothing,
 * at its closest point to the world up to `joinKm`. A new network; the
 * world's is not changed. `lengthKm` and `overlayKm` count only the finer
 * lines off the world's (the branch lines), and only those are drawn again;
 * each finer point has a country (`countryAt`, else its nearest world
 * point's).
 */
export function mergeRailOverlay(
  world,
  lines,
  {
    index = null,
    joinKm = NETWORK_JOIN_KM.rail,
    touchKm = 0.5,
    countryAt = null,
  } = {},
) {
  if (!lines?.length) return world;
  const sub = buildRailGraph(lines, { joinKm });
  const nW = world.lon.length;
  const nS = sub.lon.length;
  if (!nS) return world;
  const near = index || railVertexIndex(world);
  const extra = new Map();
  const add = (a, b, d) => {
    if (!extra.has(a)) extra.set(a, []);
    if (!extra.has(b)) extra.set(b, []);
    extra.get(a).push(b, d);
    extra.get(b).push(a, d);
  };
  const subDegree = (v) => sub.offsets[v + 1] - sub.offsets[v];
  const point = (v) => ({ lat: sub.lat[v], lon: sub.lon[v] });
  // Wider and wider: most finer points lie on or by a world line.
  const nearest = (v, limit) => {
    for (const km of [2, 10, 50, limit]) {
      if (km > limit) break;
      const hit = near.nearest(point(v), km);
      if (hit) return hit;
    }
    return null;
  };
  // The finer networks, to know which touched the world.
  const parent = new Int32Array(nS);
  for (let v = 0; v < nS; v += 1) parent[v] = v;
  const root = (v) => {
    while (parent[v] !== v) {
      parent[v] = parent[parent[v]];
      v = parent[v];
    }
    return v;
  };
  for (let v = 0; v < nS; v += 1)
    for (let k = sub.offsets[v]; k < sub.offsets[v + 1]; k += 1) {
      const a = root(v);
      const b = root(sub.targets[k]);
      if (a !== b) parent[a] = b;
    }
  const joined = new Set();
  for (let v = 0; v < nS; v += 1) {
    const touch = near.nearest(point(v), touchKm);
    if (touch) {
      add(nW + v, touch[0], touch[1]);
      joined.add(root(v));
      continue;
    }
    if (subDegree(v) <= 1) {
      const hit = nearest(v, joinKm);
      if (hit) {
        add(nW + v, hit[0], hit[1]);
        joined.add(root(v));
      }
    }
  }
  const members = new Map();
  for (let v = 0; v < nS; v += 1) {
    const r = root(v);
    if (joined.has(r)) continue;
    if (!members.has(r)) members.set(r, []);
    members.get(r).push(v);
  }
  for (const list of members.values()) {
    let best = null;
    const from =
      list.length <= 50
        ? list
        : list.filter((v, i) => subDegree(v) <= 1 || i % 10 === 0);
    for (const v of from) {
      const hit = nearest(v, best ? best[2] : joinKm);
      if (hit && (!best || hit[1] < best[2])) best = [v, hit[0], hit[1]];
    }
    if (best) add(nW + best[0], best[1], best[2]);
  }
  const n = nW + nS;
  const lon = new Float64Array(n);
  lon.set(world.lon);
  lon.set(sub.lon, nW);
  const lat = new Float64Array(n);
  lat.set(world.lat);
  lat.set(sub.lat, nW);
  const offsets = new Int32Array(n + 1);
  for (let v = 0; v < n; v += 1) {
    const own =
      v < nW
        ? world.offsets[v + 1] - world.offsets[v]
        : sub.offsets[v - nW + 1] - sub.offsets[v - nW];
    offsets[v + 1] = offsets[v] + own + (extra.get(v)?.length || 0) / 2;
  }
  const targets = new Int32Array(offsets[n]);
  const edgeKm = new Float32Array(offsets[n]);
  for (let v = 0; v < n; v += 1) {
    let at = offsets[v];
    if (v < nW) {
      const from = world.offsets[v];
      const to = world.offsets[v + 1];
      targets.set(world.targets.subarray(from, to), at);
      edgeKm.set(world.edgeKm.subarray(from, to), at);
      at += to - from;
    } else {
      for (let k = sub.offsets[v - nW]; k < sub.offsets[v - nW + 1]; k += 1) {
        targets[at] = sub.targets[k] + nW;
        edgeKm[at] = sub.edgeKm[k];
        at += 1;
      }
    }
    const more = extra.get(v) || [];
    for (let k = 0; k < more.length; k += 2) {
      targets[at] = more[k];
      edgeKm[at] = more[k + 1];
      at += 1;
    }
  }
  // The finer tiles carry the main lines too (2026-10-12): a finer stretch
  // within touchKm of a world line all along is the world's own, so it is
  // neither counted nor drawn again; only the branch lines are.
  const onWorld = worldLinesNear(world, sub, touchKm);
  const runs = [];
  let branchKm = 0;
  for (let p = 0; p + 1 < sub.pathOffsets.length; p += 1) {
    let run = [];
    for (let i = sub.pathOffsets[p] + 1; i < sub.pathOffsets[p + 1]; i += 1) {
      const a = sub.pathVerts[i - 1];
      const b = sub.pathVerts[i];
      const midLat = (sub.lat[a] + sub.lat[b]) / 2;
      const midLon = (sub.lon[a] + sub.lon[b]) / 2;
      const repeated =
        onWorld(sub.lat[a], sub.lon[a]) &&
        onWorld(sub.lat[b], sub.lon[b]) &&
        onWorld(midLat, midLon);
      if (repeated) {
        if (run.length >= 2) runs.push(run);
        run = [];
        continue;
      }
      branchKm += kmBetween(sub.lat[a], sub.lon[a], sub.lat[b], sub.lon[b]);
      if (!run.length) run.push(a + nW);
      run.push(b + nW);
    }
    if (run.length >= 2) runs.push(run);
  }
  const paths = world.pathOffsets.length - 1;
  let runVerts = 0;
  for (const run of runs) runVerts += run.length;
  const pathOffsets = new Int32Array(paths + runs.length + 1);
  pathOffsets.set(world.pathOffsets);
  const pathVerts = new Int32Array(world.pathVerts.length + runVerts);
  pathVerts.set(world.pathVerts);
  let drawnAt = world.pathVerts.length;
  runs.forEach((run, k) => {
    pathVerts.set(run, drawnAt);
    drawnAt += run.length;
    pathOffsets[paths + k + 1] = drawnAt;
  });
  // Each finer point's country (2026-10-12: the branch lines reached count
  // by continent): by `countryAt` when given, else the nearest world point's.
  const countries = [...(world.countries || [''])];
  const countryIndex = new Map(countries.map((code, i) => [code, i]));
  const country = new Uint16Array(n);
  if (world.country) country.set(world.country);
  for (let v = 0; v < nS; v += 1) {
    if (typeof countryAt === 'function') {
      const code = countryAt(sub.lat[v], sub.lon[v]) || '';
      let i = countryIndex.get(code);
      if (i === undefined) {
        i = countries.push(code) - 1;
        countryIndex.set(code, i);
      }
      country[nW + v] = i;
    } else if (world.country) {
      const hit = nearest(v, joinKm);
      if (hit) country[nW + v] = world.country[hit[0]];
    }
  }
  return {
    ...world,
    lon,
    lat,
    offsets,
    targets,
    edgeKm,
    pathOffsets,
    pathVerts,
    country,
    countries,
    lengthKm: (world.lengthKm || 0) + branchKm,
    overlayKm: branchKm,
    overlayVertices: nS,
  };
}

/**
 * Whether a point lies within `touchKm` of one of the world's lines, for
 * the points of `sub` (only the world's lines near them are looked at).
 *
 * @returns {(lat: number, lon: number) => boolean}
 */
function worldLinesNear(world, sub, touchKm) {
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (let v = 0; v < sub.lon.length; v += 1) {
    west = Math.min(west, sub.lon[v]);
    east = Math.max(east, sub.lon[v]);
    south = Math.min(south, sub.lat[v]);
    north = Math.max(north, sub.lat[v]);
  }
  const padLat = (touchKm + 1) / KM_PER_DEG;
  const padLon =
    padLat /
    Math.max(
      0.05,
      Math.cos((Math.max(Math.abs(south), Math.abs(north)) * Math.PI) / 180),
    );
  const cells = new Map();
  const { lon, lat, pathOffsets, pathVerts } = world;
  for (let p = 0; p + 1 < pathOffsets.length; p += 1)
    for (let i = pathOffsets[p] + 1; i < pathOffsets[p + 1]; i += 1) {
      const a = pathVerts[i - 1];
      const b = pathVerts[i];
      const x0 = Math.max(Math.min(lon[a], lon[b]), west - padLon);
      const x1 = Math.min(Math.max(lon[a], lon[b]), east + padLon);
      const y0 = Math.max(Math.min(lat[a], lat[b]), south - padLat);
      const y1 = Math.min(Math.max(lat[a], lat[b]), north + padLat);
      if (x0 > x1 || y0 > y1) continue;
      for (
        let cx = Math.floor(x0 / WIDE_DEG);
        cx <= Math.floor(x1 / WIDE_DEG);
        cx += 1
      )
        for (
          let cy = Math.floor(y0 / WIDE_DEG);
          cy <= Math.floor(y1 / WIDE_DEG);
          cy += 1
        ) {
          const key = cellKey(cx, cy);
          let list = cells.get(key);
          if (!list) cells.set(key, (list = []));
          list.push(a, b);
        }
    }
  return (y, x) => {
    const cx = Math.floor(x / WIDE_DEG);
    const cy = Math.floor(y / WIDE_DEG);
    const c = Math.cos((y * Math.PI) / 180) * KM_PER_DEG;
    for (let dy = -1; dy <= 1; dy += 1)
      for (let dx = -1; dx <= 1; dx += 1) {
        const list = cells.get(cellKey(cx + dx, cy + dy));
        if (!list) continue;
        for (let k = 0; k < list.length; k += 2) {
          // Local flat km round the point.
          const ax = (lon[list[k]] - x) * c;
          const ay = (lat[list[k]] - y) * KM_PER_DEG;
          const bx = (lon[list[k + 1]] - x) * c;
          const by = (lat[list[k + 1]] - y) * KM_PER_DEG;
          const ux = bx - ax;
          const uy = by - ay;
          const len2 = ux * ux + uy * uy;
          const t = len2
            ? Math.max(0, Math.min(1, -(ax * ux + ay * uy) / len2))
            : 0;
          if (Math.hypot(ax + t * ux, ay + t * uy) <= touchKm) return true;
        }
      }
    return false;
  };
}

/** Each point's separate network: an id per point (union of its edges). */
export function railComponents(graph) {
  const n = graph.lon.length;
  const comp = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  let count = 0;
  for (let s = 0; s < n; s += 1) {
    if (comp[s] >= 0) continue;
    let top = 0;
    stack[top++] = s;
    comp[s] = count;
    while (top) {
      const v = stack[--top];
      for (let k = graph.offsets[v]; k < graph.offsets[v + 1]; k += 1) {
        const u = graph.targets[k];
        if (comp[u] < 0) {
          comp[u] = count;
          stack[top++] = u;
        }
      }
    }
    count += 1;
  }
  return comp;
}
