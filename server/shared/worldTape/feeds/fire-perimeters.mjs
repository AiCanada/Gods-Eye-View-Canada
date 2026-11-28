/**
 * World tape feed: NIFC WFIGS wildfire perimeters (United States), through
 * the layer's own source (services.perimeters → /api/fire-perimeters,
 * 5-minute cache). Each incident once per revision (its perimeter date, size,
 * containment, personnel or outline changing), with its centroid and box.
 */
import { DAY, MINUTE, forget, noteChange, round } from './_util.mjs';

/** The outer rings' average vertex and bounding box. */
function outline(polygons) {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  let lon = 0;
  let lat = 0;
  let count = 0;
  for (const polygon of polygons || [])
    for (const [x, y] of polygon?.[0] || []) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      lon += x;
      lat += y;
      count += 1;
      west = Math.min(west, x);
      east = Math.max(east, x);
      south = Math.min(south, y);
      north = Math.max(north, y);
    }
  if (!count) return null;
  return {
    centroid: [round(lon / count, 5), round(lat / count, 5)],
    bbox: [west, south, east, north].map((v) => round(v, 5)),
    vertices: count,
  };
}

export default {
  id: 'fire-perimeters',
  label: 'Wildfire perimeters (NIFC WFIGS)',
  layers: ['fire-perimeters'],
  kind: 'feed',
  class: 'open',
  licence:
    'National Interagency Fire Center WFIGS perimeters (U.S. public domain)',
  cadenceMs: 15 * MINUTE,
  phase: 1,
  bytesPerDay: 0.2e6,
  async poll({ services, state, now, signal }) {
    // The layer's snapshot (firePerimeterSnapshot,
    // src/layers/perimeters/records.js): each fire's facts under its stable
    // id, and its burned area as pieces of one polygon each, in order.
    const snapshot = await services.perimeters.getSnapshot({ signal });
    const polygonsOf = new Map();
    for (const piece of snapshot?.pieces || []) {
      if (!piece?.fireId) continue;
      const polygons = polygonsOf.get(piece.fireId) ?? [];
      polygons.push(...(piece.polygons || []));
      polygonsOf.set(piece.fireId, polygons);
    }
    state.seen ??= new Map();
    const t = now();
    const records = [];
    for (const row of snapshot?.fires || []) {
      if (!row?.id) continue;
      const shape = outline(polygonsOf.get(row.id));
      if (!shape) continue;
      const sig = [
        row.updatedTime,
        row.acres,
        row.containedPct,
        row.personnel,
        shape.vertices,
      ].join('|');
      if (!noteChange(state.seen, row.id, sig, t)) continue;
      records.push({
        id: row.id,
        name: row.name ?? null,
        acres: round(row.acres, 1),
        contained: row.containedPct ?? null,
        centroid: shape.centroid,
        bbox: shape.bbox,
        state: row.state ?? null,
        county: row.county ?? null,
        category: row.category ?? null,
        cause: row.cause ?? null,
        behavior: row.behavior ?? null,
        personnel: row.personnel ?? null,
        discovered: row.discoveredTime ?? null,
        updated: row.updatedTime ?? null,
      });
    }
    forget(state.seen, t, 30 * DAY, 50_000);
    return { records };
  },
};
