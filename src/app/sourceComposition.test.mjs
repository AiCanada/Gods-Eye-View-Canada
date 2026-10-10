import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveCatalogSources,
  CATALOG_SOURCE_CONTRACTS,
} from './sourceComposition.js';
import { createApplicationCatalog } from './constructCatalog.js';
import { createSurfaceServices } from './surfaceServices.js';
import { createStandaloneLayerSources } from '../standalone/layerSources.js';
import { LayerLifecycle } from '../data/lifecycle.js';

function catalog(sources, t) {
  const lifetime = new AbortController();
  t.after(() => lifetime.abort());
  return createApplicationCatalog({
    sources,
    signal: lifetime.signal,
    surface: createSurfaceServices({
      terrainSource: { getHeights: async () => [] },
      signal: lifetime.signal,
      eventTarget: null,
    }),
  });
}

test('every acquisition source can be omitted without losing catalog membership', (t) => {
  const baseline = catalog(createStandaloneLayerSources(), t);
  for (const name of Object.keys(CATALOG_SOURCE_CONTRACTS)) {
    const sources = createStandaloneLayerSources({ [name]: null });
    const actual = catalog(sources, t);
    assert.deepEqual(actual.metadata, baseline.metadata, name);
    for (const id of CATALOG_SOURCE_CONTRACTS[name].layers) {
      assert.equal(actual.get(id).getSourceAvailability().available, false, id);
    }
  }
});

test('all acquisition sources may be absent, and enable fails before initializing or fetching', async (t) => {
  const actual = catalog({}, t);
  assert.equal(actual.layers.length, 30);
  const manager = new LayerLifecycle({});
  for (const layer of actual.layers) manager.register(layer);
  for (const { layers: ids } of Object.values(CATALOG_SOURCE_CONTRACTS)) {
    for (const id of ids) {
      assert.equal(await manager.setEnabled(id, true), false, id);
      assert.equal(manager.layers.get(id).initialized, false, id);
      const row = manager.getAll().find((entry) => entry.id === id);
      assert.equal(row.enabled, false);
      assert.equal(row.stats.status, 'unavailable');
      assert.match(row.stats.error, /not configured/);
    }
  }
});

test('configured sources retain identity; invalid implementations never become unavailable silently', () => {
  const source = { getSnapshot: async () => [] };
  assert.equal(
    resolveCatalogSources({ earthquakes: source }).sources.earthquakes,
    source,
  );
  for (const name of Object.keys(CATALOG_SOURCE_CONTRACTS)) {
    assert.throws(
      () => resolveCatalogSources({ [name]: {} }),
      /Invalid catalog source/,
    );
  }
  const missing = resolveCatalogSources({}).sources.earthquakes;
  assert.throws(() => missing.getSnapshot(), { code: 'unavailable' });
});

test('standalone defaults allow exact replacements and explicit removal, and reject typos', () => {
  const source = { getSnapshot: async () => [] };
  const sources = createStandaloneLayerSources({
    flights: source,
    military: null,
  });
  assert.equal(sources.flights, source);
  assert.equal(sources.military, null);
  assert.equal(typeof sources.cctv.getCatalog, 'function');
  assert.throws(
    () => createStandaloneLayerSources({ fligts: source }),
    /Unknown source/,
  );
});
