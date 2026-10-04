import * as Cesium from 'cesium';
import { installRenderRecovery } from './renderRecovery.js';
import { applyModelAtmosphereWorkaround } from './atmosphereCompat.js';

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

/** Create the standard globe viewer in caller-owned, visible containers. */
export function createApplicationViewer({ container, creditContainer }) {
  if (!container || !creditContainer)
    throw new TypeError('Viewer and credit containers are required');
  const viewer = new Cesium.Viewer(container, {
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
    creditContainer,
    // Frame errors are handled by installRenderRecovery, which restarts the
    // loop and raises this same modal itself once an error proves permanent.
    // (Constructor-only: Cesium has no setter for it.)
    showRenderLoopErrors: false,
    msaaSamples: 4,
    contextOptions: { webgl: { preserveDrawingBuffer: true } },
  });
  try {
    viewer.targetFrameRate = 60;
    // Before any tile builds a draw command: Cesium's per-vertex model
    // atmosphere fails to LINK on Apple's Metal backend and kills the
    // render loop. See app/atmosphereCompat.js.
    applyModelAtmosphereWorkaround(viewer.scene);
    viewer.scene.screenSpaceCameraController.zoomEventTypes =
      globeZoomEventTypes();
    // Twice Cesium's default of 5: wheel and trackpad zoom felt sluggish.
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
