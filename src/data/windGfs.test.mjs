import test from 'node:test';
import assert from 'node:assert/strict';
import {
  gfsObjectKey,
  selectLatestGfsCycle,
} from '../../server/providers/wind/catalog.js';
import {
  parseGfsIdx,
  windMessageRanges,
  fetchRange,
  fetchGfsWind,
  loadOptionalScalar,
} from '../../server/providers/wind/gfs.js';
test('catalog and index helpers', async () => {
  assert.equal(
    gfsObjectKey({ date: '20260914', hour: 6, forecastHour: 3 }),
    'gfs.20260914/06/atmos/gfs.t06z.pgrb2.0p25.f003',
  );
  assert.deepEqual(selectLatestGfsCycle(Date.UTC(2026, 8, 15, 4)), {
    date: '20260914',
    hour: 18,
  });
  const p = parseGfsIdx(
    '1:10:d=x:UGRD:10 m above ground:anl:\n2:20:d=x:VGRD:10 m above ground:anl:\n3:30:d=x:X:y:z',
  );
  assert.deepEqual(windMessageRanges(p), {
    u: { start: 10, end: 19 },
    v: { start: 20, end: 29 },
  });
  const b = await fetchRange({
    url: 'x',
    start: 0,
    end: 2,
    fetchImpl: async () =>
      new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
  });
  assert.deepEqual([...b], [1, 2, 3]);
  assert.throws(() => windMessageRanges({ messages: p.messages.slice(0, 1) }));
});

test('wind range fetch rejects invalid offsets and caps chunked bodies', async () => {
  await assert.rejects(
    fetchRange({ url: 'x', start: -1, end: 2 }),
    /range too large/,
  );
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(10));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    fetchRange({
      url: 'x',
      start: 0,
      end: 2,
      fetchImpl: async () => new Response(body, { status: 206 }),
    }),
    /budget/,
  );
  assert.equal(cancelled, true);
});

const WEATHER_IDX = [
  '1:0:d=2026091506:UGRD:10 m above ground:6 hour fcst:',
  '2:2:d=2026091506:VGRD:10 m above ground:6 hour fcst:',
  '3:4:d=2026091506:TMP:850 mb:6 hour fcst:',
  '4:6:d=2026091506:TMP:2 m above ground:6 hour fcst:',
  '5:8:d=2026091506:PRMSL:mean sea level:6 hour fcst:',
  '6:10:d=2026091506:HGT:surface:6 hour fcst:',
].join('\n');

test('GFS overlays select exact levels from the same issue and forecast object', async () => {
  assert.deepEqual(
    windMessageRanges(parseGfsIdx(WEATHER_IDX), { overlay: 'temperature' })
      .scalar,
    { start: 6, end: 7 },
  );
  assert.deepEqual(
    windMessageRanges(parseGfsIdx(WEATHER_IDX), { overlay: 'pressure' }).scalar,
    { start: 8, end: 9 },
  );
  for (const overlay of ['none', 'temperature', 'pressure']) {
    const calls = [];
    const result = await fetchGfsWind({
      overlay,
      targetDx: 90,
      now: () => Date.UTC(2026, 8, 15, 12),
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        if (url.endsWith('.idx')) return new Response(WEATHER_IDX);
        const start = Number(/bytes=(\d+)-/.exec(options.headers.Range)[1]);
        return new Response(Uint8Array.of(start, 0), { status: 206 });
      },
      decodeImpl: async (bytes) => ({
        ni: 4,
        nj: 3,
        lo1: 0,
        la1: 90,
        di: 90,
        dj: 90,
        values: new Float64Array(12).fill(
          bytes[0] === 6 ? 293.15 : bytes[0] === 8 ? 101325 : bytes[0],
        ),
        units: bytes[0] === 6 ? 'K' : bytes[0] === 8 ? 'Pa' : 'm/s',
      }),
    });
    assert.equal(calls.length, overlay === 'none' ? 3 : 4);
    assert.equal(new Set(calls.slice(1).map((c) => c.url)).size, 1);
    assert.ok(calls.every((c) => c.options.redirect === 'error'));
    assert.ok(calls[0].url.endsWith('.f006.idx'));
    assert.equal(result.cycle.validIso, '2026-09-15T12:00:00.000Z');
    if (overlay === 'none') assert.equal(result.scalar, undefined);
    else
      assert.ok(
        Math.abs(
          result.grid.scalar[0] - (overlay === 'temperature' ? 20 : 1013.25),
        ) < 0.0001,
      );
  }
  assert.throws(
    () =>
      windMessageRanges(
        parseGfsIdx(WEATHER_IDX.replace('TMP:2 m above ground', 'TMP:surface')),
        { overlay: 'temperature' },
      ),
    /missing TMP/,
  );
});

