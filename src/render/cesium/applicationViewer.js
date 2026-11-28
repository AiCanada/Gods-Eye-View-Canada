import * as Cesium from 'cesium';
import { applyModelAtmosphereWorkaround } from '../../app/atmosphereCompat.js';
import { frameRateCap } from '../../renderGovernor.js';
import { relayedWheelEvents } from './ctrlWheelZoom.js';
import { preloadImageryAhead } from './imageryLookAhead.js';
import { installRenderRecovery } from './renderRecovery.js';
import { StarrySky } from './starrySky.js';

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
 * Naming the CTRL wheel as a zoom input makes the pinch zoom the globe. (The
 * application scene also asks the camera controls for `ctrlWheel`; bound
 * from the start, the controls relay pinches from the start too.)
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
 * event per frame. Mouse wheels pass straight through. The trackpad pinch
 * relay (`ctrlWheelZoom.js`) skips both the events taken here and the
 * combined one.
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

/**
 * At the farthest a hand can zoom out, the globe is this share of the
 * screen's height across. Cesium sets no limit, so zooming on left the globe
 * a speck among the stars.
 */
const MIN_GLOBE_SHARE = 0.3;

/**
 * The farthest a hand can zoom out, in metres above the ellipsoid, for a
 * vertical field of view. It follows the screen's shape, as the app's own
 * whole-globe view does, so that view always lies within it.
 * @param {number} fovy Vertical field of view, radians.
 */
export function zoomOutLimit(fovy) {
  const radius = Cesium.Ellipsoid.WGS84.maximumRadius;
  const angular = Math.atan(MIN_GLOBE_SHARE * Math.tan(fovy / 2));
  return radius / Math.sin(angular) - radius;
}

/**
 * Hold a hand's zoom out to `zoomOutLimit` on the globe, each frame, since the
 * field of view follows the screen's shape. The limit never sits below the
 * camera: one already past it (a flight, a screen turned) stops there rather
 * than jumping in at the next zoom. Flat maps keep Cesium's own, unlimited.
 * @returns {() => void} Stop limiting.
 */
export function limitZoomOut(viewer) {
  const { scene, camera } = viewer;
  return scene.preRender.addEventListener(() => {
    const controller = scene.screenSpaceCameraController;
    const fovy = camera.frustum.fovy;
    if (scene.mode !== Cesium.SceneMode.SCENE3D || !Number.isFinite(fovy)) {
      controller.maximumZoomDistance = Number.POSITIVE_INFINITY;
      return;
    }
    controller.maximumZoomDistance = Math.max(
      zoomOutLimit(fovy),
      camera.positionCartographic?.height ?? 0,
    );
  });
}

// Dev convenience: expose the app's Cesium instance for console/preview probing
// (single shared module instance — avoids dual-Cesium state bugs when testing).
if (typeof window !== 'undefined' && !window.__CESIUM__)
  window.__CESIUM__ = Cesium;

/**
 * Cesium.Viewer options of the standard globe viewer. `showRenderLoopErrors`
 * false leaves render errors to the caller's own notice instead of Cesium's
 * panel; `msaa` is the multisampling to start with (0 off, 4 by default).
 * The drawing buffer is kept after presenting, for `capture` and
 * `readPixels` to read the frame drawn.
 */
export function applicationViewerOptions(
  creditContainer,
  { showRenderLoopErrors = true, msaa = 4 } = {},
) {
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
    // Cesium's 1 is no multisampling.
    msaaSamples: msaa || 1,
    contextOptions: { webgl: { preserveDrawingBuffer: true } },
    showRenderLoopErrors,
  };
}

/**
 * Create the standard globe viewer in caller-owned, visible containers;
 * `msaa` as `applicationViewerOptions` takes it. A frame error restarts
 * the render loop (`installRenderRecovery`); Cesium's panel, unless
 * `showRenderLoopErrors` is false, comes only once an error outlasts the
 * restarts.
 */
export function createApplicationViewer({
  container,
  creditContainer,
  showRenderLoopErrors,
  msaa,
}) {
  if (!container || !creditContainer)
    throw new TypeError('Viewer and credit containers are required');
  const viewer = new Cesium.Viewer(
    container,
    applicationViewerOptions(creditContainer, {
      // Constructor-only in Cesium: with it, the widget shows its panel on
      // the first frame error. installRenderRecovery below restarts the loop
      // instead, and raises the same panel itself (when the caller wants it)
      // once an error proves permanent.
      showRenderLoopErrors: false,
      msaa,
    }),
  );
  try {
    // Until the render governor takes over (src/renderGovernor.js, installed
    // by src/app/scene.js), tick at its cap (the Display panel's Frame rate;
    // undefined, the display's rate, when unlimited).
    viewer.targetFrameRate = frameRateCap() || undefined;
    // No double-click follow or zoom: the Viewer's own (it tracked or
    // zoomed to the entity picked) is off. Following is a layer's click.
    viewer.screenSpaceEventHandler.removeInputAction(
      Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK,
    );
    // A phone pinch spans fewer screen pixels than desktop zoom gestures.
    // Keep Cesium's distance-aware zoom and collision limits, with less travel
    // required on touch-first screens. Mouse/trackpad sensitivity follows.
    if (globalThis.matchMedia?.('(pointer: coarse)').matches)
      viewer.scene.screenSpaceCameraController.zoomFactor *= 3;
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
    // One failed asset load must not freeze the application for good. A
    // caller without Cesium's panel shows its own notice (renderFailure.js).
    installRenderRecovery(viewer, {
      showErrorPanel: showRenderLoopErrors !== false,
    });
    limitZoomOut(viewer);
    // A narrow view carried along an orbit outruns the imagery under it.
    preloadImageryAhead(viewer);
    // Before any tile builds a draw command: Cesium's per-vertex model
    // atmosphere fails to LINK on Apple's Metal backend and kills the
    // render loop. See app/atmosphereCompat.js.
    applyModelAtmosphereWorkaround(viewer.scene);
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
