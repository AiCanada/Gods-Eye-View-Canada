import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyDocumentTranslations,
  englishSingular,
  formatDate,
  formatNumber,
  formatRelativeTime,
  getCatalog,
  localDigits,
  localSay,
  msg,
  persistLocaleAndReload,
  setLocale,
  shownEnglish,
  t,
  tl,
  tln,
  tn,
} from './index.js';
import {
  LOCALE_NAMES,
  LOCALE_STORAGE_KEY,
  applyDocumentLanguage,
  normalizeLocale,
  resolveLocale,
  writeStoredLocale,
} from './locale.js';
import {
  english,
  localDigits as markerDigits,
  tl as markerTl,
  tln as markerTln,
} from './marker.js';

afterEach(() => setLocale('en'));

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    data,
  };
}

test('normalizeLocale folds regional variants and rejects unshipped tags', () => {
  assert.equal(normalizeLocale('ru-RU'), 'ru');
  assert.equal(normalizeLocale(' RU '), 'ru');
  assert.equal(normalizeLocale('uk'), 'uk');
  assert.equal(normalizeLocale('uk-UA'), 'uk');
  assert.equal(normalizeLocale('en_GB'), 'en');
  assert.equal(normalizeLocale('de'), 'de');
  assert.equal(normalizeLocale('de-AT'), 'de');
  assert.equal(normalizeLocale('de_CH'), 'de');
  assert.equal(normalizeLocale('fr'), 'fr');
  // fr-CA is the fork's Quebec French (its own test below).
  assert.equal(normalizeLocale('FR_be'), 'fr');
  assert.equal(normalizeLocale('pt-BR'), 'pt');
  assert.equal(normalizeLocale('pt_PT'), 'pt');
  assert.equal(normalizeLocale('xx'), null);
  assert.equal(normalizeLocale('it-IT'), 'it');
  assert.equal(normalizeLocale('it_CH'), 'it');
  assert.equal(normalizeLocale('ja'), 'ja');
  assert.equal(normalizeLocale('ja-JP'), 'ja');
  assert.equal(normalizeLocale('JA_jp'), 'ja');
  // Explicit script tags take precedence over regional defaults.
  assert.equal(normalizeLocale('zh'), 'zh-CN');
  assert.equal(normalizeLocale('zh-CN'), 'zh-CN');
  assert.equal(normalizeLocale('zh-Hans-SG'), 'zh-CN');
  assert.equal(normalizeLocale('zh-Hant'), 'zh-Hant');
  assert.equal(normalizeLocale(' ZH_hant '), 'zh-Hant');
  assert.equal(normalizeLocale('zh-TW'), 'zh-Hant');
  assert.equal(normalizeLocale('zh-Hant-HK'), 'zh-Hant');
  assert.equal(normalizeLocale('zh-Hans-HK'), 'zh-CN');
  assert.equal(normalizeLocale('zh-Hant-CN'), 'zh-Hant');
  assert.equal(normalizeLocale('zh_HK'), 'zh-Hant');
  assert.equal(normalizeLocale('zh-MO'), 'zh-Hant');
  assert.equal(normalizeLocale(undefined), null);
});

test('Quebec French: its tag, the page language, a translation and its plural forms', () => {
  assert.equal(normalizeLocale('fr-CA'), 'fr-CA');
  assert.equal(normalizeLocale(' FR_ca '), 'fr-CA');
  assert.equal(normalizeLocale('fr'), 'fr', 'plain French is French');
  assert.equal(normalizeLocale('fr-FR'), 'fr');
  const doc = { documentElement: {} };
  applyDocumentLanguage(doc, 'fr-ca');
  assert.deepEqual(doc.documentElement, { lang: 'fr-CA', dir: 'ltr' });

  setLocale('fr-CA');
  assert.equal(t('Live Flights'), 'Vols en direct');
  assert.equal(t('CLEAR', { context: 'action' }), 'EFFACER');
  // French takes the singular for 0 and 1, and "de" after exact millions.
  const files = (count) =>
    tn(count, '{count} file selected', '{count} files selected');
  assert.equal(files(0), '0 fichier sélectionné');
  assert.equal(files(1), '1 fichier sélectionné');
  assert.equal(files(2), '2 fichiers sélectionnés');
  assert.equal(files(1000000), '1000000 de fichiers sélectionnés');
  // A colon keeps its non-breaking space before it.
  assert.equal(
    t('Unknown key: {name}', { name: 'X' }),
    'Clé inconnue\u00a0: X',
  );
  // Numbers follow Canadian French: a space groups thousands, a comma marks decimals.
  assert.match(formatNumber(1234.5), /^1\s234,5$/u);
});

