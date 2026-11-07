import * as Cesium from 'cesium';
import { installRenderRecovery } from './renderRecovery.js';
import { applyModelAtmosphereWorkaround } from './atmosphereCompat.js';
import { StarrySky } from '../sky/starrySky.js';
import {
  FREE_LOOK_MAX_HEIGHT_METERS,
  globeOutOfFrame,
  isFreeGlobeCamera,
} from '../globeInView.js';

/**
 * Wheel events this module dispatched itself (a combined trackpad step or a
 * relayed pinch). Both trackpad handlers skip them so neither re-amplifies the
 * other's output.
 */
const relayedWheelEvents = new WeakSet();

/** Wheel and trackpad zoom speed; Cesium's default is 5. */
export const GLOBE_ZOOM_FACTOR = 10;

/**
 * Camera inputs that zoom the globe.
 *
 * Cesium's default set is right-drag, wheel and a two-finger pinch on a touch
 * screen. A trackpad pinch is none of those: Chrome, Edge and Safari deliver
 * it as a `wheel` event with `ctrlKey` set (the same shape as ctrl+scroll),
 * Cesium files that under its CTRL modifier, and the default set consumes only
 * the unmodified wheel — so the gesture did nothing at all. Cesium still calls
 * preventDefault on it, so it did not even fall through to browser page zoom.
 * Naming the CTRL wheel as a zoom input makes the pinch zoom the globe.
 *
 * @param {typeof Cesium} [cesium] Cesium namespace, injectable for tests.
 * @returns {Array} Value for ScreenSpaceCameraController.zoomEventTypes.
 */
export function globeZoomEventTypes(cesium = Cesium) {
  return [
    cesium.CameraEventType.RIGHT_DRAG,
    cesium.CameraEventType.WHEEL,
    cesium.CameraEventType.PINCH,
    {
      eventType: cesium.CameraEventType.WHEEL,
      modifier: cesium.KeyboardEventModifier.CTRL,
    },
  ];
}

/** Extra zoom for a trackpad two-finger scroll, whose steps are a few pixels. */
export const TRACKPAD_SCROLL_GAIN = 3;
/** Extra zoom for a trackpad pinch (a ctrl wheel of a pixel or two per event). */
export const TRACKPAD_PINCH_GAIN = 8;
/** Largest combined wheel step handed to Cesium in one frame. */
const TRACKPAD_BURST_LIMIT = 600;

/**
 * How much a wheel event is boosted. A mouse wheel moves in whole notches
 * (about 100 px, or lines) and is left alone. A trackpad streams small or
 * fractional pixel steps, and a pinch arrives as a ctrl wheel.
 * @param {WheelEvent} event
 * @returns {number} 1 for a mouse wheel, otherwise the trackpad gain.
 */
export function trackpadWheelGain(event) {
  if (!event || event.deltaMode !== 0) return 1;
  if (event.ctrlKey) return TRACKPAD_PINCH_GAIN;
  const step = Math.abs(event.deltaY);
  if (step === 0) return 1;
  if (step < 40 || (!Number.isInteger(event.deltaY) && step < 60))
    return TRACKPAD_SCROLL_GAIN;
  return 1;
}

/**
 * Make trackpad zoom keep up. Cesium keeps only the last wheel event of each
 * frame, and a trackpad sends several tiny ones per frame, so most of the
 * gesture was thrown away. Trackpad wheel events over the globe are caught
 * before Cesium sees them, added up (with a gain) and handed on as one wheel
 * event per frame. Mouse wheels pass straight through.
 * @returns {() => void} Removes the listener.
 */
