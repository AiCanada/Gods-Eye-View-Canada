/**
 * Screens of the phones listed on the Ultra tab (ULTRA_PHONE_MODELS in
 * src/ultraHelp.mjs), for testing the mirrored dashboard on each. Sizes are
 * the browser's CSS pixels held upright, and the screen's pixel density;
 * they are typical values for each family, close enough to test layout and
 * readability, not a specification of any one model. A fold is listed once
 * for each of its screens (`screen`: cover or open).
 */
export const PHONE_PROFILES = Object.freeze([
  {
    id: 'generic-cell',
    label: 'Generic cell',
    w: 412,
    h: 915,
    dpr: 2.625,
    os: 'android',
  },
  {
    id: 'google-pixel',
    label: 'Google Pixel',
    w: 412,
    h: 923,
    dpr: 2.625,
    os: 'android',
  },
  {
    id: 'motorola',
    label: 'Motorola',
    w: 412,
    h: 915,
    dpr: 2.625,
    os: 'android',
  },
  { id: 'oppo', label: 'Oppo', w: 393, h: 873, dpr: 2.75, os: 'android' },
  { id: 'vivo', label: 'Vivo', w: 393, h: 873, dpr: 2.75, os: 'android' },
  { id: 'xiaomi', label: 'Xiaomi', w: 393, h: 873, dpr: 2.75, os: 'android' },
  {
    id: 'samsung-s26',
    label: 'Samsung Galaxy S26',
    w: 384,
    h: 832,
    dpr: 2.8125,
    os: 'android',
  },
  {
    id: 'samsung-s22-ultra',
    label: 'Samsung Galaxy S22 Ultra',
    w: 412,
    h: 915,
    dpr: 3.5,
    os: 'android',
  },
  // Folds: both screens. Folded, the narrow cover screen; open, the big inner one.
  {
    id: 'samsung-z8',
    label: 'Samsung Galaxy Z8 cover',
    screen: 'cover',
    w: 374,
    h: 873,
    dpr: 2.625,
    os: 'android',
  },
  {
    id: 'samsung-z8',
    label: 'Samsung Galaxy Z8 open',
    screen: 'open',
    w: 750,
    h: 832,
    dpr: 2.625,
    os: 'android',
  },
  {
    id: 'samsung-z3',
    label: 'Samsung Galaxy Z3 cover',
    screen: 'cover',
    w: 317,
    h: 864,
    dpr: 2.625,
    os: 'android',
  },
  {
    id: 'samsung-z3',
    label: 'Samsung Galaxy Z3 open',
    screen: 'open',
    w: 673,
    h: 841,
    dpr: 2.625,
    os: 'android',
  },
  {
    id: 'samsung-z-fold',
    label: 'Samsung Galaxy Z Fold cover',
    screen: 'cover',
    w: 344,
    h: 882,
    dpr: 2.625,
    os: 'android',
  },
  {
    id: 'samsung-z-fold',
    label: 'Samsung Galaxy Z Fold open',
    screen: 'open',
    w: 690,
    h: 838,
    dpr: 2.625,
    os: 'android',
  },
]);

/** The user-agent string Chrome on Android sends. */
export function profileUserAgent() {
  return 'Mozilla/5.0 (Linux; Android 16; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
}
