import test from 'node:test';
import assert from 'node:assert/strict';
import { bindCctvCardAlign } from './cctvCardAlign.js';

/** The globe canvas and its parent, recording one listener per type. */
function harness(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const listeners = new Map();
  const container = {
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
    setPointerCapture() {},
    releasePointerCapture() {},
  };
  const canvas = {
    parentElement: container,
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  };
  const fire = (type, init = {}) => {
    const event = {
      type,
      button: 0,
      clientX: 0,
      clientY: 0,
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
  const finger = (type, id, x, y, extra = {}) =>
    fire(type, {
      pointerType: 'touch',
      pointerId: id,
      isPrimary: id === 1,
      clientX: x,
      clientY: y,
      ...extra,
    });
  const state = { session: null, saved: 0, cancelled: 0, reset: 0, ends: 0 };
  // One card, 100 x 80, anchored at its picture centre (150, 130).
  const card = {
    entryId: 'cam-a',
    rect: { x: 100, y: 100, w: 100, h: 80, anchorX: 150, anchorY: 130 },
  };
  const inside = (x, y) => x >= 100 && x <= 200 && y >= 100 && y <= 180;
  const unbind = bindCctvCardAlign({
    canvas,
    hitTest: (x, y) => (inside(x, y) ? card : null),
    getSession: () => state.session,
    begin: (id) => {
      state.session = { id, draft: { lat: 45, lon: -73, bearingDeg: null } };
      return true;
    },
    pickGround: (x, y) => ({
      lat: 45 - (y - 130) * 1e-5,
      lon: -73 + (x - 150) * 1e-5,
    }),
    screenUpBearing: () => 40,
    update: (patch) => {
      state.session.draft = { ...state.session.draft, ...patch };
    },
    save: () => {
      state.saved += 1;
      state.session = null;
    },
    cancel: () => {
      state.cancelled += 1;
      state.session = null;
    },
    reset: () => {
      state.reset += 1;
      state.session = null;
    },
    onDragEnd: () => {
      state.ends += 1;
    },
  });
  t.after(unbind);
  // A long press on a thumbnail reaches the page as a right-click.
  const longPressStart = () =>
    fire('contextmenu', { button: 2, clientX: 150, clientY: 130 });
  return { fire, finger, state, longPressStart };
}

test('a long press starts aligning, and a second long press on the thumbnail saves', (t) => {
  const h = harness(t);
  h.longPressStart();
  assert.equal(h.state.session.id, 'cam-a');
  h.finger('pointerdown', 1, 150, 130);
  t.mock.timers.tick(499);
  assert.equal(h.state.saved, 0);
  t.mock.timers.tick(1);
  assert.equal(h.state.saved, 1);
  // The browser's own long-press menu that follows is not a new start.
  const menu = h.fire('contextmenu', { button: 2, clientX: 150, clientY: 130 });
  assert.equal(menu.prevented, true);
  assert.equal(h.state.session, null, 'not started again');
  h.finger('pointerup', 1, 150, 130);
  assert.equal(h.state.ends, 1);
});

test('one finger moves the thumbnail without saving it', (t) => {
  const h = harness(t);
  h.longPressStart();
  h.finger('pointerdown', 1, 150, 130);
  h.finger('pointermove', 1, 190, 130);
  t.mock.timers.tick(1000);
  assert.equal(h.state.saved, 0, 'a moving finger is a drag, not a long press');
  assert.ok(Math.abs(h.state.session.draft.lon - (-73 + 40e-5)) < 1e-9);
  h.finger('pointerup', 1, 190, 130);
  assert.equal(h.state.cancelled, 0);
});

test('a second finger twisted round the first turns the thumbnail', (t) => {
  const h = harness(t);
  h.longPressStart();
  h.finger('pointerdown', 1, 150, 130);
  const second = h.finger('pointerdown', 2, 250, 130);
  assert.equal(second.prevented, true, 'the globe does not pinch');
  // A quarter turn clockwise on the screen.
  const twist = h.finger('pointermove', 2, 150, 230);
  assert.equal(twist.prevented, true);
  assert.equal(h.state.session.draft.bearingDeg, 130, 'from screen-up 40, +90');
  assert.equal(h.state.session.draft.lat, 45, 'turning does not move it');
  h.finger('pointermove', 2, 250, 130);
  assert.equal(h.state.session.draft.bearingDeg, 40, 'and back');
  t.mock.timers.tick(1000);
  assert.equal(h.state.saved, 0, 'two fingers never save');
  assert.equal(h.finger('pointerup', 2, 250, 130).prevented, true);
  h.finger('pointerup', 1, 150, 130);
  assert.equal(h.state.ends, 1);
  assert.ok(h.state.session, 'still aligning');
});

test('a three-finger tap forgets the alignment; a three-finger swipe does not', (t) => {
  const h = harness(t);
  h.longPressStart();
  h.finger('pointerdown', 1, 400, 400);
  h.finger('pointerdown', 2, 430, 400);
  assert.equal(h.finger('pointerdown', 3, 460, 400).prevented, true);
  h.finger('pointermove', 3, 470, 300);
  for (const id of [1, 2, 3]) h.finger('pointerup', id, 400, 400);
  assert.equal(h.state.reset, 0, 'a swipe');

  h.finger('pointerdown', 1, 400, 400);
  h.finger('pointerdown', 2, 430, 400);
  h.finger('pointerdown', 3, 460, 400);
  h.finger('pointerup', 3, 460, 400);
  h.finger('pointerup', 2, 430, 400);
  h.finger('pointerup', 1, 400, 400);
  assert.equal(h.state.reset, 1);
  assert.equal(h.state.cancelled, 0, 'the last finger up is not a tap off');
});

test('a tap off the thumbnail cancels; a swipe off it, or a tap on it, does not', (t) => {
  const h = harness(t);
  h.longPressStart();
  h.finger('pointerdown', 1, 400, 400);
  h.finger('pointermove', 1, 460, 400);
  h.finger('pointerup', 1, 460, 400);
  assert.equal(h.state.cancelled, 0, 'a swipe pans the globe');
  h.finger('pointerdown', 1, 150, 130);
  h.finger('pointerup', 1, 150, 130);
  assert.equal(h.state.cancelled, 0);
  h.finger('pointerdown', 1, 400, 400);
  const up = h.finger('pointerup', 1, 401, 400);
  assert.equal(h.state.cancelled, 1);
  assert.equal(up.prevented, false, 'the globe still sees its tap');
});

test('the mouse is left exactly as it was', (t) => {
  const h = harness(t);
  h.fire('pointerdown', { button: 2, clientX: 150, clientY: 130 });
  h.fire('contextmenu', { button: 2, clientX: 150, clientY: 130 });
  h.fire('pointerdown', { pointerType: 'mouse', clientX: 400, clientY: 400 });
  h.fire('pointerup', { pointerType: 'mouse', clientX: 400, clientY: 400 });
  assert.equal(h.state.cancelled, 0, 'a click off it does not cancel');
  h.fire('pointerdown', { pointerType: 'mouse', clientX: 150, clientY: 130 });
  t.mock.timers.tick(1000);
  assert.equal(h.state.saved, 0, 'holding the mouse does not save');
  h.fire('pointerup', { pointerType: 'mouse', clientX: 150, clientY: 130 });
  h.fire('pointerdown', { button: 2, clientX: 150, clientY: 130 });
  h.fire('contextmenu', { button: 2, clientX: 150, clientY: 130 });
  assert.equal(h.state.saved, 1, 'the second right-click saves');
});
