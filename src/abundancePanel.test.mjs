// The GLOBAL ABUNDANCE MAP tab (src/abundancePanel.js): the words, the
// level and indicator choice, the view handed to the globe, the selected
// place from a pick, the ranking, the CSV and the refresh.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ABUNDANCE_CHOICE_KEY,
  agoText,
  coverageText,
  figureText,
  importText,
  initAbundancePanel,
  linkText,
  readChoice,
  scoreText,
  sourceLines,
  statusText,
  unitLines,
} from './abundancePanel.js';
import {
  ABUNDANCE_CARD_EVENT,
  ABUNDANCE_INDICATOR_IDS,
  ABUNDANCE_PICK_EVENT,
  ABUNDANCE_VIEW_EVENT,
  distanceKm,
  indicatorById,
  packTable,
} from './abundanceCore.mjs';

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parent = null;
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.className = '';
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.indeterminate = false;
    this.value = '';
    this.text = '';
    this.files = null;
  }
  get textContent() {
    return this.tagName === '#TEXT'
      ? this.text
      : this.children.map((c) => c.textContent).join('');
  }
  set textContent(value) {
    this.children = [];
    if (String(value ?? '')) this.append(String(value));
  }
  append(...nodes) {
    for (const node of nodes) {
      const child =
        typeof node === 'string'
          ? Object.assign(new FakeElement('#text'), { text: node })
          : node;
      child.parent = this;
      this.children.push(child);
    }
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  addEventListener(type, listener) {
    this.listeners.set(type, [...(this.listeners.get(type) || []), listener]);
  }
  fire(type) {
    for (const listener of this.listeners.get(type) || []) listener({});
  }
  click() {
    this.fire('click');
  }
  all() {
    return [this, ...this.children.flatMap((c) => c.all())];
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

/** A document with the tab's two mounts, recording the events the tab sends. */
function fakeDocument() {
  const body = new FakeElement('div');
  body.hidden = true;
  const status = new FakeElement('div');
  const listeners = new Map();
  const events = [];
  return {
    body,
    status,
    events,
    doc: {
      getElementById: (id) =>
        id === 'abundance-body' ? body : id === 'abundance-status' ? status : null,
      createElement: (tag) => new FakeElement(tag),
      addEventListener: (type, fn) => listeners.set(type, fn),
      removeEventListener: (type) => listeners.delete(type),
      dispatchEvent: (event) => (events.push(event), true),
    },
    pick: (detail) => listeners.get(ABUNDANCE_PICK_EVENT)?.({ detail }),
  };
}

function table(level = 'country') {
  const units =
    level === 'country'
      ? [
          { id: 'TST', name: 'Testland', country: 'Testland', iso2: 'TS', lat: 5, lon: 5, values: { gdp: { v: 50000, year: 2024, from: 'own' }, inflation: { v: 2.5, year: 2025, from: 'own' } } },
          { id: 'FAR', name: 'Farland', country: 'Farland', iso2: 'FA', lat: 5, lon: 105, values: { gdp: { v: 20000, year: 2024, from: 'own' }, inflation: { v: 10, year: 2025, from: 'own' } } },
          { id: 'MID', name: 'Midland', country: 'Midland', iso2: 'MI', lat: 5, lon: 55, values: { gdp: { v: 30000, year: 2023, from: 'own' } } },
          { id: 'NOL', name: 'Noland', country: 'Noland', iso2: null, lat: -45, lon: -45, values: {} },
        ]
      : [
          { id: 'TS-N', name: 'North Testland', country: 'Testland', iso2: 'TS', lat: 8, lon: 5, values: { gdp: { v: 60000, year: 2023, from: 'own' }, inflation: { v: 2.5, year: 2025, from: 'country' } } },
        ];
  return {
    level,
    ...packTable(units),
    count: units.length,
    coverage: { gdp: { own: units.length - 1, inherited: 0, year: 2024 }, inflation: { own: 2, inherited: level === 'region' ? 1 : 0, year: 2025 } },
    imported: null,
    refreshedAt: 1_700_000_000_000,
    refreshing: null,
    stale: false,
  };
}

function status(extra = {}) {
  return {
    refreshing: null,
    refreshedAt: 1_700_000_000_000,
    stale: false,
    sources: [
      { id: 'wb:A', kind: 'worldbank', fetchedAt: 1_700_000_000_000, rows: 200, error: null },
      { id: 'wb:B', kind: 'worldbank', fetchedAt: 1_700_000_000_000, rows: 200, error: null },
      { id: 'owid:x', kind: 'owid', fetchedAt: 1_700_000_000_000, rows: 150, error: null },
      { id: 'oecd:y', kind: 'oecd', fetchedAt: null, rows: 0, error: 'HTTP 429' },
    ],
    levels: {},
    ...extra,
  };
}

/** A fetch answering the tab's routes, recording what was asked. */
function fakeFetch(answers = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined });
    const route = url.replace('/api/abundance/', '');
    let payload = null;
    if (route.startsWith('data?level=')) payload = answers.data?.(route.slice('data?level='.length)) ?? table(route.slice('data?level='.length));
    else if (route === 'status') payload = answers.status?.() ?? status();
    else if (route === 'refresh') payload = answers.status?.() ?? status({ refreshing: { done: 0, total: 24, current: 'World Bank WDI X' } });
    else if (route === 'import') payload = answers.import?.(calls.at(-1).body) ?? { ok: true, imported: { rows: 2, matched: 1, ignored: [], error: null }, status: status() };
    return {
      ok: Boolean(payload) && !payload.error,
      status: payload?.error ? 400 : 200,
      headers: { get: () => null },
      json: async () => payload || { error: 'Not found' },
    };
  };
  return { fetchImpl, calls };
}

