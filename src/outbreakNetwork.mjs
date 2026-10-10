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
 *   part of the network is within `startKm`.
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
