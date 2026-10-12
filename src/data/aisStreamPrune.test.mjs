import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AISSTREAM_CACHE_MAX,
  AISSTREAM_PRUNE_INTERVAL_MS,
  AISSTREAM_PRUNE_SIZE_TRIGGER,
  AISSTREAM_STALE_MS,
  AISSTREAM_STATIC_RETENTION_MS,
  aisStreamRows,
  aisStreamStoreStats,
  ingestAisStreamEnvelope,
  pruneAisStreamCacheNow,
  shouldPruneAisStreamCache,
} from '../../server/providers/vessels/ais-store.js';

// The store sweeps its maps on the ingest path. Sweeping on every message
// kept an idle server busy, so the sweep is throttled; the read path filters
// by the same staleness cutoff, so a delayed sweep changes nothing served.
// Static data (names) can land minutes before a vessel's first position, so
// its eviction is tied to retention AND to the absence of a live position.
//
// Time is driven through node:test's Date mock (no real timers) and through
// the `now` parameter of pruneAisStreamCacheNow.
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

test('size trigger sits five percent above the cap', () => {
  assert.equal(AISSTREAM_PRUNE_INTERVAL_MS, 5000);
  assert.equal(
    AISSTREAM_PRUNE_SIZE_TRIGGER,
    AISSTREAM_CACHE_MAX + Math.floor(AISSTREAM_CACHE_MAX / 20),
  );
});

test('a sweep is not due within the interval and due once it has elapsed', () => {
  const base = { lastPruneAt: T0, size: 10 };
  assert.equal(shouldPruneAisStreamCache({ ...base, now: T0 }), false);
  assert.equal(shouldPruneAisStreamCache({ ...base, now: T0 + 4999 }), false);
  assert.equal(shouldPruneAisStreamCache({ ...base, now: T0 + 5000 }), true);
  assert.equal(shouldPruneAisStreamCache({ ...base, now: T0 + 60000 }), true);
  assert.equal(
    shouldPruneAisStreamCache({ ...base, now: T0 + 999, intervalMs: 1000 }),
    false,
  );
  assert.equal(
    shouldPruneAisStreamCache({ ...base, now: T0 + 1000, intervalMs: 1000 }),
    true,
  );
});

test('a sweep is due immediately at the size trigger whatever the clock says', () => {
  const justSwept = { now: T0 + 1, lastPruneAt: T0 };
  assert.equal(
    shouldPruneAisStreamCache({
      ...justSwept,
      size: AISSTREAM_PRUNE_SIZE_TRIGGER - 1,
    }),
    false,
  );
  assert.equal(
    shouldPruneAisStreamCache({
      ...justSwept,
      size: AISSTREAM_PRUNE_SIZE_TRIGGER,
    }),
    true,
  );
  assert.equal(
    shouldPruneAisStreamCache({ ...justSwept, size: 3, sizeTrigger: 3 }),
    true,
  );
});

test('a clock that stepped backwards does not park the sweep', () => {
  assert.equal(
    shouldPruneAisStreamCache({ now: T0 - 1, lastPruneAt: T0, size: 1 }),
    true,
  );
});

test('the ingest path sweeps once per interval, not once per message', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: T0 });
  pruneAisStreamCacheNow(T0 - 10 * AISSTREAM_PRUNE_INTERVAL_MS);

  assert.equal(ingestAisStreamEnvelope(positionReport('211000001', T0)), true);
  assert.equal(aisStreamStoreStats().lastPruneAt, T0);

  t.mock.timers.setTime(T0 + AISSTREAM_PRUNE_INTERVAL_MS - 1);
  ingestAisStreamEnvelope(positionReport('211000002', Date.now()));
  assert.equal(aisStreamStoreStats().lastPruneAt, T0);

  t.mock.timers.setTime(T0 + AISSTREAM_PRUNE_INTERVAL_MS);
  ingestAisStreamEnvelope(positionReport('211000003', Date.now()));
  assert.equal(
    aisStreamStoreStats().lastPruneAt,
    T0 + AISSTREAM_PRUNE_INTERVAL_MS,
  );
  assert.ok(rowFor('211000001'));
  assert.ok(rowFor('211000002'));
  assert.ok(rowFor('211000003'));
});

