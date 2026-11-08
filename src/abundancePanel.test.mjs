// The GLOBAL ABUNDANCE MAP tab (src/abundancePanel.js): the words, the
// level and indicator choice, the view handed to the globe, the selected
// place from a pick, the ranking, the CSV and the refresh.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ABUNDANCE_CHOICE_KEY,
  agoText,
  coverageText,
  failureText,
  figureText,
  importText,
  initAbundancePanel,
  legendValues,
  linkText,
  readChoice,
  scoreText,
  sourceLines,
  statusText,
  trendText,
  unitLines,
  valueWithUnit,
  yearText,
  changeText,
  forecastNote,
  forecastScoreLines,
  forecastFigureText,
  modelLine,
  hindcastText,
  worldText,
  forecastCsv,
  scenarioText,
  forecastLegend,
  viewText,
  drawFan,
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
          { id: 'TST', name: 'Testland', country: 'Testland', iso2: 'TS', lat: 5, lon: 5, people: 5e6, values: { gdp: { v: 50000, year: 2024, from: 'own' }, inflation: { v: 2.5, year: 2025, from: 'own' } } },
          { id: 'FAR', name: 'Farland', country: 'Farland', iso2: 'FA', lat: 5, lon: 105, people: 20e6, values: { gdp: { v: 20000, year: 2024, from: 'own' }, inflation: { v: 10, year: 2025, from: 'own' } } },
          { id: 'MID', name: 'Midland', country: 'Midland', iso2: 'MI', lat: 5, lon: 55, people: 3e6, values: { gdp: { v: 30000, year: 2023, from: 'own' } } },
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
  const saves = [];
  // The share link's meeting point: who connected, how often the box said it changed.
  const share = {
    connected: [],
    changes: 0,
    connect(api) {
      this.connected.push(api);
      return () => {
        this.connected = this.connected.filter((p) => p !== api);
      };
    },
    changed() {
      this.changes += 1;
    },
  };
  const panel = initAbundancePanel({
    documentRef: world.doc,
    fetchImpl,
    timers,
    now: () => 1_700_000_100_000,
    storage,
    saveFile: (name, text) => {
      saves.push({ name, text });
      return true;
    },
    share,
  });
  const find = (predicate) => world.body.all().find(predicate);
  const control = (action) => find((n) => n.dataset.action === action);
  const box = (indicator) => find((n) => n.tagName === 'INPUT' && n.dataset.indicator === indicator);
  const views = () => world.events.filter((e) => e.type === ABUNDANCE_VIEW_EVENT).map((e) => e.detail);
  const cards = () => world.events.filter((e) => e.type === ABUNDANCE_CARD_EVENT).map((e) => e.detail);
  return { panel, world, calls, timers, storage, saves, share, find, control, box, views, cards };
}

test('SHARE LINKS: the box hands its state over, says when it changes, and takes a link’s state as if chosen here', async () => {
  const m = mount();
  await settle();
  assert.equal(m.share.connected.length, 1, 'connected once built');
  assert.equal(m.share.connected[0], m.panel);
  assert.deepEqual(m.panel.shareState(), { level: 'country', show: true, year: 0, view: 'p50', scale: 'today', scenario: 'baseline' });
  const told = m.share.changes;
  const slider = m.find((n) => n.className === 'abundance-year');
  slider.value = '10';
  slider.fire('input');
  assert.ok(m.share.changes > told, 'a change is told');
  assert.equal(m.panel.shareState().year, 10);
  // A link's state: another level, SHOW ON MAP off, 25 years ahead, the chance of scarcity among the others in a volatile world.
  const linked = { level: 'region', show: false, year: 25, view: 'down', scale: 'others', scenario: 'volatile' };
  assert.equal(m.panel.applyShareState(linked), true);
  assert.deepEqual(m.panel.shareState(), linked);
  assert.equal(m.panel.choice.level, 'region');
  assert.equal(m.panel.choice.show, false);
  assert.equal(JSON.parse(m.storage.getItem(ABUNDANCE_CHOICE_KEY)).scenario, 'volatile', 'kept as the viewer’s choice');
  await settle();
  assert.equal(m.views().at(-1).level, 'region', 'the level was loaded and published');
  assert.equal(m.views().at(-1).show, false);
  assert.equal(m.find((n) => n.className === 'abundance-year-text').textContent, '2048 · +25 YEARS');
  // The same level again: no reload, the rest applied; a state with no known level is nothing.
  assert.equal(m.panel.applyShareState({ level: 'region', year: 0 }), true);
  assert.deepEqual(m.panel.shareState(), { level: 'region', show: true, year: 0, view: 'p50', scale: 'today', scenario: 'baseline' });
  assert.equal(m.panel.applyShareState({ level: 'moon' }), false);
  assert.equal(m.panel.applyShareState(null), false);
  m.panel.destroy();
  assert.equal(m.share.connected.length, 0, 'disconnected with the box');
  assert.equal(m.panel.applyShareState(linked), false, 'nothing after the box is gone');
});

