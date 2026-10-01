import {
  PANEL_OVERLAP_CASCADE_PX,
  PANEL_OVERLAP_VIEWPORT_INSET,
  allocateOverlappingPanelHeights,
  allocatePanelStackHeights,
  resolveLeftStackBottomBoundary,
  resolveOverlapCascadeOrder,
  resolvePanelStackCorridor,
} from '../panelStackLayout.js';
import { measurePanelNaturalHeight } from './panelMeasurement.js';
import {
  capturePanelScroll,
  isAttributionObstacle,
  readPanelStackingRank,
  restorePanelScroll,
} from './panelRailGeometry.js';

/**
 * Measure and place the left panel rail for one synchronous layout pass.
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
 * @param {Map<string, number>} options.collapsedHeights Caller-owned measurement cache.
 * @param {Function} options.onAligned Notify the caller after the left rail moves.
 */
export function layoutLeftPanelRail({
  stack,
  obstacles,
  windowRef,
  hud,
  preferredPanelId,
  onCollapse,
  onRetry,
  collapsedHeights,
  onAligned,
  getComputedStyle = (element) => windowRef.getComputedStyle(element),
}) {
  if (!stack) return;

  const panels = [...stack.querySelectorAll(':scope > [data-panel-id]')];
  if (!panels.length) return;
  if (!hud.visible || hud.variant !== 'tactical') {
    for (const panel of panels.filter((item) =>
      item.classList.contains('layout-auto-collapsed'),
    )) {
      panel.classList.remove('collapsed', 'layout-auto-collapsed');
      onCollapse(panel);
    }
  }

  // The existing narrow-screen composition has its own full-width stack.
  // Keep this desktop lane engine from fighting those dedicated rules.
  if (windowRef.matchMedia('(max-width: 720px)').matches) {
    stack.classList.remove('layout-focus');
    stack.classList.remove('layout-tail');
    stack.classList.remove('layout-overlap');
    stack.style.removeProperty('--left-stack-safe-top');
    stack.style.removeProperty('--left-stack-safe-bottom');
    stack.style.removeProperty('--left-stack-centered-height');
    stack.dataset.layoutMode = 'mobile';
    for (const panel of panels) {
      panel.removeAttribute('aria-hidden');
      panel.style.removeProperty('--left-panel-allocated-height');
      panel.style.removeProperty('--panel-overlap-top');
    }
    return;
  }

  const viewportHeight = Math.max(1, windowRef.innerHeight);
  const stackRect = stack.getBoundingClientRect();
  const baseTop = viewportHeight * 0.26;
  const baseBottomInset = viewportHeight * 0.04;
  const safeGap = viewportHeight * 0.012;
  let obstacleSafeTop = viewportHeight * 0.04;
  let safeTop = baseTop;
  let safeBottom = viewportHeight - baseBottomInset;
  const bottomObstacles = [];
  const attributionObstacles = [];

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
    const overlapsHorizontally =
      rect.right > stackRect.left && rect.left < stackRect.right;
    if (!overlapsHorizontally) continue;

    if (isAttributionObstacle(obstacle))
      attributionObstacles.push({ top: rect.top });
    if (rect.top < baseTop && rect.bottom <= viewportHeight * 0.5) {
      const obstacleBottom = rect.bottom + safeGap;
      obstacleSafeTop = Math.max(obstacleSafeTop, obstacleBottom);
      safeTop = Math.max(safeTop, obstacleBottom);
    } else if (rect.top >= baseTop) {
      bottomObstacles.push({ top: rect.top });
    }
  }
  safeBottom = resolveLeftStackBottomBoundary({
    baseBottom: safeBottom,
    obstacles: bottomObstacles,
    safeGap,
  });

  const obstacleSafeBottom = safeBottom;

  // Keep the accordion visually centered when the balanced corridor remains
  // useful. During live viewport-height changes, retain the aligned lane
  // instead of extending a tiny midpoint corridor through a lower obstacle.
  const minimumLaneHeight = viewportHeight * 0.16;
  ({ safeTop, safeBottom } = resolvePanelStackCorridor({
    viewportHeight,
    safeTop,
    safeBottom,
    obstacleSafeTop,
    obstacleSafeBottom,
    minimumHeight: minimumLaneHeight,
  }));
  const viewportMidpoint = viewportHeight * 0.5;
  for (const panel of panels) {
    const rect = panel.getBoundingClientRect();
    if (panel.classList.contains('collapsed') && rect.height > 0) {
      collapsedHeights.set(panel.id, rect.height);
    }
  }

  const expandedPanelsInDomOrder = panels.filter(
    (panel) => !panel.classList.contains('collapsed'),
  );
  const preferredExpandedPanel = expandedPanelsInDomOrder.find(
    (panel) => panel.id === preferredPanelId,
  );
  // Auto-collapse is a presentation fallback, not permission to undo the
  // user's newest disclosure. Measure and allocate that explicitly opened
  // panel first so an older expanded sibling yields when the corridor cannot
  // usefully present both (for example Map Stack followed by Scenes).
  const expandedPanels = preferredExpandedPanel
    ? [
        preferredExpandedPanel,
        ...expandedPanelsInDomOrder.filter(
          (panel) => panel !== preferredExpandedPanel,
        ),
      ]
    : expandedPanelsInDomOrder;
  // Where the operator had scrolled to, before any height is taken away:
  // without the allocated height a box stops overflowing and the browser
  // puts its scroller back to the top, which no later measurement can undo.
  const scrollMarks = capturePanelScroll(expandedPanels);
  // Clear the prior pass before reading intrinsic heights. The allocated
  // outer height and the inner scroller otherwise feed their constrained
  // size back into the next HUD-mode calculation.
  for (const panel of expandedPanels) {
    panel.style.removeProperty('--left-panel-allocated-height');
  }
  const availableHeight = Math.max(0, safeBottom - safeTop);
  const naturalExpandedHeights = expandedPanels.map((panel) =>
    measurePanelNaturalHeight(panel, getComputedStyle),
  );
  const naturalExpandedHeight = naturalExpandedHeights.reduce(
    (sum, height) => sum + height,
    0,
  );
  const siblingHeight = panels.reduce((total, panel) => {
    if (!panel.classList.contains('collapsed')) return total;
    const measured = collapsedHeights.get(panel.id);
    return total + (measured || panel.getBoundingClientRect().height || 0);
  }, 0);
  let requiredHeight = siblingHeight;

  const rowGap = parseFloat(getComputedStyle(stack).rowGap) || 0;
  if (expandedPanels.length) {
    requiredHeight += naturalExpandedHeight;
    requiredHeight += rowGap * Math.max(0, panels.length - 1);
  } else {
    requiredHeight += rowGap * Math.max(0, panels.length - 1);
  }

  const wasFocused = stack.classList.contains('layout-focus');
  const wasTail = stack.classList.contains('layout-tail');
  const wasConstrained = wasFocused || wasTail;
  const stabilityBand = viewportHeight * 0.01;
  const exceedsCenteredCorridor =
    expandedPanels.length > 0 &&
    (wasConstrained
      ? requiredHeight > availableHeight - stabilityBand * 2
      : requiredHeight > availableHeight - stabilityBand);
  const tailRequiredHeight =
    naturalExpandedHeight +
    siblingHeight +
    rowGap * Math.max(0, panels.length - 1);
  // A compact expansion should not make the whole control stack jump down
  // merely to center a few short rows. Preserve the normal top anchor when
  // the centered stack would begin below it; tall stacks can still grow
  // upward around the viewport midpoint as their content requires.
  const centeredTailTop = viewportMidpoint - tailRequiredHeight * 0.5;
  const tailLayoutTop = Math.min(centeredTailTop, safeTop);
  const tailLayoutBottom = tailLayoutTop + tailRequiredHeight;
  const tailAvailableHeight = Math.max(0, obstacleSafeBottom - obstacleSafeTop);
  const tailTolerance = wasTail ? stabilityBand : -stabilityBand;
  const shouldTail =
    expandedPanels.length > 0 &&
    tailLayoutTop >= obstacleSafeTop - tailTolerance &&
    tailLayoutBottom <= obstacleSafeBottom + tailTolerance;
  const shouldFocus = exceedsCenteredCorridor && !shouldTail;

  // Owner ruling, 2026-09-28: an open box is free to use the whole screen.
  // Open boxes leave the rail's flow and float over the tactical HUD at the
  // top and at the bottom, which is what buys the working area the owner
  // asked for; they may cover one another and are raised by clicking. A rail
  // with nothing open keeps the obstacle-aware corridor above, so bare tabs
  // still never sit on HUD furniture. A box with no painted rectangle cannot
  // float — that is how Cockpit, which hides this rail's boxes outright,
  // keeps its own corridor.
  const floatingPanels = expandedPanels
    .map((panel, index) => ({ panel, natural: naturalExpandedHeights[index] }))
    .filter((entry) => entry.panel.getBoundingClientRect().height > 0);
  // Slots follow the stacking order, never the order the boxes were opened:
  // the box in front has to start lowest or it swallows the strip every box
  // behind it is clicked by.
  const cascadePanels = resolveOverlapCascadeOrder(
    floatingPanels.map((entry) => readPanelStackingRank(entry.panel)),
  ).map((index) => floatingPanels[index]);
  const overlapping = floatingPanels.length > 0;
  const overlapInset = viewportHeight * PANEL_OVERLAP_VIEWPORT_INSET;
  const overlapTop = overlapInset;
  const overlapBottom = resolveLeftStackBottomBoundary({
    baseBottom: viewportHeight - overlapInset,
    obstacles: attributionObstacles,
    safeGap,
  });

  // Focus mode owns the lane, so let every expanded panel share the full
  // obstacle-safe corridor. Tail/normal layouts keep the balanced
  // viewport centering used for compact accordion stacks.
  const layoutTop = overlapping
    ? overlapTop
    : shouldFocus
      ? obstacleSafeTop
      : shouldTail
        ? tailLayoutTop
        : safeTop;
  const layoutBottom = overlapping
    ? overlapBottom
    : shouldFocus
      ? obstacleSafeBottom
      : shouldTail
        ? tailLayoutBottom
        : safeBottom;
  // The collapsed tabs keep the flow column, so they stay visible and
  // clickable at all times (owner ruling, 2026-09-27) and the floats begin
  // below them.
  const flowPanels = panels.filter(
    (panel) => !floatingPanels.some((entry) => entry.panel === panel),
  );
  const flowHeight =
    flowPanels.reduce(
      (total, panel) =>
        total +
        (collapsedHeights.get(panel.id) ||
          panel.getBoundingClientRect().height ||
          0),
      0,
    ) +
    rowGap * Math.max(0, flowPanels.length - 1);
  const overlapOrigin = flowPanels.length ? flowHeight + rowGap : 0;
  const overlapPlacements = allocateOverlappingPanelHeights({
    naturalHeights: cascadePanels.map((entry) => entry.natural),
    availableHeight: Math.max(0, layoutBottom - layoutTop - overlapOrigin),
    cascadeStep: PANEL_OVERLAP_CASCADE_PX,
  });
  const topPct = (layoutTop / viewportHeight) * 100;
  const bottomPct = ((viewportHeight - layoutBottom) / viewportHeight) * 100;
  const topValue = `${topPct.toFixed(3)}vh`;
  const bottomValue = `${bottomPct.toFixed(3)}vh`;
  const expandedAvailableHeight = shouldFocus
    ? Math.max(
        0,
        layoutBottom -
          layoutTop -
          rowGap * Math.max(0, expandedPanels.length - 1),
      )
    : naturalExpandedHeight;
  const allocatedExpandedHeights = allocatePanelStackHeights({
    naturalHeights: naturalExpandedHeights,
    availableHeight: expandedAvailableHeight,
  });
  // Every open box stays open (owner ruling, 2026-09-27): boxes opened
  // together share the corridor, the newest first, and each scrolls inside
  // its share. Nothing is collapsed to make room for a sibling, on either
  // rail; `layout-auto-collapsed` survives only to release panels a previous
  // version collapsed.
  if (stack.style.getPropertyValue('--left-stack-safe-top') !== topValue) {
    stack.style.setProperty('--left-stack-safe-top', topValue);
  }
  if (
    stack.style.getPropertyValue('--left-stack-safe-bottom') !== bottomValue
  ) {
    stack.style.setProperty('--left-stack-safe-bottom', bottomValue);
  }
  stack.style.removeProperty('--left-stack-centered-height');
  for (const panel of panels) {
    panel.style.removeProperty('--left-panel-allocated-height');
    panel.style.removeProperty('--panel-overlap-top');
  }
  if (overlapping) {
    cascadePanels.forEach(({ panel }, index) => {
      const { offset, height } = overlapPlacements[index];
      panel.style.setProperty(
        '--panel-overlap-top',
        `${(overlapOrigin + offset).toFixed(1)}px`,
      );
      panel.style.setProperty(
        '--left-panel-allocated-height',
        `${height.toFixed(1)}px`,
      );
    });
  } else {
    expandedPanels.forEach((panel, index) => {
      panel.style.setProperty(
        '--left-panel-allocated-height',
        `${allocatedExpandedHeights[index].toFixed(1)}px`,
      );
    });
  }

  stack.classList.toggle('layout-overlap', overlapping);
  stack.classList.toggle('layout-focus', !overlapping && shouldFocus);
  stack.classList.toggle('layout-tail', !overlapping && shouldTail);
  stack.dataset.layoutMode = overlapping
    ? 'overlap'
    : shouldFocus
      ? 'focus'
      : shouldTail
        ? 'tail'
        : 'normal';
  stack.dataset.safeTopPct = topPct.toFixed(2);
  stack.dataset.safeBottomPct = (100 - bottomPct).toFixed(2);
  stack.dataset.availableHeightPct = (
    (availableHeight / viewportHeight) *
    100
  ).toFixed(2);
  stack.dataset.requiredHeightPct = (
    (requiredHeight / viewportHeight) *
    100
  ).toFixed(2);
  stack.dataset.tailAvailableHeightPct = (
    (tailAvailableHeight / viewportHeight) *
    100
  ).toFixed(2);
  stack.dataset.expandedCount = String(expandedPanels.length);

  // Cockpit Display/Radio live in the opposite margin and no longer borrow
  // this corridor: the left accordion's top is solved against left-lane
  // obstacles, which put the strip straight through the briefing card.
  // CockpitView.syncSignalLayout() owns `--cockpit-utility-top` instead.

  // Collapsed siblings stay visible and reachable in every mode (owner
  // ruling, 2026-09-27), so none is hidden from assistive technology either.
  for (const panel of panels) panel.removeAttribute('aria-hidden');
  // The boxes have their height back, so the scrollers can go back to where
  // they were before this pass measured anything.
  restorePanelScroll(scrollMarks);
  // The right controls share this top baseline; update them after the left
  // accordion commits an HUD-variant or obstacle-driven position change.
  onAligned();
}
