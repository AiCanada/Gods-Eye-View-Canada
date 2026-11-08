// God's Eye View Canada: the GLOBAL ABUNDANCE MAP box's state in the
// share-link manager (src/sharelink.js): `ab` in the long link, the field in
// the copied short link, and the restore that hands the box its state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShareLinkManager } from './sharelink.js';
import { parseSharePath } from './share/shareLinkPath.js';
import { decodeShareView } from './share/viewCodec.js';
import { toLegacyShareState } from './share/legacyShareState.js';

function makeManager(hash = '', options = {}) {
  globalThis.window = { location: { hash, href: `http://localhost/${hash}` } };
  globalThis.history = {
    replaceState(_state, _title, next) {
      window.location.hash = new URL(next, window.location.href).hash;
    },
  };
  const viewer = {
    camera: {
      changed: { addEventListener() {} },
      positionCartographic: { latitude: 0, longitude: 0, height: 1000 },
      heading: 0,
      pitch: -Math.PI / 2,
      roll: 0,
    },
  };
  return new ShareLinkManager(viewer, options);
}

/** The decoded view of a copied `/share/<code>` link. */
const sharedState = (href) =>
  decodeShareView(parseSharePath(new URL(href).pathname).code).state;

const BOX = Object.freeze({
  level: 'region',
  show: true,
  year: 25,
  view: 'p50',
  scale: 'others',
  scenario: 'baseline',
});

test('the box’s state is written as ab from its provider, only while the box has one', () => {
  const manager = makeManager();
  assert.equal(manager._buildHashParams().has('ab'), false);
  let state = BOX;
  manager.setAbundanceStateProvider(() => state);
  assert.equal(manager._buildHashParams().get('ab'), 'r.1.25.m.o.b');
  state = { level: 'nowhere' };
  assert.equal(manager._buildHashParams().has('ab'), false);
  state = null;
  assert.equal(manager._buildHashParams().has('ab'), false);
  manager.setAbundanceStateProvider(null);
  manager.destroy();
});

test('ab is read from v2 links, strictly, and never from v1', () => {
  assert.deepEqual(
    makeManager('#v=2&lat=10&lon=20&ab=y.0.100.d.t.v').parseInitialHash().abundance,
    { level: 'city', show: false, year: 100, view: 'down', scale: 'today', scenario: 'volatile' },
  );
  assert.equal(makeManager('#v=2&lat=10&lon=20').parseInitialHash().abundance, null);
  assert.equal(makeManager('#v=2&lat=10&lon=20&ab=nonsense').parseInitialHash().abundance, null);
  assert.equal(makeManager('#v=2&lat=10&lon=20&ab=').parseInitialHash().abundance, null);
  assert.equal(makeManager('#lat=10&lon=20&ab=c.1.0.m.t.b').parseInitialHash().abundance, null);
  assert.equal(makeManager('#v=1&lat=10&lon=20&ab=c.1.0.m.t.b').parseInitialHash().abundance, null);
});

test('a restore hands the box its state beside the visual state; a change schedules the link', async () => {
  let restored = null;
  const manager = makeManager('', {
    onRestore: (state) => {
      restored = state;
    },
    isNavigationCurrent: () => false,
  });
  const camera = { lat: 40, lon: -74, alt: 500, heading: 0, pitch: -30, roll: 0 };
  await manager.applyState({ ...camera, abundance: BOX });
  assert.deepEqual(restored.abundance, BOX);
  await manager.applyState({ ...camera });
  assert.equal(restored.abundance, null);
  assert.equal(manager._debounceTimer, null);
  manager.onAbundanceStateChange();
  assert.ok(manager._debounceTimer, 'a hash write is scheduled');
  clearTimeout(manager._debounceTimer);
  manager.destroy();
});

test('the live address and the copied short link carry the box, and the link opens with it', () => {
  const manager = makeManager();
  const box = { level: 'region', show: false, year: 7, view: 'up', scale: 'others', scenario: 'pessimistic' };
  manager.setAbundanceStateProvider(() => box);
  manager._updateHash();
  assert.equal(new URLSearchParams(window.location.hash.slice(1)).get('ab'), 'r.0.7.u.o.p');
  const href = manager.buildLink({ nowMs: 2_000_000 });
  const state = sharedState(href);
  assert.deepEqual(state.abundance, box);
  assert.deepEqual(toLegacyShareState(state).abundance, box);
  manager.destroy();
});
