/**
 * The Canada edition's own UI, written before upstream's control kit
 * (src/ui/kit) and not yet moved onto it: the fork's panel views, the
 * panels it builds in script, and a fork block inside an upstream module.
 * The kit ratchets (src/ui/kit/*.test.mjs) skip exactly these surfaces;
 * every other view and module stays held to the kit. Moving a surface onto
 * the kit takes it off this list.
 */

/** The fork's single-file panel views. */
export const FORK_VIEW_DIRECTORY = 'src/ui/views/fork/';

/** Fork modules that build their controls in script. */
export const FORK_SCRIPT_MODULES = new Set([
  'src/aiWorldPanel.js',
  'src/askOutputFind.js',
  'src/askPanel.js',
  'src/outbreakPanel.js',
  'src/socialMediaPanel.js',
  'src/ui/cctvUltraMediaView.js',
  'src/ui/copyText.js',
  'src/ui/panelCornerResize.js',
  'src/ultraHelpPanel.js',
]);

/** Fork lines inside upstream modules, by their trimmed text. */
const FORK_SCRIPT_LINES = new Map([
  [
    // The fork's rail button in the shell.
    'src/ui/applicationShell.js',
    new Set([
      "const button = document.createElement('button');",
      "icon.className = 'material-symbols-outlined';",
    ]),
  ],
]);

/**
 * Whether a repo-relative SFC path is one of the fork's panel views.
 * @param {string} file
 */
export const isForkView = (file) => file.startsWith(FORK_VIEW_DIRECTORY);

/**
 * Whether a script-scan hit (`file:line: text`) is fork UI.
 * @param {string} hit
 */
export function isForkScriptHit(hit) {
  const match = /^([^:]+):\d+: (.*)$/.exec(hit);
  if (!match) return false;
  const [, file, text] = match;
  return (
    FORK_SCRIPT_MODULES.has(file) ||
    FORK_SCRIPT_LINES.get(file)?.has(text.trim()) === true
  );
}