function mount(answers, { stored = null } = {}) {
  const world = fakeDocument();
  const { fetchImpl, calls } = fakeFetch(answers);
  const timers = { pending: [], setTimeout(fn) { this.pending.push(fn); return fn; }, clearTimeout(fn) { this.pending = this.pending.filter((f) => f !== fn); } };
  const storage = { items: new Map([[ABUNDANCE_CHOICE_KEY, stored]].filter(([, v]) => v !== null)), getItem(k) { return this.items.get(k) ?? null; }, setItem(k, v) { this.items.set(k, v); } };
  const panel = initAbundancePanel({ documentRef: world.doc, fetchImpl, timers, now: () => 1_700_000_100_000, storage });
  const find = (predicate) => world.body.all().find(predicate);
  const control = (action) => find((n) => n.dataset.action === action);
  const box = (indicator) => find((n) => n.tagName === 'INPUT' && n.dataset.indicator === indicator);
  const views = () => world.events.filter((e) => e.type === ABUNDANCE_VIEW_EVENT).map((e) => e.detail);
  const cards = () => world.events.filter((e) => e.type === ABUNDANCE_CARD_EVENT).map((e) => e.detail);
  return { panel, world, calls, timers, storage, find, control, box, views, cards };
}

test('the words: the choice, the status line, coverage, a figure, a place, a link, the sources and the CSV', () => {
  assert.deepEqual(readChoice(null), { level: 'country', indicators: [...ABUNDANCE_INDICATOR_IDS], show: true, grid: false });
  assert.deepEqual(readChoice('{"level":"city","indicators":["work","gdp","x"],"show":false,"grid":true}'), { level: 'city', indicators: ['gdp', 'work'], show: false, grid: true });
  assert.deepEqual(readChoice('not json').level, 'country');
  assert.equal(statusText({ level: 'country', table: null, status: null, loading: true }), 'LOADING COUNTRIES…');
  assert.equal(statusText({ level: 'region', table: null, status: { refreshing: { done: 3, total: 24, current: 'OECD DF_GDP' } } }), 'FETCHING THE SOURCES · 3/24 · OECD DF_GDP');
  assert.equal(statusText({ level: 'city', table: { scored: 0 }, status: null }), 'CITIES · NO FIGURES YET: PRESS REFRESH DATA');
  assert.equal(statusText({ level: 'country', table: { scored: 198, newestYear: 2025, refreshedAt: 1_000_000 }, status: null, now: () => 1_000_000 + 61 * 60_000 }), 'COUNTRIES · 198 PLACES WITH FIGURES · DATA TO 2025 · FETCHED 1 HOUR AGO');
  assert.equal(agoText(1_000_000, 1_000_000 + 30_000), 'JUST NOW');
  assert.equal(agoText(1_000_000, 1_000_000 + 5 * 60_000), '5 MINUTES AGO');
  assert.equal(agoText(1_000_000, 1_000_000 + 3 * 86_400_000), '3 DAYS AGO');
  assert.equal(statusText({ level: 'country', table: null, status: null, error: 'HTTP 500' }), 'COUNTRIES · HTTP 500');
  assert.equal(coverageText({ own: 1, inherited: 62, year: 2024 }, 'region'), '1 OWN FIGURE · 62 FROM THEIR COUNTRY · 2024');
  assert.equal(coverageText({ own: 20, inherited: 7000, year: null }, 'city'), '20 OWN FIGURES · 7,000 FROM THEIR STATE OR COUNTRY');
  assert.equal(coverageText(null, 'country'), '');
  assert.equal(scoreText({ score: 71.6, counted: 12, of: 14 }), 'ABUNDANCE 72 OF 100 · 12 OF 14 INDICATORS');
  assert.equal(scoreText({ score: null }), 'NO FIGURES FOR THE CHOSEN INDICATORS');
  assert.equal(figureText(indicatorById('gdp'), { v: 54321.4, year: 2024, from: 'own' }, 87.2, 'country'), 'GDP PER PERSON · 54,321 $ · 2024 · PLACE 87 OF 100 · GDP PER PERSON, PPP, INTERNATIONAL $');
  assert.equal(figureText(indicatorById('inflation'), { v: 2.5, year: 2025, from: 'country' }, 60, 'region'), 'INFLATION · 2.5 % · 2025 · PLACE 60 OF 100 · FROM ITS COUNTRY · CONSUMER PRICES, % A YEAR');
  assert.equal(figureText(indicatorById('life'), { v: 82.07, year: null, from: 'csv' }, undefined, 'country'), 'LIFE SPAN · 82.1 YEARS · YOUR CSV · LIFE EXPECTANCY AT BIRTH');
  assert.equal(figureText(indicatorById('happiness'), { v: 7.123, year: 2024, from: 'own' }, 90, 'country'), 'HAPPINESS · 7.12 · 2024 · PLACE 90 OF 100 · LIFE SATISFACTION, 0 TO 10 (WORLD HAPPINESS REPORT)');
  const lines = unitLines(
    { id: '1', name: 'Testville', country: 'Testland', adm1: 'North Testland', pop: 500000, values: { gdp: { v: 70000, year: 2022, from: 'own' }, work: { v: 4, year: 2024, from: 'region' } } },
    { score: 80, counted: 2, of: 2, ranks: { gdp: 90, work: 70 } },
    ['gdp', 'work', 'life'],
    'city',
  );
  assert.deepEqual(lines, [
    'North Testland, Testland',
    'POPULATION 500,000',
    'ABUNDANCE 80 OF 100 · 2 OF 2 INDICATORS',
    'GDP PER PERSON · 70,000 $ · 2022 · PLACE 90 OF 100 · GDP PER PERSON OF THE URBAN AREA, PPP, US $',
    'WORK · 4.0 % · 2024 · PLACE 70 OF 100 · FROM ITS STATE OR PROVINCE · UNEMPLOYMENT, % OF THE LABOUR FORCE',
  ]);
  assert.deepEqual(unitLines(null), []);
  assert.equal(linkText({ from: 'a', to: 'b', gap: 61.4, km: 1234 }, new Map([['a', { name: 'Rich' }], ['b', { name: 'Poor' }]])), 'Rich → Poor · GAP 61 · 1,234 KM');
  assert.deepEqual(sourceLines(status(), () => 1_700_000_000_000 + 2 * 3_600_000), ['WORLD BANK · 2 SERIES · 2 HOURS AGO', 'OUR WORLD IN DATA · 1 SERIES · 2 HOURS AGO', 'OECD REGIONS AND CITIES · 1 SERIES · NOT FETCHED YET · 1 SOURCE FAILED']);
  assert.deepEqual(sourceLines(null), []);
  assert.equal(importText({ rows: 12, matched: 10, ignored: ['colour'], error: null }), 'YOUR CSV · 12 ROWS · 10 MATCHED · COLUMNS NOT USED: colour');
  assert.equal(importText(null), '');
});

