/**
 * World tape feed: every enabled GTFS-Realtime region (buses, trams, metro
 * and trains), through the layer's own source (src/layers/transit/source.js)
 * and so the transit proxy's cache, at no more than its own pace. Each
 * vehicle carries the mode the layer paints it in (src/data/transitFeeds.js
 * transitModeFor: the operator's route-id rules, else the feed's default),
 * so the bins can count trains apart from buses.
 */
import {
  getRegisteredTransitFeed,
  transitModeFor,
  transitModeResolved,
} from '../../../../src/data/transitFeeds.js';

export default {
  id: 'transit',
  label: 'Transit (buses, trams, metro, trains)',
  layers: ['transit'],
  kind: 'feed',
  class: 'open',
  licence:
    'Per-feed open realtime data: MBTA/MassDOT, CapMetro, Metro Transit, OVapi, Entur (NLOD), TransLink, HSL (CC BY 4.0)',
  cadenceMs: 30_000,
  phase: 1,
  bytesPerDay: 150e6,
  async poll({ services, state, now, signal }) {
    if (!state.feeds || now() - state.feedsAt > 3_600_000) {
      state.feeds = await services.transit.getFeeds({ signal });
      state.feedsAt = now();
    }
    const records = [];
    for (const feed of state.feeds) {
      const id = feed?.id;
      if (!id) continue;
      try {
        const response = await services.transit.requestSnapshot(id, { signal });
        if (!response.ok) continue;
        const body = await response.json();
        const entry = getRegisteredTransitFeed(id);
        for (const v of body?.vehicles || [])
          if (Number.isFinite(v?.lat) && Number.isFinite(v?.lon))
            records.push({
              region: id,
              ...v,
              mode: transitModeFor(entry, v.routeId ?? null),
              modeInferred: !transitModeResolved(entry, v.routeId ?? null),
            });
      } catch {
        /* one region down: the others still record */
      }
    }
    return { records };
  },
};
