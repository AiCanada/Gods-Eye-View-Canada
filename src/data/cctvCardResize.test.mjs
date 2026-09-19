import test from 'node:test';
import assert from 'node:assert/strict';
import { cardResizeCorner, draggedCardScale, isCardResizeCorner } from './cctvCardResize.js';

const rect = { x: 100, y: 100, w: 104, h: 80 };

test('every corner of a thumbnail is a resize grip; the bottom-right one is still the size badge', () => {
  assert.equal(cardResizeCorner(rect, 102, 102), 'nw');
  assert.equal(cardResizeCorner(rect, 202, 102), 'ne');
  assert.equal(cardResizeCorner(rect, 102, 178), 'sw');
  assert.equal(cardResizeCorner(rect, 200, 176), 'se');
  assert.equal(isCardResizeCorner(rect, 200, 176), true);
  assert.equal(isCardResizeCorner(rect, 102, 102), false, 'only the badge steps the size on a click');
  assert.equal(cardResizeCorner(rect, 150, 140), null, 'the middle of the card still selects the camera');
  assert.equal(cardResizeCorner(rect, 150, 102), null, 'an edge is not a corner');
  assert.equal(cardResizeCorner(null, 1, 1), null);
});

test('pulling any corner away from the card grows it, pushing it in shrinks it', () => {
  const base = { startScale: 1, rect, startX: 0, startY: 0 };
  for (const [corner, x, y] of [['se', 52, 40], ['nw', -52, -40], ['ne', 52, -40], ['sw', -52, 40]]) {
    assert.equal(draggedCardScale({ ...base, corner, x, y }), 1.5, `${corner} outward`);
    assert.equal(draggedCardScale({ ...base, corner, x: -x / 2, y: -y / 2 }), 0.75, `${corner} inward`);
  }
  assert.equal(draggedCardScale({ ...base, x: 52, y: 40 }), 1.5, 'the badge is the default corner');
});
