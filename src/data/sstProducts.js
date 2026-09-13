/**
 * Sea surface temperature products the SST box can drape on the globe.
 *
 * `oceancolor` products are drawn by this server from the newest OceanColor
 * MODIS Aqua Level-3 files for the current view, with thermal fronts detected.
 * `gibs` products are NASA GIBS Web Mercator tiles; `maximumLevel` is the
 * deepest zoom GIBS publishes for the layer's matrix set.
 */
export const SST_PRODUCTS = Object.freeze([
  Object.freeze({
    id: 'oceancolor-l3-day',
    source: 'oceancolor',
    period: 'day',
    label: 'OCEANCOLOR L3 · NEWEST DAILY · FRONTS',
    note: 'Newest MODIS Aqua Level-3 daily file, drawn for this view. White lines are detected thermal fronts. Clouds leave gaps.',
  }),
  Object.freeze({
    id: 'oceancolor-l3-8d',
    source: 'oceancolor',
    period: '8d',
    label: 'OCEANCOLOR L3 · NEWEST 8-DAY · FRONTS',
    note: 'Newest MODIS Aqua Level-3 8-day composite, drawn for this view. Fewer cloud gaps, steadier fronts.',
  }),
  Object.freeze({
    id: 'modis-aqua-night',
    source: 'gibs',
    label: 'MODIS AQUA · NIGHT SWATHS · DAILY (TILES)',
    gibsLayer: 'MODIS_Aqua_L2_Sea_Surface_Temp_Night',
    matrixSet: 'GoogleMapsCompatible_Level7',
    maximumLevel: 7,
    note: 'Newest MODIS Aqua night swaths as NASA map tiles. Clouds leave gaps.',
  }),
  Object.freeze({
    id: 'mur-fronts',
    source: 'gibs',
    label: 'GHRSST MUR · GAP-FREE · DAILY (TILES)',
    gibsLayer: 'GHRSST_L4_MUR_Sea_Surface_Temperature',
    matrixSet: 'GoogleMapsCompatible_Level7',
    maximumLevel: 7,
    note: 'Cloud-free blend of several satellites, MODIS included, as NASA map tiles.',
  }),
  Object.freeze({
    id: 'modis-aqua-l3-8day',
    source: 'gibs',
    label: 'MODIS AQUA L3 · 8-DAY (TILES)',
    gibsLayer: 'MODIS_Aqua_L3_SST_Thermal_4km_Night_8Day',
    matrixSet: 'GoogleMapsCompatible_Level6',
    maximumLevel: 6,
    note: 'NASA map tiles of the Level-3 8-day composite. These tiles lag the data files by months.',
  }),
]);

/** Product selected when the box first loads. */
export const DEFAULT_SST_PRODUCT_ID = 'oceancolor-l3-day';

/** Look up a product, falling back to the first one. */
export function sstProductById(id) {
  return SST_PRODUCTS.find((product) => product.id === id) || SST_PRODUCTS[0];
}

/**
 * How strong a temperature change must be to count as a thermal front. The
 * server holds the thresholds (server/providers/sst/fronts.js) under these ids.
 */
export const SST_FRONT_SENSITIVITIES = Object.freeze([
  Object.freeze({ id: 'strong', label: 'STRONG FRONTS' }),
  Object.freeze({ id: 'moderate', label: 'MODERATE FRONTS' }),
  Object.freeze({ id: 'all', label: 'ALL GRADIENTS' }),
]);

/** Sensitivity selected when the box first loads. */
export const DEFAULT_SST_FRONT_SENSITIVITY = 'strong';
