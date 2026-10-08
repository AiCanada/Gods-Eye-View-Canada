import { readStylesheet } from '../testSupport/readStylesheet.mjs';
import { displayPanelScroller } from './displayPanelScroll.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  capturePanelScroll,
  restorePanelScroll,
  layoutLeftPanelRail,
  layoutRightPanelRail,
  measurePanelNaturalHeight,
} from './panelRails.js';

test('Display uses an inner scroll body only in Cyber', () => {
  const body = { scrollTop: 95 };
  const panel = {
    ownerDocument: { documentElement: { dataset: { uiTheme: 'cyber' } } },
    querySelector: () => body,
  };
  assert.equal(displayPanelScroller(panel), body);
  panel.ownerDocument.documentElement.dataset.uiTheme = 'tactical';
  assert.equal(displayPanelScroller(panel), panel);
  assert.equal(displayPanelScroller(null), null);
});

// Owner ruling, 2026-10-06: Cyber's side tabs behave as Tactical's, with no
// one-box accordion; a box an older version collapsed for it opens again.
test('Cyber keeps every open box open and reopens boxes the old accordion collapsed', () => {
  for (const mobile of [false, true]) {
    const f = fixture('right', {
      mobile,
      hud: { visible: true, variant: 'cyber' },
    });
    f.expand(f.first, 250);
    f.expand(f.second, 250);
    f.options.preferredPanelId = f.second.id;
    f.run();
    assert.equal(f.first.classList.contains('collapsed'), false);
    assert.equal(f.second.classList.contains('collapsed'), false);
    f.first.classList.add('collapsed', 'cyber-accordion-collapsed');
    f.run();
    assert.equal(f.first.classList.contains('collapsed'), false);
    assert.equal(
      f.first.classList.contains('cyber-accordion-collapsed'),
      false,
    );
  }
});

function element(
  id,
  { height = 42, top = 234, left = 20, width = 272, collapsed = false } = {},
) {
  const classes = new Set(collapsed ? ['collapsed'] : []);
  const properties = new Map();
  const attributes = new Map();
  const writes = [];
  const node = {
    id,
    children: [],
    dataset: {},
    parentElement: null,
    scrollHeight: height,
    clientHeight: height,
    scrollTop: 0,
    computed: {
      display: 'block',
      visibility: 'visible',
      opacity: '1',
      rowGap: '12px',
    },
    rect: {
      top,
      left,
      width,
      height,
      right: left + width,
      bottom: top + height,
    },
    classList: {
      contains: (name) => classes.has(name),
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      toggle(name, value) {
        if (value) classes.add(name);
        else classes.delete(name);
      },
    },
    style: {
      setProperty(name, value) {
        writes.push(['set', name, value]);
        properties.set(name, value);
      },
      getPropertyValue: (name) => properties.get(name) || '',
      removeProperty(name) {
        writes.push(['remove', name]);
        properties.delete(name);
      },
    },
    getBoundingClientRect() {
      return this.rect;
    },
    matches: (selector) =>
      selector === '[data-panel-id]' ||
      (selector === '[data-panel-id]:not(.panel-floating)' &&
        !classes.has('panel-floating')),
    contains(target) {
      return (
        target === this || this.children.some((child) => child.contains(target))
      );
    },
    querySelectorAll() {
      return this.children;
    },
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: (name) => attributes.delete(name),
    getAttribute: (name) => attributes.get(name),
    writes,
  };
  return node;
}
function fixture(
  side,
  { mobile = false, hud = { visible: true, variant: 'tactical' } } = {},
) {
  const first = element('first', { height: 42, collapsed: true });
  const second = element('second', { height: 42, collapsed: true });
  const stack = element('rail', {
    height: 96,
    left: side === 'left' ? 20 : 1100,
  });
  stack.children = [first, second];
  first.parentElement = second.parentElement = stack;
  const documentRef = { activeElement: null };
  stack.ownerDocument = documentRef;
  const collapsed = [];
  let retries = 0,
    aligned = 0;
  const options = {
    stack,
    hud,
    documentRef,
    obstacles: [],
    collapsedHeights: new Map(),
    windowRef: {
      innerHeight: 900,
      matchMedia: () => ({ matches: mobile }),
      getComputedStyle: (node) => node.computed,
    },
    onCollapse: (panel) => collapsed.push(panel.id),
    onRetry: () => {
      retries += 1;
    },
    onAligned: () => {
      aligned += 1;
    },
    displayPanel: null,
    readDisplayScrollTop: () => 0,
    leftStack: element('left'),
  };
  const run = () =>
    (side === 'left' ? layoutLeftPanelRail : layoutRightPanelRail)(options);
  const expand = (panel, height) => {
    panel.classList.remove('collapsed');
    panel.scrollHeight = height;
    panel.rect.height = height;
    panel.rect.bottom = panel.rect.top + height;
  };
  return {
    options,
    first,
    second,
    stack,
    run,
    expand,
    collapsed,
    retries: () => retries,
    aligned: () => aligned,
  };
}