test('the tab loads the level, scores the places, hands the globe its view, and follows the ticks', async () => {
  const m = mount();
  await settle();
  assert.equal(m.calls[0].url, '/api/abundance/data?level=country');
  assert.equal(m.calls[1].url, '/api/abundance/status');
  assert.match(m.world.status.textContent, /^COUNTRIES · 3 PLACES WITH FIGURES · DATA TO 2025 · FETCHED/);
  assert.equal(m.find((n) => n.tagName === 'SELECT').value, 'country');
  assert.equal(m.box('gdp').checked, true);
  assert.equal(m.find((n) => n.className === 'abundance-cover' && n.textContent.startsWith('3 OWN')).textContent, '3 OWN FIGURES · 2024');
  const view = m.views().at(-1);
  assert.equal(view.level, 'country');
  assert.equal(view.show, true);
  assert.deepEqual(view.units.map((u) => [u.id, Math.round(u.score ?? -1)]), [['TST', 100], ['FAR', 0], ['MID', 50], ['NOL', -1]]);
  assert.equal(view.units[0].color, '#19e6b0');
  assert.equal(view.units[3].color, '#5a6670');
  assert.deepEqual(view.links, []);
  // RANKING: most abundant first; LEAST ABUNDANT turns it round.
  const ranking = m.find((n) => n.className === 'abundance-list abundance-ranking');
  assert.deepEqual(ranking.children.map((li) => li.textContent), ['1. Testland · 100', '2. Midland · 50', '3. Farland · 0']);
  m.control('ranking-bottom').click();
  assert.deepEqual(ranking.children.map((li) => li.textContent), ['3. Farland · 0', '2. Midland · 50', '1. Testland · 100']);
  // Unticking GDP leaves inflation alone: Midland has no figure for it.
  m.box('gdp').checked = false;
  m.box('gdp').fire('change');
  const after = m.views().at(-1);
  assert.deepEqual(after.units.map((u) => [u.id, u.score]), [['TST', 100], ['FAR', 0], ['MID', null], ['NOL', null]]);
  const all = m.find((n) => n.tagName === 'INPUT' && n.parent?.className.includes('abundance-all') && n.parent.children[2].textContent === 'ALL');
  assert.equal(all.checked, false);
  assert.equal(all.indeterminate, true);
  assert.deepEqual(JSON.parse(m.storage.getItem(ABUNDANCE_CHOICE_KEY)).indicators, ABUNDANCE_INDICATOR_IDS.filter((id) => id !== 'gdp'));
  all.checked = true;
  all.fire('change');
  assert.equal(m.box('gdp').checked, true);
  // SHOW ON MAP off: the globe is told so; the grid on: links appear.
  const show = m.find((n) => n.tagName === 'INPUT' && n.parent?.children[2]?.textContent === 'SHOW ON MAP');
  show.checked = false;
  show.fire('change');
  assert.equal(m.views().at(-1).show, false);
  const grid = m.find((n) => n.tagName === 'INPUT' && n.parent?.children[2]?.textContent === 'ABUNDANCE GRID');
  grid.checked = true;
  grid.fire('change');
  const withGrid = m.views().at(-1);
  assert.deepEqual(withGrid.links.map((l) => [l.from.id, l.to.id]), [['TST', 'FAR']]);
  assert.equal(withGrid.links[0].from.lat, 5);
  const links = m.find((n) => n.className === 'abundance-list abundance-links');
  const km = Math.round(distanceKm(5, 5, 5, 105)).toLocaleString('en-US');
  assert.equal(links.children[0].textContent, `Testland → Farland · GAP 100 · ${km} KM`);
  m.panel.destroy();
  assert.equal(m.views().at(-1).show, false);
  assert.deepEqual(m.views().at(-1).units, []);
});