export function bindTrackpadZoom({
  container,
  canvas,
  isDestroyed = () => false,
  requestFrame = (callback) => requestAnimationFrame(callback),
  WheelEventCtor = globalThis.WheelEvent,
}) {
  if (
    typeof container?.addEventListener !== 'function' ||
    typeof canvas?.dispatchEvent !== 'function' ||
    typeof WheelEventCtor !== 'function'
  )
    return () => {};
  let pending = null;
  let frame = null;
  const flush = () => {
    frame = null;
    const burst = pending;
    pending = null;
    if (!burst || isDestroyed()) return;
    const deltaY = Math.max(
      -TRACKPAD_BURST_LIMIT,
      Math.min(TRACKPAD_BURST_LIMIT, burst.deltaY),
    );
    const combined = new WheelEventCtor('wheel', {
      deltaY,
      deltaMode: 0,
      clientX: burst.clientX,
      clientY: burst.clientY,
      ctrlKey: burst.ctrlKey,
      bubbles: true,
      cancelable: true,
    });
    if (combined && typeof combined === 'object')
      relayedWheelEvents.add(combined);
    canvas.dispatchEvent(combined);
  };
  const onWheel = (event) => {
    if (isDestroyed()) {
      unbind();
      return;
    }
    // Synthetic events (including the combined one) are not caught again.
    if (!event.isTrusted || event.target !== canvas) return;
    const gain = trackpadWheelGain(event);
    if (gain === 1) return;
    event.preventDefault();
    event.stopPropagation();
    if (pending && pending.ctrlKey !== event.ctrlKey) flush();
    pending ??= { deltaY: 0, ctrlKey: event.ctrlKey, clientX: 0, clientY: 0 };
    pending.deltaY += event.deltaY * gain;
    pending.clientX = event.clientX;
    pending.clientY = event.clientY;
    frame ??= requestFrame(flush);
  };
  const unbind = () =>
    container.removeEventListener('wheel', onWheel, { capture: true });
  container.addEventListener('wheel', onWheel, {
    capture: true,
    passive: false,
  });
  return unbind;
}

const PINCH_ZOOM_MULTIPLIER = 8;
const MAX_PINCH_PIXEL_DELTA = 120;

function boundedPinchDelta(delta) {
  if (!Number.isFinite(delta) || delta === 0) return delta;
  return (
    Math.sign(delta) *
    Math.min(Math.abs(delta) * PINCH_ZOOM_MULTIPLIER, MAX_PINCH_PIXEL_DELTA)
  );
}

/**
 * Add browser trackpad pinch to Cesium's zoom inputs and return its disposer.
 * Browsers expose this gesture as a small pixel-mode Ctrl+wheel event.
 */
export function installTrackpadPinchZoom(
  viewer,
  { createWheelEvent = (type, init) => new WheelEvent(type, init) } = {},
) {
  const controller = viewer?.scene?.screenSpaceCameraController;
  const container = viewer?.container;
  const canvas = viewer?.canvas;
  if (!controller || !container || !canvas)
    throw new TypeError('A complete Cesium viewer is required');

  const originalZoomEventTypes = controller.zoomEventTypes;
  const zoomEventTypes = Array.isArray(originalZoomEventTypes)
    ? originalZoomEventTypes
    : originalZoomEventTypes === undefined
      ? []
      : [originalZoomEventTypes];
  const alreadyHandlesControlWheel = zoomEventTypes.some(
    (binding) =>
      binding?.eventType === Cesium.CameraEventType.WHEEL &&
      binding?.modifier === Cesium.KeyboardEventModifier.CTRL,
  );
  const configuredZoomEventTypes = alreadyHandlesControlWheel
    ? originalZoomEventTypes
    : [
        ...zoomEventTypes,
        {
          eventType: Cesium.CameraEventType.WHEEL,
          modifier: Cesium.KeyboardEventModifier.CTRL,
        },
      ];
  if (!alreadyHandlesControlWheel)
    controller.zoomEventTypes = configuredZoomEventTypes;

  const relayedEvents = relayedWheelEvents;
  const relayPinch = (event) => {
    if (
      !event.ctrlKey ||
      relayedEvents.has(event) ||
      // bindTrackpadZoom (installed with the viewer) already took this event
      // and hands Cesium its own combined step.
      event.defaultPrevented ||
      event.deltaMode !== 0 ||
      !Number.isFinite(event.deltaY) ||
      event.deltaY === 0
    )
      return;
    let relayed;
    try {
      relayed = createWheelEvent('wheel', {
        deltaX: event.deltaX,
        deltaY: boundedPinchDelta(event.deltaY),
        deltaZ: event.deltaZ,
        deltaMode: event.deltaMode,
        screenX: event.screenX,
        screenY: event.screenY,
        clientX: event.clientX,
        clientY: event.clientY,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
        view: globalThis.window,
      });
    } catch {
      // The registered Ctrl+wheel binding can still consume the original.
      return;
    }
    relayedEvents.add(relayed);
    event.preventDefault();
    event.stopPropagation();
    canvas.dispatchEvent(relayed);
  };
  container.addEventListener('wheel', relayPinch, {
    capture: true,
    passive: false,
  });

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    container.removeEventListener('wheel', relayPinch, true);
    if (
      !alreadyHandlesControlWheel &&
      controller.zoomEventTypes === configuredZoomEventTypes
    )
      controller.zoomEventTypes = originalZoomEventTypes;
  };
}

