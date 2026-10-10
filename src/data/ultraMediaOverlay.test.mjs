import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ULTRA_MEDIA_ON_MAP_MAX,
  ULTRA_MEDIA_SCALE_BIG,
  ULTRA_MEDIA_TILE_H,
  ULTRA_MEDIA_TILE_W,
  ULTRA_MEDIA_VIEW_EVENT,
  createUltraMediaOverlay,
  draggedMediaScale,
  mediaWindow,
  toggledMediaScale,
} from './ultraMediaOverlay.js';
import {
  closeUltraMediaInCctv,
  showUltraMediaInCctv,
} from '../ui/cctvUltraMediaView.js';

/** A small stand-in for the page: elements with children, listeners, style. */
function fakeDocument() {
  const byId = new Map();
  const make = (tag) => {
    const listeners = new Map();
    const node = {
      tagName: tag.toUpperCase(),
      children: [],
      style: {},
      dataset: {},
      classList: {
        set: new Set(),
        contains(name) {
          return this.set.has(name);
        },
      },
      hidden: false,
      parent: null,
      appendChild(child) {
        if (child.parent)
          child.parent.children.splice(child.parent.children.indexOf(child), 1);
        child.parent = node;
        node.children.push(child);
        if (child.id) byId.set(child.id, child);
        return child;
      },
      remove() {
        if (!node.parent) return;
        node.parent.children.splice(node.parent.children.indexOf(node), 1);
        node.parent = null;
        if (node.id) byId.delete(node.id);
      },
      addEventListener(type, fn) {
        listeners.set(type, [...(listeners.get(type) || []), fn]);
      },
      fire(type, event = {}) {
        for (const fn of listeners.get(type) || [])
          fn({
            target: node,
            preventDefault() {},
            stopPropagation() {},
            button: 0,
            ...event,
          });
      },
      attributes: {},
      // As a browser does: an attribute is not the property of the same name.
      setAttribute(name, value) {
        node.attributes[name] = value;
      },
      removeAttribute(name) {
        if (name === 'src') delete node.src;
        delete node.attributes[name];
      },
      querySelector: () => null,
    };
    return node;
  };
  return {
    createElement: make,
    getElementById: (id) => byId.get(id) || null,
    byId,
    make,
  };
}

test('three of each at most, from the picked one, wrapping round', () => {
  assert.equal(ULTRA_MEDIA_ON_MAP_MAX, 3);
  assert.deepEqual(mediaWindow(['a', 'b', 'c', 'd', 'e'], 3), ['d', 'e', 'a']);
  assert.deepEqual(mediaWindow(['a', 'b'], 5), ['b', 'a']);
  assert.deepEqual(mediaWindow([], 2), []);
  assert.deepEqual(mediaWindow(['a', 'b', 'c', 'd'], -1), ['d', 'a', 'b']);
});

test('double-click makes a tile bigger, and again smaller; the top-right corner drags its size', () => {
  assert.equal(toggledMediaScale(1), ULTRA_MEDIA_SCALE_BIG);
  assert.equal(toggledMediaScale(ULTRA_MEDIA_SCALE_BIG), 1);
  assert.equal(
    toggledMediaScale(4),
    1,
    'a dragged-big tile goes back to the start',
  );
  const grown = draggedMediaScale({
    startScale: 1,
    startX: 100,
    startY: 100,
    x: 196,
    y: 46,
  });
  assert.ok(grown > 1.9 && grown < 2.1, 'up and right grows it');
  const shrunk = draggedMediaScale({
    startScale: 2,
    startX: 100,
    startY: 100,
    x: 60,
    y: 130,
  });
  assert.ok(shrunk < 2);
  assert.equal(
    draggedMediaScale({ startScale: 1, startX: 0, startY: 0, x: -999, y: 999 }),
    0.6,
    'never smaller than the floor',
  );
});

