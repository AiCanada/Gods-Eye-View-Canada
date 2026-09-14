import { StyleManager } from '../ui.js';
import { flyToStartupLocation } from '../camera.js';
import { CITY_POIS } from '../locations.js';
import { STARTUP_LOCATION_ID } from '../startupDefaults.js';
import { initCockpitCloudEffects } from '../cockpitCloudEffects.js';
import { initSeaSurfaceTemperaturePanel } from '../data/seaSurfaceTemperature.js';
import { initPrivateSiteLocations } from '../privateSiteLocations.js';

/** Construct the existing controls and camera presentation. */
export function createStandaloneControls({
  scene: { viewer, mapStackController },
  loaderStatus,
  placeSearch,
  defer,
}) {
  // Initialize the style manager (post-processing, HUD, locations, share links)
  const styleManager = new StyleManager(viewer, {
    mapStackController,
    placeSearch,
  });
  defer(() => styleManager.orbitController.stop());
  defer(() => styleManager.hud.destroy());
  defer(() => styleManager.dispose());
  // The previous multi-canvas weather compositor remains disabled. Cockpit
  // clouds use a separate, capped low-resolution GPU pass that never attaches
  // Cesium fog or post-process stages and is fully stopped in map mode.
  const weatherEffects = null;
  const cockpitCloudEffects = initCockpitCloudEffects(viewer);
  defer(() => cockpitCloudEffects?.destroy());
  // Sea Surface Temperature box: always off at launch, never persisted.
  defer(initSeaSurfaceTemperaturePanel({ viewer }));
  // Saved home and business security sites join the LOCATION pills.
  defer(
    initPrivateSiteLocations({
      onChange: (entries) => styleManager.setPrivateSiteLocations(entries),
    }),
  );

  // If no share link state, fly to the launch location
  if (!styleManager.hasShareState) {
    const city = CITY_POIS[STARTUP_LOCATION_ID];
    loaderStatus.textContent = `Flying to ${city.name}...`;
    defer(flyToStartupLocation(viewer, city.pois[0]));
    styleManager.markActiveLocation(STARTUP_LOCATION_ID);
  } else {
    loaderStatus.textContent = 'Restoring shared view...';
  }

  return { styleManager, weatherEffects, cockpitCloudEffects };
}
