/**
 * World tape snapshot: the bundled OpenStreetMap datacenters
 * (services.infrastructure). No live data: checked once a day and recorded
 * only when the bundle changed.
 */
import { infrastructureSnapshot } from './_util.mjs';

export default infrastructureSnapshot({
  id: 'local-datacenters',
  label: 'Datacenters (OpenStreetMap)',
  licence: 'OpenStreetMap contributors (ODbL 1.0)',
  bytesPerDay: 0.05e6,
  fields: (record) => ({ capacity: record.capacity ?? null }),
});
