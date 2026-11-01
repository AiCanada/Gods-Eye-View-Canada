// The catalogs load on demand: one file per locale, fetched by the page for
// the active locale alone, read from disk under Node the moment a locale is
// asked for, so setLocale() stays synchronous here.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CATALOG_LOCALES,
  getCatalog,
  loadCatalog,
  registerCatalog,
  setLocale,
  t,
} from './index.js';
import { LOCALES } from './locale.js';

test('every shipped locale but English has a catalog file, and no other', () => {
  assert.deepEqual(
    [...CATALOG_LOCALES].sort(),
    LOCALES.filter((locale) => locale !== 'en').sort(),
  );
});

test('under Node a locale switch reads its catalog from disk at once', () => {
  try {
    assert.equal(setLocale('ja'), 'ja');
    const ja = getCatalog('ja');
    assert.ok(ja && Object.keys(ja).length > 1000, 'the Japanese catalog');
    const [english, japanese] = Object.entries(ja).find(
      ([, value]) => typeof value === 'string' && !value.includes('{'),
    );
    assert.equal(t(english), japanese);
    assert.equal(getCatalog('en'), null, 'English needs none');
    assert.equal(getCatalog('xx'), null, 'an unknown code has none');
  } finally {
    setLocale('en');
  }
});

test('loadCatalog fetches once and keeps it; English and unknown codes resolve to nothing', async () => {
  assert.equal(await loadCatalog('en'), null);
  assert.equal(await loadCatalog('xx'), null);
  const first = await loadCatalog('fr-CA');
  assert.ok(first && Object.keys(first).length > 1000);
  assert.equal(await loadCatalog('fr-CA'), first, 'the same object again');
  assert.equal(getCatalog('fr-CA'), first);
});

test('a registered catalog is used until it is forgotten, then the file is read again', () => {
  try {
    registerCatalog('de', { 'Hold Space to talk': 'Leertaste halten' });
    setLocale('de');
    assert.equal(t('Hold Space to talk'), 'Leertaste halten');
    registerCatalog('de', null);
    const de = getCatalog('de');
    assert.ok(de && Object.keys(de).length > 1000, 'the file again');
    const [english, german] = Object.entries(de).find(
      ([, value]) => typeof value === 'string' && !value.includes('{'),
    );
    assert.equal(t(english), german);
    registerCatalog('en', { x: 'y' });
    assert.equal(getCatalog('en'), null, 'English takes no catalog');
  } finally {
    setLocale('en');
  }
});
