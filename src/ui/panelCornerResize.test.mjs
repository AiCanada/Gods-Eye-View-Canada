import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  clampPanelSize,
  draggedPanelSize,
  installPanelCornerResize,
  keyedPanelSize,
  PANEL_SIZE_KEY_PREFIX,
  panelRoom,
  parseStoredPanelSize,
} from './panelCornerResize.js';

/** An element with what the resizer touches. */
function element(tag = 'div', { id = '', panelId = null, rect = null } = {}) {
  const listeners = new Map();
  const classes = new Set();
  const props = new Map();
  const attrs = new Map();
  const el = {
    tagName: tag.toUpperCase(),
    id,
    children: [],
    dataset: panelId ? { panelId } : {},
    listeners,
    classes,
    props,
    attrs,
    rect: rect || { left: 0, top: 0, right: 0, width: 0, height: 0 },
    style: {
      setProperty: (name, value) => props.set(name, value),
      removeProperty: (name) => props.delete(name),
      getPropertyValue: (name) => props.get(name) || '',
    },
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
      toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
    },
    set className(value) {
      classes.clear();
      for (const name of String(value).split(/\s+/).filter(Boolean))
        classes.add(name);
    },
    get className() {
      return [...classes].join(' ');
    },
    setAttribute: (name, value) => attrs.set(name, String(value)),
    getAttribute: (name) => attrs.get(name) ?? null,
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
    appendChild(child) {
      el.children.push(child);
      child.parentNode = el;
      return child;
    },
    remove() {
      const list = el.parentNode?.children;
      if (list) list.splice(list.indexOf(el), 1);
    },
    querySelector: (selector) =>
      selector === '.panel-title'
        ? { textContent: ` ${id.toUpperCase()} ` }
        : null,
    getBoundingClientRect: () => el.rect,
  };
  return el;
}

function page({ stored = {} } = {}) {
  const left = element('div', { id: 'left-panel-stack' });
  const right = element('div', { id: 'right-context-rail' });
  const ai = element('div', {
    id: 'ai-world-panel',
    panelId: 'ai-world-panel',
    rect: { left: 52, top: 268, right: 572, width: 520, height: 600 },
  });
  const data = element('div', {
    id: 'data-panel',
    panelId: 'data-panel',
    rect: { left: 1400, top: 200, right: 1700, width: 300, height: 400 },
  });
  left.children.push(ai, element('div', { id: 'not-a-box' }));
  right.children.push(data);
  const observers = [];
  const win = {
    innerWidth: 1707,
    innerHeight: 898,
    listeners: new Map(),
    addEventListener(type, fn) {
      this.listeners.set(type, fn);
    },
    removeEventListener(type) {
      this.listeners.delete(type);
    },
    MutationObserver: class {
      constructor(fn) {
        this.fn = fn;
        observers.push(this);
      }
      observe(target) {
        this.target ??= target;
        (this.targets ??= []).push(target);
      }
      disconnect() {
        this.disconnected = true;
      }
    },
  };
  const nodes = { 'left-panel-stack': left, 'right-context-rail': right };
  const document = {
    defaultView: win,
    getElementById: (id) => nodes[id] || null,
    createElement: (tag) => element(tag),
  };
  const storage = {
    map: new Map(Object.entries(stored)),
    getItem(key) {
      return this.map.has(key) ? this.map.get(key) : null;
    },
    setItem(key, value) {
      this.map.set(key, String(value));
    },
    removeItem(key) {
      this.map.delete(key);
    },
  };
  return { document, storage, win, left, right, ai, data, observers };
}

const gripOf = (panel) =>
  panel.children.find((child) => child.classes.has('panel-corner-resize'));
const fire = (grip, type, event = {}) =>
  grip.listeners.get(type)?.({
    preventDefault() {},
    stopPropagation() {},
    ...event,
  });

test('the numbers: a size stays on screen and above the floor; the free edge follows the pointer', () => {
  assert.deepEqual(
    clampPanelSize({ width: 9000, height: 50 }, { width: 800, height: 600 }),
    { width: 800, height: 160 },
  );
  assert.deepEqual(clampPanelSize(null, { width: 800, height: 600 }), {
    width: null,
    height: null,
  });
  assert.deepEqual(parseStoredPanelSize('{"width":400}'), {
    width: 400,
    height: null,
  });
  assert.equal(parseStoredPanelSize('nope'), null);
  assert.equal(parseStoredPanelSize('{"width":-1}'), null);
  const start = { width: 300, height: 400 };
  assert.deepEqual(draggedPanelSize(start, 50, 20, 'right'), {
    width: 350,
    height: 420,
  });
  assert.deepEqual(draggedPanelSize(start, -50, 20, 'left'), {
    width: 350,
    height: 420,
  });
  assert.deepEqual(keyedPanelSize('ArrowRight', start), {
    width: 320,
    height: 400,
  });
  assert.deepEqual(keyedPanelSize('ArrowLeft', start, { edge: 'left' }), {
    width: 320,
    height: 400,
  });
  assert.deepEqual(keyedPanelSize('ArrowDown', start, { big: true }), {
    width: 300,
    height: 480,
  });
  assert.equal(keyedPanelSize('Enter', start), null);
  assert.deepEqual(
    panelRoom(
      { left: 50, top: 100, right: 1700 },
      { width: 1707, height: 900 },
      'left',
    ),
    { width: 1692, height: 792 },
  );
});