test('GFS preserves wind when its optional temperature is missing or malformed', async () => {
  for (const failure of ['missing', 'fetch', 'decode', 'geometry', 'units']) {
    const result = await fetchGfsWind({
      overlay: 'temperature',
      targetDx: 90,
      now: () => Date.UTC(2026, 8, 15, 12),
      fetchImpl: async (url, options) => {
        if (url.endsWith('.idx'))
          return new Response(
            failure === 'missing'
              ? WEATHER_IDX.replace('TMP:2 m above ground', 'TMP:surface')
              : WEATHER_IDX,
          );
        const start = Number(/bytes=(\d+)-/.exec(options.headers.Range)[1]);
        if (start === 6 && failure === 'fetch')
          throw new Error('private provider failure');
        return new Response(Uint8Array.of(start, 0), { status: 206 });
      },
      decodeImpl: async (bytes) => {
        if (bytes[0] === 6 && failure === 'decode')
          throw new Error('bad message');
        return {
          ni: 4,
          nj: 3,
          lo1: bytes[0] === 6 && failure === 'geometry' ? 90 : 0,
          la1: 90,
          di: 90,
          dj: 90,
          values: new Float64Array(12).fill(bytes[0] === 6 ? 293.15 : bytes[0]),
          units: bytes[0] === 6 && failure !== 'units' ? 'K' : 'm/s',
        };
      },
    });
    assert.equal(result.scalar, undefined);
    assert.equal(result.grid.scalar, undefined);
    assert.equal(result.scalarError, 'Temperature field unavailable');
    assert.deepEqual([...result.grid.v], Array(12).fill(2));
    assert.equal(result.cycle.validIso, '2026-09-15T12:00:00.000Z');
  }
});

test('optional scalar timeout cancels only its own fetch and honors parent cancellation', async () => {
  const parent = new AbortController();
  let active;
  const value = await loadOptionalScalar({
    range: { start: 0, end: 1 },
    url: 'https://fixed.test/field',
    timeoutMs: 5,
    signal: parent.signal,
    decodeImpl: () => {
      throw new Error('not reached');
    },
    fetchImpl: (_, { signal }) => {
      active = signal;
      return new Promise((resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason)),
      );
    },
  });
  assert.equal(value, undefined);
  assert.equal(active.aborted, true);
  assert.equal(parent.signal.aborted, false);
  parent.abort();
  let calls = 0;
  assert.equal(
    await loadOptionalScalar({
      range: { start: 0, end: 1 },
      url: 'x',
      signal: parent.signal,
      fetchImpl: () => {
        calls++;
      },
      decodeImpl: () => {},
    }),
    undefined,
  );
  assert.equal(calls, 0);
});

const SURFACE_IDX = [
  '1:0:d=2026091506:UGRD:10 m above ground:6 hour fcst:',
  '2:2:d=2026091506:VGRD:10 m above ground:6 hour fcst:',
  '3:4:d=2026091506:SPFH:850 mb:6 hour fcst:',
  '4:6:d=2026091506:SPFH:2 m above ground:6 hour fcst:',
  '5:8:d=2026091506:PRATE:surface:6 hour fcst:',
  '6:10:d=2026091506:APCP:surface:0-6 hour acc fcst:',
  '7:12:d=2026091506:PRATE:surface:0-6 hour ave fcst:',
  '8:14:d=2026091506:HGT:surface:6 hour fcst:',
].join('\n');