test('missing rails are inert without browser globals', () => {
  layoutLeftPanelRail({});
  layoutRightPanelRail({});
});

test('left layout records collapsed heights and aligns the right rail without changing disclosure', () => {
  const f = fixture('left');
  f.run();
  assert.equal(f.options.collapsedHeights.get('first'), 42);
  assert.equal(f.first.classList.contains('collapsed'), true);
  assert.equal(f.aligned(), 1);
  assert.equal(f.retries(), 0);
  assert.equal(f.stack.dataset.layoutMode, 'normal');
});

test('left corridor respects a lower obstacle but ignores an obstacle hidden by its parent', () => {
  const f = fixture('left');
  const blocker = element('blocker', { top: 600, height: 80 });
  const hidden = element('hidden', { top: 300, height: 80 });
  hidden.parentElement = element('hidden-parent');
  hidden.parentElement.computed.opacity = '0';
  f.options.obstacles = [blocker, hidden];
  f.run();
  assert.equal(Number(f.stack.dataset.safeBottomPct), 65.47);
});

for (const side of ['left', 'right']) {
  test(`${side} mobile layout releases desktop height/position styles and labels`, () => {
    const f = fixture(side, { mobile: true });
    f.stack.classList.add('layout-focus');
    f.stack.classList.add('layout-overlap');
    f.stack.style.setProperty(`--${side}-stack-safe-top`, '300px');
    f.first.style.setProperty(`--${side}-panel-allocated-height`, '99px');
    f.first.style.setProperty('--panel-overlap-top', '120px');
    f.first.setAttribute('aria-hidden', 'true');
    f.run();
    assert.equal(f.stack.dataset.layoutMode, 'mobile');
    assert.equal(f.stack.classList.contains('layout-overlap'), false);
    assert.equal(f.first.style.getPropertyValue('--panel-overlap-top'), '');
    assert.equal(
      f.stack.style.getPropertyValue(`--${side}-stack-safe-top`),
      '',
    );
    assert.equal(
      f.first.style.getPropertyValue(`--${side}-panel-allocated-height`),
      '',
    );
    assert.equal(f.first.getAttribute('aria-hidden'), undefined);
  });
  test(`${side} constrained layout keeps every open panel open and shares the corridor, the preferred panel first`, () => {
    // Owner ruling, 2026-09-27: boxes opened together stay open on both rails.
    const f = fixture(side);
    f.expand(f.first, 900);
    f.expand(f.second, 900);
    f.options.preferredPanelId = 'second';
    f.run();
    assert.equal(f.second.classList.contains('collapsed'), false);
    assert.equal(f.first.classList.contains('collapsed'), false);
    assert.equal(f.first.classList.contains('layout-auto-collapsed'), false);
    assert.deepEqual(f.collapsed, []);
    assert.equal(f.retries(), 0);
    const allocated = (panel) =>
      parseFloat(
        panel.style.getPropertyValue(`--${side}-panel-allocated-height`),
      );
    assert.ok(
      allocated(f.first) > 0 && allocated(f.second) > 0,
      'both open panels get a share of the corridor',
    );
    assert.ok(
      allocated(f.second) >= allocated(f.first),
      'the preferred (newest) panel gets at least as much',
    );
  });
  test(`${side} hidden HUD restores automatic collapse without altering manual collapse`, () => {
    const f = fixture(side, { hud: { visible: false, variant: 'tactical' } });
    f.first.classList.add('layout-auto-collapsed');
    f.run();
    assert.equal(f.first.classList.contains('collapsed'), false);
    assert.equal(f.second.classList.contains('collapsed'), true);
    assert.deepEqual(f.collapsed, ['first']);
  });
}

