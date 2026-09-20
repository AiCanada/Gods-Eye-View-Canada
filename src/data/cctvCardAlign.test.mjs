import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CCTV_ALIGN_COARSE_STEP_DEG,
  CCTV_ALIGN_STEP_DEG,
  bearingBetween,
  bindCctvCardAlign,
  turnedBearing,
} from './cctvCardAlign.js';
import { CCTV_ALIGN_ACCENT, CCTV_ALIGN_HINT, createCctvThumbnailOverlayEntry, createFrameSlot } from './cctvCards.js';
import {
  CCTV_THUMBNAIL_ALIGNMENTS_FILE,
  createThumbnailAlignmentStore,
  normalizeThumbnailAlignment,
  parseThumbnailAlignments,
  serializeThumbnailAlignments,
} from '../../server/providers/cctv/thumbnail-alignments.js';

test('bearings: between two points, and turned by a step', () => {
  assert.ok(Math.abs(bearingBetween(45, -73, 45.01, -73) - 0) < 0.01, 'due north');
  assert.ok(Math.abs(bearingBetween(45, -73, 45, -72.99) - 90) < 0.01, 'due east');
  assert.ok(Math.abs(bearingBetween(45, -73, 44.99, -73) - 180) < 0.01, 'due south');
  assert.ok(Math.abs(bearingBetween(45, -73, 45, -73.01) - 270) < 0.01, 'due west');
  assert.equal(turnedBearing(350, 15), 5);
  assert.equal(turnedBearing(3, -5), 358);
  assert.equal(turnedBearing(null, 2), 2);
  assert.equal(turnedBearing(10.04, 0), 10);
});

/** A stand-in for the globe canvas and its parent, recording listeners. */
function fakeStage() {
  const listeners = new Map();
  const container = {
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
    setPointerCapture() {},
    releasePointerCapture() {},
  };
  const canvas = { parentElement: container, getBoundingClientRect: () => ({ left: 0, top: 0 }) };
  const fire = (type, init = {}) => {
    const event = { button: 0, clientX: 0, clientY: 0, pointerId: 1, prevented: false, stopped: false, ...init };
    event.preventDefault = () => { event.prevented = true; };
    event.stopPropagation = () => { event.stopped = true; };
    listeners.get(type)?.(event);
    return event;
  };
  return { canvas, fire, listeners };
}

function alignHarness() {
  const stage = fakeStage();
  const state = { session: null, saved: 0, cancelled: 0, reset: 0, dragStarts: 0, dragEnds: 0 };
  // One card, 100 x 80, anchored at its picture centre (150, 130).
  const card = { entryId: 'cam-a', rect: { x: 100, y: 100, w: 100, h: 80, anchorX: 150, anchorY: 130 } };
  const inside = (x, y) => x >= 100 && x <= 200 && y >= 100 && y <= 180;
  const unbind = bindCctvCardAlign({
    canvas: stage.canvas,
    hitTest: (x, y) => (inside(x, y) ? card : null),
    getSession: () => state.session,
    begin: (id) => {
      state.session = { id, draft: { lat: 45, lon: -73, bearingDeg: null } };
      return true;
    },
    // 1 px = 0.00001 degrees, screen-down is south.
    pickGround: (x, y) => ({ lat: 45 - (y - 130) * 1e-5, lon: -73 + (x - 150) * 1e-5 }),
    screenUpBearing: () => 40,
    update: (patch) => { state.session.draft = { ...state.session.draft, ...patch }; },
    save: () => { state.saved += 1; state.session = null; },
    cancel: () => { state.cancelled += 1; state.session = null; },
    reset: () => { state.reset += 1; state.session = null; },
    onDragStart: () => { state.dragStarts += 1; },
    onDragEnd: () => { state.dragEnds += 1; },
  });
  const rightClick = (x, y) => {
    stage.fire('pointerdown', { button: 2, clientX: x, clientY: y });
    return stage.fire('contextmenu', { button: 2, clientX: x, clientY: y });
  };
  return { ...stage, state, unbind, rightClick };
}

test('right-click starts aligning, right-click on the same thumbnail saves', () => {
  const h = alignHarness();
  assert.equal(h.rightClick(400, 400).prevented, false, 'a right-click on the map is left to the globe');
  assert.equal(h.state.session, null);

  const start = h.rightClick(150, 130);
  assert.equal(start.prevented && start.stopped, true, 'no browser menu, and the globe never sees it');
  assert.equal(h.state.session.id, 'cam-a');

  h.rightClick(400, 400);
  assert.equal(h.state.saved, 0, 'a right-click elsewhere does not save');
  h.rightClick(160, 140);
  assert.equal(h.state.saved, 1);
  assert.equal(h.state.session, null);
});

test('a right-DRAG over a thumbnail (the globe\'s zoom) is never taken for a right-click', () => {
  const h = alignHarness();
  h.fire('pointerdown', { button: 2, clientX: 150, clientY: 130 });
  h.fire('contextmenu', { button: 2, clientX: 150, clientY: 170 });
  assert.equal(h.state.session, null);
});