test('every box in both rails gets a grip: bottom-right on the left, bottom-left on the right', () => {
  const p = page();
  const resize = installPanelCornerResize(p);
  const aiGrip = gripOf(p.ai);
  const dataGrip = gripOf(p.data);
  assert.ok(aiGrip.classes.has('panel-corner-resize-right'));
  assert.ok(dataGrip.classes.has('panel-corner-resize-left'));
  assert.equal(aiGrip.type, 'button');
  assert.match(aiGrip.attrs.get('aria-label'), /^Resize AI-WORLD-PANEL: drag/);
  assert.equal(resize.grips.size, 2, 'only boxes (data-panel-id) get one');
  resize.destroy();
  assert.equal(gripOf(p.ai), undefined, 'destroy takes the grips away');
  assert.ok(p.observers.every((o) => o.disconnected));
});

test('a left box grows right and down; a right box grows left; both are remembered', () => {
  const p = page();
  installPanelCornerResize(p);
  const aiGrip = gripOf(p.ai);
  fire(aiGrip, 'pointerdown', {
    button: 0,
    clientX: 560,
    clientY: 860,
    pointerId: 1,
  });
  assert.ok(p.ai.classes.has('panel-resizing-corner'));
  fire(aiGrip, 'pointermove', { clientX: 710, clientY: 760 });
  assert.equal(p.ai.props.get('--panel-user-width'), '670px');
  assert.equal(p.ai.props.get('--panel-user-height'), '500px');
  fire(aiGrip, 'pointerup');
  assert.ok(p.ai.classes.has('panel-user-wide'));
  assert.ok(p.ai.classes.has('panel-user-sized'));
  assert.equal(p.ai.classes.has('panel-resizing-corner'), false);
  assert.deepEqual(
    JSON.parse(p.storage.map.get(`${PANEL_SIZE_KEY_PREFIX}ai-world-panel`)),
    { width: 670, height: 500 },
  );
  // The right rail's box: dragging its bottom-left corner left widens it.
  const dataGrip = gripOf(p.data);
  fire(dataGrip, 'pointerdown', {
    button: 0,
    clientX: 1402,
    clientY: 598,
    pointerId: 2,
  });
  fire(dataGrip, 'pointermove', { clientX: 1302, clientY: 648 });
  assert.equal(p.data.props.get('--panel-user-width'), '400px');
  assert.equal(p.data.props.get('--panel-user-height'), '450px');
  fire(dataGrip, 'pointerup');
  // Never past its floor; the AI World box keeps its larger one.
  fire(aiGrip, 'pointerdown', {
    button: 0,
    clientX: 0,
    clientY: 0,
    pointerId: 1,
  });
  fire(aiGrip, 'pointermove', { clientX: -9000, clientY: -9000 });
  assert.equal(p.ai.props.get('--panel-user-width'), '360px');
  assert.equal(p.ai.props.get('--panel-user-height'), '240px');
  fire(aiGrip, 'pointerup');
  // A right button press is not a drag.
  fire(aiGrip, 'pointerdown', { button: 2, clientX: 0, clientY: 0 });
  assert.equal(p.ai.classes.has('panel-resizing-corner'), false);
});

test('arrow keys step the free edge, a double-click gives the box its own size back', () => {
  const p = page();
  installPanelCornerResize(p);
  const dataGrip = gripOf(p.data);
  fire(dataGrip, 'keydown', { key: 'ArrowLeft' });
  assert.equal(
    p.data.props.get('--panel-user-width'),
    '320px',
    'left widens a right-rail box',
  );
  fire(dataGrip, 'keydown', { key: 'ArrowDown', shiftKey: true });
  assert.equal(p.data.props.get('--panel-user-height'), '480px');
  const key = `${PANEL_SIZE_KEY_PREFIX}data-panel`;
  assert.ok(p.storage.map.has(key));
  fire(dataGrip, 'dblclick');
  assert.equal(p.data.props.size, 0);
  assert.equal(p.data.classes.has('panel-user-wide'), false);
  assert.equal(p.data.classes.has('panel-user-sized'), false);
  assert.equal(p.storage.map.has(key), false);
});

