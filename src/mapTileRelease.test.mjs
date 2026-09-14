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
