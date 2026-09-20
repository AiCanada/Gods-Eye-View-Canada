/**
 * Render-loop recovery.
 *
 * Cesium stops its render loop for good the first time anything throws inside
 * a frame, and shows a modal. Several of its own primitives rethrow a failed
 * ASSET load from inside the frame (the star-field sky box, the moon texture),
 * so one dropped request during start-up (a dev-server restart, a flaky
 * connection) left the whole application frozen until a manual reload, with
 * every data layer still healthy behind the modal.
 *
 * A frame error is now survived: the loop restarts after a short, growing
 * pause. Nothing is hidden for long. An error that keeps coming back exhausts
 * a small budget and then gets exactly the modal it always got.
 */

/** Restarts allowed inside one window before the error is treated as permanent. */
export const RENDER_RECOVERY_MAX_RESTARTS = 5;
/** The window those restarts are counted in. */
export const RENDER_RECOVERY_WINDOW_MS = 60 * 1000;
/** First pause before restarting; doubles with each restart still in the window. */
export const RENDER_RECOVERY_BASE_DELAY_MS = 250;
export const RENDER_RECOVERY_MAX_DELAY_MS = 4000;

/**
 * Decide what to do about one frame error. Pure.
 * @param {number[]} history Times (ms) of earlier restarts.
 * @param {number} now
 * @returns {{restart: boolean, delayMs: number, history: number[]}} `history`
 *   is the pruned list, with `now` appended when a restart is granted.
 */
export function planRenderRecovery(history, now) {
  const recent = (history || []).filter(
    (at) => now - at < RENDER_RECOVERY_WINDOW_MS,
  );
  if (recent.length >= RENDER_RECOVERY_MAX_RESTARTS) {
    return { restart: false, delayMs: 0, history: recent };
  }
  const delayMs = Math.min(
    RENDER_RECOVERY_MAX_DELAY_MS,
    RENDER_RECOVERY_BASE_DELAY_MS * 2 ** recent.length,
  );
  return { restart: true, delayMs, history: [...recent, now] };
}

/** A short, log-safe description of whatever a frame threw. */
export function describeRenderError(error) {
  if (!error) return 'unknown error';
  if (typeof error === 'string') return error.slice(0, 300);
  const name = error.name || error.constructor?.name || 'Error';
  const detail =
    error.message ||
    (error.statusCode ? `status ${error.statusCode}` : '') ||
    (error.response ? String(error.response).slice(0, 120) : '');
  return `${name}${detail ? `: ${detail}` : ''}`.slice(0, 300);
}

/**
 * Keep a viewer rendering through frame errors.
 * @param {import('cesium').Viewer} viewer
 * @param {{now?: () => number, setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout, log?: (message: string) => void}} [options]
 * @returns {() => void} Uninstall.
 */
export function installRenderRecovery(
  viewer,
  {
    now = () => Date.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (id) => clearTimeout(id),
    log = (message) => console.warn(message),
  } = {},
) {
  const widget = viewer?.cesiumWidget;
  const scene = viewer?.scene;
  if (!widget || !scene?.renderError?.addEventListener) return () => {};
  // The widget still stops its loop on an error. Its own modal is switched off
  // where the viewer is built (`showRenderLoopErrors: false`, a constructor-only
  // option), so the modal appears when, and only when, the budget runs out.
  let history = [];
  let timer = null;
  const onError = (_scene, error) => {
    const plan = planRenderRecovery(history, now());
    history = plan.history;
    const what = describeRenderError(error);
    if (!plan.restart) {
      log(`[Render] frame error persists, rendering stopped: ${what}`);
      try {
        widget.showErrorPanel(
          'An error occurred while rendering.  Rendering has stopped.',
          undefined,
          error,
        );
      } catch {
        /* the panel is best-effort */
      }
      return;
    }
    log(
      `[Render] frame error survived (restart ${history.length}/${RENDER_RECOVERY_MAX_RESTARTS} in ${plan.delayMs} ms): ${what}`,
    );
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      if (viewer.isDestroyed?.()) return;
      // A hidden tab has its loop parked on purpose; whoever parked it
      // restarts it when the tab returns.
      if (typeof document !== 'undefined' && document.hidden) return;
      viewer.useDefaultRenderLoop = true;
      scene.requestRender?.();
    }, plan.delayMs);
  };
  const remove = scene.renderError.addEventListener(onError);
  return () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    if (typeof remove === 'function') remove();
    else scene.renderError.removeEventListener?.(onError);
  };
}