test('the words: the choice, the status line, coverage, a figure, a place, a link, the sources and the CSV', () => {
  assert.deepEqual(readChoice(null), { level: 'country', indicators: [...ABUNDANCE_INDICATOR_IDS], show: true, grid: false, weights: {}, year: 0, view: 'p50', runs: null, crises: true, scale: 'today', scenario: 'baseline' });
  assert.deepEqual(readChoice('{"level":"city","indicators":["work","gdp","x"],"show":false,"grid":true,"weights":{"gdp":2,"work":7,"x":3,"life":1}}'), { level: 'city', indicators: ['gdp', 'work'], show: false, grid: true, weights: { gdp: 2, work: 3 }, year: 0, view: 'p50', runs: null, crises: true, scale: 'today', scenario: 'baseline' });
  assert.deepEqual(readChoice('{"year":"40","view":"up","runs":250,"crises":false,"scale":"others","scenario":"volatile"}'), { level: 'country', indicators: [...ABUNDANCE_INDICATOR_IDS], show: true, grid: false, weights: {}, year: 40, view: 'up', runs: 250, crises: false, scale: 'others', scenario: 'volatile' });
  assert.equal(readChoice('{"scale":"x","scenario":"y"}').scale, 'today');
  assert.equal(readChoice('{"scale":"x","scenario":"y"}').scenario, 'baseline');
  assert.deepEqual(readChoice('{"year":500,"view":"x","runs":7}').year, 100);
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
  assert.equal(coverageText({ own: 3, area: 40, inherited: 10, year: 2023 }, 'region'), '3 OWN FIGURES · 40 FROM THEIR LARGER REGION · 10 FROM THEIR COUNTRY · 2023');
  assert.equal(scoreText({ score: 71.6, counted: 12, of: 14 }), 'ABUNDANCE 72 OF 100 · 12 OF 14 INDICATORS');
  assert.equal(scoreText({ score: null }), 'NO FIGURES FOR THE CHOSEN INDICATORS');
  assert.equal(figureText(indicatorById('gdp'), { v: 54321.4, year: 2024, from: 'own' }, 87.2, 'country'), 'GDP PER PERSON · 54,321 $ · 2024 · PLACE 87 OF 100 · GDP PER PERSON, PPP, INTERNATIONAL $');
  assert.equal(figureText(indicatorById('inflation'), { v: 2.5, year: 2025, from: 'country' }, 60, 'region'), 'INFLATION · 2.5 % · 2025 · PLACE 60 OF 100 · FROM ITS COUNTRY · CONSUMER PRICES, % A YEAR');
  assert.equal(figureText(indicatorById('life'), { v: 82.07, year: null, from: 'csv' }, undefined, 'country'), 'LIFE SPAN · 82.1 YEARS · YOUR CSV · LIFE EXPECTANCY AT BIRTH');
  assert.equal(figureText(indicatorById('happiness'), { v: 7.123, year: 2024, from: 'own' }, 90, 'country'), 'HAPPINESS · 7.12 · 2024 · PLACE 90 OF 100 · LIFE SATISFACTION, 0 TO 10 (WORLD HAPPINESS REPORT)');
  // A figure's change since an earlier year rides after its year; a symbol unit stays as it is.
  assert.equal(figureText(indicatorById('gdp'), { v: 54321, year: 2024, from: 'own', d: 2500.4, y0: 2019 }, 87, 'country'), 'GDP PER PERSON · 54,321 $ · 2024 · ▲ +2,500 SINCE 2019 · PLACE 87 OF 100 · GDP PER PERSON, PPP, INTERNATIONAL $');
  assert.equal(figureText(indicatorById('air'), { v: 12.34, year: 2023, from: 'area', d: -3.2, y0: 2018 }, 40, 'region'), 'AIR · 12.3 µg/m³ · 2023 · ▼ -3.2 SINCE 2018 · PLACE 40 OF 100 · FROM ITS LARGER REGION · FINE PARTICLES (PM2.5) BREATHED OVER A YEAR');
  // A larger region's figure is the OECD's regional one, and says so in its measure.
  assert.equal(figureText(indicatorById('education'), { v: 59.6, year: 2025, from: 'area' }, 39, 'region'), 'EDUCATION · 60 % · 2025 · PLACE 39 OF 100 · FROM ITS LARGER REGION · ADULTS 25–64 WITH TERTIARY EDUCATION, %');
  assert.equal(trendText(indicatorById('work'), { v: 5, d: 0, y0: 2020 }), '■ 0.0 SINCE 2020');
  assert.equal(trendText(indicatorById('work'), { v: 5 }), '');
  // A change that rounds to nothing in the indicator's decimals reads no change, not ▼ -0.
  assert.equal(trendText(indicatorById('water'), { v: 98, d: -0.2, y0: 2020 }), '■ 0 SINCE 2020');
  assert.equal(trendText(indicatorById('work'), { v: 5, d: -0.04, y0: 2020 }), '■ 0.0 SINCE 2020');
  assert.equal(trendText(indicatorById('work'), { v: 5, d: -0.06, y0: 2020 }), '▼ -0.1 SINCE 2020');
  assert.equal(trendText(indicatorById('work'), { v: 5, d: 0.06, y0: 2020 }), '▲ +0.1 SINCE 2020');
  assert.equal(valueWithUnit(indicatorById('life'), 81.26), '81.3 YEARS');
  assert.equal(valueWithUnit(indicatorById('green'), 150), '150');
  // The legend's values: the scarce end is the highest figure where lower is better.
  const places = [
    { id: 'a', values: { gdp: { v: 1000 }, inflation: { v: 1 } } },
    { id: 'b', values: { gdp: { v: 3000 }, inflation: { v: 4 } } },
    { id: 'c', values: { gdp: { v: 20000 }, inflation: { v: 12 } } },
    { id: 'd', values: {} },
  ];
  assert.deepEqual(legendValues(places, indicatorById('gdp')), { low: '1,000 $', mid: '3,000 $', high: '20,000 $' });
  assert.deepEqual(legendValues(places, indicatorById('inflation')), { low: '12.0 %', mid: '4.0 %', high: '1.0 %' });
  assert.equal(legendValues(places, indicatorById('work')), null);
  assert.equal(legendValues([], indicatorById('gdp')), null);
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
    'WORK · 4.0 % · 2024 · PLACE 70 OF 100 · FROM ITS STATE OR PROVINCE · UNEMPLOYMENT, % OF THE LABOUR FORCE AGED 15–64',
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
  // With every indicator ticked the legend reads the score; with one, that indicator's figures.
  const legendText = () => ['abundance-legend-value'].flatMap((c) => m.world.body.all().filter((n) => n.className === c).map((n) => n.textContent));
  assert.deepEqual(legendText(), ['0', '50', '100']);
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
  for (const id of ABUNDANCE_INDICATOR_IDS) if (id !== 'inflation' && m.box(id).checked) { m.box(id).checked = false; m.box(id).fire('change'); }
  assert.deepEqual(m.panel.choice.indicators, ['inflation']);
  assert.deepEqual(legendText(), ['10.0 %', '6.3 %', '2.5 %']);
  all.checked = true;
  all.fire('change');
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

test('a weight slider counts an indicator more; RESET WEIGHTS puts every weight back; the choice is kept', async () => {
  const m = mount();
  await settle();
  const slider = (id) => m.find((n) => n.tagName === 'INPUT' && n.type === 'range' && n.dataset.indicator === id);
  const times = (id) => slider(id).parent.children[2].textContent;
  const reset = m.control('reset-weights');
  assert.equal(reset.hidden, true);
  assert.equal(times('gdp'), '×1');
  // GDP and inflation ticked: Testland is first on both, Farland last on both; Midland has only GDP.
  for (const id of ABUNDANCE_INDICATOR_IDS) if (id !== 'gdp' && id !== 'inflation') { m.box(id).checked = false; m.box(id).fire('change'); }
  const scoreOf = (id) => Math.round(m.views().at(-1).units.find((u) => u.id === id).score);
  assert.equal(scoreOf('MID'), 50);
  // A heavier inflation does not move Midland (no figure for it) but changes nothing for ties either.
  slider('inflation').value = '3';
  slider('inflation').fire('input');
  assert.equal(times('inflation'), '×3');
  assert.deepEqual(m.panel.choice.weights, { inflation: 3 });
  assert.equal(reset.hidden, false);
  assert.deepEqual(JSON.parse(m.storage.getItem(ABUNDANCE_CHOICE_KEY)).weights, { inflation: 3 });
  assert.equal(scoreOf('TST'), 100);
  // A place half-way on GDP and worst on inflation: inflation's weight pulls its score down.
  const m2 = mount({ data: () => ({ ...table('country'), ...(() => { const t = table('country'); t.figures.inflation.v[2] = 20; return { figures: t.figures }; })() }) });
  await settle();
  for (const id of ABUNDANCE_INDICATOR_IDS) if (id !== 'gdp' && id !== 'inflation') { m2.box(id).checked = false; m2.box(id).fire('change'); }
  const mid = () => Math.round(m2.views().at(-1).units.find((u) => u.id === 'MID').score);
  assert.equal(mid(), 25);
  const s2 = m2.find((n) => n.tagName === 'INPUT' && n.type === 'range' && n.dataset.indicator === 'inflation');
  s2.value = '3';
  s2.fire('change');
  assert.equal(mid(), 13);
  m2.control('reset-weights').click();
  assert.equal(mid(), 25);
  assert.deepEqual(m2.panel.choice.weights, {});
  assert.equal(m2.control('reset-weights').hidden, true);
  // An unticked indicator's slider is off.
  assert.equal(m2.find((n) => n.tagName === 'INPUT' && n.type === 'range' && n.dataset.indicator === 'work').disabled, true);
  m.panel.destroy();
  m2.panel.destroy();
});

test('a pick from the globe fills SELECTED; a click keeps it and publishes its card; the ranking rows do the same', async () => {
  const m = mount();
  await settle();
  const name = m.find((n) => n.className === 'abundance-selected-name');
  const selected = m.find((n) => n.className === 'abundance-list abundance-selected');
  assert.equal(name.hidden, true);
  m.world.pick({ id: 'MID', level: 'country', hover: true });
  assert.equal(name.textContent, 'Midland');
  assert.equal(selected.children[0].textContent, 'ABUNDANCE 50 OF 100 · 1 OF 16 INDICATORS');
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
  assert.equal(card.card.details[0], 'ABUNDANCE 100 OF 100 · 2 OF 16 INDICATORS');
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

test('a request that gets no answer is said in the tab\'s words, not the browser\'s', () => {
  assert.equal(failureText(new TypeError('Failed to fetch')), 'NO ANSWER FROM THE SERVER');
  assert.equal(failureText(new TypeError('NetworkError when attempting to fetch resource.')), 'NO ANSWER FROM THE SERVER');
  assert.equal(failureText({ name: 'TimeoutError', message: 'signal timed out' }), 'THE SERVER TOOK TOO LONG TO ANSWER');
  assert.equal(failureText({ name: 'AbortError' }), 'THE SERVER TOOK TOO LONG TO ANSWER');
  assert.equal(failureText(Object.assign(new Error('x'), { kind: 'not-json' })), 'THE SERVER ANSWERED WITH SOMETHING OTHER THAN ITS FIGURES');
  assert.equal(failureText(new Error('The Global Abundance Map failed.')), 'THE GLOBAL ABUNDANCE MAP FAILED.');
  assert.equal(
    statusText({ level: 'region', error: { problem: 'NO ANSWER FROM THE SERVER', retryInMs: 10_000 } }),
    'STATES AND PROVINCES · NO ANSWER FROM THE SERVER · TRYING AGAIN IN 10 S',
  );
  assert.equal(statusText({ level: 'region', error: 'HTTP 503' }), 'STATES AND PROVINCES · HTTP 503');
});

test('a load that gets no answer tries again after a growing wait and clears the line once the server answers; a failed status poll leaves a loaded level alone', async () => {
  let dataDown = true;
  let statusDown = true;
  const m = mount({
    data: (level) => {
      if (dataDown) throw new TypeError('Failed to fetch');
      return table(level);
    },
    status: () => {
      if (statusDown) throw new TypeError('Failed to fetch');
      return status();
    },
  });
  await settle();
  assert.equal(m.world.status.textContent, 'COUNTRIES · NO ANSWER FROM THE SERVER · TRYING AGAIN IN 5 S');
  assert.equal(m.world.status.dataset.state, 'error');
  const loads = () => m.calls.filter((c) => c.url.includes('data?level=')).length;
  assert.equal(loads(), 1);
  // The retry fires while the server is still down: the wait grows.
  let timers = m.timers.pending.splice(0);
  for (const fn of timers) fn();
  await settle();
  assert.equal(loads(), 2);
  assert.equal(m.world.status.textContent, 'COUNTRIES · NO ANSWER FROM THE SERVER · TRYING AGAIN IN 10 S');
  timers = m.timers.pending.splice(0);
  for (const fn of timers) fn();
  await settle();
  assert.equal(m.world.status.textContent, 'COUNTRIES · NO ANSWER FROM THE SERVER · TRYING AGAIN IN 20 S');
  // The server is back: the next try lands, the line reads the level again.
  dataDown = false;
  statusDown = false;
  timers = m.timers.pending.splice(0);
  for (const fn of timers) fn();
  await settle();
  assert.match(m.world.status.textContent, /^COUNTRIES · 3 PLACES WITH FIGURES/);
  assert.equal(m.world.status.dataset.state, 'ok');
  // A status poll that fails now leaves the loaded level's line alone and polls again sooner.
  statusDown = true;
  const before = m.timers.pending.length;
  timers = m.timers.pending.splice(0);
  for (const fn of timers) fn();
  await settle();
  assert.match(m.world.status.textContent, /^COUNTRIES · 3 PLACES WITH FIGURES/);
  assert.ok(m.timers.pending.length >= 1 && before >= 1, 'the next poll is scheduled');
  // A level change ends the tries of the old level: no stray retry stays armed.
  dataDown = true;
  const select = m.find((n) => n.tagName === 'SELECT');
  select.value = 'city';
  select.fire('change');
  await settle();
  assert.equal(m.world.status.textContent, 'CITIES · NO ANSWER FROM THE SERVER · TRYING AGAIN IN 5 S', 'a fresh count for the new level');
  m.panel.destroy();
  assert.equal(m.timers.pending.length, 0, 'destroy clears every timer');
});

test('without its mount the tab is a no-op', () => {
  const panel = initAbundancePanel({ documentRef: { getElementById: () => null } });
  panel.render();
  panel.destroy();
});

test('the forecast words: the year, a change, the note, a place’s lines, a figure’s line, the model line, the legend, a view’s figure, the fan chart', () => {
  assert.equal(yearText(0, 2026), 'TODAY');
  assert.equal(yearText(1, 2026), '2027 · +1 YEAR');
  assert.equal(yearText(25, 2026), '2051 · +25 YEARS');
  assert.equal(yearText('x', 2026), 'TODAY');
  assert.equal(changeText(12.4), '+12');
  assert.equal(changeText(-3), '-3');
  assert.equal(changeText(0), '0');
  assert.equal(changeText(NaN), '');
  assert.equal(forecastNote({ year: 10, running: { year: 43, years: 100 }, result: null, scored: 5 }), 'SIMULATING · 43 %');
  assert.equal(forecastNote({ year: 10, running: null, result: null, scored: 0 }), 'NO FORECAST: NO FIGURES AT THIS LEVEL');
  assert.equal(forecastNote({ year: 10, running: null, result: { runs: 500, years: 100, ms: 2345 }, scored: 5 }), '500 RUNS OVER 100 YEARS · SIMULATED IN 2.3 S');
  assert.equal(forecastNote({ year: 0, running: null, result: null, scored: 5 }), 'SLIDE YEARS AHEAD TO SEE THE FUTURE ON THE MAP');
  assert.equal(forecastNote({ year: 5, running: null, result: null, scored: 5 }), '');
  // The world's line: by population where the places have people, each once otherwise; today's three figures at TODAY.
  const world = { p10: 48.2, p50: 55.4, p90: 61, mean: 55, up: 18.4, down: 20.6, today: 47.6, upToday: 12.2, downToday: 30.4, weighted: true };
  assert.equal(
    worldText(world, { year: 25, baseYear: 2026 }),
    'ALL PLACES BY POPULATION · ABUNDANCE 48 OF 100 TODAY → 55 IN 2051 · 48 TO 61 IN 8 OF 10 RUNS · IN ABUNDANT PLACES 12 % → 18 % · IN SCARCE ONES 30 % → 21 %',
  );
  assert.equal(
    worldText({ ...world, p10: 47.6, p50: 47.6, p90: 47.6, up: 12.2, down: 30.4, weighted: false }, { year: 0, baseYear: 2026 }),
    'ALL PLACES, EACH COUNTED ONCE · ABUNDANCE 48 OF 100 · 12 % IN ABUNDANT PLACES · 30 % IN SCARCE ONES',
  );
  assert.equal(worldText(null, { year: 5 }), '');
  assert.equal(worldText({ ...world, p50: NaN }, { year: 5 }), '');
  // The line by scenario: the run's own from its world, the other three from the comparison runs;
  // nothing at TODAY, nothing until all four are in.
  const line = (p50) => ({ p50: Float64Array.from({ length: 101 }, (_, t) => (t ? p50 : 50)) });
  const lines = { scenario: 'pessimistic', world: line(58.4), compare: { baseline: line(61), optimistic: line(62.2), volatile: line(59.6) } };
  assert.equal(scenarioText(lines, { year: 25, baseYear: 2026 }), '2051 BY SCENARIO · BASELINE 61 · OPTIMISTIC 62 · PESSIMISTIC 58 · VOLATILE 60');
  assert.equal(scenarioText(lines, { year: 0, baseYear: 2026 }), '');
  assert.equal(scenarioText({ ...lines, compare: { baseline: line(61), optimistic: line(62.2) } }, { year: 25 }), '', 'volatile not in yet');
  assert.equal(scenarioText({ ...lines, world: null }, { year: 25 }), '');
  assert.equal(scenarioText(undefined, { year: 25 }), '');
  // The forecast as CSV: a header, then every place with a row at the year, a name quoted when it needs it, a place without a row left out.
  const r = {
    ids: ['TST', 'FAR', 'X'],
    years: 1,
    today: Float32Array.from([70, 30, NaN]),
    p10: Float32Array.from([70, 61, 30, 25.4, NaN, NaN]),
    p50: Float32Array.from([70, 66.6, 30, 31, NaN, NaN]),
    p90: Float32Array.from([70, 72, 30, 36, NaN, NaN]),
    mean: Float32Array.from([70, 66.4, 30, 31.2, NaN, NaN]),
    up: Uint8Array.from([0, 12, 0, 0, 0, 0]),
    down: Uint8Array.from([0, 0, 0, 20, 0, 0]),
  };
  const csvUnits = [{ id: 'TST', name: 'Testland', country: 'Testland', people: 5e6 }, { id: 'FAR', name: 'Far, Away', country: 'Farland' }, { id: 'X', name: 'Nowhere', country: 'Noland' }];
  assert.equal(
    forecastCsv(r, csvUnits, { year: 1, scale: 'today', baseYear: 2026 }),
    'id,name,country,people,year,years_ahead,scale,score_today,typical,if_badly,if_well,mean,chance_abundant_pct,chance_scarce_pct\nTST,Testland,Testland,5000000,2027,1,today,70,66.6,61,72,66.4,12,0\nFAR,"Far, Away",Farland,,2027,1,today,30,31,25.4,36,31.2,0,20\n',
  );
  assert.equal(forecastCsv(null, csvUnits).split('\n').length, 2, 'no result: the header alone');
  const row = { p10: 48.2, p50: 63.6, p90: 79.1, mean: 63, up: 31, down: 2, today: 51.4 };
  assert.deepEqual(forecastScoreLines(row, null, { year: 25, baseYear: 2026, rank: 12, count: 198 }), [
    '2051 · ABUNDANCE 64 OF 100 TYPICALLY · 48 TO 79 IN 8 OF 10 RUNS',
    'CHANCE OF ABUNDANCE 31 % · CHANCE OF SCARCITY 2 %',
    'RANKED 12 OF 198 · +12 FROM TODAY',
  ]);
  assert.equal(forecastScoreLines(row, null, { year: 25, baseYear: 2026, rank: null, count: 198 })[2], '+12 FROM TODAY');
  assert.deepEqual(forecastScoreLines(null, null, { year: 25, baseYear: 2026 }), ['NO FORECAST FOR THIS PLACE']);
  // With the ranks among the others: their line, and the chances and change of the scale shown.
  const others = { p10: 50.2, p50: 61.4, p90: 72.3, mean: 61, up: 12, down: 5, today: 51.4 };
  assert.deepEqual(forecastScoreLines(row, others, { year: 25, baseYear: 2026, rank: 12, count: 198 }), [
    '2051 · ABUNDANCE 64 OF 100 TYPICALLY · 48 TO 79 IN 8 OF 10 RUNS',
    'AMONG THE OTHERS IN 2051 · 61 OF 100 TYPICALLY · 50 TO 72',
    'CHANCE OF ABUNDANCE 31 % · CHANCE OF SCARCITY 2 %',
    'RANKED 12 OF 198 · +12 FROM TODAY',
  ]);
  assert.deepEqual(forecastScoreLines(row, others, { year: 25, baseYear: 2026, rank: 12, count: 198, scale: 'others' }).slice(2), [
    'CHANCE OF ABUNDANCE 12 % · CHANCE OF SCARCITY 5 %',
    'RANKED 12 OF 198 · +10 FROM TODAY',
  ]);
  const entry = { p10: [1, 31000], p50: [1, 38500.4], p90: [1, 48000], placeMid: [1, 70.6] };
  assert.equal(forecastFigureText(indicatorById('gdp'), entry, 1, 'own'), 'GDP PER PERSON · 38,500 $ · 31,000 TO 48,000 · PLACE 71 OF 100');
  assert.equal(forecastFigureText(indicatorById('gdp'), entry, 1, 'country'), 'GDP PER PERSON · 38,500 $ · 31,000 TO 48,000 · PLACE 71 OF 100 · FROM ITS COUNTRY');
  assert.equal(modelLine(indicatorById('gdp'), { family: 'growth', trend: 1010.4, spread: 2501, n: 28, frontier: 66055.8 }), 'GDP PER PERSON · +1,010 $ A YEAR · ±2,501 $ · CATCHING UP WITH THE FRONTIER (66,056 $) · 28 STEPS OF HISTORY');
  assert.equal(modelLine(indicatorById('gdp'), { family: 'growth', trend: 1010.4, spread: 2501, n: 28, frontier: 66055.8, scale: 1.3 }, { held: 82, tested: 180, scale: 1.3 }), 'GDP PER PERSON · +1,010 $ A YEAR · ±2,501 $ · CATCHING UP WITH THE FRONTIER (66,056 $) · 28 STEPS OF HISTORY · SWING ×1.3 · HINDCAST BAND HELD 82 %');
  assert.equal(
    modelLine(indicatorById('gdp'), { family: 'growth', trend: 1010.4, spread: 2501, n: 28, frontier: 66055.8, scale: 1.3, pull: 0.8 }, { held: 82, tested: 180, scale: 1.3, pull: 0.8 }),
    'GDP PER PERSON · +1,010 $ A YEAR · ±2,501 $ · CATCHING UP WITH THE FRONTIER (66,056 $) · 28 STEPS OF HISTORY · SWING ×1.3 · PULL ×0.8 · HINDCAST BAND HELD 82 %',
  );
  assert.equal(modelLine(indicatorById('health'), { family: 'floor', trend: -0.31, spread: 0.6, floor: 1, frontier: 2.2, n: 1 }), 'HEALTH · -0.3 A YEAR · ±0.6 · TOWARD THE FRONTIER (2.2), FLOOR 1.0 · 1 STEP OF HISTORY');
  assert.equal(modelLine(indicatorById('water'), { family: 'ceiling', trend: 0.6, spread: 0.9, cap: 100, frontier: 99.5, n: 0 }), 'WATER · +1 % A YEAR · ±1 % · TOWARD THE FRONTIER (100 %), CEILING 100 % · NO HISTORY: THE LEVEL’S TYPICAL FIGURES');
  assert.equal(hindcastText({ from: 2014, to: 2024, held: 81, tested: 2345 }), 'HINDCAST 2014→2024 · THE 8-OF-10 BAND HELD 81 % OF 2,345 FIGURES · THE TRENDS AND SWINGS ARE CALIBRATED BY IT');
  // The hindcast's trend shift reads in the figure's units, signed; one that rounds to nothing is left out.
  assert.equal(
    modelLine(indicatorById('gdp'), { family: 'growth', trend: 800.4, spread: 2501, n: 28, frontier: 66055.8, scale: 1.3, shift: -0.004, trendShift: -210.4 }, { held: 82, tested: 180, scale: 1.3, shift: -0.004 }),
    'GDP PER PERSON · +800 $ A YEAR · ±2,501 $ · CATCHING UP WITH THE FRONTIER (66,056 $) · 28 STEPS OF HISTORY · SWING ×1.3 · HINDCAST TREND -210 $ A YEAR · HINDCAST BAND HELD 82 %',
  );
  assert.equal(modelLine(indicatorById('water'), { family: 'ceiling', trend: 0.6, spread: 0.9, cap: 100, frontier: 99.5, n: 0, shift: 0.001, trendShift: 0.04 }), 'WATER · +1 % A YEAR · ±1 % · TOWARD THE FRONTIER (100 %), CEILING 100 % · NO HISTORY: THE LEVEL’S TYPICAL FIGURES');
  assert.equal(modelLine(indicatorById('inflation'), { family: 'revert', trend: 0.3, spread: 2.5, level: 3.04, n: 12, shift: 0.3, trendShift: 0.3 }), 'INFLATION · +0.3 % A YEAR · ±2.5 % · RETURNS TO ITS USUAL 3.0 % · 12 STEPS OF HISTORY · HINDCAST TREND +0.3 % A YEAR');
  assert.equal(hindcastText({ from: 2014, to: 2024, held: 0, tested: 0 }), '');
  assert.equal(hindcastText(null), '');
  assert.equal(modelLine(indicatorById('inflation'), { family: 'revert', trend: 0, spread: 2.5, level: 3.04, n: 12 }), 'INFLATION · 0.0 % A YEAR · ±2.5 % · RETURNS TO ITS USUAL 3.0 % · 12 STEPS OF HISTORY');
  assert.equal(modelLine(indicatorById('utilities'), { family: 'ceiling', trend: 0, spread: 0, cap: 100, n: 3, saturated: true }), 'UTILITIES · 0 % A YEAR · ±0 % · AT ITS CEILING, STAYS THERE · 3 STEPS OF HISTORY');
  assert.equal(modelLine(null, {}), '');
  assert.deepEqual(forecastLegend('p50'), { low: '0', mid: '50', high: '100' });
  assert.deepEqual(forecastLegend('p10'), { low: '0', mid: '50', high: '100' });
  assert.deepEqual(forecastLegend('up'), { low: '0 %', mid: '50 %', high: '100 %' });
  assert.deepEqual(forecastLegend('down'), { low: '100 %', mid: '50 %', high: '0 %' });
  assert.deepEqual(forecastLegend('change'), { low: '-50', mid: '0', high: '+50' });
  assert.equal(viewText(63.6, 'p50'), '64');
  assert.equal(viewText(31, 'up'), '31 %');
  assert.equal(viewText(-4.4, 'change'), '-4');
  assert.equal(viewText(NaN, 'p50'), '');
  // The fan chart: the band, the two marks, the typical line and the chosen year; nothing without a context.
  const calls = [];
  const ctx = new Proxy({}, { get: (_, name) => (...args) => void calls.push([name, args.length]), set: () => true });
  const series = { p10: [40, 42, 44], p50: [50, 53, 56], p90: [60, 64, 68] };
  assert.equal(drawFan({ width: 240, height: 72, getContext: () => ctx }, series, 1), true);
  assert.equal(calls.filter(([name]) => name === 'stroke').length, 4);
  assert.equal(calls.filter(([name]) => name === 'fill').length, 1);
  assert.equal(calls.filter(([name]) => name === 'lineTo').length, 6 + 3 + 1 + 1 + 1);
  assert.equal(drawFan({ width: 240, height: 72 }, series, 1), false);
  assert.equal(drawFan({ width: 240, height: 72, getContext: () => ctx }, null, 1), false);
});

test('FORECAST: the slider runs the simulation, the map, ranking and SELECTED follow the chosen year and view, PLAY walks the years, and the choice is kept', async () => {
  const m = mount();
  await settle();
  const slider = m.find((n) => n.className === 'abundance-year');
  const readout = m.find((n) => n.className === 'abundance-year-text');
  const note = m.find((n) => n.className === 'abundance-note abundance-forecast-note');
  const model = m.find((n) => n.className === 'abundance-list abundance-model');
  const legendText = () => m.world.body.all().filter((n) => n.className === 'abundance-legend-value').map((n) => n.textContent);
  const forecastNotes = () => m.world.body.all().filter((n) => n.className === 'abundance-note abundance-forecast-note').map((n) => n.textContent);
  assert.equal(readout.textContent, 'TODAY');
  assert.equal(note.textContent, 'SLIDE YEARS AHEAD TO SEE THE FUTURE ON THE MAP');
  assert.equal(forecastNotes()[1], '', 'no world line before a run');
  assert.equal(m.control('download-forecast').disabled, true, 'nothing to download before a run');
  assert.equal(m.panel.forecast, null);
  assert.equal(model.hidden, true);
  const todayView = m.views().at(-1);
  // Twenty-five years ahead: the run waits for the next change, then goes.
  slider.value = '25';
  slider.fire('input');
  assert.equal(m.panel.choice.year, 25);
  assert.equal(readout.textContent, '2048 · +25 YEARS');
  assert.equal(JSON.parse(m.storage.getItem(ABUNDANCE_CHOICE_KEY)).year, 25);
  assert.equal(m.panel.forecast, null);
  assert.equal(note.textContent, '');
  m.timers.pending.pop()();
  await settle();
  const result = m.panel.forecast;
  assert.ok(result, 'a result');
  assert.equal(m.panel.simulating, false);
  assert.equal(result.runs, 500, 'the country level’s default runs');
  assert.equal(result.years, 100);
  assert.equal(result.seed, 1);
  assert.deepEqual(result.ids, ['TST', 'FAR', 'MID', 'NOL']);
  assert.match(note.textContent, /^500 RUNS OVER 100 YEARS · SIMULATED IN \d+\.\d S$/);
  // The world's line under it: the places weighed by their people, today and at the year.
  assert.match(
    forecastNotes()[1],
    /^ALL PLACES BY POPULATION · ABUNDANCE \d+ OF 100 TODAY → \d+ IN 2048 · \d+ TO \d+ IN 8 OF 10 RUNS · IN ABUNDANT PLACES \d+ % → \d+ % · IN SCARCE ONES \d+ % → \d+ %$/,
  );
  assert.ok(result.weighted);
  // The line by scenario: the other three simulated after the run, at fewer runs, the run's own figure the world line's.
  assert.match(
    forecastNotes()[2],
    /^2048 BY SCENARIO · BASELINE \d+ · OPTIMISTIC \d+ · PESSIMISTIC \d+ · VOLATILE \d+$/,
  );
  assert.equal(
    /BASELINE (\d+)/.exec(forecastNotes()[2])[1],
    /→ (\d+) IN 2048/.exec(forecastNotes()[1])[1],
    'the run’s own scenario reads as the world line',
  );
  // The world's fan chart (a second canvas) and DOWNLOAD FORECAST, which hands over every place's row at the year.
  assert.equal(m.world.body.all().filter((n) => n.tagName === 'CANVAS').length, 2, 'the world’s fan and the place’s');
  const download = m.control('download-forecast');
  assert.equal(download.disabled, false);
  download.click();
  assert.equal(m.saves.length, 1);
  assert.equal(m.saves[0].name, 'abundance-forecast-country-2048.csv');
  const csvLines = m.saves[0].text.trim().split('\n');
  assert.equal(csvLines.length, 4, 'a header and the three places with figures');
  assert.match(csvLines[1], /^TST,Testland,Testland,5000000,2048,25,today,\d+(\.\d)?,\d+(\.\d)?,\d+(\.\d)?,\d+(\.\d)?,\d+(\.\d)?,\d+,\d+$/);
  const view = m.views().at(-1);
  const scoreOf = (id) => view.units.find((u) => u.id === id).score;
  assert.ok(scoreOf('TST') >= scoreOf('FAR'), 'the richer place stays ahead');
  assert.equal(scoreOf('NOL'), null);
  assert.ok(view.units.every((u) => /^#[0-9a-f]{6}$/.test(u.color)));
  assert.notDeepEqual(view.units.map((u) => u.score), todayView.units.map((u) => u.score));
  assert.deepEqual(legendText(), ['0', '50', '100']);
  // MODEL reads the level's typical lines until a place is selected.
  assert.equal(model.hidden, false);
  assert.equal(model.children.length, 2);
  assert.match(model.children[0].textContent, /^GDP PER PERSON · [+-]?[\d,]+ \$ A YEAR · ±[\d,]+ \$ · CATCHING UP WITH THE FRONTIER \([\d,]+ \$\) · NO HISTORY: THE LEVEL’S TYPICAL FIGURES$/);
  assert.equal(result.rp50, undefined, 'no ranks among the others until that scale is chosen');
  assert.equal(result.scenario, 'baseline');
  assert.match(model.children[1].textContent, /^INFLATION · [+-]?[\d.]+ % A YEAR · ±[\d.]+ % · RETURNS TO ITS USUAL [\d.]+ % · NO HISTORY: THE LEVEL’S TYPICAL FIGURES$/);
  // The ranking is by the view's figure at the year.
  const ranking = m.find((n) => n.className === 'abundance-list abundance-ranking');
  assert.equal(ranking.children.length, 3);
  assert.match(ranking.children[0].textContent, /^1\. \w+ · \d+$/);
  // A clicked place reads its band, chances, rank and change, then each indicator's projection once its detail comes.
  m.world.pick({ id: 'TST', hover: false });
  await settle();
  const selected = m.find((n) => n.className === 'abundance-list abundance-selected');
  const lines = selected.children.map((li) => li.textContent);
  assert.equal(lines.length, 5);
  assert.match(lines[0], /^2048 · ABUNDANCE \d+ OF 100 TYPICALLY · \d+ TO \d+ IN 8 OF 10 RUNS$/);
  assert.match(lines[1], /^CHANCE OF ABUNDANCE \d+ % · CHANCE OF SCARCITY \d+ %$/);
  assert.match(lines[2], /^RANKED [123] OF 3 · [+-]?\d+ FROM TODAY$/);
  assert.match(lines[3], /^GDP PER PERSON · [\d,]+ \$ · [\d,]+ TO [\d,]+ · PLACE \d+ OF 100$/);
  assert.match(lines[4], /^INFLATION · -?[\d.]+ % · -?[\d.]+ TO -?[\d.]+ · PLACE \d+ OF 100$/, 'deflation is a figure too');
  const card = m.cards().at(-1).card;
  assert.equal(card.id, 'TST');
  assert.deepEqual(card.details, lines);
  assert.match(model.children[0].textContent, /GDP PER PERSON · /);
  const fan = m.find((n) => n.tagName === 'CANVAS');
  assert.equal(fan.hidden, true, 'no drawing context here');
  // Another view: the chances, in percent, and their legend.
  const viewSelect = m.find((n) => n.className === 'abundance-view');
  viewSelect.value = 'up';
  viewSelect.fire('change');
  assert.deepEqual(legendText(), ['0 %', '50 %', '100 %']);
  assert.match(ranking.children[0].textContent, /^1\. \w+ · \d+ %$/);
  assert.ok(m.views().at(-1).units.every((u) => u.score === null || (u.score >= 0 && u.score <= 100)));
  assert.equal(JSON.parse(m.storage.getItem(ABUNDANCE_CHOICE_KEY)).view, 'up');
  viewSelect.value = 'change';
  viewSelect.fire('change');
  assert.deepEqual(legendText(), ['-50', '0', '+50']);
  assert.match(ranking.children[0].textContent, /^1\. \w+ · [+-]?\d+$/);
  viewSelect.value = 'p50';
  viewSelect.fire('change');
  // Back to today: the map is today's again; the result stays for the next move.
  slider.value = '0';
  slider.fire('input');
  assert.equal(readout.textContent, 'TODAY');
  assert.deepEqual(m.views().at(-1).units.map((u) => u.score), todayView.units.map((u) => u.score));
  assert.ok(m.panel.forecast);
  assert.match(forecastNotes()[1], /^ALL PLACES BY POPULATION · ABUNDANCE \d+ OF 100 · \d+ % IN ABUNDANT PLACES · \d+ % IN SCARCE ONES$/, 'today’s world line');
  assert.equal(forecastNotes()[2], '', 'no line by scenario at TODAY');
  assert.deepEqual(selected.children.map((li) => li.textContent).slice(0, 1), ['ABUNDANCE 100 OF 100 · 2 OF 16 INDICATORS']);
  // PLAY walks a year at a time; STOP holds.
  const play = m.control('play');
  assert.equal(play.textContent, 'PLAY');
  play.click();
  assert.equal(play.textContent, 'STOP');
  m.timers.pending.pop()();
  assert.equal(m.panel.choice.year, 1);
  assert.equal(readout.textContent, '2024 · +1 YEAR');
  m.timers.pending.pop()();
  assert.equal(m.panel.choice.year, 2);
  play.click();
  assert.equal(play.textContent, 'PLAY');
  assert.equal(m.timers.pending.length, 1, 'only the status poll waits');
  // Fewer runs, no crises, a new draw: each makes the runs again.
  const runs = m.find((n) => n.className === 'abundance-runs');
  runs.value = '100';
  runs.fire('change');
  assert.equal(m.panel.forecast, null);
  m.timers.pending.pop()();
  await settle();
  assert.equal(m.panel.forecast.runs, 100);
  assert.equal(JSON.parse(m.storage.getItem(ABUNDANCE_CHOICE_KEY)).runs, 100);
  const crises = m.find((n) => n.tagName === 'INPUT' && n.parent?.children[2]?.textContent === 'CRISES');
  crises.checked = false;
  crises.fire('change');
  m.timers.pending.pop()();
  await settle();
  assert.equal(m.panel.forecast.crises, false);
  m.control('redraw').click();
  m.timers.pending.pop()();
  await settle();
  assert.equal(m.panel.forecast.seed, 2);
  // The scale among the others ranks the places on each run: a new run, and SELECTED gains their line.
  const scale = m.find((n) => n.className === 'abundance-scale');
  scale.value = 'others';
  scale.fire('change');
  assert.equal(JSON.parse(m.storage.getItem(ABUNDANCE_CHOICE_KEY)).scale, 'others');
  m.timers.pending.pop()();
  await settle();
  assert.ok(m.panel.forecast.rp50, 'ranked among the others');
  slider.value = '30';
  slider.fire('input');
  await settle();
  m.world.pick({ id: 'TST', hover: true });
  await settle();
  const amongLines = selected.children.map((li) => li.textContent);
  assert.equal(amongLines.length, 6, "the two bands, the chances, the rank, and the two indicator lines");
  assert.match(amongLines[0], /^2053 · ABUNDANCE \d+ OF 100 TYPICALLY/);
  assert.match(amongLines[1], /^AMONG THE OTHERS IN 2053 · \d+ OF 100 TYPICALLY · \d+ TO \d+$/);
  m.world.pick({ id: null, hover: true });
  scale.value = 'today';
  scale.fire('change');
  // A scenario makes the runs again in that world.
  const scenario = m.find((n) => n.className === 'abundance-scenario');
  scenario.value = 'optimistic';
  scenario.fire('change');
  assert.equal(m.panel.forecast, null);
  m.timers.pending.pop()();
  await settle();
  assert.equal(m.panel.forecast.scenario, 'optimistic');
  assert.equal(JSON.parse(m.storage.getItem(ABUNDANCE_CHOICE_KEY)).scenario, 'optimistic');
  // Unticking an indicator makes the runs again for the ticks on; the choice goes on.
  m.box('inflation').checked = false;
  m.box('inflation').fire('change');
  m.timers.pending.pop()();
  await settle();
  assert.ok(m.panel.forecast);
  assert.equal(m.panel.choice.indicators.includes('inflation'), false);
  m.panel.destroy();
  assert.equal(m.views().at(-1).show, false);
});
