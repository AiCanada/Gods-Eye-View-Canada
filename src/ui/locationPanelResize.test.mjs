import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCATION_PANEL_LIMITS,
  LOCATION_PANEL_STORAGE_KEY,
  bindLocationPanelResize,
  loadLocationPanelSize,
  locationPillRows,
  resizedLocationPanel,
} from './locationPanelResize.js';

const start = { width: 600, height: 200, shiftX: 0 };

test('every corner resizes the tray; west corners carry the left edge', () => {
  assert.deepEqual(resizedLocationPanel(start, 'ne', 100, -50), { width: 700, height: 250, shiftX: 0 });
  assert.deepEqual(resizedLocationPanel(start, 'se', 100, 50), { width: 700, height: 250, shiftX: 0 });
  assert.deepEqual(resizedLocationPanel(start, 'nw', -100, -50), { width: 700, height: 250, shiftX: -100 });
  assert.deepEqual(resizedLocationPanel(start, 'sw', 80, -40), { width: 520, height: 160, shiftX: 80 });
});

test('sizes are clamped, and a clamped west drag does not slide the tray', () => {
  const huge = resizedLocationPanel(start, 'nw', -5000, -5000);
  assert.equal(huge.width, LOCATION_PANEL_LIMITS.maxWidth);
  assert.equal(huge.height, LOCATION_PANEL_LIMITS.maxHeight);
  assert.equal(huge.shiftX, -(LOCATION_PANEL_LIMITS.maxWidth - 600));
  const tiny = resizedLocationPanel(start, 'se', -5000, -5000);
  assert.deepEqual([tiny.width, tiny.height], [LOCATION_PANEL_LIMITS.minWidth, LOCATION_PANEL_LIMITS.minHeight]);
});

test('a taller tray shows more rows of location pills', () => {
  assert.equal(locationPillRows(120), 2, 'never fewer than the stock two rows');
  assert.ok(locationPillRows(300) > locationPillRows(160));
  assert.equal(locationPillRows(5000), 12);
});

function fakeDom() {
  const made = [];
  const element = () => {
    const listeners = {};
    const style = { props: {}, setProperty(k, v) { this.props[k] = v; }, removeProperty(k) { delete this.props[k]; } };
    const classes = new Set();
    return {
      listeners, style, dataset: {}, children: [],
      classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), has: (c) => classes.has(c) },
      setAttribute() {},
      addEventListener(type, fn) { listeners[type] = fn; },
      removeEventListener(type) { delete listeners[type]; },
      appendChild(child) { this.children.push(child); child.parent = this; },
      remove() { this.parent.children = this.parent.children.filter((c) => c !== this); },
      getBoundingClientRect: () => ({ width: 600, height: 200 }),
    };
  };
  return { made, element, doc: { createElement: () => { const e = element(); made.push(e); return e; } } };
}

test('dragging a grip resizes and saves; the saved size is restored; double-click resets', () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  const dom = fakeDom();
  const popover = dom.element();
  const pills = dom.element();
  const remove = bindLocationPanelResize({ popover, pills, doc: dom.doc, storage });
  assert.equal(popover.children.length, 4, 'one grip per corner');

  const ne = popover.children.find((grip) => grip.dataset.corner === 'ne');
  const event = (x, y) => ({ button: 0, clientX: x, clientY: y, pointerId: 1, preventDefault() {}, stopPropagation() {} });
  ne.listeners.pointerdown(event(1000, 500));
  ne.listeners.pointermove(event(1120, 380));
  ne.listeners.pointerup(event(1120, 380));
  assert.equal(popover.style.width, '720px');
  assert.equal(popover.style.height, '320px');
  assert.equal(pills.style.props['--location-pill-rows'], String(locationPillRows(320)));
  assert.deepEqual(loadLocationPanelSize(storage), { width: 720, height: 320, shiftX: 0 });

  // A fresh page restores it.
  const again = fakeDom();
  const popover2 = again.element();
  bindLocationPanelResize({ popover: popover2, pills: again.element(), doc: again.doc, storage });
  assert.equal(popover2.style.width, '720px');

  ne.listeners.dblclick();
  assert.equal(popover.style.width, '');
  assert.equal(store.has(LOCATION_PANEL_STORAGE_KEY), false);
  remove();
  assert.equal(popover.children.length, 0);
});

test('a broken store or a missing tray is tolerated', () => {
  assert.equal(loadLocationPanelSize({ getItem: () => '{bad' }), null);
  assert.equal(loadLocationPanelSize({ getItem: () => JSON.stringify({ width: 'x' }) }), null);
  assert.doesNotThrow(() => bindLocationPanelResize({ popover: null })());
});