test('a pick from the globe fills SELECTED; a click keeps it and publishes its card; the ranking rows do the same', async () => {
  const m = mount();
  await settle();
  const name = m.find((n) => n.className === 'abundance-selected-name');
  const selected = m.find((n) => n.className === 'abundance-list abundance-selected');
  assert.equal(name.hidden, true);
  m.world.pick({ id: 'MID', level: 'country', hover: true });
  assert.equal(name.textContent, 'Midland');
  assert.equal(selected.children[0].textContent, 'ABUNDANCE 50 OF 100 · 1 OF 14 INDICATORS');
  assert.equal(selected.children[1].textContent, 'GDP PER PERSON · 30,000 $ · 2023 · PLACE 50 OF 100 · GDP PER PERSON, PPP, INTERNATIONAL $');
  assert.equal(m.cards().length, 0, 'a hover publishes no card');
  m.world.pick({ id: null, level: 'country', hover: true });
  assert.equal(name.hidden, true);
  m.world.pick({ id: 'TST', level: 'country', hover: false });
  assert.equal(name.textContent, 'Testland');
  assert.equal(m.panel.selected, 'TST');
  const card = m.cards().at(-1);
  assert.equal(card.selected, 'TST');
  assert.equal(card.card.title, 'Testland');
  assert.deepEqual([card.card.lat, card.card.lon], [5, 5]);
  assert.equal(card.card.details[0], 'ABUNDANCE 100 OF 100 · 2 OF 14 INDICATORS');
  assert.equal(card.card.accent, '#19e6b0');
  // A hover shows the hovered place; leaving it goes back to the kept one.
  m.world.pick({ id: 'FAR', level: 'country', hover: true });
  assert.equal(name.textContent, 'Farland');
  m.world.pick({ id: null, level: 'country', hover: true });
  assert.equal(name.textContent, 'Testland');
  // A pick for another level is ignored; CLEAR lets go.
  m.world.pick({ id: 'TS-N', level: 'region', hover: false });
  assert.equal(m.panel.selected, 'TST');
  m.control('clear').click();
  assert.equal(m.panel.selected, null);
  assert.equal(m.cards().at(-1).card, null);
  const ranking = m.find((n) => n.className === 'abundance-list abundance-ranking');
  ranking.children[1].fire('click');
  assert.equal(m.panel.selected, 'MID');
  assert.equal(m.cards().at(-1).card.title, 'Midland');
  m.panel.destroy();
});

