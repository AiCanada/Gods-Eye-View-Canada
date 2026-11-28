import { createApplicationControls } from '../app/controls.js';
import { applicationServices } from '../services/application.js';
import { getStandaloneCatalog } from './catalog.js';
import { homeCountryView } from '../homeCountry.js';
import { startupLocationView } from '../camera.js';
import { CITY_POIS } from '../cityPois.js';
import { STARTUP_LOCATION_ID } from '../startupDefaults.js';
export function createStandaloneControls(options) {
  return createApplicationControls({
    catalog: options?.catalog ?? getStandaloneCatalog(),
    // God's Eye View Canada: the camera starts at the launch city, where the
    // opening closes in from the planet (src/app/openingIntro.js).
    startView: startupLocationView(
      STARTUP_LOCATION_ID,
      CITY_POIS[STARTUP_LOCATION_ID].pois[0],
    ),
    // The planet over the visitor's country; the title's logo goes back here.
    homeView: homeCountryView(),
    spotWeatherService: applicationServices.weather,
    ...options,
  });
}
