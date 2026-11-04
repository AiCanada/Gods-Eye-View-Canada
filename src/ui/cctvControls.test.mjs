import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CctvControls } from './cctvControls.js';
import { cctvAreaChip } from './cctvPresentation.js';

function element() {
  const classes = new Set();
  return {
    dataset: {},
    src: '',
    removeAttribute(name) {
      if (name === 'src') this.src = '';
    },
    classList: {
      add(...values) {
        values.forEach((value) => classes.add(value));
      },
      remove(...values) {
        values.forEach((value) => classes.delete(value));
      },
      contains(value) {
        return classes.has(value);
      },
      toggle(value, enabled) {
        if (enabled) classes.add(value);
        else classes.delete(value);
      },
    },
  };
}
function fixture(t) {
  const prior = globalThis.Image;
  const requests = [];
  globalThis.Image = class {
    constructor() {
      requests.push(this);
    }
  };
  t.after(() => {
    globalThis.Image = prior;
  });
  const controls = new CctvControls({
    elements: { _cctvFrame: element(), _cctvFrameWrap: element() },
    cctv: {},
    actions: { isEnabled: () => true },
  });
  t.after(() => controls.destroy());
  return { controls, requests };
}

test('a late image completion cannot replace a newer camera preview', (t) => {
  const { controls, requests } = fixture(t);
  controls._queueCctvFrame('first.jpg', 'a', true);
  const stale = requests[0].onload;
  controls._queueCctvFrame('second.jpg', 'b', true);
  assert.equal(requests[0].onload, null);
  requests[1].onload();
  stale();
  assert.equal(controls._frame.src, 'second.jpg');
  assert.equal(controls._frame.cameraId, 'b');
});

test('the panel preview requests nothing while the tab is hidden', (t) => {
  const { controls, requests } = fixture(t);
  const prior = globalThis.document;
  globalThis.document = { hidden: true };
  t.after(() => {
    globalThis.document = prior;
  });
  controls._queueCctvFrame('first.jpg', 'a', true);
  assert.equal(requests.length, 0);
  assert.equal(controls._frame.cameraId, '');
  globalThis.document.hidden = false;
  controls._queueCctvFrame('first.jpg', 'a', true);
  assert.equal(requests.length, 1);
});

test('the area chip names the loaded area, its cap and the cameras held back', (t) => {
  assert.equal(cctvAreaChip(null).text, 'AREA --');
  assert.equal(cctvAreaChip({ ready: false }).text, 'AREA --');
  assert.equal(
    cctvAreaChip({ loading: true, ready: true, capped: true }).text,
    'AREA LOADING',
  );
  assert.equal(
    cctvAreaChip({ ready: true, radiusKm: 50, limit: 1000, loaded: 234 }).text,
    'AREA 50 KM · 234 CAMERAS',
  );
  const capped = {
    ready: true,
    radiusKm: 50,
    limit: 1000,
    loaded: 1000,
    dropped: 317,
    capped: true,
  };
  assert.equal(
    cctvAreaChip(capped).text,
    'AREA 50 KM · 1,000 CAP · 317 MORE NEARBY',
  );

  const { controls } = fixture(t);
  const chip = {
    dataset: {},
    textContent: '',
    title: '',
    attributes: {},
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
  };
  controls._cctvRegionCapChip = chip;
  controls._renderCctvState({ enabled: true, area: capped, cameras: [] });
  assert.equal(chip.textContent, 'AREA 50 KM · 1,000 CAP · 317 MORE NEARBY');
  assert.equal(chip.dataset.over, 'true');
  assert.match(chip.attributes['aria-label'], /317 more within 50 km/);
  controls._renderCctvState({
    enabled: true,
    area: { ...capped, capped: false, dropped: 0, loaded: 12 },
    cameras: [],
  });
  assert.equal(chip.textContent, 'AREA 50 KM · 12 CAMERAS');
  assert.equal(chip.dataset.over, 'false');
});

test('NEAREST stays usable with the layer on and no cameras loaded; PREV, NEXT, FOCUS and the list need cameras', (t) => {
  const { controls } = fixture(t);
  controls.actions.setPanelCollapsed = () => {};
  // The picker asks what has focus; nothing does here.
  const prior = globalThis.document;
  globalThis.document = { activeElement: null, hidden: false };
  t.after(() => {
    globalThis.document = prior;
  });
  controls._cctvSelect = {};
  // The panel view draws NEAREST, PREV, NEXT and FOCUS from what this
  // publishes (src/ui/views/panels/CctvPanel.vue), and the list from the
  // picker.
  const buttons = () => {
    const { nearestDisabled, navDisabled, focusDisabled } = controls.store.view;
    return [nearestDisabled, navDisabled, navDisabled, focusDisabled];
  };

  // An empty area: NEAREST is how the panel re-centres it on the view.
  controls._renderCctvState({ enabled: true, cameras: [] });
  assert.deepEqual(buttons(), [false, true, true, true]);
  assert.equal(controls.store.picker.disabled, true);

  controls._renderCctvState({
    enabled: true,
    cameras: [{ id: 'a', city: 'Test', name: 'A' }],
    activeCameraId: 'a',
  });
  assert.deepEqual(buttons(), [false, false, false, false]);
  assert.equal(controls.store.picker.disabled, false);

  controls._renderCctvState({ enabled: false, cameras: [] });
  assert.deepEqual(buttons(), [true, true, true, true]);
  assert.equal(controls.store.picker.disabled, true);
});

test('failed refresh preserves settled pixels, but changing cameras clears them', (t) => {
  const { controls, requests } = fixture(t);
  controls._queueCctvFrame('first.jpg', 'a', true);
  requests[0].onload();
  controls._queueCctvFrame('refresh.jpg', 'a', false);
  requests[1].onerror();
  assert.equal(controls._frame.src, 'first.jpg');
  assert.equal(controls._frame.hasFrame, true);
  controls._queueCctvFrame('other.jpg', 'b', true);
  assert.equal(controls._frame.src, '');
  assert.equal(controls._frame.hasFrame, false);
});

test('destroy invalidates image callbacks and releases each subscription once', (t) => {
  const { controls, requests } = fixture(t);
  let unsubscribed = 0;
  controls.cctv.subscribe = () => () => {
    unsubscribed++;
  };
  controls.connect();
  controls.connect();
  assert.equal(unsubscribed, 1);
  controls._queueCctvFrame('first.jpg', 'a', true);
  const late = requests[0].onload;
  controls.destroy();
  controls.destroy();
  controls.connect();
  late();
  assert.equal(unsubscribed, 2);
  assert.equal(requests[0].onload, null);
  assert.equal(requests[0].onerror, null);
  assert.equal(controls._frame.src, '');
  controls._queueCctvFrame('late.jpg', 'b', true);
  assert.equal(requests.length, 1);
});

test('disposing during camera enable prevents the delayed focus and future clicks', async () => {
  const button = new EventTarget();
  let resolveEnable;
  let enables = 0;
  let focuses = 0;
  const controls = new CctvControls({
    elements: { _cctvPanel: {}, _cctvNextBtn: button },
    cctv: {},
    actions: {
      isEnabled: () => true,
      syncViewport() {},
      toggleEnabled() {
        enables++;
        return new Promise((resolve) => {
          resolveEnable = resolve;
        });
      },
      runExplicitFocus() {
        focuses++;
      },
    },
  });
  button.dispatchEvent(new Event('click'));
  controls.destroy();
  resolveEnable(true);
  await new Promise((resolve) => setImmediate(resolve));
  button.dispatchEvent(new Event('click'));
  assert.equal(enables, 1);
  assert.equal(focuses, 0);
});