// Owner ruling, 2026-09-28: an open box may use the whole screen, drawing
// over the tactical HUD at the top and the bottom.
for (const side of ['left', 'right']) {
  test(`${side} corridor ignores HUD obstacles only while a box is open`, () => {
    const f = fixture(side);
    const blocker = element('blocker', {
      top: 600,
      height: 80,
      left: side === 'left' ? 20 : 1100,
    });
    f.options.obstacles = [blocker];
    f.run();
    const closedTop = Number(
      side === 'left' ? f.stack.dataset.safeTopPct : f.stack.dataset.safeTop,
    );
    const closedBottom = Number(
      side === 'left'
        ? f.stack.dataset.safeBottomPct
        : f.stack.dataset.safeBottom,
    );
    assert.ok(closedBottom < (side === 'left' ? 98 : 882));
    assert.equal(f.stack.classList.contains('layout-overlap'), false);

    f.expand(f.second, 900);
    f.run();
    assert.equal(f.stack.dataset.layoutMode, 'overlap');
    assert.equal(f.stack.classList.contains('layout-overlap'), true);
    assert.equal(f.stack.classList.contains('layout-focus'), false);
    if (side === 'left') {
      assert.equal(Number(f.stack.dataset.safeTopPct), 2);
      assert.equal(Number(f.stack.dataset.safeBottomPct), 98);
    } else {
      assert.equal(f.stack.dataset.safeTop, '18.0');
      assert.equal(f.stack.dataset.safeBottom, '882.0');
    }
    assert.ok(
      Number(f.stack.dataset.safeTopPct ?? f.stack.dataset.safeTop) <=
        closedTop,
    );
  });

  test(`${side} overlapping boxes each keep their natural height, cascaded`, () => {
    const f = fixture(side);
    f.expand(f.first, 900);
    f.expand(f.second, 300);
    f.options.preferredPanelId = 'first';
    f.run();
    const read = (panel, name) => panel.style.getPropertyValue(name);
    const allocated = (panel) =>
      parseFloat(read(panel, `--${side}-panel-allocated-height`));
    // 900px viewport, 2% inset each end, no collapsed tab in the flow: 864px
    // of lane, less the one 40px cascade step.
    assert.equal(allocated(f.first), 824);
    assert.equal(allocated(f.second), 300, 'a short box is not padded out');
    assert.equal(read(f.first, '--panel-overlap-top'), '0.0px');
    assert.equal(read(f.second, '--panel-overlap-top'), '40.0px');
  });

  test(`${side} cascade puts the box in front lowest, so the one behind keeps a strip`, () => {
    // The case the owner would hit first: open the short box, then the tall
    // one. The tall box is in front, and if it also started at the top of the
    // lane it would cover the short box outright — collapse button and all.
    const f = fixture(side);
    f.expand(f.first, 300);
    f.expand(f.second, 900);
    f.first.style.setProperty('--panel-raise-z', '1');
    f.second.style.setProperty('--panel-raise-z', '2');
    f.options.preferredPanelId = 'second';
    f.run();
    const top = (panel) =>
      parseFloat(panel.style.getPropertyValue('--panel-overlap-top'));
    assert.equal(top(f.first), 0);
    assert.equal(top(f.second), 40, 'the box in front starts below the strip');

    // Clicking the box behind swaps the slots with the stacking order.
    f.first.style.setProperty('--panel-raise-z', '3');
    f.run();
    assert.equal(top(f.second), 0);
    assert.equal(top(f.first), 40);
  });
}

test('the map attribution still bounds an overlapping left rail', () => {
  const f = fixture('left');
  const credit = element('credit', { top: 820, height: 28 });
  credit.closest = (selector) =>
    selector === '#cesium-credits' ? credit : null;
  f.options.obstacles = [credit];
  f.expand(f.first, 900);
  f.run();
  assert.equal(f.stack.dataset.layoutMode, 'overlap');
  assert.equal(Number(f.stack.dataset.safeBottomPct), 89.91);
});

test('a box the stylesheet hides reserves no room above the right rail floats', () => {
  // Radio is display:none while collapsed, which is its usual state. It used
  // to reserve the 42px a tab that has not painted yet is given, so an open
  // box started a row lower than it had to.
  const f = fixture('right');
  f.second.id = 'radio-panel';
  f.second.computed = { ...f.second.computed, display: 'none' };
  f.second.rect = { ...f.second.rect, height: 0, bottom: f.second.rect.top };
  f.expand(f.first, 900);
  f.run();
  assert.equal(f.stack.dataset.layoutMode, 'overlap');
  assert.equal(f.first.style.getPropertyValue('--panel-overlap-top'), '0.0px');
});

