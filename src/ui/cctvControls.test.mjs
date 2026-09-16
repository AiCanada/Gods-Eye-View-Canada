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
  assert.equal(controls._cctvFrame.src, 'second.jpg');
  assert.equal(controls._cctvFrame.dataset.cameraId, 'b');
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
  assert.equal(controls._cctvFrame.dataset.cameraId, '');
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
  const nearest = { disabled: true };
  const prev = { disabled: false };
  const next = { disabled: false };
  const focus = { disabled: false };
  const select = { options: [], disabled: false, selectedIndex: 0 };
  Object.assign(controls, {
    _cctvNearestBtn: nearest,
    _cctvPrevBtn: prev,
    _cctvNextBtn: next,
    _cctvFocusBtn: focus,
    _cctvSelect: select,
  });

  // An empty area: NEAREST is how the panel re-centres it on the view.
  controls._renderCctvState({ enabled: true, cameras: [] });
  assert.equal(nearest.disabled, false);
  assert.deepEqual(
    [prev.disabled, next.disabled, focus.disabled, select.disabled],
    [true, true, true, true],
  );

  controls._cctvSelect = null;
  controls._renderCctvState({
    enabled: true,
    cameras: [{ id: 'a', city: 'Test', name: 'A' }],
    activeCameraId: 'a',
  });
  assert.deepEqual(
    [nearest.disabled, prev.disabled, next.disabled, focus.disabled],
    [false, false, false, false],
  );

  controls._renderCctvState({ enabled: false, cameras: [] });
  assert.deepEqual(
    [nearest.disabled, prev.disabled, next.disabled, focus.disabled],
    [true, true, true, true],
  );
});

test('failed refresh preserves settled pixels, but changing cameras clears them', (t) => {
  const { controls, requests } = fixture(t);
  controls._queueCctvFrame('first.jpg', 'a', true);
  requests[0].onload();
  controls._queueCctvFrame('refresh.jpg', 'a', false);
  requests[1].onerror();
  assert.equal(controls._cctvFrame.src, 'first.jpg');
  assert.equal(controls._cctvFrameWrap.classList.contains('has-frame'), true);
  controls._queueCctvFrame('other.jpg', 'b', true);
  assert.equal(controls._cctvFrame.src, '');
  assert.equal(controls._cctvFrameWrap.classList.contains('has-frame'), false);
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
  assert.equal(controls._cctvFrame.src, '');
  controls._queueCctvFrame('late.jpg', 'b', true);
  assert.equal(requests.length, 1);
});

function calibrationFixture(t) {
  const { controls } = fixture(t);
  const prior = globalThis.document;
  const inputs = [];
  globalThis.document = {
    createElement() {
      const input = new EventTarget();
      Object.assign(input, {
        focus() {},
        select() {},
        remove() {
          this.parent.input = null;
        },
      });
      inputs.push(input);
      return input;
    },
  };
  t.after(() => {
    globalThis.document = prior;
  });
  const chip = {
    dataset: { calField: 'heading' },
    textContent: '',
    input: null,
    appendChild(input) {
      this.input = input;
      input.parent = this;
    },
    querySelector() {
      return this.input;
    },
  };
  const patches = [];
  controls.actions.setParams = (params) => patches.push(params);
  controls.actions.setPanelCollapsed = () => {};
  controls._cctvCalReadout = { querySelectorAll: () => [chip] };
  controls._cctvState = {
    enabled: true,
    activeCameraId: 'a',
    activeCamera: { id: 'a', headingDeg: 30, basePose: { headingDeg: 20 } },
  };
  const key = (name) =>
    Object.assign(new Event('keydown', { cancelable: true }), { key: name });
  return { controls, chip, inputs, patches, key };
}

test('calibration commits against the captured camera base and releases its editor', (t) => {
  const { controls, chip, inputs, patches, key } = calibrationFixture(t);
  controls._beginCctvCalValueEdit(chip);
  inputs[0].value = '100';
  controls._cctvState.activeCamera.basePose.headingDeg = 60;
  inputs[0].dispatchEvent(key('Enter'));
  inputs[0].dispatchEvent(new Event('blur'));
  assert.deepEqual(patches, [
    {
      selectedCameraId: 'a',
      calibration: { cameraId: 'a', patch: { headingDeg: 80 } },
    },
  ]);
  assert.equal(controls._calibrationEdit, null);
});

test('a camera switch cancels calibration before old blur can change the new camera', (t) => {
  const { controls, chip, inputs, patches } = calibrationFixture(t);
  controls._beginCctvCalValueEdit(chip);
  inputs[0].value = '100';
  controls._renderCctvState({
    enabled: true,
    activeCameraId: 'b',
    activeCamera: { id: 'b', headingDeg: 200, basePose: { headingDeg: 190 } },
  });
  inputs[0].dispatchEvent(new Event('blur'));
  assert.deepEqual(patches, []);
  assert.equal(chip.input, null);
  assert.equal(chip.textContent, 'HDG 200.0°');
});

test('Escape claims calibration cancellation and disposal prevents late commits', (t) => {
  const { controls, chip, inputs, patches, key } = calibrationFixture(t);
  controls._beginCctvCalValueEdit(chip);
  inputs[0].value = '100';
  const escape = key('Escape');
  inputs[0].dispatchEvent(escape);
  inputs[0].dispatchEvent(new Event('blur'));
  assert.equal(escape.defaultPrevented, true);
  controls._beginCctvCalValueEdit(chip);
  inputs[1].value = '120';
  controls.destroy();
  inputs[1].dispatchEvent(new Event('blur'));
  assert.deepEqual(patches, []);
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
