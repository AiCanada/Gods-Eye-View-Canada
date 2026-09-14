import test from 'node:test';
import assert from 'node:assert/strict';
import { bindPrivateCameraMove, isPrivateCameraId } from './data/cctvPrivateMove.js';
import { applyPrivateCameraUpdate, movePrivateCamera, privateCameraSources } from './privateCamerasCore.mjs';

function stage() {
  const container = new EventTarget();
  const canvas = { parentElement: container, style: {}, getBoundingClientRect: () => ({ left: 0, top: 0 }) };
  const pointer = (type, x, y, extra = {}) => {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, { clientX: x, clientY: y, button: 0, pointerId: 1, ...extra });
    container.dispatchEvent(event);
    return event;
  };
  return { container, canvas, pointer };
}

test('only private camera ids are movable', () => {
  assert.equal(isPrivateCameraId('private-home--front'), true);
  assert.equal(isPrivateCameraId('on511-123'), false);
  assert.equal(isPrivateCameraId(null), false);
});

test('dragging a private icon previews and commits the spot; a click selects it', () => {
  const { canvas, pointer } = stage();
  const calls = [];
  bindPrivateCameraMove({
    canvas,
    pickCameraId: (x) => (x < 50 ? 'private-home--front' : 'on511-1'),
    globePoint: (x, y) => ({ lat: 45 + y / 1000, lon: -66 + x / 1000 }),
    onPreview: (id, point) => calls.push(['preview', id, point.lon]),
    onCommit: (id, point) => calls.push(['commit', id, point?.lon]),
    onSelect: (id) => calls.push(['select', id]),
  });

  const down = pointer('pointerdown', 10, 10);
  assert.equal(down.defaultPrevented, true, 'the globe does not pan');
  pointer('pointermove', 30, 20);
  pointer('pointerup', 30, 20);
  assert.deepEqual(calls, [
    ['preview', 'private-home--front', -65.97],
    ['commit', 'private-home--front', -65.97],
  ]);

  calls.length = 0;
  pointer('pointerdown', 10, 10);
  pointer('pointermove', 11, 11);
  pointer('pointerup', 11, 11);
  assert.deepEqual(calls, [['select', 'private-home--front']], 'a press that barely moves is a click');

  calls.length = 0;
  const publicPress = pointer('pointerdown', 80, 10);
  assert.equal(publicPress.defaultPrevented, false, 'public cameras are left to the globe');
  pointer('pointerup', 80, 10);
  assert.deepEqual(calls, []);
});

test('a press already claimed by the card size badge is left alone', () => {
  const { canvas, container, pointer } = stage();
  let picked = false;
  container.addEventListener('pointerdown', (event) => event.preventDefault(), true);
  bindPrivateCameraMove({ canvas, pickCameraId: () => { picked = true; return 'private-home--front'; }, globePoint: () => null });
  pointer('pointerdown', 10, 10);
  assert.equal(picked, false);
});

test('a moved camera keeps its spot through site saves until the site gets a new postal location', () => {
  const saved = applyPrivateCameraUpdate({
    kind: 'home',
    name: 'Home',
    postalCode: 'E2L 4S6',
    lat: 45.2733,
    lon: -66.0633,
    cameras: [
      { name: 'Front', source: 'camera.aarlo_front', headingDeg: 'S' },
      { name: 'Back Yard', source: 'camera.aarlo_back_yard', headingDeg: 'N' },
    ],
  });
  assert.equal(saved.ok, true, saved.error);
  const moved = movePrivateCamera(saved.config, 'private-home--front', 45.2801, -66.0702);
  assert.equal(moved.ok, true, moved.error);
  const front = () => privateCameraSources(current).find((source) => source.name === 'Front');
  let current = moved.config;
  assert.deepEqual([front().lat, front().lon], [45.2801, -66.0702], 'the dragged spot wins over the automatic spread');

  current = applyPrivateCameraUpdate({ kind: 'home', siteId: 'home', name: 'Home', postalCode: 'E2L 4S6', lat: 45.2733, lon: -66.0633, cameras: [{ id: 'front', name: 'Front', headingDeg: 'S' }, { id: 'back-yard', name: 'Back Yard', headingDeg: 'N' }] }, current).config;
  assert.deepEqual([front().lat, front().lon], [45.2801, -66.0702], 'saving the site again keeps the dragged spot');

  current = applyPrivateCameraUpdate({ kind: 'home', siteId: 'home', name: 'Home', postalCode: 'E2K 1A1', lat: 45.3, lon: -66.1, cameras: [{ id: 'front', name: 'Front', headingDeg: 'S' }, { id: 'back-yard', name: 'Back Yard', headingDeg: 'N' }] }, current).config;
  assert.ok(Math.abs(front().lat - 45.3) < 0.001, 'a new postal location re-spreads the cameras around it');

  assert.equal(movePrivateCamera(current, 'private-home--nope', 45, -66).ok, false);
  assert.equal(movePrivateCamera(current, 'private-home--front', 95, -66).ok, false);
});
