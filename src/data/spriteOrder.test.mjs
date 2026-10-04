import { createRendering as createFirmsRendering } from '../layers/firms/rendering.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  SPRITE_LAYER_ORDER,
  registerSpriteCollection,
  restoreSpriteOrder,
  restoreSpriteOrderOnEnable,
  unregisterSpriteCollection,
} from './spriteOrder.js';
import flightsLayer from './flights.js';
import aisLiveVesselsLayer from './aisLiveVessels.js';
import { createFirmsHeatmapLayer } from './firmsHeatmap.js';
import trafficLayer from './traffic.js';

// Upstream's transit layers draw between bike share and directions.
const ORDER = ['cctv', 'cctv-projection', 'traffic', 'firms', 'bikeshare', 'transit', 'transit-motion', 'directions', 'ais', 'military', 'flights'];

function makePrimitives(initial = []) {
  return {
    items: [...initial],
    calls: [],
    contains(collection) { return this.items.includes(collection); },
    raiseToTop(collection) {
      this.calls.push(collection.id);
      const index = this.items.indexOf(collection);
      if (index >= 0) this.items.splice(index, 1);
      this.items.push(collection);
    },
  };
}

function makeCollection(id, destroyed = false) {
  return { id, isDestroyed: () => destroyed };
}

test('restoreSpriteOrder raises live collections bottom-to-top and skips destroyed entries', () => {
  const collections = Object.fromEntries(ORDER.map((id) => [id, makeCollection(id)]));
  const destroyedFirms = makeCollection('firms', true);
  for (const id of ORDER) {
    registerSpriteCollection(id, id === 'firms' ? destroyedFirms : collections[id]);
  }
  const primitives = makePrimitives([
    collections.flights,
    collections.ais,
    collections.cctv,
    collections.traffic,
    collections.bikeshare,
    collections.military,
  ]);

  restoreSpriteOrder({ scene: { primitives } });

  assert.deepEqual(primitives.calls, ['cctv', 'traffic', 'bikeshare', 'ais', 'military', 'flights']);
  assert.deepEqual(primitives.items.map((item) => item.id), [
    'cctv', 'traffic', 'bikeshare', 'ais', 'military', 'flights',
  ]);

  for (const id of ORDER) unregisterSpriteCollection(id);
});

test('late CCTV registration still restores flights above the ambient collection', () => {
  const flights = makeCollection('flights');
  const cctv = makeCollection('cctv');
  const primitives = makePrimitives([flights]);
  const viewer = { scene: { primitives } };

  registerSpriteCollection('flights', flights);
  restoreSpriteOrder(viewer);
  primitives.items.push(cctv); // CCTV enabled after flights: it starts on top.
  registerSpriteCollection('cctv', cctv);
  primitives.calls.length = 0;

  restoreSpriteOrder(viewer);

  assert.deepEqual(primitives.calls, ['cctv', 'flights']);
  assert.deepEqual(primitives.items.map((item) => item.id), ['cctv', 'flights']);

  unregisterSpriteCollection('cctv', cctv);
  unregisterSpriteCollection('flights', flights);
});

test('restoreSpriteOrder is inert for destroyed viewers and primitive collections', () => {
  const flights = makeCollection('flights');
  const primitives = makePrimitives([flights]);
  registerSpriteCollection('flights', flights);

  restoreSpriteOrder({ isDestroyed: () => true, scene: { primitives } });
  restoreSpriteOrder({ scene: { primitives: { ...primitives, isDestroyed: () => true } } });

  assert.deepEqual(primitives.calls, []);
  unregisterSpriteCollection('flights', flights);
});

test('restoreSpriteOrder never raises a registered collection absent from scene primitives', () => {
  const flights = makeCollection('flights');
  const primitives = makePrimitives([]);
  registerSpriteCollection('flights', flights);

  restoreSpriteOrder({ scene: { primitives } });

  assert.deepEqual(primitives.calls, []);
  assert.deepEqual(primitives.items, []);
  unregisterSpriteCollection('flights', flights);
});

test('traffic sits above CCTV so vehicles draw through camera sprites', () => {
  assert.deepEqual([...SPRITE_LAYER_ORDER], ORDER);
  assert.ok(SPRITE_LAYER_ORDER.indexOf('cctv-projection') > SPRITE_LAYER_ORDER.indexOf('cctv'));
  assert.ok(SPRITE_LAYER_ORDER.indexOf('traffic') > SPRITE_LAYER_ORDER.indexOf('cctv-projection'));
  assert.equal(SPRITE_LAYER_ORDER[SPRITE_LAYER_ORDER.length - 1], 'flights');
  // Traffic's frame loop lives in its animation module since upstream's layer split.
  const trafficSrc = readFileSync(fileURLToPath(new URL('../layers/traffic/animation.js', import.meta.url)), 'utf8');
  assert.match(trafficSrc, /function animate\(\) \{[\s\S]*?restoreSpriteOrder\?\.\(layerState\._viewer\)/);
  // The monitor plane is built by the CCTV layer's projection component.
  const cctvSrc = readFileSync(fileURLToPath(new URL('../layers/cctv/projection.js', import.meta.url)), 'utf8');
  assert.match(cctvSrc, /transparent:\s*false/);
  assert.match(cctvSrc, /registerSpriteCollection\(\s*'cctv-projection'/);
  assert.match(cctvSrc, /rs\.depthMask = false/);
});

test('flights, AIS, FIRMS, and traffic enable paths are wired through the shared sprite restorer', () => {
  const viewer = { id: 'viewer' };
  const calls = [];
  const restoreSpy = (value) => calls.push(value);
  for (const layerId of ['flights', 'ais', 'firms', 'traffic']) {
    restoreSpriteOrderOnEnable(layerId, viewer, restoreSpy);
  }
  assert.deepEqual(calls, [viewer, viewer, viewer, viewer]);

  const firmsLayer = createFirmsHeatmapLayer({ id: 'firms', name: 'FIRMS' });
  assert.match(flightsLayer.enable.toString(), /restoreSpriteOrderOnEnable\('flights', viewer\)/);
  assert.match(aisLiveVesselsLayer.enable.toString(), /restoreSpriteOrderOnEnable\('ais', activeViewer\)/);
  assert.match(firmsLayer.enable.toString(), /restoreSpriteOrderOnEnable\('firms', viewer\)/);
  // Traffic's enable lives in its lifecycle module since upstream's layer split.
  assert.match(
    readFileSync(new URL('../layers/traffic/lifecycle.js', import.meta.url), 'utf8'),
    /restoreSpriteOrderOnEnable\?\.\('traffic', viewer\)/,
  );
  assert.match(
    createFirmsRendering.toString(),
    /registerSpriteCollection\('firms', layerState\._billboards\);\s*restoreSpriteOrder\(layerState\._viewer\);/,
    'lazy FIRMS registration must restore order immediately',
  );
});
