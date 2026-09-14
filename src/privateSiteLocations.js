/**
 * Home and business security sites as LOCATION pills. A site appears once it
 * has been located (street address or postal code saved in POWER UP) and
 * disappears when it is removed. The site list comes from the loopback-only
 * private camera status route, so a build without that route shows no pills.
 */

export const PRIVATE_SITE_STATUS_ENDPOINT = '/api/private-cams/status';
export const PRIVATE_SITE_CHANGED_EVENT = 'gev:private-cameras-changed';
export const PRIVATE_SITE_LOCATION_PREFIX = 'private-site-';

const KIND_LABELS = {
  home: { icon: '🏠', title: 'Home security' },
  business: { icon: '🏢', title: 'Business security' },
};

function finiteCoordinate(value, limit) {
  const number = Number(value);
  return value !== null && value !== '' && Number.isFinite(number) && Math.abs(number) <= limit ? number : null;
}

/**
 * Pill entries for every located site in a private camera status payload.
 * @returns {Array<{id: string, kind: string, name: string, title: string, label: string, lat: number, lon: number}>}
 */
export function privateSiteLocationEntries(status) {
  const entries = [];
  for (const kind of Array.isArray(status?.kinds) ? status.kinds : []) {
    const labels = KIND_LABELS[kind?.id];
    if (!labels) continue;
    for (const site of Array.isArray(kind.sites) ? kind.sites : []) {
      const lat = finiteCoordinate(site?.lat, 90);
      const lon = finiteCoordinate(site?.lon, 180);
      if (lat === null || lon === null || !/^[a-z0-9-]+$/.test(String(site.id || ''))) continue;
      const siteName = String(site.name || '').trim() || labels.title.split(' ')[0];
      entries.push({
        id: `${PRIVATE_SITE_LOCATION_PREFIX}${site.id}`,
        kind: kind.id,
        name: `${labels.icon} ${siteName}`,
        title: `${labels.title}: ${siteName}`,
        // Mini-status reads "📍 <first segment>" over the rest.
        label: `${siteName}, ${labels.title} site`,
        lat,
        lon,
      });
    }
  }
  return entries;
}

/**
 * Keep the LOCATION pills in step with the saved sites: loads them once and
 * again whenever POWER UP saves or removes a site.
 * @param {{onChange: (entries: Array<object>) => void, fetchImpl?: typeof fetch, target?: EventTarget}} options
 * @returns {() => void} stop listening
 */
export function initPrivateSiteLocations({
  onChange,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  target = globalThis.window,
} = {}) {
  let stopped = false;
  let controller = null;
  let published = '';
  const publish = (entries) => {
    const signature = JSON.stringify(entries);
    if (stopped || signature === published) return;
    published = signature;
    onChange?.(entries);
  };
  const refresh = async () => {
    if (stopped || typeof fetchImpl !== 'function') return;
    controller?.abort();
    const current = typeof AbortController === 'function' ? new AbortController() : null;
    controller = current;
    try {
      const response = await fetchImpl(PRIVATE_SITE_STATUS_ENDPOINT, {
        credentials: 'same-origin',
        cache: 'no-store',
        signal: current?.signal,
      });
      if (controller !== current) return;
      // No route (a production build) or not allowed: no private pills.
      if (!response.ok) return publish([]);
      publish(privateSiteLocationEntries(await response.json()));
    } catch (error) {
      // A dropped connection keeps the pills already shown.
      if (error?.name !== 'AbortError') console.warn('[Locations] private sites unavailable:', error?.message || error);
    }
  };
  const listener = () => void refresh();
  target?.addEventListener?.(PRIVATE_SITE_CHANGED_EVENT, listener);
  void refresh();
  return () => {
    stopped = true;
    controller?.abort();
    target?.removeEventListener?.(PRIVATE_SITE_CHANGED_EVENT, listener);
  };
}
