/**
 * World tape feed: the owner's own devices (drones, robots, marine drones,
 * trackers and Ultra phones). Two inputs, both local:
 * - the lines a recording device appends to
 *   config/device-recordings/<device>/YYYY-MM-DD.jsonl, read from where the
 *   last poll stopped (never refetched; lines written while the recorder was
 *   not running stay in those files);
 * - each device's latest position from the layer's own route
 *   (/api/device-feeds/positions), recorded when it moves or reports anew.
 *   Help-network pins on that route are other people's, never recorded.
 * Every minute (the layer polls every 5 seconds).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DAY, MINUTE, forget, noteChange, round, text } from './_util.mjs';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const RECORDINGS = path.join('config', 'device-recordings');
/** A recording line holds what the map knew around the device: up to 16 MB. */
const MAX_READ_BYTES = 32 * 1024 * 1024;

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Complete lines appended to `file` after `offset`, and where they end. */
function readNewLines(file, offset) {
  let size;
  try {
    size = fs.statSync(file).size;
  } catch {
    return { lines: [], offset };
  }
  // A file rewritten shorter starts over.
  const from = size < offset ? 0 : offset;
  if (size === from) return { lines: [], offset: from };
  const length = Math.min(size - from, MAX_READ_BYTES);
  const buffer = Buffer.alloc(length);
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buffer, 0, length, from);
  } catch {
    return { lines: [], offset: from };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  const end = buffer.lastIndexOf(0x0a);
  if (end < 0)
    // A line still being written, or one past any real line's size.
    return {
      lines: [],
      offset: length === MAX_READ_BYTES ? from + length : from,
    };
  return {
    lines: buffer
      .subarray(0, end + 1)
      .toString('utf8')
      .split('\n'),
    offset: from + end + 1,
  };
}

function recordingRecord(device, raw) {
  let line;
  try {
    line = JSON.parse(raw);
  } catch {
    return null;
  }
  const at = Date.parse(line?.at);
  const target = line?.target;
  if (!Number.isFinite(at) || !Number.isFinite(target?.lat)) return null;
  if (!Number.isFinite(target?.lon)) return null;
  const around = {};
  for (const [layer, items] of Object.entries(line.layers || {}))
    if (Array.isArray(items)) around[layer] = items.length;
  return {
    device,
    name: text(line.device, 60),
    kind: text(line.kind, 30),
    at,
    lat: round(target.lat, 7),
    lon: round(target.lon, 7),
    altM: round(target.altM, 1),
    headingDeg: round(target.headingDeg, 0),
    speedMps: round(target.speedMps, 2),
    radiusKm: line.radiusKm ?? null,
    route: line.route === true,
    around,
    source: 'recording',
  };
}

export default {
  id: 'device-feeds',
  label: 'Your devices',
  layers: ['device-feeds'],
  kind: 'feed',
  class: 'personal',
  licence: "The owner's own devices and their recordings",
  cadenceMs: MINUTE,
  phase: 2,
  bytesPerDay: 2e6,
  async poll({ fetch, state, now, signal, root = REPO_ROOT }) {
    const t = now();
    state.offsets ??= new Map(); // file → bytes read
    state.lastAt ??= new Map(); // device → newest line time recorded
    state.positions ??= new Map(); // device id → last position recorded
    const records = [];
    const first = !state.started;
    state.started = true;

    const base = path.join(root, RECORDINGS);
    let devices = [];
    try {
      devices = fs
        .readdirSync(base, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      devices = [];
    }
    const days = [utcDay(t - DAY), utcDay(t)];
    const wanted = new Set();
    for (const device of devices)
      for (const day of days) {
        const file = path.join(base, device, `${day}.jsonl`);
        wanted.add(file);
        if (!state.offsets.has(file)) {
          // At the first poll, what is already written is not new.
          let size = 0;
          if (first)
            try {
              size = fs.statSync(file).size;
            } catch {
              size = 0;
            }
          state.offsets.set(file, size);
        }
        const read = readNewLines(file, state.offsets.get(file));
        state.offsets.set(file, read.offset);
        for (const raw of read.lines) {
          if (!raw.trim()) continue;
          const record = recordingRecord(device, raw);
          if (!record || record.at <= (state.lastAt.get(device) ?? -Infinity))
            continue;
          state.lastAt.set(device, record.at);
          records.push(record);
        }
      }
    for (const file of state.offsets.keys())
      if (!wanted.has(file)) state.offsets.delete(file);

    let failure = null;
    if (typeof fetch === 'function') {
      try {
        const response = await fetch('/api/device-feeds/positions', {
          signal,
          headers: { Accept: 'application/json' },
        });
        if (!response.ok)
          throw new Error(`Device positions HTTP ${response.status}`);
        const body = await response.json();
        for (const device of Array.isArray(body?.devices) ? body.devices : []) {
          // The owner's own devices only, never a help-network pin.
          if (
            typeof device?.id !== 'string' ||
            !device.id.startsWith('device-')
          )
            continue;
          if (!device.live || !Number.isFinite(device.lat)) continue;
          if (!Number.isFinite(device.lon)) continue;
          const sig = `${device.at}|${device.lat}|${device.lon}`;
          if (!noteChange(state.positions, device.id, sig, t)) continue;
          records.push({
            device: device.id,
            name: text(device.name, 60),
            kind: text(device.kind, 30),
            at: Number.isFinite(device.at) ? device.at : null,
            lat: round(device.lat, 7),
            lon: round(device.lon, 7),
            altM: round(device.altM, 1),
            headingDeg: round(device.headingDeg, 0),
            speedMps: round(device.speedMps, 2),
            source: 'positions',
          });
        }
        forget(state.positions, t, 30 * DAY, 1000);
      } catch (error) {
        failure = error;
      }
    }
    if (failure && !devices.length) throw failure;
    return { records };
  },
};
