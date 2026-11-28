import { readWindBody } from '../../../src/sources/windBody.js';
/**
 * Parse a GFS `.idx` inventory into ordered message records.
 *
 * Each line is `msgNumber:byteOffset:d=YYYYMMDDHH:VAR:LEVEL:FORECAST:...:`,
 * FORECAST being text such as `anl`, `6 hour fcst` or `0-6 hour ave fcst`.
 * Malformed lines are skipped; a payload with no valid lines is rejected so
 * callers never treat an HTML error page as an empty inventory.
 *
 * @param {string} text - Raw `.idx` body.
 * @returns {{ messages: Array<{index: number, offset: number, variable: string, level: string, forecast: string}> }}
 */
export function parseGfsIdx(text) {
  const messages = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line) continue;
    const parts = line.split(':');
    if (
      parts.length < 6 ||
      !/^\d+$/.test(parts[0]) ||
      !/^\d+$/.test(parts[1]) ||
      !parts[3] ||
      !parts[4]
    )
      continue;
    messages.push({
      index: Number(parts[0]),
      offset: Number(parts[1]),
      variable: parts[3],
      level: parts[4],
      forecast: parts[5],
    });
  }
  if (!messages.length) throw new Error('malformed GFS index');
  return { messages };
}

/**
 * The hours a time-mean message averages over, from its forecast text:
 * `6-7 hour ave fcst` is {fromHour: 6, toHour: 7}, in forecast hours from the
 * cycle. An instant or an accumulation is null.
 */
function averageWindow(forecast) {
  const match = /^(\d+)-(\d+) hour ave fcst$/.exec(forecast);
  if (!match) return null;
  const fromHour = Number(match[1]);
  const toHour = Number(match[2]);
  return fromHour < toHour ? { fromHour, toHour } : null;
}

/**
 * Byte ranges for the two 10 m wind components and an overlay's companion
 * field. A message runs from its own offset to one byte before the next
 * message in file order. One variable and level can appear more than once, so
 * the precipitation rate is the time-mean PRATE, with the `window` it averages.
 *
 * @param {{messages: Array<object>}} parsed - {@link parseGfsIdx} result.
 * @param {{level?: string, overlay?: string}} [options]
 * @returns {{u: {start: number, end: number}, v: {start: number, end: number},
 *   scalar?: {start: number, end: number},
 *   window?: {fromHour: number, toHour: number}}}
 */
export function windMessageRanges(
  parsed,
  { level = '10 m above ground', overlay = 'none' } = {},
) {
  weatherScalarMetadata(overlay);
  const locate = (variable, fieldLevel = level, accept = () => true) => {
    const index = parsed.messages.findIndex(
      (message) =>
        message.variable === variable &&
        message.level === fieldLevel &&
        accept(message),
    );
    const message = parsed.messages[index];
    const next = parsed.messages[index + 1];
    if (!message || !next)
      throw new Error(`missing ${variable} at ${fieldLevel}`);
    return { message, range: { start: message.offset, end: next.offset - 1 } };
  };
  const range = (variable, fieldLevel) => locate(variable, fieldLevel).range;
  const meanRate = () => {
    const { message, range: scalar } = locate('PRATE', 'surface', (candidate) =>
      averageWindow(candidate.forecast),
    );
    return { scalar, window: averageWindow(message.forecast) };
  };
  return {
    u: range('UGRD'),
    v: range('VGRD'),
    ...(overlay === 'temperature'
      ? { scalar: range('TMP', '2 m above ground') }
      : {}),
    ...(overlay === 'pressure'
      ? { scalar: range('PRMSL', 'mean sea level') }
      : {}),
    ...(overlay === 'humidity'
      ? { scalar: range('SPFH', '2 m above ground') }
      : {}),
    ...(overlay === 'precipitation' ? meanRate() : {}),
  };
}

/** Fetch a bounded text response as a Buffer. */
export async function fetchText({ url, fetchImpl = fetch, signal }) {
  const response = await fetchImpl(url, { signal, redirect: 'error' });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('Wind upstream unavailable');
  }
  return Buffer.from(await readWindBody(response, 2 * 1024 * 1024, signal));
}

/**
 * Fetch one bounded byte range. Rejects oversized ranges, non-206 responses
 * (except a whole-object 200 starting at zero), and short bodies.
 */
