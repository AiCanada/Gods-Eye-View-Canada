import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OutbreakPanel } from './outbreakPanel.js';
import { OUTBREAK_MODEL_EVENT, OUTBREAK_STORAGE_KEY } from './outbreakCore.mjs';

/** Just enough of a page for the box's top row and its log. */
function fakePage() {
  const nodes = new Map();
  const make = (id, extra = {}) => {
    const listeners = new Map();
    const node = {
      id,
      checked: false,
      value: '',
      textContent: '',
      dataset: {},
      addEventListener(type, fn) {
        listeners.set(type, [...(listeners.get(type) || []), fn]);
      },
      click() {
        for (const fn of listeners.get('click') || []) fn({ target: node });
      },
      ...extra,
    };
    nodes.set(id, node);
    return node;
  };
  for (const id of [
    'outbreak-panel',
    'outbreak-show',
    'outbreak-clear-map',
    'outbreak-clear',
    'outbreak-output',
    'outbreak-status',
  ])
    make(id);
  const document = {
    getElementById: (id) => nodes.get(id) || null,
    createElement: () => make(`el-${nodes.size}`, { appendChild() {} }),
  };
  const sent = [];
  const windowRef = {
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: (event) => {
      if (event.type === OUTBREAK_MODEL_EVENT) sent.push(event.detail);
      return true;
    },
  };
  const stored = new Map();
  const storage = {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, value),
  };
  return { nodes, document, windowRef, storage, sent, stored };
}

test('CLEAR MAP takes the spread off the map and keeps every result; CLEAR DATA clears the run', () => {
  const page = fakePage();
  const now = Date.UTC(2026, 9, 8, 12);
  page.storage.setItem(
    OUTBREAK_STORAGE_KEY,
    JSON.stringify({
      show: true,
      scan: {
        startMs: now - 48 * 3_600_000,
        flights: [],
        surroundings: {},
        flightSource: 'test',
      },
      forecast: [
        { name: 'Ulan-Ude, Russia', lat: 51.83, lon: 107.6, within: 24 },
      ],
      found: [{ place: 'Bratsk', evidence: 'quarantine', link: '' }],
    }),
  );
  const panel = new OutbreakPanel(null, {
    document: page.document,
    windowRef: page.windowRef,
    storage: page.storage,
    fetch: async () => {
      throw new Error('offline');
    },
    now: () => now,
  });
  const saved = () => JSON.parse(page.stored.get(OUTBREAK_STORAGE_KEY));
  page.nodes.get('outbreak-output').textContent = 'the log';

  page.nodes.get('outbreak-clear-map').click();
  assert.equal(page.sent.at(-1).show, false, 'the map is cleared');
  assert.equal(page.nodes.get('outbreak-show').checked, false);
  assert.ok(saved().scan, 'the scan is kept');
  assert.equal(saved().forecast.length, 1, 'the future spread is kept');
  assert.equal(saved().found.length, 1, 'the found places are kept');
  assert.equal(page.nodes.get('outbreak-output').textContent, 'the log');
  assert.match(page.nodes.get('outbreak-status').textContent, /MAP CLEARED/);

  page.nodes.get('outbreak-clear').click();
  assert.equal(saved().scan, null, 'the run is cleared');
  assert.deepEqual([saved().forecast, saved().found], [[], []]);
  assert.equal(page.nodes.get('outbreak-output').textContent, '');
  assert.equal(page.sent.at(-1).show, false, 'and the map with it');
  assert.match(page.nodes.get('outbreak-status').textContent, /DATA CLEARED/);
  panel.destroy();
});
