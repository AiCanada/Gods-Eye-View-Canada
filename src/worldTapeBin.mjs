/**
 * Bins for the world tape (owner request 2026-10-13): a day of recorded
 * feeds turned into hourly features on the world graph's tracked places —
 * mobility, trains, traffic, weather, hazards and news — the driver
 * channels a world model reads beside the sim's states
 * (docs/WORLD-MODEL-DATA.md, Bins). NaN means not observed (the feed was not
 * recorded that hour), never zero. Pure: no DOM, no Node.
 */

import { supplyClass } from './supplyClass.mjs';
import { NEWS_MARKET_CHANNELS, seriesMentioned } from './newsMarketMention.mjs';

const EARTH_KM = 6371;
const RAD = Math.PI / 180;

/** The bin groups and their channels (the column order). */
export const BIN_GROUPS = Object.freeze({
  mobility: Object.freeze([
    'aircraft',
    'aircraftOnGround',
    'aircraftDepartures',
    'vessels',
    'transitVehicles',
    'transitBuses',
    'transitMeanSpeed',
    'bikesAvailable',
  ]),
  trains: Object.freeze(['railVehicles', 'railMeanSpeed']),
  traffic: Object.freeze(['speedRatio', 'segments']),
  weather: Object.freeze(['t2m', 'humidity', 'precip', 'u10', 'v10', 'mslp']),
  hazards: Object.freeze([
    'quakes',
    'quakeMaxMag',
    'fireRadiativePower',
    'fireDetections',
    'perimeterAcres',
    'cycloneDistanceKm',
  ]),
  news: Object.freeze(['articles']),
});

/**
 * Feeds that are not binned. Military flights stay out of mobility.
 * Dams, datacenters and cables are whole-world snapshots, not motion.
 */
export const EXCLUDED_BIN_FEEDS = Object.freeze([
  'military',
  'military-awareness',
  'military-installations',
]);
export const STATIC_SNAPSHOT_FEEDS = Object.freeze([
  'local-dams',
  'local-datacenters',
  'telegeography-submarine-cables',
]);

/** Which feeds feed each group (a group is NaN in hours none was recorded). */
export const BIN_SOURCES = Object.freeze({
  mobility: ['flights', 'ais-live-vessels', 'transit', 'bikeshare'],
  trains: ['transit'],
  traffic: ['traffic'],
  weather: ['wind'],
  hazards: [
    'earthquakes',
    'local-firms',
    'fire-perimeters',
    'weather-cyclones',
  ],
  news: ['news'],
});

const BIN_FEED_SKIP = new Set([
  ...EXCLUDED_BIN_FEEDS,
  ...STATIC_SNAPSHOT_FEEDS,
  ...Object.values(BIN_SOURCES).flat(),
  // Global series: not a count of points on the map.
  'markets',
  'news-urls',
]);

/**
 * Tape feed names to read, and the ones that become one count group each.
 * A later map source joins this list when its directory appears. Military
 * feeds and the three whole-world snapshots do not.
 */
export function feedsToBin(names) {
  const extras = [];
  const read = new Set(Object.values(BIN_SOURCES).flat());
  for (const name of Array.isArray(names) ? names : []) {
    if (typeof name !== 'string' || !name || BIN_FEED_SKIP.has(name)) continue;
    if (read.has(name)) continue;
    read.add(name);
    extras.push(name);
  }
  extras.sort();
  return { read: [...read], extras };
}

/** Numeric fields an extra feed may keep as their own channel, in this order. */
export const EXTRA_VALUE_FIELDS = Object.freeze([
  'value',
  'precipitationMm',
  'windKph',
  'cloudCoverPct',
  'pm25',
  'dischargeCfs',
]);

export const SUPPLY_CHANNELS = Object.freeze([
  'tankers',
  'cargoFood',
  'cargoMetal',
  'cargoRetail',
  'cargo',
]);