test('a stored size comes back on screen, a smaller window clamps it, a larger one restores it', () => {
  const p = page({
    stored: {
      [`${PANEL_SIZE_KEY_PREFIX}ai-world-panel`]: '{"width":800,"height":5000}',
    },
  });
  installPanelCornerResize(p);
  assert.equal(p.ai.props.get('--panel-user-width'), '800px');
  assert.equal(p.ai.props.get('--panel-user-height'), `${898 - 268 - 8}px`);
  p.win.innerWidth = 700;
  p.win.listeners.get('resize')();
  assert.equal(p.ai.props.get('--panel-user-width'), `${700 - 52 - 8}px`);
  p.win.innerWidth = 1707;
  p.win.listeners.get('resize')();
  assert.equal(
    p.ai.props.get('--panel-user-width'),
    '800px',
    'the size it was given',
  );
});

test('a box that joins a rail later gets its grip, on that rail’s side', () => {
  const p = page();
  installPanelCornerResize(p);
  const late = element('div', {
    id: 'street-level-panel',
    panelId: 'street-level-panel',
    rect: { left: 1400, top: 300, right: 1700, width: 300, height: 300 },
  });
  p.right.children.push(late);
  p.observers.find((o) => o.target === p.right).fn();
  assert.ok(gripOf(late).classes.has('panel-corner-resize-left'));
  // Moved to the left stack, its grip changes side.
  p.right.children.splice(p.right.children.indexOf(late), 1);
  p.left.children.push(late);
  p.observers.find((o) => o.target === p.left).fn();
  assert.ok(gripOf(late).classes.has('panel-corner-resize-right'));
  assert.equal(gripOf(late).classes.has('panel-corner-resize-left'), false);
});

test('the rules apply a set size on desktop widths only, keep floating windows out, and Cyber stays last', () => {
  const css = readFileSync(
    new URL('./styles/panel-resize.css', import.meta.url),
    'utf8',
  );
  const style = readFileSync(
    new URL('../../style.css', import.meta.url),
    'utf8',
  );
  const imports = [...style.matchAll(/@import '([^']+)'/g)].map((m) => m[1]);
  assert.ok(
    imports.indexOf('./src/ui/styles/panel-resize.css') <
      imports.indexOf('./src/ui/styles/cyber.css'),
  );
  assert.equal(imports.at(-1), './src/ui/styles/cyber.css');
  assert.match(css, /^\.panel-corner-resize \{\s*display: none;/m);
  const wide = css.slice(css.indexOf('@media (min-width: 721px)'));
  for (const rule of [
    /\.panel-user-wide:not\(\.collapsed\):not\(\.panel-floating\) \{\s*width: min\(var\(--panel-user-width\)/,
    /\.panel-user-sized:not\(\.collapsed\):not\(\.panel-floating\) \{\s*flex: 0 0 auto;\s*height: var\(--panel-user-height\);/,
    /> \[data-panel-id\]:not\(\.collapsed\):not\(\.panel-floating\)\s*> \.panel-corner-resize \{/,
    /\.panel-corner-resize\.panel-corner-resize-left \{\s*left: 2px;/,
  ])
    assert.match(wide, rule);
  for (const id of [
    'ask-panel',
    'ultra-panel',
    'social-panel',
    'outbreak-panel',
    'ai-world-panel',
    'pp-toggles',
    'data-panel',
    'street-level-panel',
    'global-context-panel',
    'sst-panel',
    'scene-panel',
  ])
    assert.ok(wide.includes(`#${id}`), id);
});

test('a closed box keeps its saved size to the window, and it is fitted again where the box opens', () => {
  const p = page({
    stored: {
      [`${PANEL_SIZE_KEY_PREFIX}ai-world-panel`]: '{"width":700,"height":5000}',
    },
  });
  p.ai.classes.add('collapsed');
  p.ai.rect = { left: 52, top: 860, right: 228, width: 176, height: 50 };
  installPanelCornerResize(p);
  assert.equal(
    p.ai.props.get('--panel-user-height'),
    `${898 - 16}px`,
    'not squeezed into the room under its tab',
  );
  // It opens higher up: its size is fitted to where it is now.
  p.ai.classes.delete('collapsed');
  p.ai.rect = { left: 52, top: 268, right: 752, width: 700, height: 600 };
  const opening = p.observers.find(
    (o) => o.targets?.includes(p.ai) && o.target !== p.left,
  );
  opening.fn([{ target: p.ai }]);
  assert.equal(p.ai.props.get('--panel-user-height'), `${898 - 268 - 8}px`);
  assert.equal(p.ai.props.get('--panel-user-width'), '700px');
});
