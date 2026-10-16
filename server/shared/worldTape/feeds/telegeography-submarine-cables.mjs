/**
 * World tape snapshot: the bundled TeleGeography submarine cables and landing
 * points (services.cables). No live data: checked once a day and written
 * (gzip GeoJSON files) only when the bundle changed.
 */
import { DAY, gzipJson, hashOf } from './_util.mjs';

export default {
  id: 'telegeography-submarine-cables',
  label: 'Submarine cables (TeleGeography)',
  layers: ['telegeography-submarine-cables'],
  kind: 'static',
  class: 'nc',
  licence: 'TeleGeography Submarine Cable Map (CC BY-NC-SA 3.0)',
  cadenceMs: DAY,
  phase: 2,
  bytesPerDay: 0.05e6,
  async poll({ services, state, signal }) {
    const { cables, landingPoints } = await services.cables.fetch(signal);
    const sig = hashOf([cables, landingPoints]);
    if (state.sig === sig) return {};
    state.sig = sig;
    const files = [];
    for (const [dataset, collection] of [
      ['cables', cables],
      ['landing-points', landingPoints],
    ])
      files.push({
        name: `${dataset}-${sig.slice(0, 12)}.geojson.gz`,
        bytes: gzipJson(collection),
        record: {
          dataset,
          features: Array.isArray(collection?.features)
            ? collection.features.length
            : 0,
          encoding: 'gzip',
          sig,
        },
      });
    return { files };
  },
};
