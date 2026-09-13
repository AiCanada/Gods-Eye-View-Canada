import { SST_PRODUCTS } from '../../src/data/sstProducts.js';
import { createSstStatusSource } from './sst/status.js';
import { createLevel3Source } from './sst/level3.js';

/**
 * Vite plugin: Sea Surface Temperature.
 *
 *   GET /api/sst/status — newest date per SST product, the newest OceanColor
 *     MODIS Aqua Level-3 file, and whether EARTHDATA_TOKEN signs in to it.
 *   GET /api/sst/l3/meta?period=day|8d&bbox=w,s,e,n — the newest Level-3 data
 *     for a view: dates, image size and bounds, °C range, detected fronts.
 *   GET /api/sst/l3/sst.png?… and /api/sst/l3/fronts.png?… — the images.
 *
 * GIBS tiles are drawn by the browser straight from NASA, which needs no key.
 * Level-3 data is read here, so the Earthdata token stays on this server.
 */
function seaSurfaceTemperatureProxy({ fetchImpl } = {}) {
  const status = createSstStatusSource({
    products: SST_PRODUCTS,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  const level3 = createLevel3Source({ ...(fetchImpl ? { fetchImpl } : {}) });

  const respond = (res, statusCode, payload) => {
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(payload));
  };

  const handleStatus = async (req, res) => {
    if (req.method !== 'GET')
      return respond(res, 405, { error: 'Method not allowed' });
    try {
      respond(res, 200, await status());
    } catch (error) {
      console.warn('[SST] status failed:', error?.message || error);
      respond(res, 502, {
        error: 'Sea surface temperature status unavailable',
      });
    }
  };

  const LEVEL3_ROUTES = new Map([
    ['/meta', null],
    ['/sst.png', 'sstPng'],
    ['/fronts.png', 'frontsPng'],
  ]);

  const handleLevel3 = async (req, res) => {
    if (req.method !== 'GET')
      return respond(res, 405, { error: 'Method not allowed' });
    const url = new URL(req.url || '/', 'http://localhost');
    if (!LEVEL3_ROUTES.has(url.pathname))
      return respond(res, 404, { error: 'not found' });
    try {
      const view = await level3({
        period: url.searchParams.get('period') || 'day',
        bbox: url.searchParams.get('bbox'),
        fronts: url.searchParams.get('fronts') || undefined,
      });
      const image = LEVEL3_ROUTES.get(url.pathname);
      if (!image) return respond(res, 200, view.meta);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'image/png');
      // The same view of the same file never changes; let the browser keep it.
      res.setHeader('Cache-Control', 'private, max-age=600');
      res.end(view[image]);
    } catch (error) {
      const statusCode = Number.isInteger(error?.status) ? error.status : 502;
      if (statusCode >= 500)
        console.warn('[SST] Level-3 view failed:', error?.message || error);
      respond(res, statusCode, {
        error:
          statusCode < 500
            ? error.message
            : error?.message || 'Level-3 data unavailable',
      });
    }
  };

  function install(middlewares) {
    middlewares.use('/api/sst/status', handleStatus);
    middlewares.use('/api/sst/l3', handleLevel3);
  }

  return {
    name: 'sst-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

export { seaSurfaceTemperatureProxy };
