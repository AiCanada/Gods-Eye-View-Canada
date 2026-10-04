import {
  PANEL_OVERLAP_CASCADE_PX,
  PANEL_OVERLAP_VIEWPORT_INSET,
  allocateOverlappingPanelHeights,
  allocatePanelStackHeights,
  resolveOverlapCascadeOrder,
} from '../panelStackLayout.js';
import {
  capturePanelScroll,
  isAttributionObstacle,
  readPanelStackingRank,
  resolveHudRailLayout,
  restorePanelScroll,
  shouldHideCollapsedRightPanels,
} from './panelRailGeometry.js';

import { displayPanelScroller } from './displayPanelScroll.js';

/**
 * Measure and place the right panel rail for one synchronous layout pass.
 * The caller owns scheduling, obstacle selection, disclosure preferences and
 * persistence. Auto-collapse is presentation only and reports through callbacks.
 * @param {object} options Live DOM and caller policy.
 * @param {HTMLElement} options.stack Rail element.
 * @param {Iterable<HTMLElement>} options.obstacles Caller-selected obstacle nodes.
 * @param {Window} options.windowRef Viewport and style reader.
 * @param {{visible: boolean, variant: string}} options.hud Current HUD presentation.
 * @param {string} options.preferredPanelId Most recently opened panel.
 * @param {Function} options.onCollapse Update a panel's disclosure chrome.
 * @param {Function} options.onRetry Request another pass after automatic collapse.
 * @param {Function} [options.getComputedStyle] Optional DOM style reader override.
 * @param {HTMLElement} options.leftStack Rail supplying the shared top baseline.
 * @param {HTMLElement} options.displayPanel Panel whose allocation owns its scroll.
 * @param {Function} options.readDisplayScrollTop Read the caller's scroll restoration value.
 * @param {Document} [options.documentRef] Document supplying current keyboard focus.
 */