test('dragging moves the thumbnail over the map, keeping the grab point under the pointer', () => {
  const h = alignHarness();
  h.rightClick(150, 130);
  // Grab 20 px right and 10 px below the anchor, drag 50 px right and 30 px down.
  h.fire('pointerdown', { clientX: 170, clientY: 140 });
  assert.equal(h.state.dragStarts, 1);
  h.fire('pointermove', { clientX: 172, clientY: 141 });
  assert.equal(h.state.session.draft.lon, -73, 'a twitch is not a drag');
  h.fire('pointermove', { clientX: 220, clientY: 170 });
  assert.ok(Math.abs(h.state.session.draft.lon - (-73 + 50e-5)) < 1e-9, 'the ANCHOR moved 50 px, not to the pointer');
  assert.ok(Math.abs(h.state.session.draft.lat - (45 - 30e-5)) < 1e-9);
  const up = h.fire('pointerup', { clientX: 220, clientY: 170 });
  assert.equal(up.stopped, true);
  assert.equal(h.state.dragEnds, 1);
  // Not aligning: the same drag is the globe's.
  h.state.session = null;
  assert.equal(h.fire('pointerdown', { clientX: 170, clientY: 140 }).stopped, false);
});

test('the wheel and the arrow keys turn it; the first turn starts from screen-up', () => {
  const h = alignHarness();
  assert.equal(h.fire('wheel', { clientX: 150, clientY: 130, deltaY: 100 }).stopped, false, 'not aligning: the wheel zooms the globe');
  h.rightClick(150, 130);
  const wheel = h.fire('wheel', { clientX: 150, clientY: 130, deltaY: 100 });
  assert.equal(wheel.prevented && wheel.stopped, true);
  assert.equal(h.state.session.draft.bearingDeg, 40 + CCTV_ALIGN_STEP_DEG);
  h.fire('wheel', { clientX: 150, clientY: 130, deltaY: -100, shiftKey: true });
  assert.equal(h.state.session.draft.bearingDeg, 40 + CCTV_ALIGN_STEP_DEG - CCTV_ALIGN_COARSE_STEP_DEG);
  assert.equal(h.fire('wheel', { clientX: 400, clientY: 400, deltaY: 100 }).stopped, false, 'off the thumbnail the wheel still zooms');
});

test('unbinding removes every listener', () => {
  const h = alignHarness();
  assert.ok(h.listeners.size >= 7);
  h.unbind();
  assert.equal(h.listeners.size, 0);
});

test('the thumbnail being aligned says so', () => {
  const base = { id: 'cam-a', position: { x: 1, y: 2, z: 3 }, title: 'Main & 5th', frameSlot: createFrameSlot() };
  const aligning = createCctvThumbnailOverlayEntry({ ...base, aligning: true });
  assert.equal(aligning.title, CCTV_ALIGN_HINT);
  assert.ok(CCTV_ALIGN_HINT.length <= 16, 'fits the title strip');
  assert.equal(aligning.accent, CCTV_ALIGN_ACCENT);
  assert.equal(createCctvThumbnailOverlayEntry(base).title, 'Main & 5th');
});

test('saved alignments: validated, written to the tracked config file, read back on the next run', () => {
  assert.deepEqual(normalizeThumbnailAlignment({ lat: 45.49003612, lon: -73.57652745, bearingDeg: 376.94 }), { lat: 45.490036, lon: -73.576527, bearingDeg: 16.9 });
  assert.deepEqual(normalizeThumbnailAlignment({ lat: 1, lon: 2, bearingDeg: null }), { lat: 1, lon: 2, bearingDeg: null });
  assert.deepEqual(normalizeThumbnailAlignment({ lat: 1, lon: 2 }), { lat: 1, lon: 2, bearingDeg: null });
  for (const bad of [null, {}, { lat: 91, lon: 0 }, { lat: 0, lon: 181 }, { lat: 'x', lon: 0 }, { lat: 0, lon: 0, bearingDeg: 'north' }]) {
    assert.equal(normalizeThumbnailAlignment(bad), null, JSON.stringify(bad));
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-align-'));
  try {
    const store = createThumbnailAlignmentStore({ sourceRoot: root });
    assert.deepEqual(store.all(), {});
    store.set('qc511-2', { lat: 2, lon: 3, bearingDeg: 10 });
    store.set('qc511-1', { lat: 1, lon: 2, bearingDeg: null });
    const text = fs.readFileSync(path.join(root, CCTV_THUMBNAIL_ALIGNMENTS_FILE), 'utf8');
    assert.ok(text.indexOf('qc511-1') < text.indexOf('qc511-2'), 'ids sorted: a save is a one-line diff');
    assert.equal(text.split('\n').filter((line) => line.includes('qc511-')).length, 2, 'one line per camera');
    // The next run is a fresh store over the same checkout.
    const next = createThumbnailAlignmentStore({ sourceRoot: root });
    assert.deepEqual(next.get('qc511-2'), { lat: 2, lon: 3, bearingDeg: 10 });
    assert.equal(next.remove('qc511-2'), true);
    assert.equal(next.remove('qc511-2'), false);
    assert.deepEqual(Object.keys(createThumbnailAlignmentStore({ sourceRoot: root }).all()), ['qc511-1']);
    assert.throws(() => next.set('../evil', { lat: 0, lon: 0, bearingDeg: null }), TypeError);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  // Junk in the file is dropped entry by entry, never trusted.
  const parsed = parseThumbnailAlignments({ alignments: { good: { lat: 1, lon: 1 }, 'bad id!': { lat: 1, lon: 1 }, broken: { lat: 'x' } } });
  assert.deepEqual([...parsed.keys()], ['good']);
  assert.deepEqual(JSON.parse(serializeThumbnailAlignments(new Map())).alignments, {});
});