test('Radio stays in the right rail flow instead of floating over it', () => {
  const f = fixture('right');
  f.second.id = 'radio-panel';
  f.expand(f.first, 900);
  f.expand(f.second, 300);
  f.run();
  assert.equal(f.stack.dataset.layoutMode, 'overlap');
  assert.equal(f.second.style.getPropertyValue('--panel-overlap-top'), '');
  // Radio holds the flow column, so the float begins below it: 300px of Radio
  // plus the 12px row gap, and the lane it is left is what remains of the
  // 864px between the insets.
  assert.equal(
    f.first.style.getPropertyValue('--panel-overlap-top'),
    '312.0px',
  );
  assert.equal(
    parseFloat(
      f.first.style.getPropertyValue('--right-panel-allocated-height'),
    ),
    552,
  );
});

test('right layout uses keyboard focus when there is no preferred panel', () => {
  const f = fixture('right');
  f.expand(f.first, 900);
  f.expand(f.second, 900);
  f.options.documentRef.activeElement = f.second;
  f.run();
  // The focused panel is allocated first; the other stays open beside it.
  assert.equal(f.first.classList.contains('collapsed'), false);
  assert.equal(f.second.classList.contains('collapsed'), false);
  const allocated = (panel) =>
    parseFloat(panel.style.getPropertyValue('--right-panel-allocated-height'));
  assert.ok(
    allocated(f.second) >= allocated(f.first) && allocated(f.first) > 0,
  );
});

for (const collapsed of [true, false]) {
  test(`right layout ignores a hidden ${collapsed ? 'collapsed' : 'expanded'} panel`, () => {
    const baseline = fixture('right');
    baseline.stack.children = [baseline.first];
    baseline.expand(baseline.first, 600);
    baseline.run();

    const f = fixture('right');
    f.expand(f.first, 600);
    f.second.id = 'weather-panel';
    f.second.hidden = true;
    if (!collapsed) f.expand(f.second, 900);
    f.options.preferredPanelId = 'weather-panel';
    f.run();

    assert.deepEqual(f.stack.dataset, baseline.stack.dataset);
    assert.equal(
      f.first.style.getPropertyValue('--right-panel-allocated-height'),
      baseline.first.style.getPropertyValue('--right-panel-allocated-height'),
    );
    assert.equal(f.second.classList.contains('collapsed'), collapsed);
    assert.deepEqual(f.second.writes, []);
    assert.deepEqual(f.collapsed, []);
    assert.equal(f.retries(), 0);
    assert.equal(f.stack.classList.contains('layout-focus'), false);
  });
}

test('right layout retains Display allocation during measurement and caps restored scroll', () => {
  const f = fixture('right');
  f.first.id = 'pp-toggles';
  f.expand(f.first, 900);
  f.first.clientHeight = 400;
  f.options.displayPanel = f.first;
  f.options.readDisplayScrollTop = () => 800;
  f.first.style.setProperty('--right-panel-allocated-height', '600px');
  f.first.writes.length = 0;
  f.run();
  assert.equal(f.first.scrollTop, 500);
  assert.equal(
    f.first.writes.some(
      ([op, name]) =>
        op === 'remove' && name === '--right-panel-allocated-height',
    ),
    false,
  );
  f.first.writes.length = 0;
  f.run();
  assert.equal(
    f.first.writes.some(
      ([, name]) => name === '--right-panel-allocated-height',
    ),
    false,
    'stable allocation must not churn the style attribute',
  );
});

test('right rail neither measures nor allocates a panel floating out of it', () => {
  const f = fixture('right');
  f.expand(f.first, 900);
  f.expand(f.second, 300);
  f.first.classList.add('panel-floating');
  f.first.style.setProperty('--right-panel-allocated-height', '500px');
  f.first.writes.length = 0;
  f.run();
  assert.equal(f.stack.dataset.expandedCount, '1');
  assert.deepEqual(
    f.first.writes,
    [],
    'a floating panel keeps whatever inline style it left the rail with',
  );
  assert.equal(f.first.getAttribute('aria-hidden'), undefined);
  assert.equal(f.first.classList.contains('layout-auto-collapsed'), false);
  assert.ok(
    f.second.style.getPropertyValue('--right-panel-allocated-height'),
    'the docked panel still receives its allocation',
  );
});

