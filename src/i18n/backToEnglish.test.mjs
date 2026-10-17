import { test } from 'node:test';
import assert from 'node:assert/strict';

import egy from './locales/egy.json' with { type: 'json' };
import iu from './locales/iu.json' with { type: 'json' };
import { createBackTranslator, hasHintScript } from './backToEnglish.js';

const CATALOG = {
  Save: '𓋴𓏠𓈖',
  'action|CLEAR': '𓅱𓂝𓃂',
  'Show {name}': '𓋴𓐍𓂝 {name}',
  '{count} files': {
    one: '𓅓𓍑 {count}',
    two: '𓅓𓍑𓍑 {count}',
    other: '𓅓𓍑𓏥 {count}',
  },
  '{label}: {value}': '{label}: {value}',
  Help: 'ᐃᑲᔪᕐᓂᖅ',
};

test('hieroglyphs and syllabics are the scripts that get help', () => {
  assert.equal(hasHintScript('𓋴𓏠𓈖'), true);
  assert.equal(hasHintScript('ᐃᑲᔪᕐᓂᖅ'), true);
  assert.equal(hasHintScript('Save 12'), false);
  assert.equal(hasHintScript(''), false);
  assert.equal(hasHintScript(null), false);
});

test('a whole line reads back, its context and spacing aside', () => {
  const { englishFor } = createBackTranslator(CATALOG);
  assert.equal(englishFor('𓋴𓏠𓈖'), 'Save');
  assert.equal(englishFor('  𓋴𓏠𓈖\n'), 'Save');
  assert.equal(englishFor('𓅱𓂝𓃂'), 'CLEAR');
  assert.equal(englishFor('ᐃᑲᔪᕐᓂᖅ'), 'Help');
  assert.equal(englishFor('Save'), undefined, 'English needs no help');
});

test('what the page kept as it drew a line comes first', () => {
  const { englishFor } = createBackTranslator(CATALOG, {
    recorded: (line) => (line === '𓋴𓏠𓈖' ? 'Save keys' : undefined),
  });
  assert.equal(englishFor('𓋴𓏠𓈖'), 'Save keys');
});

test('a line with values reads back with them, a translated value too', () => {
  const singular = (plural) =>
    plural === '{count} files' ? '{count} file' : undefined;
  const { englishFor } = createBackTranslator(CATALOG, { singular });
  assert.equal(englishFor('𓋴𓐍𓂝 𓋴𓏠𓈖'), 'Show Save');
  assert.equal(englishFor('𓋴𓐍𓂝 Toronto'), 'Show Toronto');
  assert.equal(englishFor('𓅓𓍑𓏥 12'), '12 files');
  assert.equal(englishFor('𓅓𓍑𓍑 2'), '2 files');
  assert.equal(englishFor('𓅓𓍑 1'), '1 file');
  assert.equal(
    createBackTranslator(CATALOG).englishFor('𓅓𓍑 1'),
    '1 files',
    'without the singular, the plural stands in',
  );
});

test('a line put together from translated pieces reads back piece by piece', () => {
  const { englishFor } = createBackTranslator(CATALOG);
  assert.equal(englishFor('𓋴𓏠𓈖 · 𓅱𓂝𓃂'), 'Save · CLEAR');
  assert.equal(englishFor('ᐃᑲᔪᕐᓂᖅ — 𓋴𓏠𓈖'), 'Help — Save');
  // A piece inside a longer word is not that piece.
  assert.equal(englishFor('𓋴𓏠𓈖𓈖'), undefined);
});

test('a pattern that would swallow words of its own does not match', () => {
  // "𓋴𓐍𓂝 {name}" with a name that does not read back is not "Show …".
  const { englishFor } = createBackTranslator(CATALOG);
  assert.equal(englishFor('𓋴𓐍𓂝 𓏏𓏏𓏏'), undefined);
});

for (const [locale, catalog] of [
  ['egy', egy],
  ['iu', iu],
]) {
  /** Each line of the catalog with the English it translates. */
  const sources = new Map();
  for (const [key, entry] of Object.entries(catalog)) {
    if (typeof entry !== 'string') continue;
    const line = entry.replace(/\s+/g, ' ').trim();
    if (!sources.has(line)) sources.set(line, new Set());
    sources.get(line).add(key.replace(/^[a-z][a-z ]*\|/, ''));
  }

  test(`${locale}: every whole line of the catalog reads back to an English it translates`, () => {
    const { englishFor } = createBackTranslator(catalog);
    let checked = 0;
    for (const [line, english] of sources) {
      if (!hasHintScript(line) || line.includes('{')) continue;
      assert.ok(english.has(englishFor(line)), line);
      checked += 1;
    }
    assert.ok(checked > 3000, `${checked} lines`);
  });

  test(`${locale}: a count, a translated value and a joined line read back`, () => {
    const { englishFor } = createBackTranslator(catalog, {
      singular: (plural) =>
        plural === '{count} files selected'
          ? '{count} file selected'
          : undefined,
    });
    const files = catalog['{count} files selected'];
    assert.equal(
      englishFor(files.other.replace('{count}', '7')),
      '7 files selected',
    );
    assert.equal(
      englishFor(files.one.replace('{count}', '1')),
      '1 file selected',
    );
    assert.equal(
      englishFor(
        catalog['Show {name}'].replace('{name}', catalog['Live Flights']),
      ),
      'Show Live Flights',
    );
    const joined = englishFor(`${catalog['Live Flights']} · ${catalog.Pause}`);
    assert.match(joined, /^Live Flights · /);
    assert.ok(sources.get(catalog.Pause).has(joined.slice(15)), joined);
  });
}
