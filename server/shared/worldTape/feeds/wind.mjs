/**
 * World tape feed: the GFS and ECMWF IFS forecast grids the Wind layer draws,
 * through services.wind (/api/wind, the proxy's per-cycle cache): 10 m wind
 * (u, v), 2 m temperature and mean sea-level pressure, and from GFS alone 2 m
 * specific humidity (q2m, kg/kg) and the surface precipitation rate (prate,
 * mm/h, a time mean whose window the record gives in forecast hours and as
 * times), each as a little-endian int16 grid file with its scale and offset
 * in the record (value = q × scale + offset). IFS answers those two with wind
 * alone. The proxy serves the step of the latest 6-hourly cycle valid closest
 * to now and refreshes hourly, the layer's own pace; each (model, cycle,
 * step, field) is recorded once.
 */
import { DAY, HOUR, fileName, stamp } from './_util.mjs';

const MODELS = ['gfs', 'ifs'];
/** The overlays: each answer carries u and v as well. */
const OVERLAYS = [
  { overlay: 'temperature', field: 't2m' },
  { overlay: 'pressure', field: 'msl' },
  { overlay: 'humidity', field: 'q2m' },
  { overlay: 'precipitation', field: 'prate' },
];

/**
 * A time-mean field's window: forecast hours from the run, and the times
 * they fall at.
 * @param {{fromHour: number, toHour: number}} window
 * @param {string} run - The cycle's ISO time.
 */
function averaging({ fromHour, toHour }, run) {
  const runMs = Date.parse(run);
  return {
    window: { fromHour, toHour },
    windowStartIso: new Date(runMs + fromHour * HOUR).toISOString(),
    windowEndIso: new Date(runMs + toHour * HOUR).toISOString(),
  };
}

/**
 * Float values as int16 over their own range: q = round((v − offset) /
 * scale), |q| ≤ 32767.
 * @param {ArrayLike<number>} values
 * @returns {{bytes: Buffer, scale: number, offset: number, min: number, max: number}}
 */
export function quantizeInt16(values) {
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const offset = (min + max) / 2;
  const scale = max > min ? (max - min) / 65534 : 1;
  const bytes = Buffer.alloc(values.length * 2);
  for (let i = 0; i < values.length; i += 1) {
    const q = Math.round((values[i] - offset) / scale);
    bytes.writeInt16LE(Math.max(-32767, Math.min(32767, q)), i * 2);
  }
  return { bytes, scale, offset, min, max };
}

/**
 * One field as the tape keeps it: an int16 grid file named by model, cycle,
 * step and field, and the record that says how to read it back. The live
 * poll and the GFS archive backfill (scripts/world-tape-backfill.mjs) share
 * it, so both write the same format.
 * @param {{model: string, run: string, step: number, valid?: string|null,
 *   name: string, values: ArrayLike<number>, units?: string|null,
 *   level?: string|null, window?: {fromHour: number, toHour: number},
 *   grid: {nx: number, ny: number, lo1: number, la1: number, dx: number,
 *   dy: number}}} field `run` is the cycle's ISO time.
 * @returns {{name: string, bytes: Buffer, record: object}}
 */
export function gridFile({
  model,
  run,
  step,
  valid,
  name,
  values,
  units,
  level,
  window,
  grid,
}) {
  const { nx, ny, lo1, la1, dx, dy } = grid;
  const q = quantizeInt16(values);
  return {
    name: fileName(
      [model, stamp(run), `f${String(step).padStart(3, '0')}`, name],
      'i16',
    ),
    bytes: q.bytes,
    record: {
      model,
      cycle: run,
      step,
      valid: valid ?? null,
      var: name,
      units: units ?? null,
      level: level ?? null,
      ...(Number.isFinite(window?.fromHour) && Number.isFinite(window?.toHour)
        ? averaging(window, run)
        : {}),
      grid: { nx, ny, lo1, la1, dx, dy },
      order: 'rows from la1 southward, columns from lo1 eastward',
      dtype: 'int16le',
      scale: q.scale,
      offset: q.offset,
      min: q.min,
      max: q.max,
    },
  };
}

export default {
  id: 'wind',
  label: 'Wind and surface fields (GFS, ECMWF IFS)',
  layers: ['wind'],
  kind: 'feed',
  class: 'open',
  licence:
    'NOAA GFS (U.S. public domain); ECMWF IFS open data (CC BY 4.0 and the ECMWF Terms of Use; resampled to 1°)',
  cadenceMs: HOUR,
  phase: 1,
  bytesPerDay: 31e6,
  async poll({ services, state, now, signal }) {
    state.done ??= new Map(); // model|run|step|field → ms recorded
    const files = [];
    let answered = 0;
    let failure = null;
    for (const model of MODELS) {
      for (const { overlay, field } of OVERLAYS) {
        let snapshot;
        try {
          snapshot = await services.wind.getSnapshot({
            model,
            overlay,
            signal,
          });
        } catch (error) {
          failure ??= error;
          continue;
        }
        if (snapshot?.unavailable || !snapshot?.grid || !snapshot.u) {
          failure ??= new Error(snapshot?.reason || `${model} unavailable`);
          continue;
        }
        answered += 1;
        const cycle = snapshot.cycle || {};
        const run =
          cycle.runIso ||
          (cycle.date
            ? `${cycle.date.slice(0, 4)}-${cycle.date.slice(4, 6)}-${cycle.date.slice(6, 8)}T${String(cycle.hour ?? 0).padStart(2, '0')}:00:00.000Z`
            : null);
        if (!run) continue;
        const step = cycle.forecastHour ?? 0;
        const { nx, ny } = snapshot.grid;
        const fields = [
          ['u10', snapshot.u, snapshot.units, snapshot.level],
          ['v10', snapshot.v, snapshot.units, snapshot.level],
        ];
        if (snapshot.scalar?.values)
          fields.push([
            field,
            snapshot.scalar.values,
            snapshot.scalar.units,
            snapshot.scalar.level,
            snapshot.scalar.window,
          ]);
        for (const [name, values, units, level, window] of fields) {
          if (!values?.length || values.length !== nx * ny) continue;
          const key = `${model}|${run}|${step}|${name}`;
          if (state.done.has(key)) continue;
          state.done.set(key, now());
          files.push(
            gridFile({
              model,
              run,
              step,
              valid: cycle.validIso,
              name,
              values,
              units,
              level,
              window,
              grid: snapshot.grid,
            }),
          );
        }
      }
    }
    for (const [key, at] of state.done)
      if (now() - at > 2 * DAY) state.done.delete(key);
    if (!answered && failure) throw failure;
    return { files };
  },
};