test('right rail aligns to the current left rail and excludes hidden obstacles', () => {
  const f = fixture('right');
  f.options.leftStack.rect.top = 200;
  const hidden = element('hidden', { left: 1100, top: 100, height: 200 });
  hidden.computed.display = 'none';
  f.options.obstacles = [hidden];
  f.run();
  assert.equal(f.stack.dataset.safeTop, '200.0');
});

// The left rail's `top` animates after the right pass runs, and nothing
// re-runs it when the transition lands: the right rail must read the end value.
function animatingLeftRail({ keyframes = true } = {}) {
  const f = fixture('right');
  const left = f.options.leftStack;
  left.rect.top = 250;
  left.computed.top = '250px';
  left.dataset.safeTopPct = '29.60';
  left.getAnimations = () => [
    { transitionProperty: 'bottom', effect: null },
    {
      transitionProperty: 'top',
      effect: {
        getKeyframes: () =>
          keyframes ? [{ top: '234px' }, { top: '266.4px' }] : [],
      },
    },
  ];
  return f;
}

test('right rail aligns to where a mid-transition left rail settles', () => {
  const f = animatingLeftRail();
  f.run();
  assert.equal(f.stack.dataset.safeTop, '266.4');
  assert.equal(
    f.stack.style.getPropertyValue('--right-stack-safe-top'),
    '266.4px',
  );
});

test('right rail falls back to the committed left target when the transition end is unreadable', () => {
  const f = animatingLeftRail({ keyframes: false });
  f.run();
  assert.equal(f.stack.dataset.safeTop, '266.4');
});

test('right rail follows a settled left rail whose CSS overrides the committed target', () => {
  // Cyber pins the left rail with `top: ... !important`, so the committed
  // percentage is not where it renders and no `top` transition runs.
  const f = fixture('right', { hud: { visible: true, variant: 'cyber' } });
  f.options.leftStack.rect.top = 220;
  f.options.leftStack.dataset.safeTopPct = '26.00';
  f.options.leftStack.getAnimations = () => [];
  f.run();
  assert.equal(f.stack.dataset.safeTop, '220.0');
});

test('natural height includes visible content, margins and wrapper chrome, excluding hidden rows', () => {
  const panel = element('panel');
  const inner = element('inner', { top: 100 });
  inner.computed.paddingTop = '10px';
  inner.computed.paddingBottom = '5px';
  const row = element('row', { top: 110, height: 40 });
  row.scrollHeight = 80;
  row.computed.marginBottom = '3px';
  const hidden = element('hidden', { top: 1000, height: 900 });
  hidden.computed.visibility = 'hidden';
  panel.computed.borderTopWidth = '1px';
  panel.computed.borderBottomWidth = '1px';
  panel.children = [inner];
  inner.children = [row, hidden];
  assert.equal(
    measurePanelNaturalHeight(panel, (node) => node.computed),
    100,
  );
});

test('a layout pass puts every scroller back where the operator left it', () => {
  // Owner ruling, 2026-09-28: a box being read must not jump to the top. The
  // pass has to drop each box's allocated height to measure its natural one,
  // and with the height gone the box stops overflowing, so the browser sends
  // its scroller to 0 — which is what the capture/restore pair undoes.
  const scroller = {
    scrollTop: 420,
    scrollLeft: 0,
    querySelectorAll: () => [],
  };
  const quiet = { scrollTop: 0, scrollLeft: 0, querySelectorAll: () => [] };
  const panel = {
    scrollTop: 0,
    scrollLeft: 0,
    querySelectorAll: () => [scroller, quiet],
  };
  const marks = capturePanelScroll([panel]);
  assert.deepEqual(
    marks.map(({ top }) => top),
    [420],
    'only a scroller that had been moved is worth remembering',
  );
  // The browser clamps it while the height is off the box.
  scroller.scrollTop = 0;
  restorePanelScroll(marks);
  assert.equal(scroller.scrollTop, 420);
  assert.equal(quiet.scrollTop, 0, 'a box at the top is left alone');
  // A second restore with nothing to do must not touch anything.
  scroller.scrollTop = 500;
  restorePanelScroll(marks);
  assert.equal(scroller.scrollTop, 420);
  assert.deepEqual(capturePanelScroll([]), []);
  assert.deepEqual(capturePanelScroll(null), []);
  restorePanelScroll(null);
});

