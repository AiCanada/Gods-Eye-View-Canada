// msg() for modules the server, tools or other portable code also import:
// marks English that stays in data for `npm run i18n`, without loading the
// catalogs (src/i18n/index.js). The UI shows it later through t().
// Browser-only modules import msg from src/i18n/index.js instead.
//
// tl(), tln() and localDigits() below are the same for the fork's own tabs:
// English until the page loads src/i18n/index.js, which then hands over its
// own (useLocalText). The server and tools never load the catalogs, so what
// they build with these stays English.

/** Mark English text that is stored in data and translated later by t(). */
export const msg = (text) => text;

/**
 * msg() for the fork's own tabs: English kept in data and shown later
 * through tl() (src/i18n/index.js), translated only into the locales listed
 * in src/i18n/fork-locales.json.
 */
export const msgl = (text) => text;

const fill = (text, values) =>
  values
    ? String(text).replace(/\{([A-Za-z0-9_]+)\}/g, (literal, name) =>
        Object.hasOwn(values, name) ? String(values[name]) : literal,
      )
    : text;

/**
 * English for code that builds the same text for the screen and for a model
 * or a message: such a function takes `say = english` and calls say.tl() and
 * say.tln() (read by `npm run i18n` as tl() and tln()); the screen passes
 * `localSay` from src/i18n/index.js, so only the screen is translated.
 */
export const english = Object.freeze({
  tl: (text, values) => fill(text, values),
  tln: (count, one, other, values) =>
    fill(count === 1 ? one : other, { count, ...values }),
  digits: (text) => String(text),
});

let localText = english;

/** For src/i18n/index.js: its tl(), tln() and localDigits() from now on. */
export function useLocalText(say) {
  localText = say;
}

/** tl() of src/i18n/index.js once the page has loaded it; English before. */
export const tl = (text, values) => localText.tl(text, values);

/** tln() of src/i18n/index.js once the page has loaded it; English before. */
export const tln = (count, one, other, values) =>
  localText.tln(count, one, other, values);

/** localDigits() of src/i18n/index.js once loaded; the text as is before. */
export const localDigits = (text) => localText.digits(text);