/**
 * Allow Cesium's free look only below `maxHeight` and return its disposer.
 * Orbit, tilt and zoom stay available at every height. A value other code
 * sets later is kept as the one to allow below that height, and restored on
 * dispose; a `false` written while the camera is above `maxHeight` cannot be
 * told apart from this limit's own write, so dispose restores the earlier
 * value then. `enableLook` gates the Shift+drag binding only: below its trackball
 * height Cesium also turns the camera in place for a drag that starts on the
 * stars. That height is lowered to `maxHeight` too, so above it such a drag
 * orbits the globe, as it does above Cesium's own 7,500 km.
 */
export function installFreeLookHeightLimit(
  viewer,
  maxHeight = FREE_LOOK_MAX_HEIGHT_METERS,
) {
  const scene = viewer?.scene;
  const controller = scene?.screenSpaceCameraController;
  const camera = viewer?.camera;
  if (!controller || !camera || !scene?.preUpdate)
    throw new TypeError('A complete Cesium viewer is required');

  const originalTrackBallHeight = controller.minimumTrackBallHeight;
  const trackBallHeight = Math.min(originalTrackBallHeight, maxHeight);
  controller.minimumTrackBallHeight = trackBallHeight;
  let wanted = controller.enableLook;
  let written;
  const sync = () => {
    if (written !== undefined && controller.enableLook !== written)
      wanted = controller.enableLook;
    const height = camera.positionCartographic?.height;
    written = wanted && !(Number.isFinite(height) && height > maxHeight);
    controller.enableLook = written;
  };
  sync();
  const removeListener = scene.preUpdate.addEventListener(sync);

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    removeListener();
    if (controller.enableLook === written) controller.enableLook = wanted;
    if (controller.minimumTrackBallHeight === trackBallHeight)
      controller.minimumTrackBallHeight = originalTrackBallHeight;
  };
}

// How often a moving camera is sampled to see whether it has come to rest, how
// far a pose may drift between samples and still count as at rest, and how
// long after the camera last moved the check gives up if Cesium never raises
// moveEnd.
const SETTLE_SAMPLE_MS = 250;
const SETTLE_POSITION_TOLERANCE_M = 1e-3;
const SETTLE_DIRECTION_TOLERANCE = 1e-9;
const SETTLE_GIVE_UP_MS = 5 * 60_000;

/**
 * Turn the camera back to the planet when a move ends above `minHeight` with
 * no surface on screen (`globeOutOfFrame`: limb glow and slivers up to about
 * one sample cell thick can count as none), and return the disposer. Views with
 * more surface, such as an oblique orbital shot, are left as they are. This
 * catches a saved or shared view that looked away, or any other move that ends
 * looking away from the planet.
 * Heading and position are kept. Tracked cameras, locked ones (non-identity
 * transform), a camera flight in progress, a pointer held down on the canvas
 * (a drag held still), the 2D and Columbus modes, and any time `paused`
 * returns true (an authored scene playing) are left alone; a check they defer
 * runs once they end, however long they last.
 * `keyholeRadius`
 * returns the radius of the visible circle when a scope mask hides the rest of
 * the frame (see `globeFrameShare`), or 0; it is read at every check.
 *
 * Cesium's `moveEnd` alone is not enough: Cesium compares the camera with the
 * last frame's to the last rounding error, and at some of these poses the
 * camera drifts by a rounding error every frame, so Cesium never sees it stop.
 * So each `moveStart` also starts a check of its own that samples the pose
 * every 250 ms, with a tolerance for that drift, and once the pose has held
 * for half a second after moving runs the same recovery. It keeps watching
 * until Cesium raises `moveEnd`, since under that drift Cesium raises no new
 * `moveStart` for a later move, and gives up five minutes after the camera
 * last moved.
 * `setTimeout` and `clearTimeout` can be injected for tests.
 */
