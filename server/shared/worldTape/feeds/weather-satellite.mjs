/**
 * World tape feed: infrared satellite clouds from nowCOAST, through
 * services.weatherMaps: GOES regional (about 5-minute updates, with a window
 * around each area) and the hourly global mosaic (whole extent only), every
 * 15 minutes, each observation once.
 */
import { weatherRasterFeed } from './_util.mjs';

export default weatherRasterFeed({
  id: 'weather-satellite',
  label: 'Satellite clouds (GOES and global infrared)',
  licence:
    'NOAA nowCOAST; NESDIS GOES and global satellite partners (U.S. government data; NOAA disclaimer)',
  bytesPerDay: 170e6,
  products: [
    { product: 'clouds-regional' },
    { product: 'clouds', windows: false },
  ],
});
