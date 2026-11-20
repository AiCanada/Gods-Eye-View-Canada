/** Bottom-to-top order of the sprite layers' icon and dot sets.
 * Fork: traffic sits just above the camera icons, so street vehicles draw
 * through camera sprites; flights stay the final/top layer. The CCTV monitor
 * plane is not in this list: it is a depth-tested quad, which a draw order
 * does not rank, and the vehicles on its picture are painted by
 * src/data/cctvTrafficProjection.js. */
export const SPRITE_LAYER_ORDER = Object.freeze([
  'shipwrecks',
  'cctv',
  'traffic',
  'firms',
  'wildlife-sightings',
  'bikeshare',
  'transit',
  'transit-motion',
  'rail',
  'directions',
  'ais',
  'military',
  'flights',
]);

/**
 * The draw order (`SetSpec.drawOrder`) a sprite layer's set is made with:
 * its place in `SPRITE_LAYER_ORDER`, counted back from -1 for flights, so
 * flights draw over every other sprite layer and the rest follow the list,
 * whichever layer was turned on first. Every set at the default order, 0
 * (selection highlights, route endpoints, the tracked plane and the other
 * overlays), stays over all of them, as it did when the sprite sets were
 * raised to the bottom of the scene. A key not in the list gets 0.
 * @param {string} layerId - Stable sprite-order layer key.
 * @returns {number}
 */
export function spriteDrawOrder(layerId) {
  const index = SPRITE_LAYER_ORDER.indexOf(layerId);
  return index < 0 ? 0 : index - SPRITE_LAYER_ORDER.length;
}
