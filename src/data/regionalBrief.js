import { applicationServices } from '../services/application.js';
export * from './regionalModel.js';
/** Fetch a bounded regional brief through the same-origin dev/preview proxy. */
export async function fetchRegionalBrief(latitude, longitude, { signal } = {}) {
  if (![latitude, longitude].every(Number.isFinite))
    throw new Error('Valid coordinates are required');
  return applicationServices.regional.getBrief(latitude, longitude, { signal });
}

/** Ask the same-origin proxy which province, state, territory or country a point is in. */
export async function fetchLocationRegion(
  latitude,
  longitude,
  { signal } = {},
) {
  if (![latitude, longitude].every(Number.isFinite))
    throw new Error('Valid coordinates are required');
  const params = new URLSearchParams({
    latitude: latitude.toFixed(5),
    longitude: longitude.toFixed(5),
  });
  const response = await fetch(`/api/location-region?${params}`, { signal });
  if (!response.ok)
    throw new Error(`Location region unavailable (${response.status})`);
  return response.json();
}