export async function fetchRange({
  url,
  start,
  end,
  fetchImpl = fetch,
  signal,
  maxBytes = 8 * 1024 * 1024,
}) {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    end - start + 1 > maxBytes
  )
    throw new Error('range too large');
  const response = await fetchImpl(url, {
    signal,
    redirect: 'error',
    headers: { Range: `bytes=${start}-${end}` },
  });
  const validStatus =
    response.status === 206 || (response.status === 200 && start === 0);
  if (!validStatus || !response.ok) {
    await response.body?.cancel();
    throw new Error('Wind upstream unavailable');
  }
  const buffer = Buffer.from(
    await readWindBody(response, end - start + 1, signal),
  );
  if (buffer.length !== end - start + 1)
    throw new Error('invalid range length');
  return buffer;
}

/**
 * A bounded optional request may fail without cancelling valid wind siblings.
 * `scalarSignal` gives up on this field alone (returning undefined), while
 * `signal` cancels the whole refresh.
 */
export async function loadOptionalScalar({
  range,
  url,
  fetchImpl,
  decodeImpl,
  signal,
  scalarSignal,
  targetDx = 1,
  timeoutMs = 12_000,
}) {
  if (!range) return undefined;
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  const giveUp = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  scalarSignal?.addEventListener('abort', giveUp, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    signal?.throwIfAborted();
    scalarSignal?.throwIfAborted();
    const bytes = await fetchRange({
      url,
      ...range,
      fetchImpl,
      signal: controller.signal,
    });
    // The 12 s deadline bounds the download only. The worker bounds the decode,
    // and scalarSignal ends the wait in time to serve ready wind.
    clearTimeout(timer);
    const value = await decodeImpl(bytes, {
      targetDx,
      signal: controller.signal,
    });
    controller.signal.throwIfAborted();
    return value;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    controller.abort();
    signal?.removeEventListener('abort', abort);
    scalarSignal?.removeEventListener('abort', giveUp);
  }
}

/**
 * The analysis (f000) has no time-mean PRATE; the cycle's f006 object holds
 * its first six-hour mean. Its inventory is read under the same bounds as the
 * field (loadOptionalScalar), so a failure leaves the served step's wind alone.
 * @returns {Promise<{scalar: object, window: {fromHour: number, toHour: number}}|undefined>}
 */
async function loadCycleMeanRate({
  url,
  fetchImpl,
  decodeImpl,
  signal,
  scalarSignal,
  targetDx = 1,
  timeoutMs = 12_000,
}) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  const giveUp = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  scalarSignal?.addEventListener('abort', giveUp, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let found;
  try {
    signal?.throwIfAborted();
    scalarSignal?.throwIfAborted();
    const index = await fetchText({
      url: `${url}.idx`,
      fetchImpl,
      signal: controller.signal,
    });
    found = windMessageRanges(parseGfsIdx(index.toString()), {
      overlay: 'precipitation',
    });
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    controller.abort();
    signal?.removeEventListener('abort', abort);
    scalarSignal?.removeEventListener('abort', giveUp);
  }
  const scalar = await loadOptionalScalar({
    range: found.scalar,
    url,
    fetchImpl,
    decodeImpl,
    signal,
    scalarSignal,
    targetDx,
    timeoutMs,
  });
  return scalar ? { scalar, window: found.window } : undefined;
}

import {
  GFS_BUCKET,
  gfsObjectKey,
  selectLatestGfsCycle,
  nearestGfsStep,
} from './catalog.js';
import { decodeWindGribMessage } from './decode.js';
import { resampleWeatherSnapshot, weatherScalarMetadata } from './grid.js';

/**
 * Load U, V and the optional companion from one forecast object and resample
 * them to the display grid.
 *
 * `windCache` (one per windProxy) keeps the U/V of the last forecast file per
 * model as the decoder returned them (display-grid samples from the worker,
 * ~1 MB at 1°). The same URL and U/V ranges reuse them without fetching U/V
 * again, even if upstream would now fail. Written only after the wind passes
 * every check.
 *
 * `loadScalar` (God's Eye View Canada), when given, loads the companion
 * instead of `scalarRange`: a precipitation rate from another object.
 */
