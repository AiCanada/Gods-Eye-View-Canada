import { toRadians } from './geo/index.js';
import { cameraOf } from './render/rendererOf.js';

/**
 * The view the renderer starts from: the whole planet, looking straight
 * down, centred where Cesium's default view rectangle is.
 */
export const START_VIEW = Object.freeze({
  lon: -82.5,
  lat: 35,
  height: 23000000,
});

/**
 * Put the camera at a start view without a flight. A host may pass a city
 * (`{ lon, lat, height, heading?, pitch? }`, angles in degrees) instead of
 * the planet.
 */
export function applyStartView(viewer, view = START_VIEW) {
  const { lon, lat, height, heading = 0, pitch = -90 } = view;
  cameraOf(viewer).setView({
    destination: { lon, lat, height },
    orientation: {
      heading: toRadians(heading),
      pitch: toRadians(pitch),
      roll: 0,
    },
  });
}

/**
 * Where the camera stands to look at a preset POI: at the POI's height, pitch
 * and heading, stood back along the heading so the POI sits in the middle of
 * the view. Degrees and metres.
 * @param {{lat:number, lon:number, alt:number, pitch:number, heading:number}} poi
 * @returns {{lon:number, lat:number, height:number, heading:number, pitch:number}}
 */
function poiCameraPose(poi) {
  const pitchRad = toRadians(poi.pitch);
  const headingRad = toRadians(poi.heading);
  const standBackM = poi.alt / Math.tan(Math.abs(pitchRad));
  const metresPerDegLat = 111320;
  return {
    lat: poi.lat - (standBackM * Math.cos(headingRad)) / metresPerDegLat,
    lon:
      poi.lon -
      (standBackM * Math.sin(headingRad)) /
        (metresPerDegLat * Math.cos(toRadians(poi.lat))),
    height: poi.alt,
    heading: poi.heading,
    pitch: poi.pitch,
  };
}

/**
 * God's Eye View Canada: a launch city's first POI as a start view
 * (applyStartView), the pose the launch fly-in ends at. `cityId` names the
 * city, so the controls know the camera starts there; the opening
 * (src/app/openingIntro.js) closes in on it from the planet.
 * @param {string} cityId - CITY_POIS id.
 * @param {{lat:number, lon:number, alt:number, pitch:number, heading:number}} poi
 */
export function startupLocationView(cityId, poi) {
  return Object.freeze({ ...poiCameraPose(poi), cityId });
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
  const camera = cameraOf(viewer);
  camera.setView({
    destination: { lon: poi.lon, lat: poi.lat, height: 25000 },
    orientation: { heading: 0, pitch: toRadians(-90), roll: 0 },
  });

  const pose = poiCameraPose(poi);
  const pitchRad = toRadians(pose.pitch);
  const headingRad = toRadians(pose.heading);
  const cameraLat = pose.lat;
  const cameraLon = pose.lon;

  let flight = null;
  // A scene host need not say whether it is gone (`isDestroyed` is
  // optional, as src/render/rendererOf.js reads it).
  const timer = setTimeout(() => {
    if (viewer.isDestroyed?.()) return;
    flight = camera.flyTo(
      { lon: cameraLon, lat: cameraLat, height: poi.alt },
      {
        orientation: { heading: headingRad, pitch: pitchRad, roll: 0 },
        durationS: 4.0,
        easing: 'cubicInOut',
      },
    );
  }, 500);
  return () => {
    clearTimeout(timer);
    // Only the fly-in: a flight the user started since is theirs.
    if (!viewer.isDestroyed?.()) flight?.cancel();
  };
}
