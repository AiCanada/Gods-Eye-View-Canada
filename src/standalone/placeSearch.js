import {
  createPlaceSearch,
  createGoogleGeocoder,
  createPhotonGeocoder,
  createCoordinateGeocoder,
  createPresetGeocoder,
} from '../search/index.js';

/**
 * Coordinates and bundled names first, then Google when configured, then
 * keyless Photon, then the local Nominatim route as a last resort.
 */
export function createStandalonePlaceSearch({
  resolveApiKey,
  fetchImpl = (...args) => fetch(...args),
  signal,
  presets = null,
  nominatimEndpoint = '/api/geocode',
} = {}) {
  return createPlaceSearch({
    signal,
    providers: [
      createCoordinateGeocoder(),
      ...(presets ? [createPresetGeocoder({ presets })] : []),
      createGoogleGeocoder({
        request(query, { bias, signal }) {
          const key = resolveApiKey?.();
          if (!key) return null;
          const url = new URL(
            'https://maps.googleapis.com/maps/api/geocode/json',
          );
          url.searchParams.set('address', query);
          url.searchParams.set('key', key);
          if (bias) url.searchParams.set('bounds', bias);
          return fetchImpl(url.toString(), { signal });
        },
      }),
      createPhotonGeocoder({ fetchImpl }),
      createGoogleGeocoder({
        request(query, { bias, signal }) {
          const params = new URLSearchParams({ q: query });
          if (bias) params.set('bounds', bias);
          return fetchImpl(`${nominatimEndpoint}?${params}`, { signal });
        },
      }),
    ],
  });
}
