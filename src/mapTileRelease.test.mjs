import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseTilesAfterLoad } from './mapTileRelease.js';

function fakeTileset({ tilesLoaded = false } = {}) {
  const listeners = [];
  return {
    listeners,
    tilesLoaded,
    trims: 0,
    destroyed: false,
    trimLoadedTiles() { this.trims += 1; },
    isDestroyed() { return this.destroyed; },
    allTilesLoaded: {
      addEventListener(fn) {
        listeners.push(fn);
        return () => listeners.splice(listeners.indexOf(fn), 1);
      },
    },
  };
}

function timers() {
  const list = [];
  return {
    list,
    setTimer: (fn, ms) => { list.push({ fn, ms }); return list.length; },
    clearTimer: () => {},
  };
}

test('old tiles are trimmed once the destination has loaded, never before', () => {
  const tileset = fakeTileset();
  const clock = timers();
  let renders = 0;
  releaseTilesAfterLoad(tileset, { ...clock, requestRender: () => { renders += 1; } });
  assert.equal(tileset.trims, 0, 'nothing is dropped while the destination is still loading');
  tileset.listeners[0]();
  assert.equal(tileset.trims, 1);
  assert.equal(renders, 1, 'a frame is requested so the unload runs');
  assert.equal(tileset.listeners.length, 0, 'the listener is removed');
  clock.list[0].fn();
  assert.equal(tileset.trims, 1, 'the timeout does nothing afterwards');
});

test('an already loaded view trims at once; a timeout or cancel never trims', () => {
  const loaded = fakeTileset({ tilesLoaded: true });
  releaseTilesAfterLoad(loaded, timers());
  assert.equal(loaded.trims, 1);

  const slow = fakeTileset();
  const clock = timers();
  releaseTilesAfterLoad(slow, clock);
  clock.list[0].fn();
  assert.equal(slow.trims, 0, 'a destination that never finishes loading keeps its tiles');
  assert.equal(slow.listeners.length, 0);

  const cancelled = fakeTileset();
  const cancel = releaseTilesAfterLoad(cancelled, timers());
  cancel();
  assert.equal(cancelled.listeners.length, 0);
  assert.equal(cancelled.trims, 0);
});

test('no tileset, or a destroyed one, is left alone', () => {
  assert.doesNotThrow(() => releaseTilesAfterLoad(null)());
  const gone = fakeTileset({ tilesLoaded: true });
  gone.destroyed = true;
  releaseTilesAfterLoad(gone, timers());
  assert.equal(gone.trims, 0);
});

// The scene's map engine hands an opaque handle to the photoreal base
// (src/maps/globeEngine.js), which cannot be trimmed directly.
function fakeRenderer(result) {
  const renderer = {
    waits: [],
    releases: 0,
    whenSettled(options) {
      renderer.waits.push(options);
      return typeof result === 'function' ? result() : Promise.resolve(result);
    },
    releaseUnused() { renderer.releases += 1; },
  };
  return renderer;
}
const HANDLE = { spec: { provider: 'google' }, globe: {}, shown: true };
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('an engine handle is trimmed through the renderer once the view has settled', async () => {
  const renderer = fakeRenderer({ state: 'settled', blockers: [] });
  releaseTilesAfterLoad(HANDLE, { renderer, timeoutMs: 1234 });
  assert.equal(renderer.releases, 0, 'not before the destination has loaded');
  await settle();
  assert.deepEqual(renderer.waits, [{ timeoutMs: 1234 }]);
  assert.equal(renderer.releases, 1);
});

test('an engine handle is left alone on a timeout, a failure, a cancel, or with no renderer', async () => {
  for (const state of ['timeout', 'failed']) {
    const renderer = fakeRenderer({ state, blockers: ['tiles'] });
    releaseTilesAfterLoad(HANDLE, { renderer });
    await settle();
    assert.equal(renderer.releases, 0, state);
  }
  const rejecting = fakeRenderer(() => Promise.reject(new Error('gone')));
  releaseTilesAfterLoad(HANDLE, { renderer: rejecting });
  await settle();
  assert.equal(rejecting.releases, 0);

  const cancelled = fakeRenderer({ state: 'settled', blockers: [] });
  releaseTilesAfterLoad(HANDLE, { renderer: cancelled })();
  await settle();
  assert.equal(cancelled.releases, 0, 'a newer switch cancels the older trim');

  assert.doesNotThrow(() => releaseTilesAfterLoad(HANDLE)());
  const none = fakeRenderer({ state: 'settled', blockers: [] });
  releaseTilesAfterLoad(null, { renderer: none });
  await settle();
  assert.equal(none.waits.length, 0, 'no photoreal base, nothing to trim');
});
