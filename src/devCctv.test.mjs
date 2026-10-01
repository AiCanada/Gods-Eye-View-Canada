import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

// Retired pack defaults and caps. Area loading (1,000 nearest within 50 km of
// the selected place) replaced them, so no launcher may set one.
const REMOVED_PACK_SETTINGS = [
  'CCTV_PREFER_AUSTIN',
  'CCTV_FORCE_AUSTIN',
  'CCTV_AUSTIN_MAX_SOURCES',
  'CCTV_CALTRANS_MAX_SOURCES',
  'CCTV_TFL_MAX_SOURCES',
  'CCTV_MAX_SOURCES',
  'CCTV_REGION_CAP',
];

test('no launcher script carries a CCTV pack default or cap', async () => {
  for (const name of ['dev-cctv.sh', 'dev-fresh.sh', 'dev-secure.sh']) {
    const source = await fs.readFile(new URL(`../scripts/${name}`, import.meta.url), 'utf8');
    for (const setting of REMOVED_PACK_SETTINGS) {
      assert.doesNotMatch(source, new RegExp(`\\b${setting}\\b`), `${name} still sets ${setting}`);
    }
    assert.doesNotMatch(source, /CCTV_CALTRANS_DISTRICTS[:]?-/, `${name} defaults the Caltrans districts`);
    assert.doesNotMatch(source, /put_env CCTV_CALTRANS_DISTRICTS/, `${name} forces the Caltrans districts`);
  }
});