/** Count, plus each whitelist field that is actually present. No number at all keeps the value slot. */
export function extraChannels(records) {
  const present = new Set();
  for (const record of records || []) {
    for (const field of EXTRA_VALUE_FIELDS) {
      if (Number.isFinite(Number(record?.[field]))) present.add(field);
    }
  }
  const fields = EXTRA_VALUE_FIELDS.filter((field) => present.has(field));
  return ['count', ...(fields.length ? fields : ['value'])];
}

/** Catchment radius per kind of point, km. */
const RADIUS_KM = Object.freeze({
  mobility: 60,
  rail: 60,
  traffic: 40,
  quake: 300,
  fire: 60,
  news: 100,
});

export function distanceKm(a, b) {
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A grid index over places: the nearest place within `km`, or -1. */
export function placeIndex(places, cellDeg = 1) {
  const cells = new Map();
  const key = (lat, lon) =>
    `${Math.floor(lat / cellDeg)}:${Math.floor(lon / cellDeg)}`;
  places.forEach((p, k) => {
    const id = key(p.lat, p.lon);
    if (!cells.has(id)) cells.set(id, []);
    cells.get(id).push(k);
  });
  return {
    nearest(point, km) {
      if (!Number.isFinite(point?.lat) || !Number.isFinite(point?.lon))
        return -1;
      const span = Math.ceil(km / (111 * cellDeg)) + 1;
      const lonSpan = Math.ceil(
        span / Math.max(0.05, Math.cos(point.lat * RAD)),
      );
      const cy = Math.floor(point.lat / cellDeg);
      const cx = Math.floor(point.lon / cellDeg);
      let best = -1;
      let bestKm = km;
      for (let dy = -span; dy <= span; dy += 1)
        for (let dx = -lonSpan; dx <= lonSpan; dx += 1) {
          let x = cx + dx;
          const wrap = Math.round(360 / cellDeg);
          if (x < -wrap / 2) x += wrap;
          if (x >= wrap / 2) x -= wrap;
          for (const k of cells.get(`${cy + dy}:${x}`) || []) {
            const d = distanceKm(point, places[k]);
            if (d <= bestKm) {
              best = k;
              bestKm = d;
            }
          }
        }
      return best;
    },
  };
}

/** A record's position: lat/lon, a centroid [lon, lat] or {lat, lon}. */
export function pointOf(record) {
  if (Number.isFinite(record?.lat) && Number.isFinite(record?.lon))
    return { lat: record.lat, lon: record.lon };
  const c = record?.centroid;
  if (Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]))
    return { lat: c[1], lon: c[0] };
  if (Number.isFinite(c?.lat) && Number.isFinite(c?.lon))
    return { lat: c.lat, lon: c.lon };
  return null;
}

const HOUR_MS = 3_600_000;

/**
 * The recorded grid fields (the wind feed's file records, by `var`) and the
 * weather channel each fills, with [scale, offset] from each unit the proxy
 * may answer in to the bin's own: t2m °C, humidity kg/kg (2 m specific),
 * precip mm/h, u10 and v10 m/s, mslp hPa. A field in a unit not listed is
 * left out (NaN), never guessed.
 */
export const WEATHER_FIELDS = Object.freeze({
  t2m: { channel: 't2m', units: { '°C': [1, 0], K: [1, -273.15] } },
  q2m: { channel: 'humidity', units: { 'kg/kg': [1, 0], 'g/kg': [0.001, 0] } },
  prate: { channel: 'precip', units: { 'mm/h': [1, 0] } },
  u10: { channel: 'u10', units: { 'm/s': [1, 0], 'm s-1': [1, 0] } },
  v10: { channel: 'v10', units: { 'm/s': [1, 0], 'm s-1': [1, 0] } },
  msl: { channel: 'mslp', units: { hPa: [1, 0], Pa: [0.01, 0] } },
});