export async function loadWeatherSnapshot({
  model,
  url,
  ranges,
  scalarRange,
  loadScalar,
  overlay,
  targetDx,
  fetchImpl,
  decodeImpl,
  signal,
  scalarSignal,
  windCache,
}) {
  const key = [
    url,
    `${ranges.u.start}-${ranges.u.end}`,
    `${ranges.v.start}-${ranges.v.end}`,
  ].join('|');
  const kept = windCache?.get(model);
  const wind = kept?.key === key ? kept : null;
  // All selected messages come from this one issue/valid-time object.
  const load = async (range) =>
    decodeImpl(await fetchRange({ url, ...range, fetchImpl, signal }), {
      targetDx,
      signal,
    });
  const [u, v, scalar] = await Promise.all([
    wind ? wind.u : load(ranges.u),
    wind ? wind.v : load(ranges.v),
    loadScalar
      ? loadScalar()
      : loadOptionalScalar({
          range: scalarRange,
          url,
          fetchImpl,
          decodeImpl,
          signal,
          scalarSignal,
          targetDx,
        }),
  ]);
  signal?.throwIfAborted();
  const fields = resampleWeatherSnapshot({ u, v, scalar, overlay, targetDx });
  if (!wind) windCache?.set(model, { key, u, v });
  return fields;
}

/**
 * Fetch and decode the GFS 10 m wind field valid closest to now.
 * @param {{fetchImpl?: Function, now?: Function, targetDx?: number,
 *   decodeImpl?: Function, signal?: AbortSignal, overlay?: string,
 *   scalarSignal?: AbortSignal, windCache?: Map}} [options] - `decodeImpl(bytes, {targetDx, signal})`
 *   returns a decoded field or a `sampleWindField` result; for `windCache` see
 *   loadWeatherSnapshot. For `scalarSignal` see loadOptionalScalar.
 */
export async function fetchGfsWind({
  fetchImpl = fetch,
  now = () => Date.now(),
  targetDx = 1,
  decodeImpl = decodeWindGribMessage,
  signal,
  overlay = 'none',
  scalarSignal,
  windCache,
} = {}) {
  weatherScalarMetadata(overlay);
  const nowMs = now();
  const cycle = selectLatestGfsCycle(nowMs);
  const runMs = Date.UTC(
    Number(cycle.date.slice(0, 4)),
    Number(cycle.date.slice(4, 6)) - 1,
    Number(cycle.date.slice(6, 8)),
    cycle.hour,
  );
  // Pick the forecast step whose valid time is closest to now, so the layer
  // shows the freshest field the cycle offers instead of the analysis.
  const forecastHour = nearestGfsStep((nowMs - runMs) / 3600_000);
  const objectUrl = (step) =>
    `https://${GFS_BUCKET}.s3.amazonaws.com/${gfsObjectKey({ ...cycle, forecastHour: step })}`;
  const base = objectUrl(forecastHour);
  const index = await fetchText({ url: `${base}.idx`, fetchImpl, signal });
  const inventory = parseGfsIdx(index.toString());
  const ranges = windMessageRanges(inventory);
  let companion;
  if (overlay !== 'none') {
    try {
      companion = windMessageRanges(inventory, { overlay });
    } catch {
      /* A missing optional field does not discard valid wind. */
    }
  }
  // A precipitation rate the step lacks: the cycle's f006 mean stands in, and
  // its window says so.
  let window = companion?.window;
  const loadScalar =
    overlay === 'precipitation' && !companion && forecastHour !== 6
      ? async () => {
          const mean = await loadCycleMeanRate({
            url: objectUrl(6),
            fetchImpl,
            decodeImpl,
            signal,
            scalarSignal,
            targetDx,
          });
          window = mean?.window;
          return mean?.scalar;
        }
      : undefined;
  const fields = await loadWeatherSnapshot({
    model: 'gfs',
    url: base,
    ranges,
    scalarRange: companion?.scalar,
    loadScalar,
    overlay,
    targetDx,
    fetchImpl,
    decodeImpl,
    signal,
    scalarSignal,
    windCache,
  });
  const runIso = new Date(runMs).toISOString();
  const validIso = new Date(runMs + forecastHour * 3600_000).toISOString();
  return {
    cycle: { ...cycle, forecastHour, runIso, validIso },
    level: '10 m above ground',
    units: 'm/s',
    ...fields,
    // A time mean names the forecast hours it averages over.
    ...(fields.scalar && window
      ? { scalar: { ...fields.scalar, window } }
      : {}),
  };
}
