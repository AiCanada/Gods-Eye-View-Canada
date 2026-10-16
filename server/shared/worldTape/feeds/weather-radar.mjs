/**
 * World tape feed: NOAA MRMS radar reflectivity (contiguous US) from nowCOAST,
 * through services.weatherMaps: the newest whole-extent frame and a window
 * around each area, every 15 minutes, each observation once.
 */
import { weatherRasterFeed } from './_util.mjs';

export default weatherRasterFeed({
  id: 'weather-radar',
  label: 'Weather radar (NOAA MRMS)',
  licence:
    'NOAA nowCOAST, NWS/OAR MRMS radar (U.S. government data; NOAA disclaimer)',
  bytesPerDay: 40e6,
  products: [{ product: 'radar' }],
});
