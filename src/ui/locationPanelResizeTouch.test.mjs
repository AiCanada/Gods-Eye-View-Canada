import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LOCATION_PANEL_STORAGE_KEY,
  bindLocationPanelResize,
} from './locationPanelResize.js';

/** Just enough of a page for the four corner grips. */
function tray() {
  const element = () => {
    const listeners = {};
    const style = {
      props: {},
      setProperty(k, v) {
        this.props[k] = v;
      },
      removeProperty(k) {
        delete this.props[k];
      },
    };
    return {
      listeners,
      style,
      dataset: {},
      children: [],
      classList: { add() {}, remove() {} },
      setAttribute() {},
      addEventListener(type, fn) {
        listeners[type] = fn;
      },
      removeEventListener(type) {
        delete listeners[type];
      },
      appendChild(child) {
        this.children.push(child);
        child.parent = this;
      },
      remove() {
        this.parent.children = this.parent.children.filter((c) => c !== this);
      },
      getBoundingClientRect: () => ({ width: 600, height: 200 }),
    };
  };
  const store = new Map();
  const storage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
  };
  const popover = element();
  bindLocationPanelResize({
    popover,
    pills: element(),
    doc: { createElement: element },
    storage,
  });
  const ne = popover.children.find((grip) => grip.dataset.corner === 'ne');
  const pointer = (type, x, y, timeStamp, pointerType = 'touch') =>
    ne.listeners[type]({
      type,
      button: 0,
      clientX: x,
      clientY: y,
      pointerId: 1,
      pointerType,
      timeStamp,
      preventDefault() {},
      stopPropagation() {},
    });
  const drag = (x, y, timeStamp, pointerType) => {
    pointer('pointerdown', 1000, 500, timeStamp, pointerType);
    pointer('pointermove', x, y, timeStamp, pointerType);
    pointer('pointerup', x, y, timeStamp, pointerType);
  };
  const tap = (timeStamp, pointerType) => {
    pointer('pointerdown', 1000, 500, timeStamp, pointerType);
    pointer('pointerup', 1002, 501, timeStamp + 60, pointerType);
  };
  return { popover, store, drag, tap };
}

test('a finger drags a corner to resize, and a double-tap on it resets the tray', () => {
  const t = tray();
  t.drag(1120, 380, 1000);
  assert.equal(t.popover.style.width, '720px');
  assert.equal(t.store.has(LOCATION_PANEL_STORAGE_KEY), true);

  t.tap(5000);
  t.tap(5700);
  assert.equal(t.popover.style.width, '720px', 'two slow taps are two taps');
  t.tap(9000);
  t.tap(9200);
  assert.equal(t.popover.style.width, '', 'reset');
  assert.equal(t.store.has(LOCATION_PANEL_STORAGE_KEY), false);
});

test('a drag between two taps is not a double-tap, and the mouse still uses dblclick', () => {
  const t = tray();
  t.drag(1120, 380, 1000);
  t.tap(2000);
  t.drag(1150, 360, 2100);
  t.tap(2200);
  assert.notEqual(t.popover.style.width, '', 'not reset');

  t.tap(4000, 'mouse');
  t.tap(4100, 'mouse');
  assert.notEqual(
    t.popover.style.width,
    '',
    'two mouse clicks wait for the dblclick, as before',
  );
});
