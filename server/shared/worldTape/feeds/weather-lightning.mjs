/**
 * World tape feed: 15-minute lightning strike density (Americas and Pacific)
 * from nowCOAST, through services.weatherMaps, every 15 minutes, each
 * observation once.
 */
import { weatherRasterFeed } from './_util.mjs';

export default weatherRasterFeed({
  id: 'weather-lightning',
  label: 'Lightning density',
  licence:
    'NOAA/NWS nowCOAST lightning density, derived from Vaisala NLDN/GLD360 (NOAA Level-5 product; public distribution permitted, not raw detections)',
  bytesPerDay: 10e6,
  products: [{ product: 'lightning' }],
});