test('resolveLocale: ?lang= wins, then the stored choice, then browser languages, then English', () => {
  const storage = memoryStorage({ [LOCALE_STORAGE_KEY]: 'ru' });
  assert.equal(
    resolveLocale({
      location: { search: '?lang=en' },
      storage,
      languages: ['ru'],
    }),
    'en',
  );
  assert.equal(
    resolveLocale({ location: { search: '' }, storage, languages: ['en'] }),
    'ru',
  );
  assert.equal(
    resolveLocale({
      location: { search: '?lang=xx' },
      storage: memoryStorage(),
      languages: ['ko-KR', 'ru-RU'],
    }),
    'ru',
  );
  assert.equal(
    resolveLocale({
      location: { search: '' },
      storage: memoryStorage(),
      languages: ['de-DE', 'ru-RU'],
    }),
    'de',
  );
  assert.equal(
    resolveLocale({
      location: { search: '' },
      storage: memoryStorage(),
      languages: ['ko'],
    }),
    'en',
  );
});

test('a throwing storage never escapes', () => {
  const storage = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
  };
  assert.equal(
    resolveLocale({ location: { search: '' }, storage, languages: [] }),
    'en',
  );
  assert.equal(writeStoredLocale('ru', storage), false);
});

test('applyDocumentLanguage sets lang and dir', () => {
  const doc = { documentElement: {} };
  applyDocumentLanguage(doc, 'ru-RU');
  assert.deepEqual(doc.documentElement, { lang: 'ru', dir: 'ltr' });
});

test('t() returns English text in English and translates in Russian', () => {
  assert.equal(t('POWERED UP'), 'POWERED UP');
  setLocale('ru');
  assert.notEqual(t('POWERED UP'), 'POWERED UP');
});

test('t() interpolates named values and keeps unknown names literal', () => {
  assert.equal(
    t('Save failed: {detail}', { detail: 'disk full' }),
    'Save failed: disk full',
  );
  assert.equal(
    t('Hello {who} {missing}', { who: 'pilot' }),
    'Hello pilot {missing}',
  );
});

test('t() falls back to English for text without a translation', () => {
  setLocale('ru');
  assert.equal(t('No such message {n}', { n: 1 }), 'No such message 1');
});

test('tn() picks English and Russian plural forms', () => {
  const label = (count) =>
    tn(
      count,
      'POWER UP · {count} KEY WAITING',
      'POWER UP · {count} KEYS WAITING',
    );
  assert.equal(label(1), 'POWER UP · 1 KEY WAITING');
  assert.equal(label(3), 'POWER UP · 3 KEYS WAITING');
  setLocale('ru');
  assert.match(label(1), / 1 КЛЮЧ(?![А-ЯЁ])/);
  assert.match(label(3), / 3 КЛЮЧА(?![А-ЯЁ])/);
  assert.match(label(5), / 5 КЛЮЧЕЙ(?![А-ЯЁ])/);
  assert.match(label(21), / 21 КЛЮЧ(?![А-ЯЁ])/);
});

test('tn() picks the Portuguese one, many and other forms', () => {
  const label = (count) =>
    tn(
      count,
      'POWER UP · {count} KEY WAITING',
      'POWER UP · {count} KEYS WAITING',
    );
  setLocale('pt');
  assert.equal(label(0), 'ATIVAR · 0 CHAVE PENDENTE');
  assert.equal(label(1), 'ATIVAR · 1 CHAVE PENDENTE');
  assert.equal(label(3), 'ATIVAR · 3 CHAVES PENDENTES');
  assert.equal(label(1_000_000), 'ATIVAR · 1000000 DE CHAVES PENDENTES');
});

