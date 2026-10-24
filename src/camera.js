import * as Cesium from 'cesium';

/**
 * Set camera to Austin on load with a cinematic fly-in.
 * @returns {Function} Cancels the pending or active startup flight.
 */
export function flyToAustin(viewer) {
  // Start from a high altitude, then fly down
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(-97.7431, 30.2672, 25000),
    orientation: {
      heading: Cesium.Math.toRadians(0),
      pitch: Cesium.Math.toRadians(-90),
      roll: 0.0,
    },
  });

  // Cinematic fly-in after a brief pause
  const timer = setTimeout(() => {
    if (viewer.isDestroyed()) return;
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(-97.7431, 30.2672, 600),
      orientation: {
        heading: Cesium.Math.toRadians(15),
        pitch: Cesium.Math.toRadians(-30),
        roll: 0.0,
      },
      duration: 4.0,
      easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
    });
  }, 500);
  return () => {
    clearTimeout(timer);
    if (!viewer.isDestroyed()) viewer.camera.cancelFlight();
  };
}

/**
 * Cinematic launch fly-in to a preset POI: straight down from 25 km, then an
 * oblique arrival at the POI's height, pitch and heading. The camera stands
 * back along the heading so the POI itself sits in the middle of the view.
 * @param {object} viewer
 * @param {{lat:number, lon:number, alt:number, pitch:number, heading:number}} poi
 * @returns {Function} Cancels the pending or active startup flight.
 */
export function flyToStartupLocation(viewer, poi) {
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(poi.lon, poi.lat, 25000),
    orientation: {
      heading: Cesium.Math.toRadians(0),
      pitch: Cesium.Math.toRadians(-90),
      roll: 0.0,
    },
  });

  const pitchRad = Cesium.Math.toRadians(poi.pitch);
  const headingRad = Cesium.Math.toRadians(poi.heading);
  const standBackM = poi.alt / Math.tan(Math.abs(pitchRad));
  const metresPerDegLat = 111320;
  const cameraLat =
    poi.lat - (standBackM * Math.cos(headingRad)) / metresPerDegLat;
  const cameraLon =
    poi.lon -
    (standBackM * Math.sin(headingRad)) /
      (metresPerDegLat * Math.cos(Cesium.Math.toRadians(poi.lat)));

  const timer = setTimeout(() => {
    if (viewer.isDestroyed()) return;
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(cameraLon, cameraLat, poi.alt),
      orientation: { heading: headingRad, pitch: pitchRad, roll: 0.0 },
      duration: 4.0,
      easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
    });
  }, 500);
  return () => {
    clearTimeout(timer);
    if (!viewer.isDestroyed()) viewer.camera.cancelFlight();
  };
}
