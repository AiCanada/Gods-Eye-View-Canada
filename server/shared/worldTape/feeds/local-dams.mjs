/**
 * World tape snapshot: the bundled OpenStreetMap dams
 * (services.infrastructure). No live data: checked once a day and recorded
 * only when the bundle changed.
 */
import { infrastructureSnapshot } from './_util.mjs';

export default infrastructureSnapshot({
  id: 'local-dams',
  label: 'Dams (OpenStreetMap)',
  licence: 'OpenStreetMap contributors (ODbL 1.0), via Open Infrastructure Map',
  bytesPerDay: 0.02e6,
  fields: (record) => ({
    river: record.river ?? null,
    output: record.output ?? null,
  }),
});
