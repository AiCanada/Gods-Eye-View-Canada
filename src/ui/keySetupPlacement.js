/**
 * Where the POWER UP chip sits. ProviderSettingsView reads it; the setup
 * owner (src/keySetup.js) re-exports it for its tests.
 */

/**
 * Whether the POWER UP chip sits in the top toolbar: in the Cyber theme, and
 * on a phone (Mirror of PC GEVC on Cell), where in the PC layout the
 * right-hand panels cover the corner and in the phone layout the map credits
 * and the dock do. Every other theme keeps it first in the corner row, beside
 * the language picker. Pure.
 * @param {DOMStringMap|Record<string, string>} dataset The root element's.
 * @returns {boolean}
 */
export function keySetupChipInToolbar(dataset = {}) {
  return (
    dataset.uiTheme === 'cyber' ||
    dataset.pcMirror === 'true' ||
    // The phone layout on a touch screen: the bottom corner holds the dock.
    (dataset.touchDevice === 'true' && dataset.layoutMode === 'phone')
  );
}

/** The root attributes keySetupChipInToolbar reads, for an observer. */
export const KEY_SETUP_PLACEMENT_ATTRIBUTES = Object.freeze([
  'data-ui-theme',
  'data-pc-mirror',
  'data-touch-device',
  'data-layout-mode',
]);
