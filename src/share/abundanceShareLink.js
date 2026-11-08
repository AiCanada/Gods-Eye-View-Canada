/**
 * God's Eye View Canada: the meeting point of the GLOBAL ABUNDANCE MAP box
 * (src/abundancePanel.js, made by the startup chrome) and the share-link
 * manager (src/sharelink.js, made by the application shell), which never
 * see each other. The box connects once it is built; the manager reads its
 * state through `abundanceShareState` and is told of changes; a shared
 * state that arrives before the box exists waits for it.
 */

let box = null;
let manager = null;
let waiting = null;

/**
 * The box offers its `shareState()` and `applyShareState(state)`; a state
 * that arrived first is applied now. Returns the disconnect.
 */
export function connectAbundanceShare(target) {
  if (!target || typeof target.applyShareState !== 'function') return () => {};
  box = target;
  if (waiting) {
    const state = waiting;
    waiting = null;
    target.applyShareState(state);
  }
  return () => {
    if (box === target) box = null;
  };
}

/** The manager that writes the links; the box tells it of changes. */
export function setAbundanceShareManager(target) {
  manager = target || null;
}

/** The box's state for a link, or null without a box. */
export function abundanceShareState() {
  return box?.shareState?.() ?? null;
}

/** The box changed: the live link follows. */
export function noteAbundanceShareChange() {
  manager?.onAbundanceStateChange?.();
}

/** A link's box state: applied now, or kept for the box when it comes. */
export function restoreAbundanceShare(state) {
  if (!state || typeof state !== 'object') return false;
  if (box) return Boolean(box.applyShareState(state));
  waiting = state;
  return true;
}

/** Forget everything (tests, teardown). */
export function resetAbundanceShare() {
  box = null;
  manager = null;
  waiting = null;
}
