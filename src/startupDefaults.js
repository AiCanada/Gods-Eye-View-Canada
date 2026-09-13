/**
 * What a normal launch looks like: where the camera lands and which layers are
 * on. A share link is a deliberate view and bypasses all of this.
 */

/** Preset city the startup flight lands on (CITY_POIS id). */
export const STARTUP_LOCATION_ID = 'saintjohn';

/** Layers forced on at every launch. */
export const STARTUP_LAYERS_ON = Object.freeze(['cctv', 'traffic']);

/** Layers forced off at every launch, whatever the last session left on. */
export const STARTUP_LAYERS_OFF = Object.freeze(['rocket-launches']);

/**
 * Apply the launch layer policy to a saved (or default) layer state.
 * Pure: returns a new state and never mutates the input.
 *
 * @param {{enabledLayerIds?: string[]}} state
 * @returns {object}
 */
export function applyStartupLayerDefaults(state) {
  const enabled = new Set(state?.enabledLayerIds || []);
  for (const id of STARTUP_LAYERS_OFF) enabled.delete(id);
  for (const id of STARTUP_LAYERS_ON) enabled.add(id);
  return { ...state, enabledLayerIds: [...enabled] };
}