test('the tiles: photos and videos at the live card’s size, resized, toggled, and clicked into the CCTV viewer', () => {
  const doc = fakeDocument();
  const container = doc.make('div');
  const stored = new Map();
  const storage = {
    getItem: (k) => stored.get(k) ?? null,
    setItem: (k, v) => stored.set(k, v),
  };
  const timers = [];
  const dispatched = [];
  const windowRef = {
    setTimeout: (fn) => (timers.push(fn), timers.length),
    clearTimeout: (id) => (timers[id - 1] = null),
    dispatchEvent: (event) => dispatched.push([event.type, event.detail]),
  };
  const overlay = createUltraMediaOverlay({
    container,
    documentRef: doc,
    windowRef,
    storage,
  });
  const [root] = container.children;
  const photo = 'photo-20261008T120000Z-1.jpg';
  const clip = 'clip-20261008T120100Z-2.webm';
  overlay.setMedia({
    photos: [photo],
    videos: [clip],
    photoTotal: 4,
    videoTotal: 1,
  });
  const [left, right] = root.children;
  assert.equal(left.children.length, 1, 'the photo on the left');
  assert.equal(right.children.length, 1, 'the video on the right');
  const tile = overlay.tiles().find((entry) => entry.name === photo);
  assert.equal(tile.media.tagName, 'IMG');
  assert.equal(tile.media.src, `/api/ultra-help/media/${photo}`);
  assert.equal(tile.title.textContent, 'PHOTO 1/4');
  assert.deepEqual(
    [tile.media.style.width, tile.media.style.height],
    [`${ULTRA_MEDIA_TILE_W}px`, `${ULTRA_MEDIA_TILE_H}px`],
  );
  const video = overlay.tiles().find((entry) => entry.name === clip);
  assert.deepEqual(
    [video.media.tagName, video.media.muted, video.media.loop],
    ['VIDEO', true, true],
  );

  // Double-click: bigger, kept for this photo.
  tile.tile.fire('click');
  tile.tile.fire('dblclick');
  assert.equal(
    tile.media.style.width,
    `${Math.round(ULTRA_MEDIA_TILE_W * ULTRA_MEDIA_SCALE_BIG)}px`,
  );
  assert.equal(
    JSON.parse(stored.get('ultra-media-scales'))[photo],
    ULTRA_MEDIA_SCALE_BIG,
  );
  assert.deepEqual(dispatched, [], 'a double-click is not a click');
  // Top-right corner drag: smaller.
  tile.grip.fire('pointerdown', { pointerId: 1, clientX: 100, clientY: 100 });
  tile.grip.fire('pointermove', { pointerId: 1, clientX: 20, clientY: 160 });
  tile.grip.fire('pointerup', { pointerId: 1 });
  assert.ok(
    parseInt(tile.media.style.width, 10) <
      ULTRA_MEDIA_TILE_W * ULTRA_MEDIA_SCALE_BIG,
  );
  // One click: the CCTV viewer, once the double-click wait is over.
  video.tile.fire('click');
  timers.filter(Boolean).at(-1)();
  assert.deepEqual(dispatched.at(-1), [
    ULTRA_MEDIA_VIEW_EVENT,
    { name: clip, kind: 'clip' },
  ]);

  // Placed beside the cell, hidden while it is not on screen.
  overlay.place({ x: 400.4, y: 300.6, visible: true });
  assert.deepEqual(
    [root.hidden, root.style.left, root.style.top],
    [false, '400px', '301px'],
  );
  overlay.place({ visible: false });
  assert.equal(root.hidden, true);
  // Dropped from the map: the tile goes.
  overlay.setMedia({ photos: [], videos: [clip] });
  assert.equal(left.children.length, 0);
  overlay.destroy();
  assert.equal(container.children.length, 0);
});

test('the CCTV viewer shows a saved photo or video over the camera, and BACK TO CAMERA takes it away', () => {
  const doc = fakeDocument();
  const wrap = doc.make('div');
  wrap.id = 'cctv-frame-wrap';
  doc.byId.set('cctv-frame-wrap', wrap);
  assert.equal(
    showUltraMediaInCctv(doc, { name: '../config/ultra-help.json' }),
    false,
    'only a saved name',
  );
  assert.equal(
    showUltraMediaInCctv(doc, {
      name: 'clip-20261008T120100Z-2.webm',
      kind: 'clip',
    }),
    true,
  );
  const view = doc.getElementById('cctv-ultra-view');
  const [bar, media] = view.children;
  assert.equal(media.tagName, 'VIDEO');
  assert.equal(media.src, '/api/ultra-help/media/clip-20261008T120100Z-2.webm');
  assert.match(bar.children[0].textContent, /^ULTRA VIDEO · /);
  bar.children[1].fire('click');
  assert.equal(doc.getElementById('cctv-ultra-view'), null);
  showUltraMediaInCctv(doc, {
    name: 'photo-20261008T120000Z-1.jpg',
    kind: 'photo',
  });
  assert.equal(
    doc.getElementById('cctv-ultra-view').children[1].tagName,
    'IMG',
  );
  closeUltraMediaInCctv(doc);
  assert.equal(wrap.children.length, 0);
});