/**
 * A recorded grid's value at a point, bilinear: rows run from la1 southward,
 * columns from lo1 eastward, and a grid that spans the globe wraps round.
 * NaN outside the grid.
 * @param {{values: ArrayLike<number>, grid: {nx: number, ny: number, lo1: number, la1: number, dx: number, dy: number}}} field
 * @param {{lat: number, lon: number}} point
 */
export function sampleGrid({ values, grid }, { lat, lon }) {
  const { nx, ny, lo1, la1, dx, dy } = grid || {};
  if (!(nx > 0 && ny > 0 && dx > 0 && dy > 0) || values?.length !== nx * ny)
    return NaN;
  const row = (la1 - lat) / dy;
  if (row < 0 || row > ny - 1) return NaN;
  const global = Math.abs(nx * dx - 360) < dx / 2;
  let col = (lon - lo1) / dx;
  if (global) col = ((col % nx) + nx) % nx;
  else if (col < 0 || col > nx - 1) return NaN;
  const r0 = Math.floor(row);
  const r1 = Math.min(ny - 1, r0 + 1);
  const c0 = Math.floor(col);
  const c1 = global ? (c0 + 1) % nx : Math.min(nx - 1, c0 + 1);
  const fr = row - r0;
  const fc = col - c0;
  const at = (r, c) => values[r * nx + c];
  return (
    (1 - fr) * ((1 - fc) * at(r0, c0) + fc * at(r0, c1)) +
    fr * ((1 - fc) * at(r1, c0) + fc * at(r1, c1))
  );
}

/**
 * When a grid record is valid: the middle of the hours a time mean averages
 * (precipitation), else its stated time, else its cycle plus step.
 */
function validMs(record) {
  const from = Date.parse(record?.windowStartIso ?? '');
  const to = Date.parse(record?.windowEndIso ?? '');
  if (Number.isFinite(from) && Number.isFinite(to) && to > from)
    return (from + to) / 2;
  const stated = Date.parse(record?.valid ?? '');
  if (Number.isFinite(stated)) return stated;
  const cycle = Date.parse(record?.cycle ?? '');
  return Number.isFinite(cycle)
    ? cycle + (Number(record.step) || 0) * HOUR_MS
    : NaN;
}

/**
 * `weatherAt` for binDay from a day's grid records: in each hour, each field
 * from the record valid nearest the middle of the hour (within `windowMs`),
 * GFS before ECMWF IFS (finer, and the only one with humidity and
 * precipitation), converted to the bin's units.
 * @param {object} input
 * @param {object[]} input.records The wind feed's file records.
 * @param {(record: object) => ArrayLike<number>|null} input.load A record's
 *   decoded values (value = q × scale + offset), or null when unreadable.
 * @param {number} input.dayStart The day's 00:00 UTC, ms.
 * @param {number} [input.windowMs]
 * @returns {(point: {lat: number, lon: number}, hour: number) => object|null}
 */
export function weatherFromGrids({
  records,
  load,
  dayStart,
  windowMs = 3 * HOUR_MS,
}) {
  const byField = new Map();
  for (const record of records || []) {
    const field = WEATHER_FIELDS[record?.var];
    const unit = field?.units[record.units];
    const t = validMs(record);
    if (!unit || !Number.isFinite(t) || !record.grid) continue;
    if (!byField.has(record.var)) byField.set(record.var, []);
    byField
      .get(record.var)
      .push({ record, t, unit, gfs: record.model === 'gfs' });
  }
  const chosen = new Map(); // hour → [[field, entry]]
  const pick = (h) => {
    if (chosen.has(h)) return chosen.get(h);
    const mid = dayStart + (h + 0.5) * HOUR_MS;
    const out = [];
    for (const [name, list] of byField) {
      let best = null;
      for (const entry of list) {
        const off = Math.abs(entry.t - mid);
        if (off > windowMs) continue;
        if (
          !best ||
          (entry.gfs && !best.gfs) ||
          (entry.gfs === best.gfs && off < Math.abs(best.t - mid))
        )
          best = entry;
      }
      if (best) out.push([name, best]);
    }
    chosen.set(h, out);
    return out;
  };
  const values = new Map(); // record → decoded values
  const valuesOf = (record) => {
    if (!values.has(record)) values.set(record, load(record) || null);
    return values.get(record);
  };
  return (point, h) => {
    const fields = pick(h);
    if (!fields.length) return null;
    const w = {};
    for (const [name, { record, unit }] of fields) {
      const data = valuesOf(record);
      if (!data) continue;
      const v = sampleGrid({ values: data, grid: record.grid }, point);
      if (Number.isFinite(v))
        w[WEATHER_FIELDS[name].channel] = v * unit[0] + unit[1];
    }
    return w;
  };
}

