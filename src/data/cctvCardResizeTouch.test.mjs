import assert from 'node:assert/strict';
import test from 'node:test';
import { bindCctvCardResize } from './cctvCardResize.js';

/** The globe canvas and its parent, with one card whose badge is at its corner. */
function stage() {
  const listeners = new Map();
  const container = {
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
    setPointerCapture() {},
    releasePointerCapture() {},
  };
  const canvas = {
    parentElement: container,
    style: {},
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  };
  let scale = 1;
  const rect = () => ({ x: 100, y: 100, w: 104 * scale, h: 80 * scale });
  const inside = (x, y) => {
    const r = rect();
    return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  };
  const unbind = bindCctvCardResize({
    canvas,
    hitTest: (x, y) => (inside(x, y) ? { rect: rect() } : null),
    getScale: () => scale,
    setScale: (next) => {
      scale = next;
    },
    storage: null,
  });
  const fire = (type, init = {}) => {
    const event = {
      type,
      button: 0,
      pointerId: 1,
      prevented: false,
      ...init,
    };
    event.preventDefault = () => {
      event.prevented = true;
    };
    event.stopPropagation = () => {};
    listeners.get(type)?.(event);
    return event;
  };
  const tapBadge = (timeStamp, pointerType = 'touch') => {
    const at = { clientX: 200, clientY: 176, pointerType, timeStamp };
    fire('pointerdown', at);
    fire('pointerup', at);
  };
  return { fire, tapBadge, scale: () => scale, unbind };
}

test('a finger double-tap on the size badge steps once and never reaches the globe', () => {
  const s = stage();
  s.tapBadge(1000);
  const stepped = s.scale();
  assert.ok(stepped > 1, 'the first tap stepped the size, as a click does');
  // The card grew out from under the finger: the second tap lands on its
  // middle now, where it would select the camera.
  const at = { clientX: 200, clientY: 176, pointerType: 'touch' };
  const down = s.fire('pointerdown', { ...at, timeStamp: 1200 });
  assert.equal(down.prevented, true, 'the second tap is held back');
  assert.equal(s.fire('pointerup', { ...at, timeStamp: 1260 }).prevented, true);
  assert.equal(s.scale(), stepped, 'and is not another step');
  const dbl = s.fire('dblclick', { ...at, timeStamp: 1270 });
  assert.equal(dbl.prevented, true, 'the globe does not zoom');
  const later = s.fire('dblclick', {
    clientX: 600,
    clientY: 600,
    timeStamp: 5000,
  });
  assert.equal(later.prevented, false, 'a later double-tap is the globe’s');
  // A slow second tap, on the badge where it is now, is a tap: it steps.
  const corner = {
    clientX: 100 + 104 * stepped - 2,
    clientY: 100 + 80 * stepped - 2,
    pointerType: 'touch',
  };
  s.fire('pointerdown', { ...corner, timeStamp: 8000 });
  s.fire('pointerup', { ...corner, timeStamp: 8060 });
  assert.notEqual(s.scale(), stepped);
  s.unbind();
});

test('the mouse is as before: only a dblclick on the badge is held back', () => {
  const s = stage();
  s.tapBadge(1000, 'mouse');
  s.tapBadge(1200, 'mouse');
  const off = s.fire('dblclick', {
    clientX: 600,
    clientY: 600,
    timeStamp: 1210,
  });
  assert.equal(off.prevented, false);
  s.unbind();
});
