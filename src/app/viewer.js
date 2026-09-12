import * as Cesium from 'cesium';

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
    msaaSamples: 4,
    contextOptions: { webgl: { preserveDrawingBuffer: true } },
  });
  try {
    viewer.targetFrameRate = 60;
    viewer.scene.screenSpaceCameraController.zoomEventTypes =
      globeZoomEventTypes();
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