test('tn() picks the four Ukrainian plural forms', () => {
  const label = (count) =>
    tn(
      count,
      'POWER UP · {count} KEY WAITING',
      'POWER UP · {count} KEYS WAITING',
    );
  setLocale('uk');
  assert.match(label(1), / 1 КЛЮЧ(?![А-ЯҐЄІЇ])/);
  assert.match(label(3), / 3 КЛЮЧІ(?![А-ЯҐЄІЇ])/);
  assert.match(label(5), / 5 КЛЮЧІВ(?![А-ЯҐЄІЇ])/);
  assert.match(label(11), / 11 КЛЮЧІВ(?![А-ЯҐЄІЇ])/);
  assert.match(label(21), / 21 КЛЮЧ(?![А-ЯҐЄІЇ])/);
  assert.match(label(1.5), / 1\.5 КЛЮЧА(?![А-ЯҐЄІЇ])/);
});

test('t() context separates identical English with different meanings', () => {
  assert.equal(t('CLEAR', { context: 'action' }), 'CLEAR');
  setLocale('ru');
  assert.notEqual(t('CLEAR', { context: 'action' }), t('CLEAR'));
});

test('msg() returns its text unchanged', () => {
  assert.equal(msg('Live Flights'), 'Live Flights');
});

test('Intl formatters follow the active locale', () => {
  const date = new Date(Date.UTC(2026, 0, 15));
  const options = {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  };
  assert.equal(formatDate(date, options), 'January 15, 2026');
  assert.equal(formatNumber(1234.5), '1,234.5');
  setLocale('ru');
  assert.equal(formatDate(date, options), '15 января 2026 г.');
  assert.equal(formatRelativeTime(-5, 'minute'), '5 минут назад');
  assert.equal(formatNumber(1234.5), '1 234,5');
  // Japanese keeps a number and its unit together, as the catalog does.
  setLocale('ja');
  assert.equal(formatDate(date, options), '2026年1月15日');
  assert.equal(formatRelativeTime(-5, 'minute'), '5分前');
  assert.equal(formatRelativeTime(-3, 'day'), '3日前');
});

function fakeElement({ text = '', attributes = {} } = {}) {
  const attrs = new Map(Object.entries(attributes));
  return {
    textContent: text,
    getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null),
    setAttribute: (name, value) => attrs.set(name, value),
    attrs,
  };
}

test('applyDocumentTranslations translates opted-in text and attributes in place', () => {
  const label = fakeElement({ text: '\n  POWERED\n  UP  ' });
  const pin = fakeElement({ attributes: { title: 'POWERED UP' } });
  const unknown = fakeElement({ text: 'No such message' });
  const doc = {
    querySelectorAll(selector) {
      if (selector === '[data-i18n]') return [label, unknown];
      if (selector === '[data-i18n-title]') return [pin];
      return [];
    },
  };
  assert.equal(
    applyDocumentTranslations(doc),
    0,
    'English leaves markup alone',
  );
  setLocale('ru');
  assert.equal(applyDocumentTranslations(doc), 2);
  assert.equal(label.textContent, t('POWERED UP'));
  assert.equal(pin.attrs.get('title'), t('POWERED UP'));
  assert.equal(unknown.textContent, 'No such message');
});

test('applyDocumentTranslations reads data-i18n-context for element text', () => {
  const option = fakeElement({
    text: 'All',
    attributes: { 'data-i18n-context': 'radio tag' },
  });
  const doc = {
    querySelectorAll: (selector) =>
      selector === '[data-i18n]' ? [option] : [],
  };
  setLocale('pt');
  applyDocumentTranslations(doc);
  assert.equal(option.textContent, t('All', { context: 'radio tag' }));
  assert.notEqual(option.textContent, t('All'));
});

