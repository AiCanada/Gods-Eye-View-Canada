import { DEVICE_RECORD_RADIUS_KM, deviceDistanceKm } from '../deviceFeedsCore.mjs';

/**
 * Saving what the map knows around a recording device (an Ultra Security
 * Package, or any device whose owner ticked RECORD).
 *
 * Every layer that is on is asked what it holds. A layer with plain records
 * (`getAnalystRecords`: flights, military flights, vessels, earthquakes, fires,
 * cameras, the owner's other devices) gives them as they are; any other layer
 * gives the marks it draws (`getDetectableObjects`: satellites, bike share,
 * installations; the device layer leaves out traffic, whose dots are an
 * animation, not observations). What lies within 50 km of the device is sent to the
 * server, which checks the distance again against the position IT knows and
 * appends one line to the device's recording.
 *
 * Only what changed is sent. A camera that has not moved is saved once, when it
 * first comes within range, and again only if it leaves and returns; an
 * aircraft is saved every time, because it has moved. A recording is therefore
 * complete without repeating 2,500 cameras every half minute.
 */

export const DEVICE_RECORD_INTERVAL_MS = 30_000;

const RECORD_ENDPOINT = '/api/device-feeds/record/';

const finite = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * Everything the enabled layers hold within `km` of `center`.
 * @param {{layers: Map<string, {module: object}>, isEnabled: (id: string) => boolean}} dataManager
 * @param {{lat: number, lon: number}} center
 * @param {object} [options]
 * @param {number} [options.km]
 * @param {(position: unknown) => ({lat: number, lon: number, altM?: number}|null)} [options.toLatLon]
 *   Turns a drawn mark's world position into degrees (Cesium lives with the caller).
 * @param {string[]} [options.skip] Layer ids left out (the device's own layer is the target, not its surroundings).
 * @returns {Record<string, object[]>}
 */
export function collectNearbyRecords(dataManager, center, { km = DEVICE_RECORD_RADIUS_KM, toLatLon = null, skip = [] } = {}) {
  const out = {};
  if (!dataManager?.layers || !finite(center?.lat) || !finite(center?.lon)) return out;
  for (const [layerId, entry] of dataManager.layers) {
    if (skip.includes(layerId)) continue;
    let enabled = false;
    try {
      enabled = dataManager.isEnabled ? dataManager.isEnabled(layerId) : entry?.enabled === true;
    } catch {
      enabled = false;
    }
    if (!enabled) continue;
    const module = entry?.module;
    let records = [];
    try {
      if (typeof module?.getAnalystRecords === 'function') {
        records = module.getAnalystRecords(Number.MAX_SAFE_INTEGER) || [];
      } else if (typeof module?.getDetectableObjects === 'function' && toLatLon) {
        records = (module.getDetectableObjects({}) || []).map((mark) => {
          const point = toLatLon(mark?.position);
          if (!point) return null;
          return { id: String(mark.sourceId ?? mark.id ?? ''), type: mark.type ?? null, label: mark.label ?? mark.name ?? null, ...point };
        });
      }
    } catch {
      // One layer failing never costs the others their place in the recording.
      records = [];
    }
    const inside = [];
    for (const record of records) {
      if (!record || !finite(record.lat) || !finite(record.lon)) continue;
      if (deviceDistanceKm(center, record) <= km) inside.push(record);
    }
    if (inside.length) out[layerId] = inside;
  }
  return out;
}

/**
 * Keep only what is new or changed since this device's last save. `memory` is
 * that device's own Map and is updated in place; what has left the radius is
 * forgotten, so it is saved again if it comes back.
 * @param {Record<string, object[]>} layers
 * @param {Map<string, string>} memory
 * @returns {Record<string, object[]>}
 */
export function changedRecordsOnly(layers, memory) {
  const out = {};
  const present = new Set();
  for (const [layerId, records] of Object.entries(layers)) {
    const changed = [];
    records.forEach((record, index) => {
      const key = `${layerId}\u0000${record.id ?? `#${index}`}`;
      const value = JSON.stringify(record);
      present.add(key);
      if (memory.get(key) === value) return;
      memory.set(key, value);
      changed.push(record);
    });
    if (changed.length) out[layerId] = changed;
  }
  for (const key of [...memory.keys()]) if (!present.has(key)) memory.delete(key);
  return out;
}

/**
 * The recorder the device layer drives once per poll.
 * @returns {{tick: (devices: object[], dataManager: object, options?: object) => Promise<object[]>, forget: (id?: string) => void, stats: () => object}}
 */
export function createDeviceRecorder({ fetchImpl = (...args) => fetch(...args), now = () => Date.now(), intervalMs = DEVICE_RECORD_INTERVAL_MS } = {}) {
  /** device id -> {memory, nextAt, pending, saved, lastAt, error} */
  const states = new Map();

  const stateOf = (id) => {
    let state = states.get(id);
    if (!state) {
      state = { memory: new Map(), nextAt: 0, pending: false, saved: 0, lastAt: null, error: '' };
      states.set(id, state);
    }
    return state;
  };

  return {
    async tick(devices, dataManager, { toLatLon = null, skip = [] } = {}) {
      const recording = (devices || []).filter((device) => device?.record === true && finite(device.lat) && finite(device.lon));
      const wanted = new Set(recording.map((device) => device.id));
      for (const id of [...states.keys()]) if (!wanted.has(id)) states.delete(id);
      const results = [];
      for (const device of recording) {
        const state = stateOf(device.id);
        const time = now();
        if (state.pending || time < state.nextAt) continue;
        state.pending = true;
        state.nextAt = time + intervalMs;
        // Judged against a copy: a save that fails is tried again in full.
        const trial = new Map(state.memory);
        const layers = changedRecordsOnly(collectNearbyRecords(dataManager, device, { toLatLon, skip }), trial);
        try {
          const response = await fetchImpl(`${RECORD_ENDPOINT}${encodeURIComponent(device.id)}`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ layers }),
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const payload = await response.json().catch(() => ({}));
          state.memory = trial;
          state.saved += Number(payload?.saved) || 0;
          state.lastAt = now();
          state.error = '';
          results.push({ id: device.id, saved: Number(payload?.saved) || 0 });
        } catch (error) {
          state.error = String(error?.message || 'not saved').slice(0, 80);
          results.push({ id: device.id, error: state.error });
        } finally {
          state.pending = false;
        }
      }
      return results;
    },
    forget(id) {
      if (id === undefined) states.clear();
      else states.delete(id);
    },
    stats() {
      let saved = 0;
      let failing = 0;
      for (const state of states.values()) {
        saved += state.saved;
        if (state.error) failing += 1;
      }
      return { recording: states.size, saved, failing };
    },
  };
}