// Reproduce the allocation-dependent readings seen beside the weather card.
// Outside measurement, CCTV is 391 px in focus and 629 px in normal mode;
// Removing only the allocation leaves focus CSS active: its next reading is
// 422 px, so the old decision exits focus and then re-enters on the 629 px read.
// `painted: false` models an open box with no painted rectangle (Cockpit's
// hidden rail): it never floats in the overlap mode, so the focus decision
// is what places the rail.
function thrashingRightRail({
  focused = false,
  weatherOpen = false,
  painted = true,
} = {}) {
  const f = fixture('right');
  f.options.windowRef.innerHeight = 920;
  f.options.leftStack.rect.top = 439.6;
  f.stack.computed.rowGap = '8px';
  const display = element('pp-toggles', { collapsed: true });
  const cctv = element('cctv-panel', { height: 629 });
  const weather = element('weather-panel', {
    height: 444,
    collapsed: !weatherOpen,
  });
  const context = element('global-context-panel', { collapsed: true });
  if (!weatherOpen) weather.classList.add('layout-auto-collapsed');
  f.stack.children = [display, cctv, weather, context];
  f.stack.classList.toggle('layout-focus', focused);
  f.options.preferredPanelId = cctv.id;
  f.options.displayPanel = display;
  const allocation = '--right-panel-allocated-height';
  const measuring = () =>
    f.stack.getAttribute('data-rail-measuring') !== undefined;
  for (const panel of f.stack.children) {
    panel.parentElement = f.stack;
    panel.intrinsicHeight = panel.rect.height;
    panel.style.setProperty(allocation, '391px');
    panel.getBoundingClientRect = () => {
      let height;
      if (panel.classList.contains('collapsed')) {
        height =
          measuring() || f.stack.classList.contains('layout-focus') ? 44 : 0;
      } else if (measuring()) {
        height = panel.intrinsicHeight;
      } else if (!painted) {
        height = 0;
      } else if (f.stack.classList.contains('layout-focus')) {
        height = 391;
      } else {
        height = panel.intrinsicHeight;
      }
      return { ...panel.rect, height, bottom: panel.rect.top + height };
    };
    Object.defineProperty(panel, 'scrollHeight', {
      get: () => {
        if (measuring())
          return panel.classList.contains('collapsed')
            ? 44
            : panel.intrinsicHeight;
        if (panel.classList.contains('collapsed'))
          return panel.getBoundingClientRect().height;
        return f.stack.classList.contains('layout-focus') &&
          panel.style.getPropertyValue(allocation)
          ? 603
          : 422;
      },
    });
  }
  return { ...f, cctv, weather };
}

for (const focused of [false, true]) {
  test(`right rail settles mode-dependent CCTV and weather heights within two passes from ${focused ? 'focus' : 'normal'}`, () => {
    const f = thrashingRightRail({ focused });
    assert.equal(f.cctv.getBoundingClientRect().height, focused ? 391 : 629);
    assert.equal(f.weather.getBoundingClientRect().height, focused ? 44 : 0);
    const modes = [];
    const needs = [];
    for (let pass = 0; pass < 10; pass++) {
      f.run();
      // An open box floats over the HUD (owner ruling, 2026-09-28), so the
      // settled mode is overlap rather than focus.
      modes.push(f.stack.dataset.layoutMode);
      needs.push(f.stack.dataset.requiredHeight);
      assert.equal(f.stack.dataset.availableHeight, '443.6');
      assert.equal(f.stack.getAttribute('data-rail-measuring'), undefined);
    }
    assert.deepEqual(modes, Array(10).fill('overlap'));
    // The collapsed tabs stay on the rail (owner ruling, 2026-09-27), so all
    // three count: 629 + 3 × 44 + 3 × 8 gap.
    assert.deepEqual(needs, Array(10).fill('785.0'));
    assert.equal(f.retries(), 0);
    assert.equal(f.cctv.writes.filter(([op]) => op === 'remove').length, 0);
  });
}

test('right rail keeps focus through 30 px content growth inside the hysteresis band', () => {
  const f = thrashingRightRail({ painted: false });
  f.run();
  // The three tabs that stay on the rail (owner ruling, 2026-09-27) and their
  // gaps contribute 156 px: need moves 420 -> 450 -> 420.
  for (const height of [264, 294, 264, 294, 264]) {
    f.cctv.intrinsicHeight = height;
    f.run();
    assert.equal(f.stack.classList.contains('layout-focus'), true);
  }
  f.cctv.intrinsicHeight = 231; // Need 387 < 443.6 - 55.2.
  f.run();
  assert.equal(f.stack.classList.contains('layout-focus'), false);
  f.cctv.intrinsicHeight = 261;
  f.run();
  assert.equal(f.stack.classList.contains('layout-focus'), false);
});

