import { fetchRegionalJson } from './http.js';
import { normalizeRegionalPlace } from '../../../src/data/regionalBrief.js';

const NOMINATIM_SPACING_MS = 1100;

let _nominatimQueue = Promise.resolve();

let _nominatimLastRequestAt = 0;

function placeLookupAborted() {
  return new DOMException('Regional place lookup was aborted', 'AbortError');
}

/** Wait out the spacing, or stop early once the lookup is no longer wanted. */
function waitForNominatimTurn(waitMs, signal) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, waitMs);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * Reverse-geocode a point through Nominatim. Every lookup shares one queue
 * spaced NOMINATIM_SPACING_MS apart (the public usage policy). A lookup whose
 * `signal` has aborted by its turn, or during the spacing wait, rejects with an
 * AbortError without calling Nominatim, so superseded lookups do not hold up
 * the ones behind them. A lookup already sent to Nominatim is not cancelled.
 * @param {{latitude: number, longitude: number}} point
 * @param {{signal?: AbortSignal}} [options]
 */
function fetchRegionalPlace(point, { signal } = {}) {
  const task = _nominatimQueue.then(async () => {
    if (signal?.aborted) throw placeLookupAborted();
    const waitMs = Math.max(
      0,
      NOMINATIM_SPACING_MS - (Date.now() - _nominatimLastRequestAt),
    );
    if (waitMs) await waitForNominatimTurn(waitMs, signal);
    if (signal?.aborted) throw placeLookupAborted();
    _nominatimLastRequestAt = Date.now();
    const params = new URLSearchParams({
      format: 'jsonv2',
      lat: point.latitude.toFixed(5),
      lon: point.longitude.toFixed(5),
      zoom: '10',
      addressdetails: '1',
      'accept-language': 'en',
    });
    const payload = await fetchRegionalJson(
      `https://nominatim.openstreetmap.org/reverse?${params}`,
      {
        headers: {
          'User-Agent':
            'GodsEyeView/0.1 (+https://github.com/bilawalsidhu/gods-eye-view)',
          Referer: 'https://github.com/bilawalsidhu/gods-eye-view',
        },
      },
    );
    return normalizeRegionalPlace(payload);
  });
  _nominatimQueue = task.catch(() => null);
  return task;
}

export { fetchRegionalPlace };
