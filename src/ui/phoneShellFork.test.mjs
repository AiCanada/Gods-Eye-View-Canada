import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// Upstream's phone tab shell stays off in this fork (owner, 2026-10-11: the
// phone's layout is deliberate and keeps every tab). A merge that starts the
// shell again without the switch fails here.
test('the phone tab shell starts only behind the fork switch, which is off', () => {
  const source = fs.readFileSync(
    new URL('./applicationShell.js', import.meta.url),
    'utf8',
  );
  assert.match(source, /export const PHONE_TAB_SHELL = false;/);
  const calls = source.match(/^.*this\._initMobileShell\(\);.*$/gm) || [];
  assert.deepEqual(
    calls.map((line) => line.trim()),
    ['if (PHONE_TAB_SHELL) this._initMobileShell();'],
  );
});
