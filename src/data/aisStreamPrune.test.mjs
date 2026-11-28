import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AISSTREAM_CACHE_MAX,
  aisStreamRows,
  aisStreamStoreStats,
  ingestAisStreamEnvelope,
  pruneAisStreamCache,
} from '../../server/providers/vessels/ais-store.js';

// The store's expiry runs on the AIS watchdog tick (pruneAisStreamCache), not
// per message; server/providers/vessels/ais-store.test.mjs covers that rule.
// These are the fork's checks beside it: a name that lands before a vessel's
// first position still reaches it, store-private stamps never reach a client,
// and /__gev/health reads every map size and the last timed prune.
//
// Time is driven through node:test's Date mock (no real timers).
const MINUTE = 60 * 1000;
const T0 = Date.UTC(2026, 8, 17, 20, 0, 0);

const positionReport = (mmsi, now, body = {}) => ({
  MessageType: 'PositionReport',
  Message: { PositionReport: { UserID: Number(mmsi), ...body } },
  MetaData: {
    MMSI: mmsi,
    latitude: body.Latitude ?? 53.40879,
    longitude: body.Longitude ?? 6.19741,
    time_utc: new Date(now).toISOString(),
  },
});

const staticReport = (mmsi, name, extra = {}) => ({
  MessageType: 'ShipStaticData',
  Message: {
    ShipStaticData: { UserID: Number(mmsi), Name: name, ...extra },
  },
  MetaData: { MMSI: mmsi },
});

const rowFor = (mmsi) =>
  aisStreamRows(AISSTREAM_CACHE_MAX).find((row) => row.mmsi === mmsi);

test('a name keeps through timed prunes while its vessel is live', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: T0 });
  const mmsi = '353136000';
  assert.equal(ingestAisStreamEnvelope(staticReport(mmsi, 'EVER GIVEN')), true);

  t.mock.timers.setTime(T0 + 20 * MINUTE);
  ingestAisStreamEnvelope(positionReport(mmsi, Date.now()));
  assert.equal(rowFor(mmsi).name, 'EVER GIVEN');

  // The static report is older than the vessel window, the position is not.
  t.mock.timers.setTime(T0 + 35 * MINUTE);
  pruneAisStreamCache();
  assert.equal(rowFor(mmsi).name, 'EVER GIVEN');
});

test('a first position minutes after its static data still picks up the name', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: T0 });
  const mmsi = '636092000';
  ingestAisStreamEnvelope(
    staticReport(mmsi, 'MAERSK ESSEX', {
      Destination: 'ROTTERDAM',
      ImoNumber: 9632179,
      Type: 70,
    }),
  );
  t.mock.timers.setTime(T0 + 12 * MINUTE);
  pruneAisStreamCache();
  ingestAisStreamEnvelope(positionReport(mmsi, Date.now()));
  const row = rowFor(mmsi);
  assert.equal(row.name, 'MAERSK ESSEX');
  assert.equal(row.destination, 'ROTTERDAM');
  assert.equal(row.imo, '9632179');
  assert.equal(row.type, '70');
});

test('store-private stamps never reach served rows', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: T0 });
  const mmsi = '249000101';
  ingestAisStreamEnvelope(positionReport(mmsi, T0), true);
  ingestAisStreamEnvelope(staticReport(mmsi, 'LATE NAME'), true);
  ingestAisStreamEnvelope(positionReport(mmsi, T0), true);
  for (const row of aisStreamRows(AISSTREAM_CACHE_MAX)) {
    for (const key of ['_updatedAt', '_worldwide'])
      assert.equal(key in row, false, `${key} leaked for ${row.mmsi}`);
  }
  assert.equal(rowFor(mmsi).name, 'LATE NAME');
});

test('aisStreamStoreStats reports every map size and the last timed prune', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: T0 });
  pruneAisStreamCache();
  const before = aisStreamStoreStats();
  assert.deepEqual(Object.keys(before).sort(), [
    'lastPruneAt',
    'pending',
    'static',
    'tracks',
    'vessels',
  ]);
  for (const value of Object.values(before))
    assert.equal(typeof value, 'number');
  assert.equal(before.lastPruneAt, T0);

  const mmsi = '304010417';
  ingestAisStreamEnvelope(staticReport(mmsi, 'STATS SHIP'));
  ingestAisStreamEnvelope(positionReport(mmsi, T0));
  let stats = aisStreamStoreStats();
  assert.equal(stats.vessels, before.vessels + 1);
  assert.equal(stats.static, before.static + 1);
  assert.equal(stats.pending, before.pending + 1);
  assert.equal(stats.tracks, before.tracks);

  // A second fix far enough away in time and space allocates the track buffer.
  t.mock.timers.setTime(T0 + MINUTE);
  ingestAisStreamEnvelope(
    positionReport(mmsi, T0 + MINUTE, {
      Latitude: 53.41879,
      Longitude: 6.19741,
    }),
  );
  stats = aisStreamStoreStats();
  assert.equal(stats.tracks, before.tracks + 1);
  assert.equal(stats.pending, before.pending);

  t.mock.timers.setTime(T0 + 2 * MINUTE);
  pruneAisStreamCache();
  assert.equal(aisStreamStoreStats().lastPruneAt, T0 + 2 * MINUTE);
});
