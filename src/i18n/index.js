// God's Eye View i18n: the English source text is the message key.
//
//   t('Save keys')                                   → 'Сохранить ключи'
//   t('Cleared {name}', { name })                    → named interpolation
//   tn(count, '{count} camera', '{count} cameras')   → plural by Intl.PluralRules
//   t('CLEAR', { context: 'action' })                → same English, own entry
//   msg('Live Flights')                              → marks a string kept in data
//                                                      for a later t(); returns it as is
//
// English needs no catalog. Every other locale is one flat JSON file,
// locales/<code>.json, keyed by the English text (for tn, by the English
// plural form). A missing or empty entry falls back to English.
// `npm run i18n` keeps the catalogs in step with the code. Guide: docs/I18N.md.
import {
  DEFAULT_LOCALE,
  intlLocale,
  isRtlLocale,
  normalizeLocale,
  pluralRulesLocale,
  writeStoredLocale,
} from './locale.js';
import forkLocales from './fork-locales.json' with { type: 'json' };
import { useLocalText } from './marker.js';

// Bumped whenever a catalog arrives (loadCatalog, registerCatalog), so a Vue
// view that translated before its catalog landed renders again: every lookup
// reads it. The UI binds it to a ref (src/ui/i18n.js); unbound it is plain
// state.
let catalogRevision = { value: 0 };

/**
 * Keep the catalog revision in `revision`, a ref, as bindLocale keeps the
 * locale, so a render that looked a message up renders again when a catalog
 * lands.
 * @param {{value: number}} revision
 */
export function bindCatalogRevision(revision) {
  revision.value = catalogRevision.value;
  catalogRevision = revision;
}

/** A catalog arrived: views render again, and listeners word their text again. */
function catalogArrived(locale) {
  catalogRevision.value += 1;
  if (locale === getLocale()) notifyLocaleChange();
}

/**
 * The catalogs, one file per locale, loaded on demand: the page fetches the
 * active locale's alone (loadCatalog(), awaited at boot), where it used to
 * carry all fourteen in its main script, two megabytes of JSON that a page
 * read in English never opened. Each is addressed by a URL built from this
 * module's, so the build emits the files as assets and the dev server serves
 * them as they are. Under Node (node:test, the scripts) a catalog is read
 * from disk the moment its locale is first asked for, so setLocale() stays
 * synchronous there.
 */
const CATALOG_URLS = Object.freeze({
  ar: new URL('./locales/ar.json', import.meta.url),
  de: new URL('./locales/de.json', import.meta.url),
  es: new URL('./locales/es.json', import.meta.url),
  fr: new URL('./locales/fr.json', import.meta.url),
  'fr-CA': new URL('./locales/fr-CA.json', import.meta.url),
  it: new URL('./locales/it.json', import.meta.url),
  iu: new URL('./locales/iu.json', import.meta.url),
  ja: new URL('./locales/ja.json', import.meta.url),
  pt: new URL('./locales/pt.json', import.meta.url),
  ru: new URL('./locales/ru.json', import.meta.url),
  uk: new URL('./locales/uk.json', import.meta.url),
  'zh-CN': new URL('./locales/zh-CN.json', import.meta.url),
  'zh-Hant': new URL('./locales/zh-Hant.json', import.meta.url),
  egy: new URL('./locales/egy.json', import.meta.url),
});
/** The locales that have a catalog file. */
export const CATALOG_LOCALES = Object.freeze(Object.keys(CATALOG_URLS));
/** The catalogs loaded so far, by locale. */
const CATALOGS = {};
/** Loads in flight, by locale, so two callers share one fetch. */
const catalogLoads = new Map();

/**
 * A catalog read from disk under Node, where this module's URL is a file;
 * null in a browser, where the catalog comes by loadCatalog().
 */
