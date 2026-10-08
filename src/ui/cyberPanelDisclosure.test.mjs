import test from 'node:test';
import assert from 'node:assert/strict';
import { PanelChrome } from './panelChrome.js';

function fixture(theme = 'cyber') {
  const nodes = new Map();
  const node = (id, collapsed = true) => {
    const classes = new Set(collapsed ? ['collapsed'] : []);
    const value = { id, hidden: false, children: [],
      matches: () => true,
      contains(target) { return this === target || this.children.some((child) => child.contains(target)); },
      classList: {
        contains: (name) => classes.has(name),
        add: (...names) => names.forEach((name) => classes.add(name)),
        remove: (...names) => names.forEach((name) => classes.delete(name)),
        toggle: (name, on) => on ? classes.add(name) : classes.delete(name),
      },
    };
    nodes.set(id, value);
    return value;
  };
  const rail = node('rail');
  const display = node('pp-toggles'), context = node('global-context-panel'), cctv = node('cctv-panel'), radio = node('radio-panel');
  rail.children = [display, context, cctv];
  for (const panel of rail.children) panel.parentElement = rail;
  context.children = [radio];
  radio.parentElement = context;
  const saved = [], claimed = [];
  const owner = {
    _rightPanelStack: rail,
    _panelLayout: {},
    _lifetime: { frame() {} },
    _syncPanelCollapseButton() {}, _scheduleRightPanelLayout() {},
    _scheduleLeftPanelLayout() {}, _layoutRightPanels() {}, _syncCctvPanelViewport() {},
    _savePanelCollapsedState: (...args) => saved.push(args),
    shareLinkManager: { claimRestoreLane: (...args) => claimed.push(args), onPanelStateChange() {} },
  };
  owner.setPanelCollapsed = PanelChrome.prototype.setPanelCollapsed.bind(owner);
  return { display, context, cctv, radio, owner, saved, claimed,
    doc: { documentElement: { dataset: { uiTheme: theme } }, getElementById: (id) => nodes.get(id) },
  };
}

// Owner ruling, 2026-10-06: Cyber's side tabs behave as Tactical's, so
// opening one box leaves the others open.
test('explicit Cyber opening leaves the other open boxes open, as in Tactical', () => {
  const f = fixture(), prior = globalThis.document;
  globalThis.document = f.doc;
  try {
    f.owner.setPanelCollapsed('global-context-panel', false, { explicit: true });
    f.owner.setPanelCollapsed('pp-toggles', false, { explicit: true });
    assert.equal(f.display.classList.contains('collapsed'), false);
    assert.equal(f.context.classList.contains('collapsed'), false);
    assert.equal(
      f.saved.some(([id, collapsed]) => id === 'global-context-panel' && collapsed),
      false,
      'no peer is collapsed and saved closed',
    );
    // A box an older version collapsed for its accordion loses the mark.
    f.cctv.classList.add('cyber-accordion-collapsed');
    f.owner.setPanelCollapsed('cctv-panel', true, { explicit: true });
    assert.equal(f.cctv.classList.contains('cyber-accordion-collapsed'), false);
  } finally { globalThis.document = prior; }
});

// Owner ruling, 2026-09-27: Radio is the rail's last member, shown below the
// last tab when selected, not a section nested in Context. It is not one of
// the rail's boxes, so in Cyber it neither owns nor yields the accordion and
// opening it does not open Context.
test('Radio on the rail does not reveal Context in Cyber', () => {
  const f = fixture(), prior = globalThis.document;
  globalThis.document = f.doc;
  f.context.children = [];
  f.radio.parentElement = f.context.parentElement;
  f.context.parentElement.children.push(f.radio);
  try {
    f.owner.setPanelCollapsed('radio-panel', false, { explicit: true });
    f.owner.setPanelCollapsed('pp-toggles', false, { explicit: true });
    assert.equal(f.radio.classList.contains('collapsed'), false);
    assert.equal(f.context.classList.contains('collapsed'), true);
    f.owner.setPanelCollapsed('radio-panel', false, { explicit: true });
    assert.equal(f.context.classList.contains('collapsed'), true);
    assert.equal(f.display.classList.contains('collapsed'), false);
  } finally { globalThis.document = prior; }
});

test('non-Cyber explicit panels and restored preferences retain their existing policy', () => {
  for (const theme of ['tactical', 'operator', 'minimal', 'cyber']) {
    const f = fixture(theme), prior = globalThis.document;
    globalThis.document = f.doc;
    try {
      const options = theme === 'cyber' ? { restore: true, persist: false } : { explicit: true };
      f.owner.setPanelCollapsed('pp-toggles', false, options);
      f.owner.setPanelCollapsed('cctv-panel', false, options);
      assert.equal(f.display.classList.contains('collapsed'), false);
      assert.equal(f.cctv.classList.contains('collapsed'), false);
      if (theme === 'cyber') assert.deepEqual(f.saved, []);
    } finally { globalThis.document = prior; }
  }
});

test('opening a floating Cyber window leaves the docked rail panels open', () => {
  const f = fixture(), prior = globalThis.document;
  globalThis.document = f.doc;
  try {
    f.owner.setPanelCollapsed('pp-toggles', false, { explicit: true });
    f.cctv.classList.add('panel-floating');
    f.owner.setPanelCollapsed('cctv-panel', false, { explicit: true });
    assert.equal(f.cctv.classList.contains('collapsed'), false);
    assert.equal(f.display.classList.contains('collapsed'), false, 'DISPLAY stays open');
    assert.ok(!f.saved.some(([id, collapsed]) => id === 'pp-toggles' && collapsed));
  } finally { globalThis.document = prior; }
});
