/**
 * Inferred predictions for the AI World tab. A question names a location,
 * an item, a topic, or an event. The match comes from tape already on this
 * machine. Military feeds are ignored. No match draws nothing.
 */

export const INFER_KINDS = Object.freeze([
  'location',
  'item',
  'topic',
  'event',
]);

export const EVENT_FEEDS = Object.freeze([
  'earthquakes',
  'local-firms',
  'fire-perimeters',
  'weather-cyclones',
  'rocket-launches',
  'news',
]);

const MILITARY_FEEDS = new Set([
  'military',
  'military-awareness',
  'military-installations',
]);

const ITEM_FIELDS = [
  'hex',
  'mmsi',
  'id',
  'callsign',
  'name',
  'norad',
  'title',
  'label',
  'series',
  'supply',
];

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function point(record) {
  const lat = Number(record?.lat);
  const lon = Number(record?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

function labelOf(record) {
  return (
    text(record?.title) ||
    text(record?.name) ||
    text(record?.label) ||
    text(record?.callsign) ||
    text(record?.id) ||
    text(record?.hex) ||
    text(record?.mmsi) ||
    record?.feed ||
    ''
  );
}

function hit(record) {
  const where = point(record);
  return {
    feed: record.feed,
    id:
      text(record.id) ||
      text(record.hex) ||
      text(record.mmsi) ||
      labelOf(record),
    label: labelOf(record),
    ...(where || {}),
  };
}

/**
 * @param {{kind?: string, query?: string, lat?: number, lon?: number, records?: object[]}} input
 * @returns {{matched: object[], note: string|null, kind: string}}
 */
export function matchInfer({ kind, query, lat, lon, records } = {}) {
  const mode = text(kind).toLowerCase();
  if (!INFER_KINDS.includes(mode))
    return { kind: mode, matched: [], note: 'NO MATCH' };
  const rows = (Array.isArray(records) ? records : []).filter(
    (record) => record && !MILITARY_FEEDS.has(record.feed),
  );
  const q = text(query).toLowerCase();
  if (mode === 'location') {
    const parsed = q.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
    const at = parsed
      ? { lat: Number(parsed[1]), lon: Number(parsed[2]) }
      : { lat: Number(lat), lon: Number(lon) };
    if (!Number.isFinite(at.lat) || !Number.isFinite(at.lon))
      return { kind: mode, matched: [], note: 'NO MATCH' };
    const named =
      q && !parsed
        ? rows.filter((record) => labelOf(record).toLowerCase().includes(q))
        : [];
    const matched = named.length
      ? named.slice(0, 20).map(hit)
      : [{ feed: '', id: '', label: q || 'MAP CENTER', ...at }];
    return { kind: mode, matched, note: null };
  }
  if (!q) return { kind: mode, matched: [], note: 'NO MATCH' };
  const pool =
    mode === 'event'
      ? rows.filter((record) => EVENT_FEEDS.includes(record.feed))
      : rows;
  const matched = [];
  for (const record of pool) {
    const fields =
      mode === 'topic'
        ? [record.title, record.name, record.label, record.supply]
        : ITEM_FIELDS.map((field) => record[field]);
    const blob = fields.map((value) => text(value).toLowerCase()).join(' ');
    if (!blob.includes(q)) continue;
    matched.push(hit(record));
    if (matched.length >= 20) break;
  }
  return {
    kind: mode,
    matched,
    note: matched.length ? null : 'NO MATCH',
  };
}

/** Keep points and tracks that sit near a match. */
export function filterPrediction(prediction, matched, radiusKm = 100) {
  const anchors = (matched || []).map((item) => point(item)).filter(Boolean);
  if (!anchors.length) return { points: [], tracks: [] };
  const near = (lat, lon) =>
    anchors.some((anchor) => distanceKm(anchor, { lat, lon }) <= radiusKm);
  const points = (prediction?.points || []).filter((item) =>
    near(Number(item?.lat), Number(item?.lon)),
  );
  const tracks = (prediction?.tracks || []).filter((track) =>
    (track?.path || []).some(([lat, lon]) => near(lat, lon)),
  );
  return { points, tracks };
}

function distanceKm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}