test('a static entry outlives the retention window while its vessel is live', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: T0 });
  const mmsi = '353136000';
  assert.equal(ingestAisStreamEnvelope(staticReport(mmsi, 'EVER GIVEN')), true);
  const staticBefore = aisStreamStoreStats().static;

  t.mock.timers.setTime(T0 + 20 * MINUTE);
  ingestAisStreamEnvelope(positionReport(mmsi, Date.now()));
  assert.equal(rowFor(mmsi).name, 'EVER GIVEN');

  // The static entry is older than the window, the position is not.
  t.mock.timers.setTime(T0 + 35 * MINUTE);
  pruneAisStreamCacheNow(Date.now());
  assert.equal(aisStreamStoreStats().static, staticBefore);
  assert.equal(rowFor(mmsi).name, 'EVER GIVEN');

  // Once the position is stale the row goes; the static entry outlives it
  // by its own, longer window so the name is back the moment it returns.
  t.mock.timers.setTime(T0 + 51 * MINUTE);
  pruneAisStreamCacheNow(Date.now());
  assert.equal(rowFor(mmsi), undefined);
  assert.equal(aisStreamStoreStats().static, staticBefore);

  t.mock.timers.setTime(T0 + AISSTREAM_STATIC_RETENTION_MS + 1);
  pruneAisStreamCacheNow(Date.now());
  assert.equal(aisStreamStoreStats().static, staticBefore - 1);
});

test('a static entry without a position goes only after the static retention window, not the vessel one', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: T0 });
  const mmsi = '477995900';
  ingestAisStreamEnvelope(staticReport(mmsi, 'COSCO SHIPPING ARIES'));
  const staticBefore = aisStreamStoreStats().static;
  assert.ok(AISSTREAM_STATIC_RETENTION_MS > AISSTREAM_STALE_MS);

  pruneAisStreamCacheNow(T0 + AISSTREAM_STALE_MS + 1);
  assert.equal(aisStreamStoreStats().static, staticBefore);

  pruneAisStreamCacheNow(T0 + AISSTREAM_STATIC_RETENTION_MS - 1);
  assert.equal(aisStreamStoreStats().static, staticBefore);

  // A first position inside the window still picks the name up.
  t.mock.timers.setTime(T0 + AISSTREAM_STALE_MS + 2);
  ingestAisStreamEnvelope(positionReport(mmsi, Date.now()));
  assert.equal(rowFor(mmsi).name, 'COSCO SHIPPING ARIES');

  // With no position at all the entry goes once its window has passed.
  const alone = '477995901';
  ingestAisStreamEnvelope(staticReport(alone, 'NEVER SEEN MOVING'));
  const withAlone = aisStreamStoreStats().static;
  pruneAisStreamCacheNow(
    T0 + AISSTREAM_STALE_MS + 2 + AISSTREAM_STATIC_RETENTION_MS + 1,
  );
  // Both are past their window by now: the one never seen moving, and the
  // first one, whose only position is long stale as well.
  assert.equal(aisStreamStoreStats().static, withAlone - 2);
});

test('a vessel returning after a coverage gap gets name, type, destination and IMO back at once', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: T0 });
  const mmsi = '636092001';
  ingestAisStreamEnvelope(
    staticReport(mmsi, 'MSC GULSUN', {
      Destination: 'ANTWERP',
      ImoNumber: 9839430,
      Type: 70,
    }),
  );
  ingestAisStreamEnvelope(positionReport(mmsi, T0));
  assert.equal(rowFor(mmsi).name, 'MSC GULSUN');

  // Out of coverage for longer than the vessel window: the row is gone.
  t.mock.timers.setTime(T0 + 31 * MINUTE);
  pruneAisStreamCacheNow(Date.now());
  assert.equal(rowFor(mmsi), undefined);

  // Back a minute later, with a position report that carries no static data.
  t.mock.timers.setTime(T0 + 32 * MINUTE);
  ingestAisStreamEnvelope(positionReport(mmsi, Date.now()));
  const row = rowFor(mmsi);
  assert.equal(row.name, 'MSC GULSUN');
  assert.equal(row.type, '70');
  assert.equal(row.destination, 'ANTWERP');
  assert.equal(row.imo, '9839430');
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
  ingestAisStreamEnvelope(positionReport(mmsi, T0));
  ingestAisStreamEnvelope(staticReport(mmsi, 'LATE NAME'));
  ingestAisStreamEnvelope(positionReport(mmsi, T0));
  for (const row of aisStreamRows(AISSTREAM_CACHE_MAX)) {
    assert.equal('_at' in row, false, `_at leaked for ${row.mmsi}`);
    assert.equal(
      '_updatedAt' in row,
      false,
      `_updatedAt leaked for ${row.mmsi}`,
    );
  }
  assert.equal(rowFor(mmsi).name, 'LATE NAME');
});

test('aisStreamStoreStats reports every map size and the last sweep time', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: T0 });
  pruneAisStreamCacheNow(T0);
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
  ingestAisStreamEnvelope(
    positionReport(mmsi, T0 + 60 * 1000, {
      Latitude: 53.41879,
      Longitude: 6.19741,
    }),
  );
  stats = aisStreamStoreStats();
  assert.equal(stats.tracks, before.tracks + 1);
  assert.equal(stats.pending, before.pending);
});
