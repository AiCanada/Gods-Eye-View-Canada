/**
 * World tape feed: Launch Library 2 launches (the rolling 30 days the layer
 * shows), through the layer's own source (services.launches → /api/launches,
 * cached 15 minutes in memory and on disk). Anonymous LL2 access allows 15
 * calls an hour, so the recorder asks every 15 minutes at most and the
 * proxy's cache answers the rest. Each launch once, and again when its time,
 * status or record changes.
 */
import { DAY, MINUTE, finite, forget, noteChange, text } from './_util.mjs';

export default {
  id: 'rocket-launches',
  label: 'Rocket launches (Launch Library 2)',
  layers: ['rocket-launches'],
  kind: 'feed',
  class: 'open',
  licence:
    'The Space Devs Launch Library 2 (data may be used and shared in any form; attribution encouraged)',
  cadenceMs: 15 * MINUTE,
  phase: 1,
  bytesPerDay: 0.05e6,
  async poll({ services, state, now, signal }) {
    const { payload } = services.launches.getLaunchSnapshot
      ? await services.launches.getLaunchSnapshot({ signal })
      : { payload: await services.launches.getLaunches({ signal }) };
    const launches = Array.isArray(payload) ? payload : payload?.results;
    if (!Array.isArray(launches)) throw new Error('Malformed launch snapshot');
    state.seen ??= new Map();
    const t = now();
    const records = [];
    for (const launch of launches) {
      const id = text(launch?.id);
      if (!id) continue;
      const status = text(launch.status?.abbrev) || text(launch.status?.name);
      const sig = [
        launch.net,
        status,
        launch.last_updated,
        launch.window_start,
        launch.window_end,
      ].join('|');
      if (!noteChange(state.seen, id, sig, t)) continue;
      records.push({
        id,
        name: text(launch.name),
        net: text(launch.net),
        status,
        pad: text(launch.pad?.name),
        lat: finite(launch.pad?.latitude),
        lon: finite(launch.pad?.longitude),
        location: text(launch.pad?.location?.name),
        provider: text(launch.launch_service_provider?.name),
        rocket: text(
          launch.rocket?.configuration?.full_name ??
            launch.rocket?.configuration?.name,
        ),
        mission: text(launch.mission?.name),
        orbit: text(launch.mission?.orbit?.name),
        windowStart: text(launch.window_start),
        windowEnd: text(launch.window_end),
        updated: text(launch.last_updated),
      });
    }
    forget(state.seen, t, 60 * DAY, 20_000);
    return { records };
  },
};