test('persistLocaleAndReload keeps the choice in ?lang when storage is blocked', () => {
  const calls = [];
  const location = {
    href: 'https://gev.local/?x=1#scene=a',
    assign: (url) => calls.push(['assign', url]),
    reload: () => calls.push(['reload']),
  };
  const history = {
    replaceState: (_s, _t, url) => calls.push(['replace', url]),
  };
  const storage = {
    setItem() {
      throw new Error('blocked');
    },
  };
  assert.equal(
    persistLocaleAndReload('ru', { location, history, storage }),
    true,
  );
  assert.deepEqual(calls, [
    ['replace', 'https://gev.local/?x=1&lang=ru#scene=a'],
    ['reload'],
  ]);
});

test('persistLocaleAndReload stores the choice, keeps the hash, strips ?lang', () => {
  const storage = memoryStorage();
  const calls = [];
  const location = {
    href: 'https://gev.local/?lang=en&x=1#scene=a',
    assign: (url) => calls.push(['assign', url]),
    reload: () => calls.push(['reload']),
  };
  const history = {
    replaceState: (_s, _t, url) => calls.push(['replace', url]),
  };
  assert.equal(
    persistLocaleAndReload('ru', { location, history, storage }),
    true,
  );
  assert.equal(storage.data.get(LOCALE_STORAGE_KEY), 'ru');
  assert.deepEqual(calls, [
    ['replace', 'https://gev.local/?x=1#scene=a'],
    ['reload'],
  ]);
});

test('tn() shows a caller-formatted count and still picks the form by number', () => {
  const label = (n) =>
    tn(n, '{count} map object', '{count} map objects', {
      count: formatNumber(n),
    });
  assert.equal(label(12345), '12,345 map objects');
  assert.equal(tn(12345, '{count} file', '{count} files'), '12345 files');
  setLocale('ru');
  try {
    assert.equal(label(12345), '12 345 объектов на карте');
    assert.equal(label(1), '1 объект на карте');
  } finally {
    setLocale('en');
  }
});

test('the fork tabs: tl() and tln() are Quebec French in fr-CA, Spanish in es, English in Russian', () => {
  const title = 'AI RISK & TRUTH ASSESSMENT';
  const files = (count) => tln(count, '{count} FILE', '{count} FILES');
  setLocale('fr-CA');
  assert.equal(tl(title), 'RISQUE ET VÉRITÉ PAR IA');
  assert.equal(tl('OPEN', { context: 'licence' }), 'LIBRE');
  assert.equal(files(1), '1 FICHIER');
  assert.equal(files(2), '2 FICHIERS');
  assert.equal(files(1000000), '1000000 DE FICHIERS');
  assert.equal(tl('NOT IN A CATALOG {n}', { n: 3 }), 'NOT IN A CATALOG 3');
  // Spanish has the fork tabs too (owner, 2026-10-19: "Finish coding for all Espanola").
  setLocale('es');
  assert.equal(tl(title), 'EVALUACIÓN DE RIESGO Y VERDAD CON IA');
  assert.equal(tl('OPEN', { context: 'licence' }), 'ABIERTA');
  assert.equal(files(1), '1 ARCHIVO');
  assert.equal(files(2), '2 ARCHIVOS');
  assert.equal(files(1000000), '1000000 DE ARCHIVOS');
  assert.equal(tl('NOT IN A CATALOG {n}', { n: 3 }), 'NOT IN A CATALOG 3');
  setLocale('ru');
  assert.equal(tl(title), title);
  assert.equal(tl('OPEN', { context: 'licence' }), 'OPEN');
  assert.equal(files(2), '2 FILES');
  // English even where the locale translates the same text elsewhere.
  assert.notEqual(t('Live Flights'), 'Live Flights');
  assert.equal(tl('Live Flights'), 'Live Flights');
});

