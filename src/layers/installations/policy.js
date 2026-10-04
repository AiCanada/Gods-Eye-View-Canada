export const LAYER_ID = 'military-installations';

export const REQUEST_DEBOUNCE_MS = 180;

export const MAX_VIEWPORT_DEGREES = 10;

export const MAX_RENDERED = 700;

export const GOOGLE_MILITARY_PLACE_TYPES = new Set(['military_base']);

export const COLOR_BY_CLASS = {
  airfield: '#5aa9ff',
  naval_base: '#48c7d5',
  range: '#d9a85d',
  military_land: '#9ca6b0',
  places_candidate: '#c58cff',
};

export const EARTH_MEAN_RADIUS_M = 6371008.8;

export const DISTANCE_PREFILTER_MARGIN_M = 5000;

/** A Contacts subject must move this far before its installation window moves. */
export const ANCHOR_REFRESH_M = 20_000;

/**
 * Upper bound on a location-switch suspension. The manager lifts it on arrival;
 * this only heals a switch whose arrival never comes (a cancelled flight), so
 * moveEnd cannot stay muted for good.
 */
export const LOCATION_SWITCH_SUSPEND_MAX_MS = 15000;

/** Below this a camera with an unbounded view is looking along the ground (Cockpit), not zoomed out. */
export const UNBOUNDED_VIEW_KEEP_MAX_HEIGHT_M = 100000;

/** How far outside the last loaded viewport such a camera may be and still keep its sites (~110 km). */
export const UNBOUNDED_VIEW_KEEP_MARGIN_DEGREES = 1;
