import { readStylesheet } from './testSupport/readStylesheet.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { shouldExpandGlobalContextPanel } from './rightRailPolicy.js';

test('desktop side rails never hide a collapsed panel, in any HUD layout (fork)', () => {
  // Owner rulings, 2026-09-27 and 2026-10-06: boxes open together and scroll,
  // and the collapsed tabs stay in reach while one is open. Upstream's
  // exclusive presentation (#1499) is off in both rails; its CSS stays unused.
  const right = readFileSync(new URL('./ui/rightPanelRail.js', import.meta.url), 'utf8');
  const left = readFileSync(new URL('./ui/leftPanelRail.js', import.meta.url), 'utf8');
  const css = readStylesheet(new URL('../style.css', import.meta.url));
  for (const ui of [right, left]) {
    assert.match(ui, /const isMobile = windowRef\.matchMedia\('\(max-width: 720px\)'\)\.matches/);
    assert.match(ui, /const exclusive = false;/);
    assert.doesNotMatch(ui, /const exclusive =\s*!isMobile/);
    assert.doesNotMatch(ui, /hud\.variant === 'cyber'/);
    assert.doesNotMatch(ui, /classList\.add\('layout-exclusive'\)/);
  }
  assert.match(right, /stack\.classList\.toggle\('layout-exclusive', exclusive\)/);
  assert.match(left, /stack\.classList\.remove\('layout-exclusive'\)/);
  // A panel floating out of the rail (portable mode) would be exempt anyway.
  assert.match(
    css,
    /#right-context-rail\.layout-exclusive\s*> \[data-panel-id\]\.collapsed:not\(\.panel-floating\) \{/,
  );
  assert.match(css, /#left-panel-stack\.layout-exclusive > \[data-panel-id\]\.collapsed \{/);
});

test('explicit Contacts, Space Missions, and Cockpit actions expand Global Context after success', () => {
  for (const action of ['contacts', 'space-missions', 'cockpit']) {
    assert.equal(shouldExpandGlobalContextPanel({
      action,
      explicitUserAction: true,
      succeeded: true,
    }), true, `${action} should reveal its supporting context`);
  }
});

test('Cockpit expansion is independent of whether a track was already selected', () => {
  for (const selectedTrack of [null, 'UAL649']) {
    assert.equal(shouldExpandGlobalContextPanel({
      action: 'cockpit',
      explicitUserAction: true,
      succeeded: true,
      selectedTrack,
    }), true);
  }
});

test('restoration and programmatic replay preserve the saved Global Context collapse state', () => {
  assert.equal(shouldExpandGlobalContextPanel({
    action: 'contacts',
    explicitUserAction: false,
    succeeded: true,
  }), false);
  assert.equal(shouldExpandGlobalContextPanel({
    action: 'space-missions',
    explicitUserAction: true,
    succeeded: true,
    restoring: true,
  }), false);
});

test('failed or unrelated actions never expand Global Context', () => {
  assert.equal(shouldExpandGlobalContextPanel({
    action: 'contacts',
    explicitUserAction: true,
    succeeded: false,
  }), false, 'a failed transition must preserve the prior panel state for rollback');
  assert.equal(shouldExpandGlobalContextPanel({
    action: 'search-nearby',
    explicitUserAction: true,
    succeeded: true,
  }), false);
});