function readCatalogFromDisk(locale) {
  const url = CATALOG_URLS[locale];
  if (!url || url.protocol !== 'file:') return null;
  const getBuiltinModule = globalThis.process?.getBuiltinModule;
  if (typeof getBuiltinModule !== 'function') return null;
  try {
    const { readFileSync } = getBuiltinModule('node:fs');
    return JSON.parse(readFileSync(url, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The catalog of a normalized locale: the one loaded, else under Node the
 * file; null for English, an unknown code, or one the page has not loaded.
 */
function catalogOf(locale) {
  // Read for its reactivity: a render that found no catalog runs again once
  // one lands (catalogArrived).
  void catalogRevision.value;
  if (!locale || locale === DEFAULT_LOCALE) return null;
  if (Object.hasOwn(CATALOGS, locale)) return CATALOGS[locale];
  if (!Object.hasOwn(CATALOG_URLS, locale)) return null;
  const read = readCatalogFromDisk(locale);
  if (read) CATALOGS[locale] = read;
  return read;
}

/** Keep a catalog for a locale (a test's, or one fetched another way); null forgets it. */
export function registerCatalog(locale, catalog) {
  const normalized = normalizeLocale(locale);
  if (!normalized || normalized === DEFAULT_LOCALE) return;
  if (catalog && typeof catalog === 'object') CATALOGS[normalized] = catalog;
  else delete CATALOGS[normalized];
  catalogArrived(normalized);
}

/**
 * Fetch a locale's catalog once and keep it; resolves with it, or null for
 * English and unknown codes. setLocale() starts it for a locale it switches to and boot
 * awaits it for the active one; until it lands every lookup answers in
 * English, and when it does the views and onLocaleChange listeners word their
 * text again.
 */
export async function loadCatalog(locale) {
  const normalized = normalizeLocale(locale) || DEFAULT_LOCALE;
  const held = catalogOf(normalized);
  if (held || !Object.hasOwn(CATALOG_URLS, normalized)) return held;
  let pending = catalogLoads.get(normalized);
  if (!pending) {
    pending = fetch(CATALOG_URLS[normalized])
      .then((response) => {
        if (!response.ok)
          throw new Error(
            `HTTP ${response.status} for the ${normalized} catalog`,
          );
        return response.json();
      })
      .then((catalog) => {
        CATALOGS[normalized] = catalog;
        catalogArrived(normalized);
        return catalog;
      })
      .finally(() => catalogLoads.delete(normalized));
    catalogLoads.set(normalized, pending);
  }
  return pending;
}

/** The locales that translate the fork's own tabs (see tl()). */
const FORK_LOCALES = new Set(forkLocales);

/**
 * God's Eye View Canada: hover help in the locales few readers know. A mouse
 * resting on their text shows the English it came from (src/ui/englishHint.js).
 * Each line shown here is kept with its English, values filled in, so the help
 * is exact. Lines with values change as the page runs; only the latest of
 * those are kept.
 */
export const ENGLISH_HINT_LOCALES = Object.freeze(['egy', 'iu']);
const LINES_WITH_VALUES_KEPT = 4000;
/** Whether the active locale keeps each line's English for the hover help. */
const keepingEnglish = () => ENGLISH_HINT_LOCALES.includes(getLocale());
const plainLines = new Map();
const linesWithValues = new Map();
const englishSingulars = new Map();

const squashLine = (text) => String(text).replace(/\s+/g, ' ').trim();

/** A translated line, kept with its English while a hint locale is active. */
function shownLine(entry, english, values) {
  const shown = interpolate(entry, values);
  if (!keepingEnglish()) return shown;
  const key = squashLine(shown);
  if (!key) return shown;
  const line = squashLine(interpolate(english, englishValues(values)));
  if (shown === entry) {
    plainLines.set(key, line);
  } else {
    linesWithValues.delete(key);
    linesWithValues.set(key, line);
    if (linesWithValues.size > LINES_WITH_VALUES_KEPT)
      linesWithValues.delete(linesWithValues.keys().next().value);
  }
  return shown;
}

/** The values in English: one that is itself a line shown here reads back. */
function englishValues(values) {
  if (!values) return values;
  const english = {};
  for (const [name, value] of Object.entries(values))
    english[name] =
      typeof value === 'string' ? (shownEnglish(value) ?? value) : value;
  return english;
}

/** The English of a line this page showed in a hint locale, else undefined. */
export function shownEnglish(text) {
  const key = squashLine(text);
  return linesWithValues.get(key) ?? plainLines.get(key);
}

/** The English singular of a count message shown here, found by its plural. */
export function englishSingular(other) {
  return englishSingulars.get(other);
}

// The page's locale. The UI binds it to its vue-i18n instance's
// (src/ui/i18n.js), so a Vue render that translates re-renders when it
// changes; until then, and in portable code, it is plain state.
let pageLocale = { value: DEFAULT_LOCALE };

/**
 * Keep the active locale in `locale`, a ref such as a vue-i18n composer's
 * `locale`. It takes the current locale; switch with setLocale afterwards.
 * @param {{value: string}} locale
 */
export function bindLocale(locale) {
  locale.value = pageLocale.value;
  pageLocale = locale;
  bound = true;
}

let bound = false;
const localeListeners = new Set();

/**
 * Call `listener` after the active locale changes, so code that shows text it
 * translated itself (a status line, a count, a time) shows it again. Text a
 * Vue view translates while rendering follows the locale without this.
 * @param {() => void} listener
 * @returns {() => void} Stops listening.
 */
export function onLocaleChange(listener) {
  if (typeof listener !== 'function') return () => {};
  localeListeners.add(listener);
  return () => localeListeners.delete(listener);
}

/**
 * Tell the listeners the locale changed. setLocale does this for an unbound
 * locale; the owner of a bound ref calls it when the ref changes.
 */
export function notifyLocaleChange() {
  for (const listener of [...localeListeners]) {
    try {
      listener();
    } catch (error) {
      console.error('[i18n] locale listener failed', error);
    }
  }
}

/** The catalog for a locale; null for English, unknown codes, and one not loaded yet. */
export function getCatalog(locale) {
  return catalogOf(normalizeLocale(locale));
}

let boundValue = DEFAULT_LOCALE;
let activeLocale = DEFAULT_LOCALE;

/** Active locale, normalized: a bound ref may be set to any language tag. */
export function getLocale() {
  const value = pageLocale.value;
  if (value !== boundValue) {
    boundValue = value;
    activeLocale = normalizeLocale(value) || DEFAULT_LOCALE;
  }
  return activeLocale;
}

/**
 * A value inserted into right-to-left text as one unit: `30 م` next to
 * `Sentinel-2` would otherwise lend its digits to the Latin run and leave the
 * unit stranded. First-strong isolates (U+2068…U+2069) in RTL locales only.
 */
export function isolate(text) {
  return isRtlLocale(getLocale()) ? `\u2068${text}\u2069` : String(text);
}

const CODE_BEFORE_VALUE =
  /(?<![\p{L}\p{N}])([A-Z][A-Z0-9/]+) (\u2068[^\u2068\u2069]*\u2069)/gu;

/**
 * A Latin code and the isolated value after it ("HDG 68\u00b0") as one unit in
 * right-to-left text. Two codes in a row (HDG 68\u00b0 \u00b7 FOV 44\u00b0) otherwise form a
 * single left-to-right run and the second code ends up beside the first
 * value. Applies to t() output; a no-op outside RTL locales.
 */
export function keepCodesWithValues(text) {
  if (!isRtlLocale(getLocale())) return text;
  return String(text).replace(CODE_BEFORE_VALUE, '\u2068$1 $2\u2069');
}

/**
 * Switch the active locale. Views re-render and onLocaleChange listeners
 * word their text again; the application keeps <html lang>/<html dir> and
 * the page's data-i18n markup in step.
 * @returns {string} The locale actually applied (normalized).
 */
export function setLocale(locale) {
  const normalized = normalizeLocale(locale) || DEFAULT_LOCALE;
  if (normalized !== pageLocale.value) {
    pageLocale.value = normalized;
    formatterCache.clear();
    if (!bound) notifyLocaleChange();
  }
  // Under Node the catalog comes off the disk here. A page fetches it, and
  // the views and the onLocaleChange listeners word their text again when it
  // lands (catalogArrived); until then the page reads in English.
  if (!catalogOf(normalized) && Object.hasOwn(CATALOG_URLS, normalized))
    loadCatalog(normalized).catch((error) =>
      console.warn(
        `[i18n] the ${normalized} catalog did not load:`,
        error?.message || error,
      ),
    );
  return normalized;
}

/** Development-only warning; silent under node:test and in production. */
function warnMissing(text) {
  if (import.meta.env?.DEV !== true) return;
  console.warn(
    `[i18n] no ${getLocale()} translation for ${JSON.stringify(text)}`,
  );
}

const PLACEHOLDER_PATTERN = /\{([A-Za-z0-9_]+)\}/g;

/** Named {placeholder} interpolation. Unknown names stay literal so a gap
 * stays visible instead of silently vanishing. */
function interpolate(pattern, values) {
  if (!values) return pattern;
  // In a right-to-left page each value is isolated: a time, a code or an
  // English name keeps its own order instead of mixing with the sentence.
  return pattern.replace(PLACEHOLDER_PATTERN, (literal, name) => {
    if (!Object.hasOwn(values, name)) return literal;
    const value = String(values[name]);
    return value === '' ? value : isolate(value);
  });
}

/** A catalog string with something to show; an empty one counts as missing. */
const filled = (value) => typeof value === 'string' && value.trim() !== '';

/** The active catalog's entry for `text`, or undefined; never warns. */
function lookupQuiet(text) {
  const catalog = catalogOf(getLocale());
  if (!catalog) return undefined;
  const entry = Object.hasOwn(catalog, text) ? catalog[text] : undefined;
  if (filled(entry) || (entry && typeof entry === 'object')) return entry;
  return undefined;
}

function lookup(text) {
  if (!catalogOf(getLocale())) return undefined;
  const entry = lookupQuiet(text);
  if (entry === undefined) warnMissing(text);
  return entry;
}

/**
 * Translate English source text into the active locale.
 * @param {string} text English text, e.g. 'Hold Space to talk'
 * @param {object} [values] Named interpolation values. `context` tells
 *   apart identical English with different meanings: t('CLEAR', { context:
 *   'action' }) is the catalog entry "action|CLEAR"; English is unchanged.
 * @returns {string}
 */
export function t(text, values) {
  const entry = lookup(values?.context ? `${values.context}|${text}` : text);
  return typeof entry === 'string'
    ? shownLine(entry, text, values)
    : interpolate(text, values);
}

/**
 * Translate a count-dependent message. The catalog entry for `other` holds
 * one form per Intl.PluralRules category of the locale ({ one, few, many, other }
 * for Russian). `{count}` is always available to the pattern: the raw number,
 * unless `values.count` gives its display text, e.g. `formatNumber(n)`.
 * @param {number} count
 * @param {string} one English singular, e.g. '{count} camera'
 * @param {string} other English plural, e.g. '{count} cameras'
 * @param {object} [values] Extra interpolation values; a `count` here is
 *   shown in place of the number (the plural form still follows `count`)
 * @returns {string}
 */
export function tn(count, one, other, values) {
  return pluralFrom(lookup(other), count, one, other, values);
}

/** tn() with the lookup it is given: one form per plural category. */
function pluralFrom(entry, count, one, other, values) {
  const category = pluralRules(getLocale()).select(count);
  const english =
    pluralRules(DEFAULT_LOCALE).select(count) === 'one' ? one : other;
  const forms = entry && typeof entry === 'object' ? entry : null;
  if (!forms || !(filled(forms[category]) || filled(forms.other)))
    return interpolate(english, { count, ...values });
  const pattern = filled(forms[category]) ? forms[category] : forms.other;
  if (keepingEnglish()) englishSingulars.set(other, one);
  return shownLine(pattern, english, { count, ...values });
}

/** A catalog entry for the fork's own tabs: only a fork locale has one. */
function lookupLocal(text) {
  return FORK_LOCALES.has(getLocale()) ? lookupQuiet(text) : undefined;
}

/**
 * The fork's own tabs (the six on the left: AI Risk & Truth Assessment,
 * Ultra Security Package, Social Media Analysis, Outbreak, the AI World
 * Training Sim, AI Distillation) are translated only into the locales listed
 * in src/i18n/fork-locales.json (Spanish, Quebec French, Inuktitut, Ancient
 * Egyptian).
 * tl() and tln() mark their text as t() and tn() do; any other locale shows
 * the English, without a missing-translation warning, even where its catalog
 * has the same English for the rest of the page. `npm run i18n` requires
 * these entries only of the listed locales.
 */
export function tl(text, values) {
  const entry = lookupLocal(
    values?.context ? `${values.context}|${text}` : text,
  );
  return typeof entry === 'string'
    ? shownLine(entry, text, values)
    : interpolate(text, values);
}

/** tn() for the fork's own tabs; see tl(). */
export function tln(count, one, other, values) {
  return pluralFrom(lookupLocal(other), count, one, other, values);
}

const separatorCache = new Map();

/** The active locale's thousands and decimal marks. */
function separators() {
  let marks = separatorCache.get(getLocale());
  if (!marks) {
    const parts = new Intl.NumberFormat(intlLocale(getLocale())).formatToParts(
      12345.6,
    );
    marks = {
      group: parts.find((part) => part.type === 'group')?.value ?? ',',
      decimal: parts.find((part) => part.type === 'decimal')?.value ?? '.',
    };
    separatorCache.set(getLocale(), marks);
  }
  return marks;
}

/**
 * A number the fork's tabs wrote the English way (12,345.6), in the marks of
 * a locale that translates those tabs (12 345,6 in Quebec French); as given
 * in every other locale, as their text is.
 */
export function localDigits(text) {
  const value = String(text);
  if (!FORK_LOCALES.has(getLocale())) return value;
  const { group, decimal } = separators();
  return value.replace(/[,.]/g, (mark) => (mark === ',' ? group : decimal));
}

/** Mark English kept in data for a later tl(); returns it as is. */
export function msgl(text) {
  return text;
}

/** tl(), tln() and localDigits() as one object, for builders that take `say`
 * (marker.js). */
export const localSay = Object.freeze({ tl, tln, digits: localDigits });
// Modules the server also loads mark their text with marker.js's tl(): on
// the page it is this one.
useLocalText(localSay);

/**
 * Translate text that may be ours or may come from a provider: a catalog
 * entry is used when there is one, anything else shows as given, without a
 * missing-translation warning.
 */
export function translateKnown(text) {
  const catalog = catalogOf(getLocale());
  if (!catalog || typeof text !== 'string') return text;
  const entry = Object.hasOwn(catalog, text) ? catalog[text] : undefined;
  return filled(entry) ? shownLine(entry, text) : text;
}

/** Mark English text that is stored in data and translated later by t(). */
export function msg(text) {
  return text;
}

const pluralRulesCache = new Map();

function pluralRules(locale) {
  let rules = pluralRulesCache.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(pluralRulesLocale(locale));
    pluralRulesCache.set(locale, rules);
  }
  return rules;
}

/*
 * Intl formatters are memoized per (kind, locale, options): the constructors
 * are expensive and panels format on refresh paths. The cache is cleared
 * whenever the active locale changes.
 */
const formatterCache = new Map();

function cachedFormatter(kind, Constructor, options) {
  const cacheKey = `${kind}|${getLocale()}|${options ? JSON.stringify(options) : ''}`;
  let formatter = formatterCache.get(cacheKey);
  if (!formatter) {
    formatter = new Constructor(intlLocale(getLocale()), options);
    formatterCache.set(cacheKey, formatter);
  }
  return formatter;
}

/** Locale-aware number formatting (Intl.NumberFormat). */
export function formatNumber(value, options) {
  return cachedFormatter('number', Intl.NumberFormat, options).format(value);
}

/** Locale-aware date/time formatting (Intl.DateTimeFormat). */
export function formatDate(value, options) {
  return cachedFormatter('date', Intl.DateTimeFormat, options).format(value);
}

const UTC_DAY_MONTH = Object.freeze({
  day: '2-digit',
  month: '2-digit',
  timeZone: 'UTC',
});

/**
 * The UTC day and month of a time, for "MM-DD HH:MM UTC" readouts: "10-13" in
 * English, "13.10" in Russian, "13/10" in Spanish, never read as a
 * range. Takes an ISO string (its date part is used as written) or a time.
 * @param {string|number|Date} value
 * @returns {string} '' when the value is not a time.
 */
export function formatUtcDayMonth(value) {
  const written =
    typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})/.exec(value) : null;
  const time = written
    ? Date.UTC(Number(written[1]), Number(written[2]) - 1, Number(written[3]))
    : new Date(value).getTime();
  if (!Number.isFinite(time)) return '';
  if (getLocale() === 'en') return new Date(time).toISOString().slice(5, 10);
  return cachedFormatter('date', Intl.DateTimeFormat, UTC_DAY_MONTH).format(
    time,
  );
}

/**
 * Locale-aware relative time (Intl.RelativeTimeFormat), e.g.
 * formatRelativeTime(-5, 'minute') → '5 minutes ago' / '5 минут назад' /
 * '5分前'.
 */
export function formatRelativeTime(value, unit = 'second', options) {
  const text = cachedFormatter('relative', Intl.RelativeTimeFormat, {
    numeric: 'auto',
    ...options,
  }).format(value, unit);
  // CLDR spaces Japanese (5 分前); the ja catalog writes the number and its
  // unit together (5分前), so the two must not differ on one screen.
  return getLocale() === 'ja'
    ? text.replace(/(?<=\d) (?=\p{Script=Han})/gu, '')
    : text;
}

/** Collapse markup whitespace so a message reads the same in HTML and JS. */
function normalizeMarkupText(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Markup opt-in: the element's own English text or attribute is the source.
 *   <span data-i18n>Normal</span>
 *   <button title="Pin" data-i18n-title>…</button>
 * Also data-i18n-aria-label and data-i18n-placeholder. data-i18n-context
 * gives the element's text a context, as t(text, { context }) does:
 *   <option data-i18n data-i18n-context="radio tag">All</option>
 */
const DOCUMENT_TRANSLATION_TARGETS = Object.freeze([
  ['data-i18n', null],
  ['data-i18n-title', 'title'],
  ['data-i18n-aria-label', 'aria-label'],
  ['data-i18n-placeholder', 'placeholder'],
  // The fork's own tabs: translated only where src/i18n/fork-locales.json
  // lists the locale, silently English elsewhere (see tl()).
  ['data-i18n-local', null, true],
  ['data-i18n-local-title', 'title', true],
  ['data-i18n-local-aria-label', 'aria-label', true],
  ['data-i18n-local-placeholder', 'placeholder', true],
  ['data-i18n-local-label', 'label', true],
  // A tab's short name on its collapsed rail button (CSS attr()).
  ['data-i18n-local-collapsed-title', 'data-collapsed-title', true],
]);

// Per element, the English source a pass read and the text it wrote, so a
// later pass in another locale, English included, starts from the source
// rather than from that text. Text that code wrote since is the new source.
const documentSources = new WeakMap();

/**
 * Translate every opted-in element in `doc` into the active locale. Runs at
 * boot and again after every locale change (the page's own markup, such as
 * a host's, is not rendered by a view).
 * @param {Document|Element} doc
 * @returns {number} Count of element/attribute writes performed.
 */
export function applyDocumentTranslations(doc) {
  if (typeof doc?.querySelectorAll !== 'function') return 0;
  let applied = 0;
  for (const [marker, attribute, local] of DOCUMENT_TRANSLATION_TARGETS) {
    for (const element of doc.querySelectorAll(`[${marker}]`)) {
      const read = () =>
        attribute
          ? element.getAttribute(attribute)
          : normalizeMarkupText(element.textContent);
      let sources = documentSources.get(element);
      if (!sources) documentSources.set(element, (sources = {}));
      const shown = read();
      const known = sources[marker];
      const source = known && shown === known.written ? known.source : shown;
      sources[marker] = { source, written: shown };
      if (!source) continue;
      const context =
        attribute || local ? null : element.getAttribute?.('data-i18n-context');
      const text = local
        ? tl(source)
        : context
          ? t(source, { context })
          : t(source);
      if (text === shown) continue;
      if (attribute) element.setAttribute(attribute, text);
      else element.textContent = text;
      sources[marker].written = read();
      applied += 1;
    }
  }
  return applied;
}

/**
 * Store a locale choice for the next visit and keep the address in step
 * without reloading: ?lang is dropped once the choice is stored, or carries
 * the choice where storage is blocked (share links drop it:
 * ShareLinkManager.copyLink). The hash is kept exactly. setLocale applies
 * the choice to the page.
 * @returns {string} The normalized locale.
 */
export function persistLocale(
  locale,
  {
    location = globalThis.location,
    history = globalThis.history,
    storage,
  } = {},
) {
  const normalized = normalizeLocale(locale) || DEFAULT_LOCALE;
  const stored = writeStoredLocale(normalized, storage);
  try {
    const url = new URL(location.href);
    if (stored) url.searchParams.delete('lang');
    else url.searchParams.set('lang', normalized);
    if (url.href !== location.href) history?.replaceState?.(null, '', url.href);
  } catch {
    // Without a location or history the stored choice still applies.
  }
  return normalized;
}
