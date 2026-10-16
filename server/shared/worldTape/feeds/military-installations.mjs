/**
 * World tape snapshot: military installations mapped in OpenStreetMap around
 * each area, through the layer's own source (services.installations, the
 * same request the find tool makes). No live data: once a day, recorded when
 * an area's sites changed.
 */
import { DAY, boxAround, hashOf, requireAreas, round, text } from './_util.mjs';

const DEFAULT_RADIUS_KM = 100;
/** The exact source answers boxes of at most 10° a side. */
const MAX_RADIUS_KM = 500;
const NAMES_WAIT_MS = 5000;

/** The value of `promise` within `ms`, else null. */
function within(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value ?? null);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

export default {
  id: 'military-installations',
  label: 'Military installations (OpenStreetMap)',
  layers: ['military-installations'],
  kind: 'static',
  class: 'open',
  licence:
    'OpenStreetMap contributors (ODbL 1.0); names via Overture Maps Foundation (ODbL 1.0)',
  cadenceMs: DAY,
  phase: 1,
  bytesPerDay: 0.2e6,
  async poll({ services, areas, state, signal }) {
    const list = requireAreas(areas, { max: 16 });
    state.sig ??= new Map(); // area key → content signature
    const records = [];
    let answered = 0;
    let failure = null;
    for (const area of list) {
      const radius = Math.min(
        MAX_RADIUS_KM,
        area.radiusKm ?? DEFAULT_RADIUS_KM,
      );
      let result;
      try {
        result = await services.installations.getMappedSites(
          boxAround(area, radius),
          { exact: true, thinned: false, signal },
        );
        // Tile results can come before their names; wait briefly for them.
        if (result?.enrichment) {
          const named = await within(result.enrichment, NAMES_WAIT_MS);
          if (named) result = named;
        }
      } catch (error) {
        failure ??= error;
        continue;
      }
      answered += 1;
      const rows = (result?.records || [])
        .filter(
          (s) => Number.isFinite(s?.latitude) && Number.isFinite(s?.longitude),
        )
        .map((site) => ({
          area: area.name,
          id: String(site.id),
          name: text(site.name, 160),
          kindOfSite: text(site.kind, 60),
          siteClass: text(site.class, 60),
          lat: round(site.latitude, 6),
          lon: round(site.longitude, 6),
          ...(result.saturated ? { partial: true } : {}),
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
      const sig = hashOf(rows);
      if (state.sig.get(area.key) === sig) continue;
      state.sig.set(area.key, sig);
      records.push(...rows);
    }
    if (!answered && failure) throw failure;
    return { records };
  },
};
