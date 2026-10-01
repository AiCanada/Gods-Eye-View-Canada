/**
 * Resolve a vertically centered panel slot inside a HUD rail while respecting
 * live rectangles that intersect that rail above or below the viewport center.
 */
export function resolveHudRailLayout({
  viewportHeight,
  panelHeight,
  laneLeft,
  laneRight,
  obstacles = [],
  baseTop,
  baseBottom,
  gap = 12,
  align = 'center',
}) {
  if (
    ![
      viewportHeight,
      panelHeight,
      laneLeft,
      laneRight,
      baseTop,
      baseBottom,
    ].every(Number.isFinite) ||
    viewportHeight <= 0 ||
    laneRight <= laneLeft
  )
    return null;
  const midpoint = viewportHeight * 0.5;
  let safeTop = Math.max(0, baseTop);
  let safeBottom = Math.min(viewportHeight, baseBottom);

  for (const rect of obstacles) {
    if (
      ![rect?.left, rect?.right, rect?.top, rect?.bottom].every(Number.isFinite)
    )
      continue;
    if (
      rect.right <= laneLeft ||
      rect.left >= laneRight ||
      rect.bottom <= rect.top
    )
      continue;
    if (rect.bottom <= midpoint) safeTop = Math.max(safeTop, rect.bottom + gap);
    else if (rect.top >= midpoint)
      safeBottom = Math.min(safeBottom, rect.top - gap);
  }

  safeBottom = Math.max(safeTop, safeBottom);
  const availableHeight = Math.max(0, safeBottom - safeTop);
  const renderedHeight = Math.min(Math.max(0, panelHeight), availableHeight);
  return {
    top:
      align === 'start'
        ? safeTop
        : safeTop + Math.max(0, (availableHeight - renderedHeight) * 0.5),
    maxHeight: availableHeight,
    safeTop,
    safeBottom,
    constrained: panelHeight > availableHeight,
  };
}

/**
 * The one surface an overlapping box may still not cover. Cesium and Google
 * both require their credit line to stay legible while their content is on
 * screen, so it keeps bounding the corridor after the owner ruling of
 * 2026-09-28 released the boxes from every other obstacle.
 *
 * @param {Element} element Obstacle node the rail is measuring.
 * @returns {boolean} Whether it carries required attribution.
 */
export function isAttributionObstacle(element) {
  return Boolean(element?.closest?.('#cesium-credits'));
}

/**
 * Reads back the stacking rank the click-to-raise handler wrote on a box.
 * The rank is the rail's own record of what the operator touched last, and
 * the cascade has to place the boxes in the same order it paints them, so
 * the layout pass reads the value rather than keeping a second copy of it.
 *
 * @param {Element} panel Rail box being placed.
 * @returns {number} Its rank, or 0 before any has been written.
 */
export function readPanelStackingRank(panel) {
  const rank = Number(panel?.style?.getPropertyValue?.('--panel-raise-z'));
  return Number.isFinite(rank) ? rank : 0;
}

/**
 * Tactical HUD gives an expanded right-rail panel the whole control lane.
 * Other HUD layouts keep collapsed launchers visible for quick switching.
 *
 * @param {object} input Current rail state.
 * @param {string} input.hudVariant Active HUD layout variant.
 * @param {boolean} input.hasExpandedPanel Whether any rail panel is expanded.
 * @returns {boolean} Whether collapsed sibling launchers should be hidden.
 */
export function shouldHideCollapsedRightPanels({
  hudVariant,
  hasExpandedPanel,
}) {
  // Owner ruling, 2026-09-27: the collapsed tabs stay in reach while a box is
  // open, on every HUD layout, so a second (and third) box can be opened
  // beside it; open boxes share the rail and scroll. The tactical HUD used to
  // hide the other tabs as soon as one box opened.
  void hudVariant;
  void hasExpandedPanel;
  return false;
}

/**
 * Where every scroller inside these panels is sitting. A layout pass has to
 * drop each panel's allocated height to read its natural one, and with the
 * height gone the box no longer overflows, so the browser forces its
 * scroller back to the top; restoring the height afterwards does not undo
 * that. Recording the positions first and putting them back at the end is
 * what keeps a box the owner is reading from jumping to the top under them
 * (owner ruling, 2026-09-28).
 */
export function capturePanelScroll(panels) {
  const marks = [];
  for (const panel of panels || []) {
    if (!panel?.querySelectorAll) continue;
    for (const node of [panel, ...panel.querySelectorAll('*')]) {
      const top = node.scrollTop;
      const left = node.scrollLeft;
      if (top > 0 || left > 0) marks.push({ node, top, left });
    }
  }
  return marks;
}

/** Put every recorded scroller back, once the panels have their height again. */
export function restorePanelScroll(marks) {
  for (const { node, top, left } of marks || []) {
    if (top > 0 && node.scrollTop !== top) node.scrollTop = top;
    if (left > 0 && node.scrollLeft !== left) node.scrollLeft = left;
  }
}
