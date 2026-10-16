/**
 * World tape snapshot: the bundled Bhote Koshi 2026 outburst flood event pack
 * (services.events, /events/bhote-koshi-2026/event.json): the whole pack as
 * a gzip JSON file and one record per geolocated piece of evidence. No live
 * data: checked once a day and written only when the pack changed.
 */
import { DAY, gzipJson, hashOf, round, text } from './_util.mjs';

const EVENT_ID = 'bhote-koshi-2026';

export default {
  id: EVENT_ID,
  label: 'Bhote Koshi 2026 flood (event pack)',
  layers: [EVENT_ID],
  kind: 'static',
  class: 'nc',
  licence:
    "Vantor Open Data imagery and GeoPera reconstruction (CC BY-NC 4.0); witness posts keep their owners' terms",
  cadenceMs: DAY,
  phase: 2,
  bytesPerDay: 0.01e6,
  async poll({ services, state, signal }) {
    const event = await services.events.getEvent(EVENT_ID, { signal });
    if (!event || typeof event !== 'object')
      throw new Error('Event pack unavailable');
    const sig = hashOf(event);
    if (state.sig === sig) return {};
    state.sig = sig;
    const records = (
      Array.isArray(event.evidenceSpine) ? event.evidenceSpine : []
    )
      .filter(
        (item) => Number.isFinite(item?.lat) && Number.isFinite(item?.lon),
      )
      .map((item) => ({
        kind: 'evidence',
        id: text(String(item.id ?? ''), 120),
        sequence: item.sequence ?? null,
        phase: text(item.phase, 60),
        title: text(item.title, 240),
        lat: round(item.lat, 6),
        lon: round(item.lon, 6),
        capturedAt: item.timing?.capturedAt ?? null,
        source: text(item.media?.sourceUrl, 500),
      }));
    return {
      records,
      files: [
        {
          name: `${EVENT_ID}-${sig.slice(0, 12)}.json.gz`,
          bytes: gzipJson(event),
          record: {
            kind: 'pack',
            event: event.id ?? EVENT_ID,
            title: text(event.title, 240),
            observed: event.observedDate ?? null,
            evidence: records.length,
            encoding: 'gzip',
            sig,
          },
        },
      ],
    };
  },
};