export function layoutRightPanelRail({
  stack,
  obstacles,
  windowRef,
  hud,
  preferredPanelId,
  onCollapse,
  onRetry,
  leftStack,
  displayPanel,
  readDisplayScrollTop,
  documentRef = stack?.ownerDocument,
  getComputedStyle = (element) => windowRef.getComputedStyle(element),
}) {
  if (!stack) return;

  const panels = [...stack.children].filter(
    (panel) => panel.matches('[data-panel-id]') && !panel.hidden,
  );
  if (!hud.visible || hud.variant !== 'tactical') {
    for (const panel of panels.filter((item) =>
      item.classList.contains('layout-auto-collapsed'),
    )) {
      panel.classList.remove('collapsed', 'layout-auto-collapsed');
      onCollapse(panel);
    }
  }
  // Normalize restored state and theme entry without overwriting saved panel
  // preferences. This marker is distinct from Tactical's space-based collapse.
  if (hud.variant === 'cyber') {
    // Radio is not a box of the rail (it sits below the last tab when
    // selected), so it neither owns nor yields the accordion.
    const expanded = panels.filter(
      (panel) =>
        !panel.classList.contains('collapsed') && panel.id !== 'radio-panel',
    );
    const owner =
      expanded.find((panel) => panel.id === preferredPanelId) ||
      expanded.find((panel) => panel.contains(documentRef?.activeElement)) ||
      expanded[0];
    for (const panel of expanded) {
      if (panel === owner) continue;
      panel.classList.add('collapsed', 'cyber-accordion-collapsed');
      onCollapse(panel);
    }
  } else {
    for (const panel of panels) {
      if (!panel.classList.contains('cyber-accordion-collapsed')) continue;
      panel.classList.remove('collapsed', 'cyber-accordion-collapsed');
      onCollapse(panel);
    }
  }
  const isMobile = windowRef.matchMedia('(max-width: 720px)').matches;
  // Radio is not a box of the rail: selecting it must not put the rail into
  // its one-box mode, which would hide the tabs it sits above.
  const hasExpandedPanel = panels.some(
    (panel) =>
      !panel.classList.contains('collapsed') &&
      panel.id !== 'radio-panel' &&
      (!isMobile || panel.id !== 'pp-toggles'),
  );
  const exclusive = shouldHideCollapsedRightPanels({
    hudVariant: hud.variant,
    hasExpandedPanel,
  });
  stack.classList.toggle('layout-exclusive', exclusive);
  for (const panel of panels) {
    if (exclusive && panel.classList.contains('collapsed'))
      panel.setAttribute('aria-hidden', 'true');
    else panel.removeAttribute('aria-hidden');
  }

  if (isMobile) {
    stack.classList.remove('layout-focus');
    stack.classList.remove('layout-overlap');
    stack.style.removeProperty('--right-stack-safe-top');
    stack.style.removeProperty('--right-stack-max-height');
    for (const panel of panels) {
      panel.style.removeProperty('--right-panel-allocated-height');
      panel.style.removeProperty('--panel-overlap-top');
    }
    stack.dataset.layoutMode = 'mobile';
    return;
  }

  const viewportHeight = Math.max(1, windowRef.innerHeight);
  const safeGap = Math.max(8, viewportHeight * 0.012);
  const stackRect = stack.getBoundingClientRect();
  const leftStackTop = leftStack?.getBoundingClientRect().top;
  const alignedTop = Number.isFinite(leftStackTop)
    ? leftStackTop
    : viewportHeight * 0.26;
  const obstacleRects = [];
  const attributionRects = [];

  for (const obstacle of obstacles) {
    if (stack.contains(obstacle)) continue;
    let hiddenByAncestor = false;
    for (let element = obstacle; element; element = element.parentElement) {
      const style = getComputedStyle(element);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        Number(style.opacity) === 0
      ) {
        hiddenByAncestor = true;
        break;
      }
    }
    if (hiddenByAncestor) continue;
    const rect = obstacle.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const bounds = {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
    };
    obstacleRects.push(bounds);
    if (isAttributionObstacle(obstacle)) attributionRects.push(bounds);
  }

  // Auto-collapsed headers contribute the same need even when exclusive
  // presentation hides them. Manually collapsed launchers keep their policy.
  const measuredPanels = panels.filter(
    (panel) =>
      !exclusive ||
      !panel.classList.contains('collapsed') ||
      panel.classList.contains('layout-auto-collapsed'),
  );
  const visiblePanels = panels.filter(
    (panel) => !exclusive || !panel.classList.contains('collapsed'),
  );
  const displayScrollTop = readDisplayScrollTop();
  // The same care Display has always had, for every box on the rail: with
  // its allocated height gone a box stops overflowing, so the browser puts
  // its scroller back to the top and no later measurement undoes that
  // (owner ruling, 2026-09-28 — a box being read must not jump).
  const scrollMarks = capturePanelScroll(visiblePanels);
  // Measuring lifts each opted-in scroller's max-height, which clamps its
  // scroll offset; remember the offsets to put back afterwards.
  const scrollers = [
    ...(stack.querySelectorAll?.('[data-rail-scroller]') || []),
  ]
    .map((node) => [node, node.scrollTop || 0])
    .filter(([, top]) => top > 0);
  const naturalHeights = new Map();
  // Remove live height allocations through a synchronous CSS override. Keeping
  // the stored properties intact avoids REMOVE/SET churn on unchanged panels.
  // Do not toggle layout classes here: the class observer schedules new passes.
  stack.setAttribute('data-rail-measuring', '');
  try {
    for (const panel of measuredPanels) {
      naturalHeights.set(
        panel,
        Math.max(
          panel.getBoundingClientRect().height,
          panel.scrollHeight || 0,
          panel.classList.contains('collapsed') ? 42 : 0,
        ),
      );
    }
  } finally {
    stack.removeAttribute('data-rail-measuring');
    for (const [node, top] of scrollers)
      if (node.scrollTop !== top) node.scrollTop = top;
  }
  const gap = parseFloat(getComputedStyle(stack).rowGap) || 0;
  const naturalHeight =
    measuredPanels.reduce(
      (total, panel) => total + naturalHeights.get(panel),
      0,
    ) +
    gap * Math.max(0, measuredPanels.length - 1);
  const layout = resolveHudRailLayout({
    viewportHeight,
    panelHeight: naturalHeight,
    laneLeft: stackRect.left,
    laneRight: stackRect.right,
    obstacles: obstacleRects,
    baseTop: alignedTop,
    baseBottom: viewportHeight * 0.96,
    gap: safeGap,
    align: 'start',
  });
  if (!layout) return;
  const { safeTop, safeBottom, maxHeight: availableHeight } = layout;
  const stabilityBand = Math.max(48, viewportHeight * 0.06);
  const wasFocused = stack.classList.contains('layout-focus');
  const shouldFocus = wasFocused
    ? naturalHeight >= availableHeight - stabilityBand
    : naturalHeight > availableHeight;
  const layoutTop = shouldFocus ? safeTop : layout.top;
  const collapsedHeight = visiblePanels.reduce(
    (total, panel) =>
      panel.classList.contains('collapsed')
        ? total + naturalHeights.get(panel)
        : total,
    0,
  );
  const expandedPanelsInDomOrder = visiblePanels.filter(
    (panel) => !panel.classList.contains('collapsed'),
  );
  const focusedExpandedPanel = expandedPanelsInDomOrder.find((panel) =>
    panel.contains(documentRef.activeElement),
  );
  const preferredExpandedPanel =
    expandedPanelsInDomOrder.find((panel) => panel.id === preferredPanelId) ||
    focusedExpandedPanel;
  // Match the left lane: allocation order follows the latest explicit
  // disclosure, not DOM order. A focused panel is the fallback owner so
  // temporary presentation collapse never strands keyboard focus.
  const expandedPanels = preferredExpandedPanel
    ? [
        preferredExpandedPanel,
        ...expandedPanelsInDomOrder.filter(
          (panel) => panel !== preferredExpandedPanel,
        ),
      ]
    : expandedPanelsInDomOrder;
  const expandedAvailableHeight = Math.max(
    0,
    safeBottom -
      layoutTop -
      collapsedHeight -
      gap * Math.max(0, visiblePanels.length - 1),
  );
  const expandedHeights = allocatePanelStackHeights({
    naturalHeights: expandedPanels.map((panel) => naturalHeights.get(panel)),
    availableHeight: expandedAvailableHeight,
  });

  // Owner ruling, 2026-09-28, matching the left lane: an open box floats over
  // the tactical HUD at both ends instead of sharing a corridor squeezed
  // between HUD furniture, and open boxes may cover one another. Only the map
  // attribution still bounds the lane. Radio never floats — it stays in the
  // flow under the Scenes tab where the owner put it (ruling of 2026-09-27) —
  // and neither does a box with no painted rectangle, which is what keeps
  // Cockpit's hidden rail out of this mode.
  const overlapLayout = resolveHudRailLayout({
    viewportHeight,
    panelHeight: naturalHeight,
    laneLeft: stackRect.left,
    laneRight: stackRect.right,
    obstacles: attributionRects,
    baseTop: viewportHeight * PANEL_OVERLAP_VIEWPORT_INSET,
    baseBottom: viewportHeight * (1 - PANEL_OVERLAP_VIEWPORT_INSET),
    gap: safeGap,
    align: 'start',
  });
  const floatingPanels = expandedPanels.filter(
    (panel) =>
      panel.id !== 'radio-panel' && panel.getBoundingClientRect().height > 0,
  );
  // Slots follow the stacking order, never the order the boxes were opened:
  // the box in front has to start lowest or it swallows the strip every box
  // behind it is clicked by.
  const cascadePanels = resolveOverlapCascadeOrder(
    floatingPanels.map((panel) => readPanelStackingRank(panel)),
  ).map((index) => floatingPanels[index]);
  const overlapping = Boolean(overlapLayout) && floatingPanels.length > 0;
  const railTop = overlapping ? overlapLayout.safeTop : layoutTop;
  const railBottom = overlapping ? overlapLayout.safeBottom : safeBottom;
  // The collapsed tabs and Radio keep the flow column above the floats, so
  // every tab stays visible and clickable (owner ruling, 2026-09-27). A box
  // the stylesheet hides outright takes up no column, so it must not reserve
  // any either: Radio is display:none while collapsed, which is its normal
  // state, and the 42px placeholder every other tab needs was costing the
  // floats a row of working area for a box that is not on screen.
  const flowPanels = visiblePanels.filter(
    (panel) =>
      !floatingPanels.includes(panel) &&
      getComputedStyle(panel).display !== 'none',
  );
  const flowHeight =
    flowPanels.reduce(
      (total, panel) =>
        total +
        Math.max(
          panel.getBoundingClientRect().height,
          panel.classList.contains('collapsed') ? 42 : 0,
        ),
      0,
    ) +
    gap * Math.max(0, flowPanels.length - 1);
  const overlapOrigin = flowPanels.length ? flowHeight + gap : 0;
  const overlapPlacements = allocateOverlappingPanelHeights({
    naturalHeights: cascadePanels.map((panel) => naturalHeights.get(panel)),
    availableHeight: Math.max(0, railBottom - railTop - overlapOrigin),
    cascadeStep: PANEL_OVERLAP_CASCADE_PX,
  });
  // Every open box stays open (owner ruling, 2026-09-27), as on the left:
  // boxes opened together share the corridor, the newest first, and each
  // scrolls inside its share. Nothing is collapsed to make room for a
  // sibling; `layout-auto-collapsed` survives only to release panels a
  // previous version collapsed.
  // Write-if-changed. This pass runs on the 500 ms stats cadence, and an
  // unconditional REMOVE-then-SET of an unchanged allocation is two style
  // mutations per tick on `#pp-toggles` (the one panel the measure-strip
  // above deliberately skips) — churn that reads as a genuine panel move to
  // the world-overlay host's occluder observer and defeats parked-idle
  // render savings. Only a real allocation change may touch the attribute.
  const writeIfChanged = (panel, name, value) => {
    if (panel.style.getPropertyValue(name) !== value)
      panel.style.setProperty(name, value);
  };
  const allocatedPanels = overlapping ? floatingPanels : expandedPanels;
  if (overlapping) {
    cascadePanels.forEach((panel, index) => {
      const { offset, height } = overlapPlacements[index];
      writeIfChanged(
        panel,
        '--panel-overlap-top',
        `${(overlapOrigin + offset).toFixed(1)}px`,
      );
      writeIfChanged(
        panel,
        '--right-panel-allocated-height',
        `${height.toFixed(1)}px`,
      );
    });
  } else {
    expandedPanels.forEach((panel, index) => {
      writeIfChanged(
        panel,
        '--right-panel-allocated-height',
        `${expandedHeights[index].toFixed(1)}px`,
      );
    });
  }
  for (const panel of panels) {
    if (!allocatedPanels.includes(panel))
      panel.style.removeProperty('--right-panel-allocated-height');
    if (!overlapping || !floatingPanels.includes(panel))
      panel.style.removeProperty('--panel-overlap-top');
  }

  stack.style.setProperty('--right-stack-safe-top', `${railTop.toFixed(1)}px`);
  stack.style.setProperty(
    '--right-stack-max-height',
    `${Math.max(0, railBottom - railTop).toFixed(1)}px`,
  );
  stack.classList.toggle('layout-overlap', overlapping);
  stack.classList.toggle('layout-focus', !overlapping && shouldFocus);
  stack.dataset.layoutMode = overlapping
    ? 'overlap'
    : shouldFocus
      ? 'focus'
      : 'normal';
  stack.dataset.safeTop = railTop.toFixed(1);
  stack.dataset.safeBottom = railBottom.toFixed(1);
  stack.dataset.availableHeight = availableHeight.toFixed(1);
  stack.dataset.requiredHeight = naturalHeight.toFixed(1);
  stack.dataset.expandedCount = String(expandedPanels.length);

  if (displayPanel && expandedPanels.includes(displayPanel)) {
    const scroller = displayPanelScroller(displayPanel);
    const maxScrollTop = Math.max(
      0,
      scroller.scrollHeight - scroller.clientHeight,
    );
    scroller.scrollTop = Math.min(displayScrollTop, maxScrollTop);
  }
  // Every other box goes back where it was, now the heights are written.
  restorePanelScroll(scrollMarks);
}