test('Inuktitut: its tag, syllabic text, the dual plural, the fork tabs and Canadian number marks', () => {
  assert.equal(normalizeLocale('iu'), 'iu');
  assert.equal(normalizeLocale('iu-Cans-CA'), 'iu');
  assert.equal(normalizeLocale(' IU_ca '), 'iu');
  const doc = { documentElement: {} };
  applyDocumentLanguage(doc, 'iu');
  assert.deepEqual(doc.documentElement, { lang: 'iu', dir: 'ltr' });

  setLocale('iu');
  assert.equal(t('Live Flights'), 'ᒫᓐᓇ ᖃᖓᑕᓂᐅᔪᑦ');
  assert.equal(t('CLEAR', { context: 'action' }), 'ᐲᕐᓗᒋᑦ');
  // Inuktitut has a dual: one, two, then the plural from three on.
  const files = (count) =>
    tn(count, '{count} file selected', '{count} files selected');
  assert.equal(files(1), '1 ᑐᖅᑯᖅᑕᐅᓯᒪᔪᖅ ᓂᕈᐊᖅᑕᐅᔪᖅ');
  assert.equal(files(2), '2 ᑐᖅᑯᖅᑕᐅᓯᒪᔫᒃ ᓂᕈᐊᖅᑕᐅᔫᒃ');
  assert.equal(files(3), '3 ᑐᖅᑯᖅᑕᐅᓯᒪᔪᑦ ᓂᕈᐊᖅᑕᐅᔪᑦ');
  assert.equal(files(0), '0 ᑐᖅᑯᖅᑕᐅᓯᒪᔪᑦ ᓂᕈᐊᖅᑕᐅᔪᑦ');
  // The fork's own tabs are translated too, with the same dual.
  assert.equal(
    tl('AI RISK & TRUTH ASSESSMENT'),
    'AI ᐊᑦᑕᓇᕐᓂᖓᓄᑦ ᓱᓕᓂᖓᓄᓪᓗ ᖃᐅᔨᓴᕐᓂᖅ',
  );
  assert.equal(tl('OPEN', { context: 'licence' }), 'ᒪᑐᐃᖅᓯᒪᔪᖅ');
  const tabFiles = (count) => tln(count, '{count} FILE', '{count} FILES');
  assert.equal(tabFiles(2), '2 ᑐᖅᑯᖅᑕᐅᓯᒪᔫᒃ');
  assert.equal(tabFiles(5), '5 ᑐᖅᑯᖅᑕᐅᓯᒪᔪᑦ');
  // Intl has no Inuktitut number or date data: numbers and dates use
  // Canadian English, the way Nunavut writes them, whatever the browser is.
  assert.equal(formatNumber(1234.5), '1,234.5');
  assert.equal(localDigits('12,345.6'), '12,345.6');
  assert.equal(
    formatDate(new Date(Date.UTC(2026, 0, 15)), {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC',
    }),
    'January 15, 2026',
  );
});

test('Ancient Egyptian: its tag, hieroglyphic text, the dual plural, the fork tabs and Canadian number marks', () => {
  assert.equal(normalizeLocale('egy'), 'egy');
  assert.equal(normalizeLocale('egy-Egyp-EG'), 'egy');
  assert.equal(normalizeLocale(' EGY '), 'egy');
  assert.equal(LOCALE_NAMES.egy, 'Ancient Egyptian');
  const doc = { documentElement: {} };
  applyDocumentLanguage(doc, 'egy');
  assert.deepEqual(doc.documentElement, { lang: 'egy', dir: 'ltr' });

  setLocale('egy');
  // dp.t.PL n.t p.t ꜥnḫ: the living boats of the sky.
  assert.equal(t('Live Flights'), '𓂧𓊪𓏏𓊛𓏥 𓈖𓏏 𓊪𓏏𓇯 𓋹𓈖𓐍');
  assert.equal(t('CLEAR', { context: 'action' }), '𓅱𓂝𓃂');
  // Egyptian has a dual: one, two, then the plural from three on. Intl has
  // no Egyptian plural rules; it counts as Inuktitut does.
  const files = (count) =>
    tn(count, '{count} file selected', '{count} files selected');
  assert.equal(files(1), '𓅓𓍑𓏏𓏛 1 𓍉𓏏𓊪𓏏');
  assert.equal(files(2), '𓅓𓍑𓏏𓏛𓏛 2 𓍉𓏏𓊪𓏏');
  assert.equal(files(3), '𓅓𓍒𓏏𓏝𓏝𓏝 3 𓍉𓏏𓊪𓏏');
  assert.equal(files(0), '𓅓𓍒𓏏𓏝𓏝𓏝 0 𓍉𓏏𓊪𓏏');
  // The fork's own tabs are translated too, with the same dual.
  assert.equal(tl('AI RISK & TRUTH ASSESSMENT'), '𓇋𓊪𓏝 𓈖 𓇓𓅱𓏏 𓎛𓈖𓂝 𓌳𓂝𓏏 𓈖 𓅜𓐍');
  assert.equal(tl('OPEN', { context: 'licence' }), '𓃹𓈖');
  const tabFiles = (count) => tln(count, '{count} FILE', '{count} FILES');
  assert.equal(tabFiles(2), '𓅓𓍑𓏏𓏛𓏛 2');
  assert.equal(tabFiles(5), '𓅓𓍒𓏏𓏝𓏝𓏝 5');
  // Signs from the Unicode base block only: no format controls, so every
  // hieroglyph font draws them in a plain line. Names, codes and units stay
  // in Latin letters; the rest is hieroglyphic.
  const entries = Object.values(getCatalog('egy')).map((entry) =>
    typeof entry === 'string' ? [entry] : Object.values(entry),
  );
  for (const forms of entries)
    for (const text of forms)
      assert.doesNotMatch(text, /[\u{13430}-\u{1345F}]/u, text);
  const written = entries.filter((forms) =>
    forms.some((text) => /[\u{13000}-\u{1342F}]/u.test(text)),
  );
  assert.ok(written.length > entries.length * 0.9, `${written.length}`);
  // Intl has no Egyptian number or date data: numbers and dates use
  // Canadian English, in Western digits, whatever the browser is.
  assert.equal(formatNumber(1234.5), '1,234.5');
  assert.equal(localDigits('12,345.6'), '12,345.6');
  assert.equal(
    formatDate(new Date(Date.UTC(2026, 0, 15)), {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC',
    }),
    'January 15, 2026',
  );
});