test('right rail enters focus only above available height and leaves below the full deadband', () => {
  const f = thrashingRightRail({ painted: false });
  f.options.windowRef.innerHeight = 1000;
  f.options.leftStack.rect.top = 500;
  // Tabs and gaps add 156 px to the open box.
  f.cctv.intrinsicHeight = 304; // Need equals available (460 px).
  f.run();
  assert.equal(f.stack.classList.contains('layout-focus'), false);
  f.cctv.intrinsicHeight = 305;
  f.run();
  assert.equal(f.stack.classList.contains('layout-focus'), true);
  f.cctv.intrinsicHeight = 244; // Need equals the 400 px exit boundary.
  f.run();
  assert.equal(f.stack.classList.contains('layout-focus'), true);
  f.cctv.intrinsicHeight = 243;
  f.run();
  assert.equal(f.stack.classList.contains('layout-focus'), false);
});

// Owner ruling, 2026-09-27: every open box stays open, so a crowded rail
// never collapses a sibling and never asks for a retry pass.
test('right rail keeps both open boxes open and settles without a retry', () => {
  const f = thrashingRightRail({ weatherOpen: true });
  const modes = [];
  for (let pass = 0; pass < 10; pass++) {
    f.run();
    modes.push(f.stack.dataset.layoutMode);
  }
  assert.deepEqual(f.collapsed, []);
  assert.equal(f.retries(), 0);
  assert.deepEqual(modes, Array(10).fill('overlap'));
});

test('right rail requests no retry even if disclosure changes between passes', () => {
  const f = thrashingRightRail({ weatherOpen: true });
  f.run();
  assert.equal(f.retries(), 0);
  f.weather.classList.remove('collapsed', 'layout-auto-collapsed');
  f.run();
  assert.equal(f.retries(), 0);
  assert.equal(f.stack.dataset.layoutMode, 'overlap');
});

test('right rail restores presentation even when intrinsic measurement throws', () => {
  const f = thrashingRightRail();
  f.cctv.getBoundingClientRect = () => {
    throw new Error('measurement failed');
  };
  assert.throws(() => f.run(), /measurement failed/);
  assert.equal(f.stack.getAttribute('data-rail-measuring'), undefined);
});

test('right rail measuring pass keeps an opted-in scroller position', () => {
  const f = fixture('right');
  f.expand(f.first, 300);
  let scrollTop = 240;
  let writes = 0;
  let clamp = true;
  const body = {
    get scrollTop() {
      return scrollTop;
    },
    set scrollTop(value) {
      writes++;
      scrollTop = value;
    },
  };
  f.stack.querySelectorAll = (selector) =>
    selector === '[data-rail-scroller]' ? [body] : [];
  const setAttribute = f.stack.setAttribute;
  f.stack.setAttribute = (name, value) => {
    setAttribute(name, value);
    // The lifted max-height removes the overflow and clamps the offset.
    if (clamp && name === 'data-rail-measuring') scrollTop = 0;
  };
  f.run();
  assert.equal(scrollTop, 240);
  assert.equal(writes, 1);
  clamp = false;
  f.run();
  assert.equal(writes, 1, 'an unclamped offset is not rewritten');
});

for (const variant of ['minimal', 'full']) {
  test(`right rail does not retry collapse that the ${variant} HUD immediately restores`, () => {
    const f = fixture('right', { hud: { visible: true, variant } });
    f.expand(f.first, 900);
    f.expand(f.second, 900);
    for (let pass = 0; pass < 10; pass++) f.run();
    assert.equal(f.retries(), 0);
    assert.equal(f.first.classList.contains('collapsed'), false);
    assert.equal(f.second.classList.contains('collapsed'), false);
  });
}
// ── Narrow-screen rail overflow pin ──────────────────────────────────────────
// At ≤720px both panel stacks become scroll containers (overflow-y: auto),
// which also makes their overflow-x compute to auto. Each panel's decorative
// .panel-glow is absolutely positioned with a negative inset, so inside a
// scroll container that overhang is no longer harmless paint: it becomes
// 18–20px of scrollable overflow on both axes, drawing a horizontal scrollbar
// band under the expanded CCTV/Context/Data panel plus a vertical scrollbar
// that scrolls nothing but glow. The narrow block therefore pins every hosted
// glow to its panel box.