/** Decoded value and GRIB units by message offset; the rest is wind. */
const SURFACE_FIELDS = {
  4: [0.004, 'kg kg**-1'], // SPFH at 850 mb
  6: [0.0125, 'kg kg**-1'], // SPFH at 2 m
  8: [0.002, 'kg m**-2 s**-1'], // the instantaneous rate
  10: [3, 'kg m**-2'], // the accumulation
  12: [0.0005, 'kg m**-2 s**-1'], // the time-mean rate
};

/** Range bodies carry their start offset and their object's forecast hour. */
function surfaceFetch(inventories, calls = []) {
  return async (url, options) => {
    calls.push({ url, options });
    const step = Number(/\.f(\d{3})/.exec(url)[1]);
    if (url.endsWith('.idx'))
      return inventories[step] === undefined
        ? new Response('Not Found', { status: 404 })
        : new Response(inventories[step]);
    const start = Number(/bytes=(\d+)-/.exec(options.headers.Range)[1]);
    return new Response(Uint8Array.of(start, step), { status: 206 });
  };
}

/** Wind is offset + step / 100, so each value names its message and object. */
async function decodeSurface([offset, step]) {
  const [value, units] = SURFACE_FIELDS[offset] ?? [offset + step / 100, 'm/s'];
  return {
    ni: 4,
    nj: 3,
    lo1: 0,
    la1: 90,
    di: 90,
    dj: 90,
    values: new Float64Array(12).fill(value),
    units,
  };
}

const near = (values, expected) =>
  values.every((n) => Math.abs(n - expected) < 1e-6);

test('the GFS inventory keeps forecast text; humidity is SPFH at 2 m and the rate the time-mean PRATE', () => {
  const parsed = parseGfsIdx(SURFACE_IDX);
  assert.deepEqual(parsed.messages[6], {
    index: 7,
    offset: 12,
    variable: 'PRATE',
    level: 'surface',
    forecast: '0-6 hour ave fcst',
  });
  assert.equal(parsed.messages[4].forecast, '6 hour fcst');
  assert.deepEqual(windMessageRanges(parsed, { overlay: 'humidity' }), {
    u: { start: 0, end: 1 },
    v: { start: 2, end: 3 },
    scalar: { start: 6, end: 7 },
  });
  assert.deepEqual(windMessageRanges(parsed, { overlay: 'precipitation' }), {
    u: { start: 0, end: 1 },
    v: { start: 2, end: 3 },
    scalar: { start: 12, end: 13 },
    window: { fromHour: 0, toHour: 6 },
  });
  // Past the first six hours the mean restarts at f006.
  assert.deepEqual(
    windMessageRanges(
      parseGfsIdx(SURFACE_IDX.replace('0-6 hour ave', '6-11 hour ave')),
      { overlay: 'precipitation' },
    ).window,
    { fromHour: 6, toHour: 11 },
  );
  // An instantaneous rate or an accumulation is not the mean.
  assert.throws(
    () =>
      windMessageRanges(
        parseGfsIdx(SURFACE_IDX.replace('0-6 hour ave fcst', '6 hour fcst')),
        { overlay: 'precipitation' },
      ),
    /missing PRATE at surface/,
  );
});

test('GFS humidity and the mean precipitation rate come from the served step, with the window it averages', async () => {
  for (const [hour, step, forecast, window] of [
    [12, 6, '0-6 hour ave fcst', { fromHour: 0, toHour: 6 }],
    [13, 7, '6-7 hour ave fcst', { fromHour: 6, toHour: 7 }],
  ]) {
    const inventory = SURFACE_IDX.replace('0-6 hour ave fcst', forecast);
    for (const overlay of ['humidity', 'precipitation']) {
      const calls = [];
      const result = await fetchGfsWind({
        overlay,
        targetDx: 90,
        now: () => Date.UTC(2026, 8, 15, hour),
        fetchImpl: surfaceFetch({ [step]: inventory }, calls),
        decodeImpl: decodeSurface,
      });
      assert.equal(result.cycle.forecastHour, step);
      assert.ok(calls.every((call) => call.url.includes(`.f00${step}`)));
      assert.deepEqual(
        calls
          .slice(1)
          .map((call) => call.options.headers.Range)
          .sort(),
        [
          'bytes=0-1',
          overlay === 'humidity' ? 'bytes=6-7' : 'bytes=12-13',
          'bytes=2-3',
        ].sort(),
      );
      assert.deepEqual(
        result.scalar,
        overlay === 'humidity'
          ? { kind: 'humidity', units: 'kg/kg', level: '2 m above ground' }
          : { kind: 'precipitation', units: 'mm/h', level: 'surface', window },
      );
      assert.equal(result.scalarError, undefined);
      // 0.0005 kg m⁻² s⁻¹ is 1.8 mm/h.
      assert.ok(
        near(result.grid.scalar, overlay === 'humidity' ? 0.0125 : 1.8),
      );
      assert.ok(near(result.grid.v, 2 + step / 100));
    }
  }
});