/**
 * Each thing once: the last record of each id in an hour (records come in
 * the order they were written), so a count does not grow with how often a
 * feed was polled. Records without an id are each kept.
 */
export function lastBy(records, idOf) {
  const last = new Map();
  const loose = [];
  for (const r of records || []) {
    const id = idOf(r);
    if (id === undefined || id === null || id === '') loose.push(r);
    else {
      last.delete(id);
      last.set(id, r);
    }
  }
  return [...loose, ...last.values()];
}

const isRail = (r) =>
  /rail|train|metro|subway|tram/i.test(
    String(r?.mode ?? r?.routeType ?? r?.kind ?? ''),
  );
const isBus = (r) =>
  /bus|coach/i.test(String(r?.mode ?? r?.routeType ?? r?.kind ?? ''));

/**
 * Bin one day.
 *
 * @param {object} input
 * @param {{lat: number, lon: number}[]} input.places The tracked places.
 * @param {Record<string, object[][]>} input.hours Per feed, 24 arrays of the
 *   records recorded in each hour (missing feed or hour: not observed).
 * @param {(feed: string, hour: number) => boolean} [input.observed] Whether
 *   a feed was recording that hour (default: it has records that hour).
 * @param {(point: object, hour: number) => object|null} [input.weatherAt]
 *   Weather at a point in an hour (from the recorded grids), or null.
 * @param {string[]} [input.countFeeds] Non-military feeds that are not
 *   already a source. Each becomes one `count` channel.
 * @returns {Record<string, {data: Float32Array, shape: number[], channels: string[]}>}
 */
