import { readWindBody } from '../../sources/windBody.js';

/** The provider's optional fields: units, level, and the error naming one missing. */
const SCALARS = {
  temperature: {
    units: '°C',
    level: '2 m above ground',
    error: 'Temperature field unavailable',
  },
  pressure: {
    units: 'hPa',
    level: 'mean sea level',
    error: 'Mean sea level pressure field unavailable',
  },
  humidity: {
    units: 'kg/kg',
    level: '2 m above ground',
    error: 'Specific humidity field unavailable',
  },
  precipitation: {
    units: 'mm/h',
    level: 'surface',
    error: 'Precipitation rate field unavailable',
  },
};

/** Create a bounded, cancellable source for the same-origin wind provider. */
export function createWindSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = 45_000,
} = {}) {
  return {
    async getSnapshot({ signal, model = 'gfs', overlay = 'none' } = {}) {
      if (!['gfs', 'ifs'].includes(model))
        throw new Error('Unknown wind model');
      if (overlay !== 'none' && !Object.hasOwn(SCALARS, overlay))
        throw new Error('Unknown weather overlay');
      const query = `model=${model}${overlay === 'none' ? '' : `&overlay=${overlay}`}`;
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(
        () => controller.abort(new Error('Wind request timed out')),
        timeoutMs,
      );
      const active = controller.signal;
      try {
        signal?.throwIfAborted();
        const response = await fetchImpl(`/api/wind/manifest?${query}`, {
          signal: active,
          cache: 'no-store',
          redirect: 'error',
        });
        if (!response.ok) throw new Error(`Wind HTTP ${response.status}`);
        const manifest = JSON.parse(
          new TextDecoder().decode(
            await readWindBody(response, 16_384, active),
          ),
        );
        if (manifest?.unavailable) return manifest;
        const grid = manifest?.grid;
        const scalar = manifest?.scalar;
        const scalarError = manifest?.scalarError;
        const expected = SCALARS[overlay];
        const optionalUnavailable =
          overlay !== 'none' &&
          scalar === undefined &&
          scalarError === expected.error;
        // A precipitation rate is a time mean over this window, in forecast
        // hours from the cycle.
        const meanWindow = scalar?.window;
        const scalarValid =
          overlay === 'none'
            ? scalar === undefined && scalarError === undefined
            : optionalUnavailable ||
              (scalarError === undefined &&
                scalar?.kind === overlay &&
                scalar.units === expected.units &&
                scalar.level === expected.level &&
                (overlay !== 'precipitation' ||
                  (Number.isInteger(meanWindow?.fromHour) &&
                    Number.isInteger(meanWindow?.toHour) &&
                    meanWindow.fromHour >= 0 &&
                    meanWindow.fromHour < meanWindow.toHour)));
        if (
          manifest?.model !== model ||
          (manifest.overlay ?? 'none') !== overlay ||
          !scalarValid ||
          !grid ||
          !Number.isInteger(grid.nx) ||
          !Number.isInteger(grid.ny) ||
          grid.nx < 1 ||
          grid.ny < 1 ||
          grid.nx * grid.ny > 1_000_000 ||
          ![grid.lo1, grid.la1, grid.dx, grid.dy].every(Number.isFinite) ||
          grid.dx <= 0 ||
          grid.dy <= 0 ||
          Math.abs(grid.nx * grid.dx - 360) > 0.01 ||
          !new RegExp(
            `^/api/wind/grid/${model}-[\\w.-]+\\.bin\\?${query}$`,
          ).test(manifest.gridUrl)
        )
          throw new Error('Malformed wind manifest');
        const count = grid.nx * grid.ny;
        const expectedBytes = count * (scalar ? 12 : 8);
        const gridResponse = await fetchImpl(manifest.gridUrl, {
          signal: active,
          redirect: 'error',
        });
        if (!gridResponse.ok)
          throw new Error(`Wind HTTP ${gridResponse.status}`);
        const bytes = await readWindBody(gridResponse, expectedBytes, active);
        if (bytes.byteLength !== expectedBytes)
          throw new Error('Malformed wind grid');
        const values = new Float32Array(bytes.buffer);
        if (!values.every(Number.isFinite))
          throw new Error('Malformed wind grid');
        return {
          ...manifest,
          u: values.slice(0, count),
          v: values.slice(count, count * 2),
          ...(scalar
            ? { scalar: { ...scalar, values: values.slice(count * 2) } }
            : {}),
        };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    },
  };
}