export function installGlobeInViewRecovery(
  viewer,
  {
    minHeight = FREE_LOOK_MAX_HEIGHT_METERS,
    keyholeRadius = () => 0,
    paused = () => false,
    setTimeout: schedule = globalThis.setTimeout,
    clearTimeout: unschedule = globalThis.clearTimeout,
  } = {},
) {
  const scene = viewer?.scene;
  const camera = viewer?.camera;
  if (!scene || !camera?.moveEnd || !camera?.moveStart)
    throw new TypeError('A complete Cesium viewer is required');

  // A pointer held on the globe is a gesture in progress, even when it holds
  // still for half a second: the check waits until every pointer pressed on
  // it (each finger of a pinch) is released. A release the page never sees,
  // outside the window, is taken as given when the window loses focus, the
  // page is hidden, the canvas loses the pointer's capture, or the pointer
  // moves with no button down.
  const canvas = scene.canvas;
  const releaseTarget = canvas?.ownerDocument ?? canvas;
  const releaseWindow = canvas?.ownerDocument?.defaultView;
  const heldPointers = new Set();
  const onPointerDown = (event) => heldPointers.add(event?.pointerId);
  const onPointerUp = (event) => heldPointers.delete(event?.pointerId);
  const onPointerMove = (event) => {
    if (event?.buttons === 0) heldPointers.delete(event.pointerId);
  };
  const releaseAll = () => heldPointers.clear();
  const onVisibilityChange = () => {
    if (canvas.ownerDocument.visibilityState === 'hidden') releaseAll();
  };
  const listeners = [
    [canvas, 'pointerdown', onPointerDown],
    [canvas, 'lostpointercapture', onPointerUp],
    [releaseTarget, 'pointerup', onPointerUp],
    [releaseTarget, 'pointercancel', onPointerUp],
    [releaseTarget, 'pointermove', onPointerMove],
    [canvas?.ownerDocument, 'visibilitychange', onVisibilityChange],
    [releaseWindow, 'blur', releaseAll],
  ];
  for (const [target, type, listener] of listeners)
    target?.addEventListener?.(type, listener);

  // Returns false while a flight, a paused scene or a held pointer defers the
  // check, so the caller can try again once it ends.
  const recover = () => {
    if (!isFreeGlobeCamera(viewer)) return true;
    // Cesium has no public running-flight flag.
    if (camera._currentFlight || paused() || heldPointers.size > 0)
      return false;
    const height = camera.positionCartographic?.height;
    if (
      !(height > minHeight) ||
      !globeOutOfFrame(camera, { keyholeRadius: keyholeRadius() })
    )
      return true;
    camera.setView({
      orientation: {
        heading: camera.heading,
        pitch: -Cesium.Math.PI_OVER_TWO,
        roll: 0,
      },
    });
    scene.requestRender?.();
    return true;
  };

  const lastPosition = new Cesium.Cartesian3();
  const lastDirection = new Cesium.Cartesian3();
  let settleTimer = null;
  let settleElapsed = 0;
  let restingSamples = 0;
  let movedSinceCheck = false;
  const stopSettling = () => {
    if (settleTimer !== null) unschedule(settleTimer);
    settleTimer = null;
  };
  const sample = () => {
    settleTimer = null;
    settleElapsed += SETTLE_SAMPLE_MS;
    const atRest =
      Cesium.Cartesian3.equalsEpsilon(
        camera.positionWC,
        lastPosition,
        0,
        SETTLE_POSITION_TOLERANCE_M,
      ) &&
      Cesium.Cartesian3.equalsEpsilon(
        camera.directionWC,
        lastDirection,
        0,
        SETTLE_DIRECTION_TOLERANCE,
      );
    restingSamples = atRest ? restingSamples + 1 : 0;
    if (!atRest) {
      movedSinceCheck = true;
      settleElapsed = 0;
    }
    // Two quiet samples in a row after a move: at rest for half a second, as
    // for moveEnd.
    if (restingSamples >= 2 && movedSinceCheck) {
      if (recover()) movedSinceCheck = false;
      // A flight or a playing scene bounds its own deferral.
      else settleElapsed = 0;
    }
    if (settleElapsed >= SETTLE_GIVE_UP_MS) return;
    Cesium.Cartesian3.clone(camera.positionWC, lastPosition);
    Cesium.Cartesian3.clone(camera.directionWC, lastDirection);
    settleTimer = schedule(sample, SETTLE_SAMPLE_MS);
  };
  const startSettling = () => {
    stopSettling();
    settleElapsed = 0;
    restingSamples = 0;
    movedSinceCheck = true;
    Cesium.Cartesian3.clone(camera.positionWC, lastPosition);
    Cesium.Cartesian3.clone(camera.directionWC, lastDirection);
    settleTimer = schedule(sample, SETTLE_SAMPLE_MS);
  };
  const removeMoveEnd = camera.moveEnd.addEventListener(() => {
    if (recover()) stopSettling();
    // Deferred: keep sampling so the check runs once the flight or scene ends.
    else if (settleTimer === null) startSettling();
  });
  const removeMoveStart = camera.moveStart.addEventListener(startSettling);

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    stopSettling();
    removeMoveEnd();
    removeMoveStart();
    for (const [target, type, listener] of listeners)
      target?.removeEventListener?.(type, listener);
    heldPointers.clear();
  };
}

