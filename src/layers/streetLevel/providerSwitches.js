const MAX_SWITCHES_LENGTH = 256;
const ENTRY = /^([a-z][a-z0-9-]*)=([01])$/;

/** Canonical, bounded provider switches; Mapillary retains its legacy token. */
export function normalizeProviderSwitches(value) {
  if (typeof value !== 'string' || value.length > MAX_SWITCHES_LENGTH)
    return null;
  if (!value) return '';
  const entries = new Map();
  for (const field of value.split(',')) {
    const match = ENTRY.exec(field);
    if (!match || match[1] === 'mapillary' || entries.has(match[1]))
      return null;
    entries.set(match[1], match[2] === '1');
  }
  return [...entries]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, on]) => `${id}=${on ? '1' : '0'}`)
    .join(',');
}

/** Encode by stable IDs rather than registration order or generated tokens. */
export function encodeProviderSwitches(providers) {
  const value = [...providers]
    .filter(([id]) => id !== 'mapillary')
    .map(([id, on]) => `${id}=${on === true ? '1' : '0'}`)
    .join(',');
  const normalized = normalizeProviderSwitches(value);
  if (normalized === null)
    throw new TypeError('Invalid or oversized Street Level provider switches');
  return normalized;
}

/** A Map keeps provider IDs separate from object prototype properties. */
export function decodeProviderSwitches(value) {
  const normalized = normalizeProviderSwitches(value);
  return new Map(
    normalized
      ? normalized.split(',').map((entry) => {
          const [id, on] = entry.split('=');
          return [id, on === '1'];
        })
      : [],
  );
}
