import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ENGLISH_HINT_DELAY_MS,
  createEnglishHintModel,
  installEnglishHint,
  textsAt,
} from './englishHint.js';

function harness({ texts = ['𓋴𓏠𓈖'], english = { '𓋴𓏠𓈖': 'Save' } } = {}) {
  const timers = new Map();
  let nextTimer = 1;
  const shown = [];
  let hides = 0;
  const model = createEnglishHintModel({
    textsAt: () => texts,
    englishFor: (text) => english[text],
    show: (hint) => shown.push(hint),
    hide: () => {
      hides += 1;
    },
    setTimer: (callback, ms) => {
      const id = nextTimer++;
      timers.set(id, { callback, ms });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
  });
  const elapse = () => {
    const due = [...timers.values()];
    timers.clear();
    for (const { callback } of due) callback();
  };
  return { model, timers, shown, elapse, hides: () => hides };
}

const mouse = (x, y, target = 'line') => ({
  x,
  y,
  target,
  pointerType: 'mouse',
});

test('the English shows after the mouse rests two seconds on the text', () => {
  assert.equal(ENGLISH_HINT_DELAY_MS, 2000);
  const page = harness();
  page.model.pointerMove(mouse(10, 20));
  assert.deepEqual(
    [...page.timers.values()].map((timer) => timer.ms),
    [2000],
  );
  assert.equal(page.shown.length, 0, 'nothing before the wait');
  page.elapse();
  assert.deepEqual(page.shown, [{ x: 10, y: 20, english: 'Save' }]);
  assert.equal(page.model.visible, true);
});

test("a resting hand's jitter keeps the wait; a real move starts it again", () => {
  const page = harness();
  page.model.pointerMove(mouse(10, 20));
  const [first] = page.timers.keys();
  page.model.pointerMove(mouse(13, 22));
  assert.deepEqual([...page.timers.keys()], [first]);
  page.model.pointerMove(mouse(40, 20));
  assert.equal(page.timers.size, 1);
  assert.notEqual([...page.timers.keys()][0], first);
  page.model.pointerMove(mouse(41, 20, 'another line'));
  assert.equal(page.timers.size, 1, 'a new element starts the wait again');
});

test('moving away, a click or a key hides the English', () => {
  const page = harness();
  page.model.pointerMove(mouse(10, 20));
  page.elapse();
  page.model.pointerMove(mouse(12, 21));
  assert.equal(page.model.visible, true, 'jitter keeps it');
  page.model.pointerMove(mouse(60, 20));
  assert.equal(page.model.visible, false);
  assert.equal(page.hides(), 1);
  page.elapse();
  page.model.dismiss();
  assert.equal(page.model.visible, false);
  assert.equal(page.hides(), 2);
  assert.equal(page.timers.size, 0);
});

test('touch and pen never show it', () => {
  const page = harness();
  for (const pointerType of ['touch', 'pen'])
    page.model.pointerMove({ x: 10, y: 20, target: 'line', pointerType });
  assert.equal(page.timers.size, 0);
});

test('English, and script with no known English, show nothing', () => {
  for (const texts of [['Save'], ['𓏏𓏏𓏏']]) {
    const page = harness({ texts });
    page.model.pointerMove(mouse(1, 1));
    page.elapse();
    assert.equal(page.shown.length, 0, texts[0]);
  }
});

test('the first text under the pointer that reads back wins', () => {
  const page = harness({ texts: ['𓏏𓏏𓏏', '𓋴𓏠𓈖'] });
  page.model.pointerMove(mouse(5, 5));
  page.elapse();
  assert.equal(page.shown[0].english, 'Save');
});

function element(
  tagName,
  { text = '', attributes = {}, parent = null, value = '', selected } = {},
) {
  return {
    nodeType: 1,
    tagName,
    textContent: text,
    value,
    parentElement: parent,
    selectedOptions: selected ? [{ textContent: selected }] : undefined,
    getAttribute: (name) => attributes[name] ?? null,
  };
}

test('textsAt: the line under the pointer first, then the text itself', () => {
  const line = element('SPAN', { text: '12 𓋴𓏠𓈖' });
  const node = { nodeType: 3, data: '𓋴𓏠𓈖', parentElement: line };
  const doc = {
    caretPositionFromPoint: () => ({ offsetNode: node }),
    createRange: () => ({
      selectNodeContents() {},
      getClientRects: () => [{ left: 0, right: 50, top: 0, bottom: 20 }],
    }),
  };
  assert.deepEqual(textsAt(doc, 10, 10, line), ['12 𓋴𓏠𓈖', '𓋴𓏠𓈖']);
  // Beside the letters, the element's own text stands in.
  assert.deepEqual(textsAt(doc, 100, 100, line), ['12 𓋴𓏠𓈖']);
});

test('textsAt: an empty field, a selected option and a tooltip count too', () => {
  const doc = {};
  const panel = element('DIV', { attributes: { title: '𓂋𓈖' } });
  const field = element('INPUT', {
    attributes: { placeholder: '𓋴𓏠𓈖' },
    parent: panel,
  });
  assert.deepEqual(textsAt(doc, 0, 0, field), ['𓋴𓏠𓈖', '𓂋𓈖']);
  field.value = 'typed';
  assert.deepEqual(textsAt(doc, 0, 0, field), ['𓂋𓈖']);
  const select = element('SELECT', { selected: '𓂧𓏇', parent: panel });
  assert.deepEqual(textsAt(doc, 0, 0, select), ['𓂧𓏇', '𓂋𓈖']);
});

function fakePage() {
  const listeners = [];
  const events = (name) => ({
    addEventListener: (type, handler) =>
      listeners.push({ name, type, handler }),
    removeEventListener: (type, handler) => {
      const at = listeners.findIndex(
        (listener) =>
          listener.name === name &&
          listener.type === type &&
          listener.handler === handler,
      );
      if (at >= 0) listeners.splice(at, 1);
    },
  });
  const appended = [];
  const doc = {
    ...events('document'),
    documentElement: events('html'),
    body: { append: (node) => appended.push(node) },
    createElement: (tagName) => {
      const node = {
        tagName,
        attributes: {},
        style: {},
        setAttribute(name, value) {
          this.attributes[name] = value;
        },
        remove() {
          appended.splice(appended.indexOf(node), 1);
        },
      };
      return node;
    },
  };
  const win = { ...events('window'), innerWidth: 1280, innerHeight: 800 };
  return { doc, win, listeners, appended };
}

test('installEnglishHint: only Ancient Egyptian and Inuktitut get it', () => {
  for (const locale of ['en', 'es', 'fr-CA', 'ru']) {
    const page = fakePage();
    assert.equal(
      installEnglishHint({ doc: page.doc, win: page.win, locale }),
      null,
    );
    assert.equal(page.listeners.length, 0, locale);
  }
  for (const locale of ['egy', 'iu']) {
    const page = fakePage();
    const hint = installEnglishHint({ doc: page.doc, win: page.win, locale });
    assert.ok(hint, locale);
    const [box] = page.appended;
    assert.equal(box.attributes.role, 'tooltip');
    assert.equal(box.lang, 'en');
    assert.equal(box.hidden, true);
    assert.equal(page.listeners.length, 7);
    hint.destroy();
    assert.equal(page.listeners.length, 0);
    assert.equal(page.appended.length, 0);
  }
});