test('the level changes what is fetched and shown; the choice comes back from this browser', async () => {
  const m = mount({}, { stored: JSON.stringify({ level: 'region', indicators: ['gdp'], show: true, grid: false }) });
  await settle();
  assert.equal(m.calls[0].url, '/api/abundance/data?level=region');
  assert.equal(m.find((n) => n.tagName === 'SELECT').value, 'region');
  assert.equal(m.box('gdp').checked, true);
  assert.equal(m.box('work').checked, false);
  assert.match(m.world.status.textContent, /^STATES AND PROVINCES · 1 PLACE WITH FIGURES/);
  assert.equal(m.find((n) => n.className === 'abundance-cover' && n.textContent.includes('FROM THEIR COUNTRY')).textContent, '2 OWN FIGURES · 1 FROM THEIR COUNTRY · 2025');
  const select = m.find((n) => n.tagName === 'SELECT');
  select.value = 'city';
  select.fire('change');
  await settle();
  assert.equal(m.calls.at(-1).url, '/api/abundance/data?level=city');
  assert.equal(m.views().at(-1).level, 'city');
  assert.equal(JSON.parse(m.storage.getItem(ABUNDANCE_CHOICE_KEY)).level, 'city');
  m.panel.destroy();
});

test('REFRESH DATA starts a refresh and polls; a finished refresh reloads the level; LOAD CSV posts the file and CLEAR CSV takes it off', async () => {
  let busy = true;
  const m = mount({
    status: () => (busy ? status({ refreshing: { done: 2, total: 24, current: 'World Bank WDI X' } }) : status({ refreshedAt: 1_700_000_500_000 })),
  });
  await settle();
  m.control('refresh').click();
  await settle();
  assert.deepEqual(m.calls.at(-1), { url: '/api/abundance/refresh', method: 'POST', body: { force: true } });
  assert.equal(m.world.status.textContent, 'FETCHING THE SOURCES · 2/24 · World Bank WDI X');
  assert.equal(m.control('refresh').disabled, true);
  // The poll runs while it is busy; once done the level is fetched again.
  busy = false;
  const loads = m.calls.filter((c) => c.url.includes('data?level=')).length;
  m.timers.pending.pop()();
  await settle();
  assert.equal(m.calls.filter((c) => c.url.includes('data?level=')).length, loads + 1);
  assert.equal(m.control('refresh').disabled, false);
  // LOAD CSV: the file's text goes up with the level; the line reports it.
  const file = m.find((n) => n.tagName === 'INPUT' && n.type === 'file');
  const m2 = mount({ data: (level) => ({ ...table(level), imported: { rows: 2, matched: 1, ignored: [], error: null, at: 1 } }) });
  await settle();
  const input = m2.find((n) => n.tagName === 'INPUT' && n.type === 'file');
  input.files = [{ text: async () => 'id,gdp\nTST,1' }];
  input.fire('change');
  await settle();
  const post = m2.calls.find((c) => c.url === '/api/abundance/import' && c.method === 'POST');
  assert.deepEqual(post.body, { level: 'country', csv: 'id,gdp\nTST,1' });
  assert.equal(m2.world.status.textContent, 'YOUR CSV · 2 ROWS · 1 MATCHED');
  assert.equal(m2.find((n) => n.className === 'abundance-note' && n.textContent.startsWith('YOUR CSV')).textContent, 'YOUR CSV · 2 ROWS · 1 MATCHED');
  m2.control('clear-csv').click();
  await settle();
  assert.deepEqual(m2.calls.at(-2), { url: '/api/abundance/import', method: 'DELETE', body: { level: 'country' } });
  assert.ok(file);
  m.panel.destroy();
  m2.panel.destroy();
});

test('without its mount the tab is a no-op', () => {
  const panel = initAbundancePanel({ documentRef: { getElementById: () => null } });
  panel.render();
  panel.destroy();
});