test('a step without a time-mean rate (the analysis has none) borrows the cycle f006 mean, window and all', async () => {
  const withoutMean = SURFACE_IDX.replace(
    'PRATE:surface:0-6 hour ave fcst',
    'CPRAT:surface:0-6 hour ave fcst',
  );
  const calls = [];
  const result = await fetchGfsWind({
    overlay: 'precipitation',
    targetDx: 90,
    now: () => Date.UTC(2026, 8, 15, 13),
    fetchImpl: surfaceFetch({ 7: withoutMean, 6: SURFACE_IDX }, calls),
    decodeImpl: decodeSurface,
  });
  assert.equal(result.cycle.forecastHour, 7);
  assert.equal(result.cycle.validIso, '2026-09-15T13:00:00.000Z');
  assert.deepEqual(result.scalar, {
    kind: 'precipitation',
    units: 'mm/h',
    level: 'surface',
    window: { fromHour: 0, toHour: 6 },
  });
  assert.ok(near(result.grid.scalar, 1.8));
  assert.ok(near(result.grid.v, 2.07), 'wind stays the served step');
  const object = (call) => /\.f(\d{3})/.exec(call.url)[1];
  assert.deepEqual(
    calls
      .filter((call) => call.url.endsWith('.idx'))
      .map(object)
      .sort(),
    ['006', '007'],
  );
  assert.deepEqual(
    calls
      .filter((call) => call.options.headers)
      .map((call) => `${object(call)} ${call.options.headers.Range}`)
      .sort(),
    ['006 bytes=12-13', '007 bytes=0-1', '007 bytes=2-3'],
  );
  for (const failure of ['index', 'missing', 'fetch', 'decode']) {
    const partial = await fetchGfsWind({
      overlay: 'precipitation',
      targetDx: 90,
      now: () => Date.UTC(2026, 8, 15, 13),
      fetchImpl: async (url, options) => {
        if (failure === 'fetch' && url.includes('.f006') && options.headers)
          throw new Error('private provider failure');
        return surfaceFetch({
          7: withoutMean,
          ...(failure === 'index'
            ? {}
            : { 6: failure === 'missing' ? withoutMean : SURFACE_IDX }),
        })(url, options);
      },
      decodeImpl: async (bytes) => {
        if (failure === 'decode' && bytes[1] === 6)
          throw new Error('bad message');
        return decodeSurface(bytes);
      },
    });
    assert.equal(partial.scalar, undefined, failure);
    assert.equal(partial.grid.scalar, undefined);
    assert.equal(partial.scalarError, 'Precipitation rate field unavailable');
    assert.ok(near(partial.grid.v, 2.07));
  }
  // The step's own mean failing borrows nothing: one step, one window.
  const urls = [];
  const own = await fetchGfsWind({
    overlay: 'precipitation',
    targetDx: 90,
    now: () => Date.UTC(2026, 8, 15, 13),
    fetchImpl: async (url, options) => {
      urls.push(url);
      if (options.headers?.Range === 'bytes=12-13')
        throw new Error('private provider failure');
      return surfaceFetch({
        7: SURFACE_IDX.replace('0-6 hour ave', '6-7 hour ave'),
      })(url, options);
    },
    decodeImpl: decodeSurface,
  });
  assert.equal(own.scalarError, 'Precipitation rate field unavailable');
  assert.ok(urls.every((url) => url.includes('.f007')));
});