/** Cesium.Viewer options of the standard globe viewer. */
export function applicationViewerOptions(creditContainer) {
  return {
    timeline: false,
    animation: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    vrButton: false,
    selectionIndicator: false,
    infoBox: false,
    baseLayer: false,
    // Replaces the blocky Tycho-2 default. An option, not `skyBox: false`,
    // which would also stop CesiumWidget from creating the Sun and Moon.
    skyBox: new StarrySky(),
    creditContainer,
    // Frame errors are handled by installRenderRecovery, which restarts the
    // loop and raises this same modal itself once an error proves permanent.
    // (Constructor-only: Cesium has no setter for it.)
    showRenderLoopErrors: false,
    msaaSamples: 4,
    contextOptions: { webgl: { preserveDrawingBuffer: true } },
  };
}

/** Create the standard globe viewer in caller-owned, visible containers. */
export function createApplicationViewer({ container, creditContainer }) {
  if (!container || !creditContainer)
    throw new TypeError('Viewer and credit containers are required');
  const viewer = new Cesium.Viewer(
    container,
    applicationViewerOptions(creditContainer),
  );
  try {
    viewer.targetFrameRate = 60;
    // A phone pinch spans fewer screen pixels than desktop zoom gestures.
    // Keep Cesium's distance-aware zoom and collision limits, with less travel
    // required on touch-first screens. Mouse/trackpad sensitivity stays native.
    if (globalThis.matchMedia?.('(pointer: coarse)').matches)
      viewer.scene.screenSpaceCameraController.zoomFactor *= 3;
    // Before any tile builds a draw command: Cesium's per-vertex model
    // atmosphere fails to LINK on Apple's Metal backend and kills the
    // render loop. See app/atmosphereCompat.js.
    applyModelAtmosphereWorkaround(viewer.scene);
    viewer.scene.screenSpaceCameraController.zoomEventTypes =
      globeZoomEventTypes();
    // Twice Cesium's default of 5: wheel and trackpad zoom felt sluggish. A
    // touch-first screen keeps the pinch setting above (three times the
    // default); set unconditionally here, this line used to undo it.
    if (!globalThis.matchMedia?.('(pointer: coarse)').matches)
      viewer.scene.screenSpaceCameraController.zoomFactor = GLOBE_ZOOM_FACTOR;
    bindTrackpadZoom({
      container: viewer.container,
      canvas: viewer.scene.canvas,
      isDestroyed: () => viewer.isDestroyed(),
    });
    // One failed asset load must not freeze the application for good.
    installRenderRecovery(viewer);
    viewer.scene.globe.show = false;
    viewer.scene.skyAtmosphere.show = true;
    viewer.scene.skyAtmosphere.atmosphereLightIntensity = 18;
    viewer.scene.skyAtmosphere.saturationShift = -0.12;
    viewer.scene.skyAtmosphere.brightnessShift = -0.08;
    return viewer;
  } catch (error) {
    viewer.destroy();
    throw error;
  }
}
