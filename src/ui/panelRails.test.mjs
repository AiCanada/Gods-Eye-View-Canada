import assert from 'node:assert/strict';
import test from 'node:test';
import {
  capturePanelScroll,
  restorePanelScroll,
  layoutLeftPanelRail,
  layoutRightPanelRail,
  measurePanelNaturalHeight,
} from './panelRails.js';

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
    matches: (selector) => selector === '[data-panel-id]',
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

test('right rail aligns to the current left rail and excludes hidden obstacles', () => {
  const f = fixture('right');
  f.options.leftStack.rect.top = 200;
  const hidden = element('hidden', { left: 1100, top: 100, height: 200 });
  hidden.computed.display = 'none';
  f.options.obstacles = [hidden];
  f.run();
  assert.equal(f.stack.dataset.safeTop, '200.0');
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
