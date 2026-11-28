// The fork's three locales (Quebec French, Inuktitut, Ancient Egyptian) load
// as every other catalog does (upstream #1966): each its own chunk, loaded
// when its locale is chosen, and setLocale applies it once it is in.
// catalogLoading.test.mjs covers the loading rules themselves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getCatalog, getLocale, loadCatalog, setLocale, t } from './index.js';

for (const locale of ['fr-CA', 'iu', 'egy']) {
  test(`the ${locale} catalog loads when chosen and the switch applies it`, async () => {
    try {
      const catalog = await loadCatalog(locale);
      assert.ok(
        catalog && Object.keys(catalog).length > 1000,
        `the ${locale} catalog`,
      );
      assert.equal(getCatalog(locale), catalog);
      assert.equal(await setLocale(locale), locale);
      assert.equal(getLocale(), locale);
      const [english, translated] = Object.entries(catalog).find(
        ([key, value]) =>
          !key.includes('|') &&
          typeof value === 'string' &&
          value.trim() !== '' &&
          value !== key &&
          !value.includes('{'),
      );
      assert.equal(t(english), translated);
    } finally {
      await setLocale('en');
    }
  });
}