export function binDay({
  places,
  hours,
  observed,
  weatherAt = null,
  countFeeds = [],
}) {
  const K = places.length;
  const index = placeIndex(places);
  const seen = (feed, h) =>
    observed ? observed(feed, h) : Boolean(hours[feed]?.[h]?.length);
  const extras = feedsToBin(countFeeds).extras;
  const groups = { ...BIN_GROUPS };
  for (const id of extras) {
    const records = (hours[id] || []).flat();
    groups[id] = extraChannels(records);
  }
  if ((hours['ais-live-vessels'] || []).some((hour) => hour?.length))
    groups.supply = [...SUPPLY_CHANNELS];
  const newsTouched = ['news', 'news-urls'].some(
    (feed) =>
      (hours[feed] || []).some((hour) => hour?.length) ||
      (observed &&
        Array.from({ length: 24 }, (_, hour) => observed(feed, hour)).some(
          Boolean,
        )),
  );
  if (newsTouched) groups['news-markets'] = [...NEWS_MARKET_CHANNELS];
  const marketIds = [
    ...new Set(
      (hours.markets || [])
        .flat()
        .map((record) => record?.series)
        .filter((id) => typeof id === 'string' && id),
    ),
  ].sort();
  if (marketIds.length) groups.markets = marketIds;
  if ((hours['news-urls'] || []).some((hour) => hour?.length))
    groups['news-urls'] = ['count'];
  const out = {};
  for (const [group, channels] of Object.entries(groups)) {
    const C = channels.length;
    const data = new Float32Array(24 * K * C).fill(NaN);
    out[group] = { data, shape: [24, K, C], channels };
  }
  const set = (group, h, k, c, value) => {
    const { data, channels } = out[group];
    data[(h * K + k) * channels.length + c] = value;
  };
  const add = (group, h, k, c, value) => {
    const { data, channels } = out[group];
    const at = (h * K + k) * channels.length + c;
    data[at] = (Number.isNaN(data[at]) ? 0 : data[at]) + value;
  };
  const zero = (group, h) => {
    const { data, channels } = out[group];
    data.fill(0, h * K * channels.length, (h + 1) * K * channels.length);
  };
  // Mobility columns by name (military travel has none: it is not data).
  const M = Object.fromEntries(BIN_GROUPS.mobility.map((name, c) => [name, c]));
  // Aircraft on the ground earlier, by hex, for departures.
  const lastGround = new Map();
  for (let h = 0; h < 24; h += 1) {
    const mobility = BIN_SOURCES.mobility.some((f) => seen(f, h));
    if (mobility) zero('mobility', h);
    if (seen('transit', h)) zero('trains', h);
    if (seen('traffic', h)) zero('traffic', h);
    if (BIN_SOURCES.hazards.some((f) => seen(f, h))) zero('hazards', h);
    if (seen('news', h)) zero('news', h);
    const speedSum = new Float64Array(K);
    const speedN = new Float64Array(K);
    const railSpeed = new Float64Array(K);
    const railN = new Float64Array(K);
    // Aircraft, vessels and vehicles count once an hour, where they were
    // last seen in it; take-offs count at every ground-to-air change.
    const aircraftId = (r) => r.hex || r.icao24 || r.id;
    for (const r of hours.flights?.[h] || []) {
      const id = aircraftId(r);
      if (!id) continue;
      if (lastGround.get(id) === true && r.ground === false) {
        const k = index.nearest(pointOf(r), RADIUS_KM.mobility);
        if (k >= 0) add('mobility', h, k, M.aircraftDepartures, 1);
      }
      lastGround.set(id, Boolean(r.ground));
    }
    for (const r of lastBy(hours.flights?.[h], aircraftId)) {
      const k = index.nearest(pointOf(r), RADIUS_KM.mobility);
      if (k < 0) continue;
      add('mobility', h, k, M.aircraft, 1);
      if (r.ground) add('mobility', h, k, M.aircraftOnGround, 1);
    }
    for (const r of lastBy(hours['ais-live-vessels']?.[h], (v) => v.mmsi)) {
      const k = index.nearest(pointOf(r), RADIUS_KM.mobility);
      if (k >= 0) add('mobility', h, k, M.vessels, 1);
    }
    // Speeds are the mean of every report; vehicles count once.
    for (const r of hours.transit?.[h] || []) {
      const k = index.nearest(pointOf(r), RADIUS_KM.mobility);
      if (k < 0) continue;
      // GTFS-Realtime vehicles carry speedMps.
      const speed = Number.isFinite(r.speed) ? r.speed : r.speedMps;
      if (!Number.isFinite(speed)) continue;
      speedSum[k] += speed;
      speedN[k] += 1;
      if (isRail(r)) {
        railSpeed[k] += speed;
        railN[k] += 1;
      }
    }
    const vehicleId = (r) =>
      r.id === undefined || r.id === null ? null : `${r.region}|${r.id}`;
    for (const r of lastBy(hours.transit?.[h], vehicleId)) {
      const k = index.nearest(pointOf(r), RADIUS_KM.mobility);
      if (k < 0) continue;
      add('mobility', h, k, M.transitVehicles, 1);
      if (isBus(r)) add('mobility', h, k, M.transitBuses, 1);
      if (isRail(r)) add('trains', h, k, 0, 1);
    }
    // Bikes: each station's mean over the hour's polls.
    const stations = new Map();
    for (const r of hours.bikeshare?.[h] || []) {
      if (!Number.isFinite(r.bikes)) continue;
      const id = r.station === undefined ? r : `${r.system}|${r.station}`;
      const entry = stations.get(id) || { r, sum: 0, n: 0 };
      entry.r = r;
      entry.sum += r.bikes;
      entry.n += 1;
      stations.set(id, entry);
    }
    for (const { r, sum, n } of stations.values()) {
      const k = index.nearest(pointOf(r), RADIUS_KM.mobility);
      if (k >= 0) add('mobility', h, k, M.bikesAvailable, sum / n);
    }
    for (let k = 0; k < K; k += 1) {
      if (speedN[k])
        set('mobility', h, k, M.transitMeanSpeed, speedSum[k] / speedN[k]);
      if (railN[k]) set('trains', h, k, 1, railSpeed[k] / railN[k]);
    }
    // Traffic: the mean ratio of flow to free-flow speed near each place,
    // and how many road segments were measured there. The traffic feed
    // writes one record per area (its speedShare, the length-weighted flow
    // ratio) and one per segment, named by its area.
    const ratio = new Float64Array(K);
    const ratioN = new Float64Array(K);
    const segments = new Float64Array(K);
    const areaPlace = new Map();
    const areaPolls = new Map();
    for (const r of hours.traffic?.[h] || []) {
      const k = index.nearest(pointOf(r), RADIUS_KM.traffic);
      if (r.kind === 'area' && r.area && k >= 0) {
        areaPlace.set(r.area, k);
        areaPolls.set(r.area, (areaPolls.get(r.area) || 0) + 1);
      }
      const v = Number.isFinite(r.speedRatio)
        ? r.speedRatio
        : Number.isFinite(r.speedShare)
          ? r.speedShare
          : Number.isFinite(r.speed) && r.freeFlow > 0
            ? r.speed / r.freeFlow
            : NaN;
      if (k < 0 || !Number.isFinite(v)) continue;
      ratio[k] += v;
      ratioN[k] += 1;
      if (r.kind !== 'area' && r.kind !== 'segment') segments[k] += 1;
    }
    // Segments per poll: an area polled twice in the hour is not twice
    // the road.
    for (const r of hours.traffic?.[h] || [])
      if (r.kind === 'segment' && areaPlace.has(r.area))
        segments[areaPlace.get(r.area)] += 1 / areaPolls.get(r.area);
    for (let k = 0; k < K; k += 1)
      if (ratioN[k]) {
        set('traffic', h, k, 0, ratio[k] / ratioN[k]);
        set('traffic', h, k, 1, segments[k]);
      }
    // Weather at each place, from the recorded grids.
    if (weatherAt)
      for (let k = 0; k < K; k += 1) {
        const w = weatherAt(places[k], h);
        if (!w) continue;
        BIN_GROUPS.weather.forEach((name, c) => {
          if (Number.isFinite(w[name])) set('weather', h, k, c, w[name]);
        });
      }
    // Hazards.
    // A quake revised in the hour is one quake; a perimeter, one fire.
    for (const r of lastBy(hours.earthquakes?.[h], (q) => q.id)) {
      const p = pointOf(r);
      if (!p) continue;
      const k = index.nearest(p, RADIUS_KM.quake);
      if (k < 0) continue;
      add('hazards', h, k, 0, 1);
      const { data } = out.hazards;
      const at = (h * K + k) * BIN_GROUPS.hazards.length + 1;
      data[at] = Math.max(Number.isNaN(data[at]) ? 0 : data[at], r.mag || 0);
    }
    for (const r of hours['local-firms']?.[h] || []) {
      const k = index.nearest(pointOf(r), RADIUS_KM.fire);
      if (k < 0) continue;
      add('hazards', h, k, 2, Number.isFinite(r.frp) ? r.frp : 0);
      add('hazards', h, k, 3, 1);
    }
    for (const r of lastBy(hours['fire-perimeters']?.[h], (f) => f.id)) {
      const k = index.nearest(pointOf(r), RADIUS_KM.fire);
      if (k >= 0 && Number.isFinite(r.acres)) add('hazards', h, k, 4, r.acres);
    }
    const storms = (hours['weather-cyclones']?.[h] || [])
      .map(pointOf)
      .filter(Boolean);
    if (seen('weather-cyclones', h))
      for (let k = 0; k < K; k += 1) {
        let best = Infinity;
        for (const s of storms) best = Math.min(best, distanceKm(places[k], s));
        set('hazards', h, k, 5, Number.isFinite(best) ? best : 20_000);
      }
    for (const r of hours.news?.[h] || []) {
      const k = index.nearest(pointOf(r), RADIUS_KM.news);
      if (k >= 0) add('news', h, k, 0, 1);
    }
    if (groups['news-markets'] && (seen('news', h) || seen('news-urls', h))) {
      zero('news-markets', h);
      const mention = (record, everyPlace) => {
        const hits = seriesMentioned(
          record?.title || record?.name || record?.label || '',
        );
        if (!hits.length) return;
        const where = [];
        if (everyPlace || !pointOf(record)) {
          for (let k = 0; k < K; k += 1) where.push(k);
        } else {
          const k = index.nearest(pointOf(record), RADIUS_KM.news);
          if (k >= 0) where.push(k);
        }
        for (const id of hits) {
          const c = NEWS_MARKET_CHANNELS.indexOf(id);
          for (const k of where) add('news-markets', h, k, c, 1);
        }
      };
      if (seen('news', h))
        for (const record of hours.news?.[h] || []) mention(record, false);
      if (seen('news-urls', h))
        for (const record of hours['news-urls']?.[h] || [])
          mention(record, true);
    }
    // One count per other non-military feed: records near a tracked place.
    // A picture counts as a record, not as pixels.
    for (const id of extras) {
      if (!seen(id, h)) continue;
      zero(id, h);
      const channels = groups[id];
      const sums = channels.map(() => new Float64Array(K));
      const counts = channels.map(() => new Float64Array(K));
      for (const r of hours[id]?.[h] || []) {
        const p = pointOf(r);
        if (!p) continue;
        const k = index.nearest(p, RADIUS_KM.mobility);
        if (k < 0) continue;
        add(id, h, k, 0, 1);
        channels.forEach((field, c) => {
          if (c === 0) return;
          const value = Number(r[field]);
          if (!Number.isFinite(value)) return;
          sums[c][k] += value;
          counts[c][k] += 1;
        });
      }
      for (let k = 0; k < K; k += 1) {
        for (let c = 1; c < channels.length; c += 1) {
          set(id, h, k, c, counts[c][k] ? sums[c][k] / counts[c][k] : NaN);
        }
      }
    }
    if (groups.supply && seen('ais-live-vessels', h)) {
      zero('supply', h);
      for (const r of lastBy(hours['ais-live-vessels']?.[h], (v) => v.mmsi)) {
        const kind = supplyClass(r);
        const c = SUPPLY_CHANNELS.indexOf(kind);
        const k = index.nearest(pointOf(r), RADIUS_KM.mobility);
        if (c < 0 || k < 0) continue;
        add('supply', h, k, c, 1);
      }
    }
    if (marketIds.length && seen('markets', h)) {
      for (const r of hours.markets?.[h] || []) {
        const c = marketIds.indexOf(r?.series);
        const value = Number(r?.value);
        if (c < 0 || !Number.isFinite(value)) continue;
        for (let k = 0; k < K; k += 1) set('markets', h, k, c, value);
      }
    }
    if (groups['news-urls'] && seen('news-urls', h)) {
      const n = (hours['news-urls']?.[h] || []).length;
      for (let k = 0; k < K; k += 1) set('news-urls', h, k, 0, n);
    }
  }
  return out;
}
