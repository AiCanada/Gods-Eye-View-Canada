import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLocationShortcuts,
  loadLocationHistory,
  recordLocationSelection,
  saveLocationHistory,
} from './locationShortcuts.js';
import { CITY_POIS } from '../locations.js';

const poi = (cityId, poiIndex, name) => ({ type: 'poi', cityId, poiIndex, name });

test('Rapid Falls DZ always has its own pill in the location row', () => {
  const shortcuts = buildLocationShortcuts({ cities: CITY_POIS, history: [] });
  assert.equal(shortcuts.length, 1);
  assert.equal(shortcuts[0].role, 'pinned');
  assert.match(shortcuts[0].name, /^Rapid Falls DZ$/);
  const { cityId, poiIndex } = shortcuts[0].target;
  assert.equal(CITY_POIS[cityId].pois[poiIndex].name, 'Rapid Falls DZ');
});

test('LAST and 2ND LAST are the two selections before the current one', () => {
  let history = [];
  history = recordLocationSelection(history, poi('austin', 0, 'Texas State Capitol'));
  history = recordLocationSelection(history, poi('saintjohn', 0, 'Danger Zone'));
  history = recordLocationSelection(history, poi('austin', 2, 'Pennybacker Bridge'));
  const shortcuts = buildLocationShortcuts({ cities: CITY_POIS, history });
  assert.deepEqual(shortcuts.map((s) => s.role), ['pinned', 'last', 'second-last']);
  assert.equal(shortcuts[1].target.name, 'Danger Zone', 'the one selected just before this one');
  assert.equal(shortcuts[2].target.name, 'Texas State Capitol');
  assert.match(shortcuts[1].name, /^LAST · /);
  assert.match(shortcuts[2].name, /^2ND LAST · /);
});

test('re-selecting a place moves it to the front instead of duplicating it, and history is bounded', () => {
  let history = [];
  for (const entry of [poi('austin', 0, 'A'), poi('austin', 1, 'B'), poi('austin', 0, 'A'), poi('austin', 2, 'C'), poi('austin', 3, 'D')]) {
    history = recordLocationSelection(history, entry);
  }
  assert.deepEqual(history.map((h) => h.name), ['D', 'C', 'A']);
  assert.deepEqual(recordLocationSelection(history, null), history);
});

test('a pinned landmark is not repeated as LAST, and vanished places are dropped', () => {
  const rapid = buildLocationShortcuts({ cities: CITY_POIS, history: [] })[0].target;
  const history = [poi('austin', 0, 'Texas State Capitol'), rapid, { type: 'site', siteId: 'gone', name: 'Old site' }, poi('nowhere', 9, 'Ghost')];
  const shortcuts = buildLocationShortcuts({ cities: CITY_POIS, history });
  assert.deepEqual(shortcuts.map((s) => s.role), ['pinned']);
  const withSite = buildLocationShortcuts({ cities: CITY_POIS, history: [poi('austin', 0, 'X'), { type: 'site', siteId: 'home', name: 'Home' }], siteIds: new Set(['home']) });
  assert.equal(withSite[1].target.siteId, 'home');
});

test('history survives a reload and tolerates a broken store', () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  saveLocationHistory([poi('austin', 0, 'A'), poi('austin', 1, 'B')], storage);
  assert.deepEqual(loadLocationHistory(storage).map((h) => h.name), ['A', 'B']);
  assert.deepEqual(loadLocationHistory({ getItem: () => '{not json' }), []);
  assert.deepEqual(loadLocationHistory({ getItem() { throw new Error('denied'); } }), []);
  assert.doesNotThrow(() => saveLocationHistory([], { setItem() { throw new Error('full'); } }));
});