/** Strip comments and return the bodies of every ≤720px media block. */
function narrowScreenBlocks(css) {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks = [];
  let from = 0;
  for (;;) {
    const start = source.indexOf('@media (max-width: 720px) {', from);
    if (start === -1) break;
    const open = source.indexOf('{', start);
    let depth = 0;
    let close = -1;
    for (let index = open; index < source.length; index += 1) {
      if (source[index] === '{') depth += 1;
      if (source[index] === '}' && (depth -= 1) === 0) {
        close = index;
        break;
      }
    }
    assert.notEqual(close, -1, 'unterminated narrow-screen media block');
    blocks.push(source.slice(open + 1, close));
    from = close + 1;
  }
  assert.ok(blocks.length, 'narrow-screen media block is missing');
  return blocks;
}

/** Split a flat (non-nested) rule list into [selectors, declarations] pairs. */
function flatRules(block) {
  assert.doesNotMatch(block, /@media/, 'nested media queries are not modelled');
  return [...block.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
    ([, selectors, declarations]) => [
      selectors.split(',').map((part) => part.trim().replace(/\s+/g, ' ')),
      declarations,
    ],
  );
}

test('narrow-screen rails pin every hosted panel glow inside its panel box', () => {
  const css = readStylesheet(new URL('../../style.css', import.meta.url));
  for (const panel of [
    'data-panel',
    'scene-panel',
    'cctv-panel',
    'global-context-panel',
  ]) {
    assert.match(
      css,
      new RegExp(`#${panel} \\.panel-glow \\{[^}]*\\binset: -\\d+px;`),
      `${panel} glow no longer overhangs its panel; revisit this pin`,
    );
  }
  const narrow = narrowScreenBlocks(css).flatMap(flatRules);
  const scrollingRails = [
    ...new Set(
      narrow
        .filter(([, declarations]) =>
          /\boverflow(?:-y)?:\s*(?:auto|scroll)\b/.test(declarations),
        )
        .flatMap(([selectors]) => selectors)
        .filter((selector) =>
          /^#(?:left-panel-stack|right-context-rail)$/.test(selector),
        ),
    ),
  ].sort();
  assert.deepEqual(scrollingRails, [
    '#left-panel-stack',
    '#right-context-rail',
  ]);
  for (const rail of scrollingRails) {
    assert.ok(
      narrow.some(
        ([selectors, declarations]) =>
          selectors.includes(`${rail} .panel-glow`) &&
          /(?:^|;)\s*inset:\s*0\s*;/.test(declarations),
      ),
      `${rail} scrolls at ≤720px but does not pin its panel glows (inset: 0)`,
    );
  }
});

test('right layout ignores a hidden panel: no lane, no gap, no auto-collapse', () => {
  const f = fixture('right');
  const imagery = element('recent-imagery-panel', { height: 0 });
  imagery.hidden = true;
  imagery.scrollHeight = 0;
  imagery.rect.height = 0;
  f.stack.children.push(imagery);
  imagery.parentElement = f.stack;
  // A tall panel floats over the HUD: the hidden sibling takes no slot, is
  // never collapsed, and counts for nothing.
  f.expand(f.first, 900);
  f.run();
  assert.equal(f.stack.dataset.layoutMode, 'overlap');
  assert.equal(imagery.classList.contains('collapsed'), false);
  assert.equal(imagery.classList.contains('layout-auto-collapsed'), false);
  assert.equal(f.stack.dataset.expandedCount, '1');
  assert.equal(
    imagery.style.getPropertyValue('--right-panel-allocated-height'),
    '',
  );
  assert.equal(imagery.getAttribute('aria-hidden'), undefined);
  const alone = parseFloat(
    f.first.style.getPropertyValue('--right-panel-allocated-height'),
  );
  // Shown (and expanded) it joins the allocation like any other panel and,
  // as every open box stays open (owner ruling, 2026-09-27), nothing collapses.
  imagery.hidden = false;
  imagery.scrollHeight = 300;
  imagery.rect.height = 300;
  const retriesBefore = f.retries();
  f.run();
  assert.equal(f.collapsed.includes('recent-imagery-panel'), false);
  assert.equal(f.retries(), retriesBefore);
  f.run();
  assert.equal(f.stack.dataset.expandedCount, '2');
  assert.ok(
    parseFloat(
      imagery.style.getPropertyValue('--right-panel-allocated-height'),
    ) > 0,
  );
  assert.ok(
    parseFloat(
      f.first.style.getPropertyValue('--right-panel-allocated-height'),
    ) <= alone,
  );
});