test('in Ancient Egyptian and Inuktitut the page keeps the English of each line it shows', () => {
  setLocale('es');
  assert.equal(
    shownEnglish(t('Live Flights')),
    undefined,
    'other locales keep nothing',
  );
  setLocale('egy');
  const flights = t('Live Flights');
  assert.equal(shownEnglish(flights), 'Live Flights');
  assert.equal(shownEnglish(` ${flights}  `), 'Live Flights');
  // A value comes back in English too, a translated one included.
  assert.equal(
    shownEnglish(t('Show {name}', { name: flights })),
    'Show Live Flights',
  );
  assert.equal(
    shownEnglish(t('Show {name}', { name: 'Toronto' })),
    'Show Toronto',
  );
  const files = (count) =>
    tn(count, '{count} file selected', '{count} files selected');
  assert.equal(shownEnglish(files(1)), '1 file selected');
  assert.equal(shownEnglish(files(3)), '3 files selected');
  assert.equal(
    englishSingular('{count} files selected'),
    '{count} file selected',
  );
  setLocale('iu');
  const title = tl('AI RISK & TRUTH ASSESSMENT');
  assert.notEqual(title, 'AI RISK & TRUTH ASSESSMENT');
  assert.equal(shownEnglish(title), 'AI RISK & TRUTH ASSESSMENT');
});

test('marker.js tl(), tln() and localDigits() follow the page once index.js is loaded; english stays English', () => {
  const title = 'AI RISK & TRUTH ASSESSMENT';
  setLocale('fr-CA');
  assert.equal(markerTl(title), 'RISQUE ET VÉRITÉ PAR IA');
  assert.equal(markerTln(3, '{count} FILE', '{count} FILES'), '3 FICHIERS');
  assert.equal(localSay.tl(title), 'RISQUE ET VÉRITÉ PAR IA');
  assert.match(localDigits('12,345.6'), /^12\s345,6$/u);
  assert.match(markerDigits('12,345.6'), /^12\s345,6$/u);
  // A builder that takes say = english gives a model or a message English.
  assert.equal(english.tl(title), title);
  assert.equal(english.tln(1, '{count} FILE', '{count} FILES'), '1 FILE');
  assert.equal(english.digits('12,345.6'), '12,345.6');
  setLocale('ru');
  assert.equal(markerTl(title), title);
  assert.equal(localDigits('12,345.6'), '12,345.6');
});
