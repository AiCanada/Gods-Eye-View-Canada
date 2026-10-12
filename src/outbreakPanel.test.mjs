import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EPIDEMIC_PERSIST_PLACES,
  OutbreakPanel,
  PROFILE_DEFAULTS_VERSION,
  RAIL_WORLD_POLL_MS,
  cleanSeed,
  epidemicTrimmedNote,
  railWorldLine,
  trimmedEpidemic,
} from './outbreakPanel.js';
import { OUTBREAK_MODEL_EVENT, OUTBREAK_STORAGE_KEY } from './outbreakCore.mjs';
import { OUTBREAK_DEFAULT_PROFILE, PATHOGEN_PRESETS } from './outbreakEpi.mjs';

/** Just enough of a page for the box's top row and its log, plus `extra` ids. */
function fakePage(extraIds = []) {
  const nodes = new Map();
  const make = (id, extra = {}) => {
    const listeners = new Map();
    const node = {
      id,
      checked: false,
      value: '',
      textContent: '',
      dataset: {},
      children: [],
      appendChild(child) {
        node.children.push(child);
        return child;
      },
      replaceChildren(...children) {
        node.children = [...children];
      },
      fire(type) {
        for (const fn of listeners.get(type) || []) fn({ target: node });
      },
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
    ...extraIds,
  ])
    make(id);
  const document = {
    getElementById: (id) => nodes.get(id) || null,
    createElement: () => make(`el-${nodes.size}`),
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

test('EPIDEMIC MODEL: a preset fills the fields; RUN sends the scan and profile; the result reaches the map and the list', async () => {
  const page = fakePage([
    'outbreak-preset',
    'outbreak-transmission',
    'outbreak-r0',
    'outbreak-latent',
    'outbreak-superspreading',
    'outbreak-travel-ban',
    'outbreak-epi-run',
    'outbreak-epi-runs',
    'outbreak-epi-days',
    'outbreak-epi-curve',
    'outbreak-mode-epidemic',
    'outbreak-epidemic',
  ]);
  const now = Date.UTC(2026, 9, 8, 12);
  const startMs = now - 48 * 3_600_000;
  page.storage.setItem(
    OUTBREAK_STORAGE_KEY,
    JSON.stringify({
      scan: {
        startMs,
        flights: [],
        surroundings: {},
        flightSource: 'test',
        airports: ['UIII'],
      },
    }),
  );
  const asked = [];
  const during = [];
  const result = {
    startMs,
    runs: 50,
    seed: 7,
    places: [
      {
        id: 'UUEE',
        code: 'UUEE',
        name: 'Sheremetyevo',
        lat: 55.97,
        lon: 37.41,
        pArrive: 0.8,
        arrivalHours: Array(21).fill(30),
        etaP5: 20,
        etaP50: 30,
        etaP95: 60,
        casesP50: 40,
      },
    ],
    commutes: [],
    totals: [
      {
        day: 1,
        p5: 50,
        p50: 60,
        p95: 80,
        reportedP50: 0,
        deathsP50: 0,
        hospitalP50: 0,
        icuP50: 0,
      },
      {
        day: 2,
        p5: 70,
        p50: 90,
        p95: 130,
        reportedP50: 6,
        deathsP50: 1,
        hospitalP50: 5,
        icuP50: 1,
      },
    ],
    summary: {
      r0: 15,
      rEffective: 12,
      rControlled: 12,
      doublingDays: 1.1,
      peakDayP50: 2,
    },
    network: { places: 3, flights: 10 },
    populationSource: 'GeoNames',
    effectiveDistance: [],
  };
  // Just enough SVG for the epidemic curve.
  page.document.createElementNS = (ns, tag) => ({
    ns,
    tag,
    attrs: {},
    children: [],
    setAttribute(key, value) {
      this.attrs[key] = value;
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
  });
  const panel = new OutbreakPanel(null, {
    document: page.document,
    windowRef: page.windowRef,
    storage: page.storage,
    fetch: async (url, init) => {
      if (!String(url).endsWith('/epidemic')) throw new Error('offline');
      asked.push(JSON.parse(init.body));
      const button = page.nodes.get('outbreak-epi-run');
      during.push([
        button.textContent,
        button.disabled,
        page.nodes.get('outbreak-status').textContent,
      ]);
      return { ok: true, status: 200, json: async () => result };
    },
    now: () => now,
  });
  const saved = () => JSON.parse(page.stored.get(OUTBREAK_STORAGE_KEY));
  const preset = page.nodes.get('outbreak-preset');
  assert.equal(preset.children.length, PATHOGEN_PRESETS.length);
  assert.equal(
    page.nodes.get('outbreak-superspreading').children.length,
    3,
    'filled from the model',
  );

  preset.value = 'measles';
  preset.fire('change');
  assert.equal(page.nodes.get('outbreak-r0').value, '15');
  assert.equal(page.nodes.get('outbreak-transmission').value, 'airborne');
  assert.equal(page.nodes.get('outbreak-latent').value, '9');
  assert.equal(saved().profile.preset, 'measles');
  assert.equal(saved().profile.r0, 15);
  // Any field stays editable after a preset.
  const ban = page.nodes.get('outbreak-travel-ban');
  ban.value = '80';
  ban.fire('input');
  assert.equal(saved().profile.travelBanPct, 80);

  page.nodes.get('outbreak-epi-runs').value = '50';
  page.nodes.get('outbreak-epi-days').value = '14';
  page.nodes.get('outbreak-epi-run').click();
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
  assert.equal(asked.length, 1);
  // While it runs: RUNNING MODEL... on the greyed button and the status.
  assert.match(during[0][0], /^RUNNING MODEL\.\.\. \d+ s$/);
  assert.equal(during[0][1], true);
  assert.match(during[0][2], /^Running Model\.\.\. 50 runs · 14 days ahead/);
  const runButton = page.nodes.get('outbreak-epi-run');
  assert.deepEqual(
    [runButton.textContent, runButton.disabled],
    ['RUN EPIDEMIC MODEL', false],
    'back once it is done',
  );
  assert.equal(asked[0].runs, 50);
  assert.equal(asked[0].untilMs, now + 14 * 86_400_000, '14 days ahead');
  assert.equal(saved().epidemicDays, 14);
  assert.deepEqual(asked[0].outbreakAirports, ['UIII']);
  assert.equal(asked[0].profile.preset, 'measles');
  assert.equal(asked[0].profile.travelBanPct, 80);
  assert.equal(asked[0].startMs, startMs);
  // Rail travel (owner ruling 2026-10-12): at the box's train speed, on
  // while trains are shown.
  assert.equal(asked[0].rail, true);
  assert.ok(asked[0].speedKmh > 0);
  // The map is shown (the last message that says either way).
  assert.equal(page.sent.filter((d) => 'show' in d).at(-1).show, true);
  assert.equal(page.sent.at(-1).epidemic.places[0].id, 'UUEE');
  const list = page.nodes.get('outbreak-epidemic').children;
  assert.match(list[0].children[0].textContent, /^R0 15 · R now 12/);
  assert.ok(
    list.some((li) =>
      /UUEE Sheremetyevo: 80 %/.test(li.children[0].textContent),
    ),
  );
  assert.match(
    page.nodes.get('outbreak-status').textContent,
    /EPIDEMIC MODEL DONE/,
  );
  // The curve: the 5–95 % band, then infected, reported, deaths, hospital
  // and intensive care, and the peak-day tick.
  const curve = page.nodes.get('outbreak-epi-curve');
  assert.equal(curve.hidden, false);
  const [svg, legend] = curve.children;
  assert.deepEqual(
    svg.children.map((c) => [c.tag, c.attrs.stroke ?? c.attrs.fill]),
    [
      ['polygon', '#19e6b0'],
      ['polyline', '#19e6b0'],
      ['polyline', '#ffb14a'],
      ['polyline', '#ff4a4a'],
      ['polyline', '#4a9bff'],
      ['polyline', '#9b5cff'],
      ['line', '#ffffff'],
    ],
  );
  assert.equal(svg.children[5].attrs['stroke-dasharray'], '3 2');
  assert.match(
    legend.textContent,
    /^Day 2: infected 90 \(5–95 %: 70–130\) · reported 6 · deaths 1$/,
  );
  // The second legend: the peak day and the hospital load.
  assert.equal(curve.children.length, 3);
  assert.match(curve.children[2].textContent, /^Peak day 2 /);
  assert.match(
    curve.children[2].textContent,
    /· in hospital 5 · intensive care 1$/,
  );

  // Unticked: the model leaves the map, the result stays.
  const show = page.nodes.get('outbreak-mode-epidemic');
  show.checked = false;
  show.fire('change');
  assert.equal(page.sent.at(-1).epidemic, null);
  assert.equal(saved().showEpidemic, false);

  // CLEAR DATA clears it.
  page.nodes.get('outbreak-clear').click();
  assert.equal(page.nodes.get('outbreak-epidemic').children.length, 0);
  panel.destroy();
});

test("the default profile fills what is not set, once; the operator's choices stay", () => {
  const open = (saved) => {
    const page = fakePage(['outbreak-r0', 'outbreak-preset']);
    if (saved)
      page.storage.setItem(OUTBREAK_STORAGE_KEY, JSON.stringify(saved));
    const panel = new OutbreakPanel(null, {
      document: page.document,
      windowRef: page.windowRef,
      storage: page.storage,
      fetch: async () => {
        throw new Error('offline');
      },
      now: () => Date.UTC(2026, 9, 9, 12),
    });
    const profile = JSON.parse(page.stored.get(OUTBREAK_STORAGE_KEY)).profile;
    panel.destroy();
    return { profile, page };
  };
  const fresh = open();
  assert.deepEqual(fresh.profile, { ...OUTBREAK_DEFAULT_PROFILE });
  assert.equal(fresh.page.nodes.get('outbreak-r0').value, 2.5);
  assert.equal(fresh.page.nodes.get('outbreak-preset').value, 'novel');
  // Set before the default existed: kept, and the rest filled in.
  const earlier = open({ profile: { r0: 3, transmission: 'airborne' } });
  assert.equal(earlier.profile.r0, 3);
  assert.equal(earlier.profile.transmission, 'airborne');
  assert.equal(earlier.profile.season, 'winter');
  // Once filled, a field the operator cleared stays clear.
  const cleared = open({
    profileDefaults: PROFILE_DEFAULTS_VERSION,
    profile: { r0: 3 },
  });
  assert.deepEqual(cleared.profile, { r0: 3 });
  // Saved under an older version with a preset: the preset's own values
  // fill the new fields, not the novel default's; the operator's stay.
  const measles = open({
    profileDefaults: PROFILE_DEFAULTS_VERSION - 1,
    profile: { preset: 'measles', r0: 15 },
  });
  assert.equal(measles.profile.preset, 'measles');
  assert.equal(measles.profile.r0, 15);
  assert.equal(measles.profile.hospitalDays, 5);
  assert.equal(measles.profile.vaccinatedPct, 85);
  assert.equal(measles.profile.vaccineEfficacyPct, 95);
});

test('the box fetches each location’s main roads and rail lines and the spread follows them', async () => {
  const page = fakePage();
  const now = Date.UTC(2026, 9, 9, 12);
  page.storage.setItem(
    OUTBREAK_STORAGE_KEY,
    JSON.stringify({
      locations: [
        { id: 'irk', name: 'Irkutsk, Russia', lat: 52.29, lon: 104.3 },
      ],
      scan: {
        startMs: now - 48 * 3_600_000,
        flights: [],
        surroundings: { irk: { rail: true, water: false } },
        flightSource: 'test',
      },
    }),
  );
  const network = {
    bandKm: 10,
    bands: { 0: [[104.3, 52.29, 104.4, 52.29]] },
    unreached: [],
    reachedKm: 10,
    lengthKm: 10,
    startKm: 0.5,
  };
  const asked = [];
  const panel = new OutbreakPanel(null, {
    document: page.document,
    windowRef: page.windowRef,
    storage: page.storage,
    fetch: async (url) => {
      if (!String(url).includes('/network?')) throw new Error('offline');
      const q = new URL(url, 'http://x').searchParams;
      asked.push(`${q.get('mode')}:${q.get('level')}`);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          network,
          tiles: 1,
          failedTiles: 0,
          radiusKm: 500,
        }),
      };
    },
    now: () => now,
  });
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
  // Each location's nearest roads and rail first, then roads farther out.
  assert.deepEqual(asked, ['road:1', 'rail:1', 'road:2', 'road:3']);
  const last = page.sent.at(-1);
  assert.deepEqual(
    last.networks.map((n) => n.key),
    ['irk|road', 'irk|rail'],
  );
  assert.deepEqual(
    last.spread.reaches.map((r) => r.mode),
    ['road', 'train'],
  );
  assert.equal(
    last.spread.rings.some((r) => r.mode === 'road'),
    false,
  );
  // Asked once: a later refresh does not fetch them again.
  page.nodes.get('outbreak-clear-map').click();
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
  assert.equal(asked.length, 4);
  panel.destroy();
});

const settle = async () => {
  for (let i = 0; i < 10; i += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
};

test('every rail line on the globe: the status line while the server finds it, then rail from the whole world, even where no station was found', async () => {
  assert.equal(RAIL_WORLD_POLL_MS, 10_000);
  assert.equal(
    railWorldLine({
      state: 'sweeping',
      tilesDone: 6812,
      tilesTotal: 16096,
      railKm: 412000,
    }),
    'World rail: 6,812 / 16,096 tiles · 412,000 km; rail works as before until it is done.',
  );
  assert.match(
    railWorldLine({ state: 'ready', tilesDone: 20000, railKm: 1_100_000 }),
    /^World rail: 1,100,000 km from 20,000 map tiles/,
  );
  const page = fakePage();
  const now = Date.UTC(2026, 9, 12, 12);
  page.storage.setItem(
    OUTBREAK_STORAGE_KEY,
    JSON.stringify({
      locations: [
        { id: 'sj', name: 'Saint John, Canada', lat: 45.27, lon: -66.06 },
      ],
      scan: {
        startMs: now - 48 * 3_600_000,
        flights: [],
        // OpenStreetMap found no station.
        surroundings: { sj: { rail: false, water: false } },
        flightSource: 'test',
      },
    }),
  );
  let state = {
    state: 'sweeping',
    tilesDone: 6812,
    tilesTotal: 16096,
    railKm: 412000,
  };
  const asked = [];
  const panel = new OutbreakPanel(null, {
    document: page.document,
    windowRef: page.windowRef,
    storage: page.storage,
    fetch: async (url) => {
      const u = String(url);
      if (u.endsWith('/rail-world/status'))
        return { ok: true, status: 200, json: async () => state };
      if (!u.includes('/network?')) throw new Error('offline');
      const q = new URL(url, 'http://x').searchParams;
      asked.push(q.get('mode'));
      return {
        ok: true,
        status: 200,
        json: async () =>
          q.get('mode') === 'rail'
            ? {
                world: true,
                radiusKm: null,
                lastLevel: true,
                tiles: 16,
                failedTiles: 0,
                network: {
                  bandKm: 10,
                  bands: { 0: [[-66.06, 45.27, -66.0, 45.3]] },
                  unreached: [],
                  reachedKm: 4000,
                  lengthKm: 1_100_000,
                  startKm: 0.4,
                  world: true,
                },
              }
            : {
                tiles: 1,
                failedTiles: 0,
                radiusKm: 500,
                lastLevel: true,
                network: {
                  bandKm: 10,
                  bands: { 0: [[-66.06, 45.27, -66.1, 45.27]] },
                  unreached: [],
                  reachedKm: 10,
                  lengthKm: 10,
                  startKm: 0.5,
                },
              },
      };
    },
    now: () => now,
  });
  await settle();
  assert.equal(
    page.nodes.get('outbreak-status').textContent,
    'World rail: 6,812 / 16,096 tiles · 412,000 km; rail works as before until it is done.',
  );
  assert.ok(
    !asked.includes('rail'),
    'no station, no world rail yet: not asked',
  );
  assert.equal(page.sent.at(-1).railWorld, null);
  // Built: the next poll says so once, and rail is asked for.
  state = {
    state: 'ready',
    tilesDone: 20000,
    tilesTotal: 20000,
    railKm: 1_100_000,
    builtAt: 5,
  };
  globalThis.clearTimeout(panel._railWorldTimer);
  panel._railWorldTimer = null;
  await panel._pollRailWorld();
  await settle();
  assert.ok(asked.includes('rail'));
  assert.match(page.nodes.get('outbreak-output').textContent, /WORLD RAIL/);
  assert.match(
    page.nodes.get('outbreak-output').textContent,
    /The world's rail, 1,100,000 km, from 0.4 km away/,
  );
  assert.equal(page.nodes.get('outbreak-status').textContent, '');
  const last = page.sent.at(-1);
  assert.deepEqual(last.railWorld, { builtAt: 5 });
  assert.ok(last.networks.some((n) => n.key === 'sj|rail'));
  assert.ok(last.spread.reaches.some((r) => r.mode === 'train'));
  assert.equal(panel._railWorldTimer, null, 'no more polls once built');
  panel.destroy();
});

test('SOCIAL SEARCH with no Grok Bot key logs the copied task and finds no places in it', async () => {
  const page = fakePage([
    'outbreak-social',
    'outbreak-swarm',
    'outbreak-found',
  ]);
  page.nodes.get('outbreak-swarm').value = 'xai';
  const panel = new OutbreakPanel(null, {
    document: page.document,
    windowRef: page.windowRef,
    storage: page.storage,
    fetch: async (url) => {
      if (url === '/api/llm/providers') {
        return { ok: true, json: async () => ({ providers: [] }) };
      }
      if (url === '/api/social/swarm/status') {
        return {
          ok: true,
          json: async () => ({
            xai: { key: false, computer: false },
            openai: { key: false },
          }),
        };
      }
      if (String(url).startsWith('/api/social/swarm/nearest-city')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ city: 'Irkutsk' }),
        };
      }
      if (url === '/api/social/grok-bot/open') {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      throw new Error(`unexpected ${url}`);
    },
  });
  await settle();
  page.nodes.get('outbreak-social').click();
  await settle();
  const log = page.nodes.get('outbreak-output').textContent;
  // The task names Irkutsk; it is the task, not a place found.
  assert.match(log, /Chief of Staff: run a GROK BOT SWARM sweep/);
  assert.deepEqual(panel._state.found, []);
  assert.doesNotMatch(
    page.nodes.get('outbreak-status').textContent,
    /new location/,
  );
  panel.destroy();
});

test('SOCIAL SEARCH with Grok Bot POSTs seven bots and prepends each answer to the log', async () => {
  const page = fakePage([
    'outbreak-social',
    'outbreak-swarm',
    'outbreak-found',
  ]);
  page.nodes.get('outbreak-swarm').value = 'xai';
  const bots = [];
  const panel = new OutbreakPanel(null, {
    document: page.document,
    windowRef: page.windowRef,
    storage: page.storage,
    fetch: async (url, init = {}) => {
      if (url === '/api/llm/providers') {
        return { ok: true, json: async () => ({ providers: [] }) };
      }
      if (url === '/api/social/swarm/status') {
        return {
          ok: true,
          json: async () => ({
            xai: { key: true, computer: false },
            openai: { key: false },
          }),
        };
      }
      if (url === '/api/social/swarm') {
        const body = JSON.parse(init.body);
        bots.push(body);
        if (body.bot === 'tiktok') {
          return {
            ok: false,
            status: 502,
            json: async () => ({
              error: 'xAI refused the bot (HTTP 500)',
            }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            bot: body.bot,
            text:
              body.bot === 'x'
                ? '14:05 · Ulan-Ude · quarantine'
                : 'NOTHING FOUND',
          }),
        };
      }
      throw new Error(`unexpected ${url}`);
    },
  });
  await settle();
  page.nodes.get('outbreak-social').click();
  await settle();
  assert.deepEqual(
    bots.map((bot) => bot.bot),
    ['x', 'facebook', 'instagram', 'threads', 'tiktok', 'truth', 'news'],
  );
  for (const bot of bots) {
    assert.equal(bot.provider, 'xai');
    assert.equal(bot.place, 'Irkutsk, Russia');
    assert.equal(bot.latitude, 52.287);
    assert.equal(bot.longitude, 104.305);
  }
  const log = page.nodes.get('outbreak-output').textContent;
  assert.match(log, /GROK BOT SWARM · X/);
  assert.match(log, /Ulan-Ude · quarantine/);
  assert.match(
    log,
    /GROK BOT SWARM · TikTok[^\n]*\nBOT FAILED: xAI refused the bot \(HTTP 500\)/,
  );
  assert.match(
    page.nodes.get('outbreak-status').textContent,
    /SOCIAL SEARCH DONE · 1 new location found/,
  );
  panel.destroy();
});

/** A page with the epidemic row, the curve, the list and a few profile fields. */
function epidemicPage() {
  const page = fakePage([
    'outbreak-preset',
    'outbreak-r0',
    'outbreak-hospital-days',
    'outbreak-trigger-mode',
    'outbreak-epi-run',
    'outbreak-epi-runs',
    'outbreak-epi-days',
    'outbreak-epi-seed',
    'outbreak-epi-download',
    'outbreak-epi-csv',
    'outbreak-epi-curve',
    'outbreak-mode-epidemic',
    'outbreak-epidemic',
  ]);
  page.document.createElementNS = (ns, tag) => ({
    ns,
    tag,
    attrs: {},
    children: [],
    setAttribute(key, value) {
      this.attrs[key] = value;
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
  });
  return page;
}

const NOW = Date.UTC(2026, 9, 8, 12);

/** A small result: one place, two days, a time-limited ensemble, a tornado. */
function epidemicResult(startMs, extra = {}) {
  return {
    startMs,
    untilMs: startMs + 2 * 86_400_000,
    hours: 48,
    runs: 50,
    runsAsked: 200,
    partial: true,
    seed: 12,
    places: [
      {
        id: 'UUEE',
        code: 'UUEE',
        name: 'Sheremetyevo',
        lat: 55.97,
        lon: 37.41,
        pArrive: 0.8,
        arrivalHours: Array(21).fill(30),
        etaP5: 20,
        etaP50: 30,
        etaP95: 60,
        casesP50: 40,
      },
    ],
    commutes: [],
    totals: [
      { day: 1, p5: 50, p50: 60, p95: 80, reportedP50: 0, deathsP50: 0 },
      { day: 2, p5: 70, p50: 90, p95: 130, reportedP50: 6, deathsP50: 1 },
    ],
    summary: { r0: 2.5, rEffective: 2.1, rControlled: 2.1, doublingDays: 3 },
    sensitivity: [
      {
        key: 'r0',
        low: 1.7,
        high: 3.8,
        rLow: 1.4,
        rHigh: 3.2,
        doublingLow: 6,
        doublingHigh: 2,
        swing: 1.8,
        doublingSwing: -4,
      },
      {
        key: 'infectiousDays',
        low: 4.7,
        high: 10.5,
        rLow: 2.1,
        rHigh: 2.1,
        doublingLow: 2.5,
        doublingHigh: 4,
        swing: 0,
        doublingSwing: 1.5,
      },
    ],
    network: { places: 3, flights: 10 },
    populationSource: 'GeoNames',
    effectiveDistance: [],
    ...extra,
  };
}

test('EPIDEMIC MODEL: the seed is sent only when set and a profile change clears it; a time-limited run says so; the tornado is logged', async () => {
  const page = epidemicPage();
  const startMs = NOW - 48 * 3_600_000;
  page.storage.setItem(
    OUTBREAK_STORAGE_KEY,
    JSON.stringify({
      epidemicSeed: 12,
      scan: {
        startMs,
        flights: [],
        surroundings: {},
        flightSource: 'test',
        airports: ['UIII'],
      },
    }),
  );
  const asked = [];
  const panel = new OutbreakPanel(null, {
    document: page.document,
    windowRef: page.windowRef,
    storage: page.storage,
    fetch: async (url, init) => {
      if (!String(url).endsWith('/epidemic')) throw new Error('offline');
      asked.push(JSON.parse(init.body));
      return {
        ok: true,
        status: 200,
        json: async () => epidemicResult(startMs),
      };
    },
    now: () => NOW,
  });
  const saved = () => JSON.parse(page.stored.get(OUTBREAK_STORAGE_KEY));
  const seedBox = page.nodes.get('outbreak-epi-seed');
  const run = async () => {
    page.nodes.get('outbreak-epi-run').click();
    await settle();
  };
  // The saved seed fills the box and rides in the body.
  assert.equal(seedBox.value, '12');
  assert.equal(page.nodes.get('outbreak-epi-download').disabled, true);
  await run();
  assert.equal(asked.length, 1);
  assert.equal(asked[0].seed, 12);
  assert.match(
    page.nodes.get('outbreak-status').textContent,
    /^EPIDEMIC MODEL DONE · 1 places at risk · 50 runs · time limit: 50 of 200 runs \(try 50\)$/,
  );
  assert.match(
    page.nodes.get('outbreak-output').textContent,
    /What moves R most \(one at a time\): r0 1\.7–3\.8 → R 1\.4–3\.2 · infectiousDays 4\.7–10\.5 → R 2\.1–2\.1/,
  );
  assert.equal(page.nodes.get('outbreak-epi-download').disabled, false);
  assert.equal(page.nodes.get('outbreak-epi-csv').disabled, false);
  // A profile change lets the seed go: the next run has none.
  const r0 = page.nodes.get('outbreak-r0');
  r0.value = '3';
  r0.fire('input');
  assert.equal(saved().epidemicSeed, null);
  assert.equal(seedBox.value, '');
  await run();
  assert.equal(asked.length, 2);
  assert.equal('seed' in asked[1], false, 'auto: the server derives it');
  // Typed into the box: kept when it is a whole number in range.
  seedBox.value = '5';
  seedBox.fire('change');
  assert.equal(saved().epidemicSeed, 5);
  await run();
  assert.equal(asked[2].seed, 5);
  seedBox.value = '-1';
  seedBox.fire('input');
  assert.equal(saved().epidemicSeed, null);
  assert.deepEqual(
    [cleanSeed(''), cleanSeed('4294967296'), cleanSeed('1.5'), cleanSeed(0)],
    [null, null, null, 0],
  );
  panel.destroy();
});

test('EPIDEMIC MODEL: the result is kept across reloads, trimmed, and shown again as a saved result; CLEAR DATA drops it', async () => {
  const page = epidemicPage();
  const startMs = NOW - 48 * 3_600_000;
  page.storage.setItem(
    OUTBREAK_STORAGE_KEY,
    JSON.stringify({
      scan: {
        startMs,
        flights: [],
        surroundings: {},
        flightSource: 'test',
        airports: ['UIII'],
      },
    }),
  );
  const options = (document, windowRef) => ({
    document,
    windowRef,
    storage: page.storage,
    fetch: async (url) => {
      if (!String(url).endsWith('/epidemic')) throw new Error('offline');
      return {
        ok: true,
        status: 200,
        json: async () =>
          epidemicResult(startMs, { partial: false, runsAsked: 50 }),
      };
    },
    now: () => NOW,
  });
  const panel = new OutbreakPanel(null, options(page.document, page.windowRef));
  const saved = () => JSON.parse(page.stored.get(OUTBREAK_STORAGE_KEY));
  page.nodes.get('outbreak-epi-run').click();
  await settle();
  assert.equal(saved().epidemic.places[0].id, 'UUEE');
  assert.equal(saved().epidemic.seed, 12);
  assert.equal(saved().epidemic.sensitivity.length, 2);
  assert.equal('effectiveDistance' in saved().epidemic, false, 'trimmed');
  assert.match(
    page.nodes.get('outbreak-status').textContent,
    /^EPIDEMIC MODEL DONE · 1 places at risk · 50 runs$/,
  );
  panel.destroy();

  // Reloaded: the list, the curve and the map get the saved result.
  const again = epidemicPage();
  const reloaded = new OutbreakPanel(
    null,
    options(again.document, again.windowRef),
  );
  assert.match(
    again.nodes.get('outbreak-status').textContent,
    /^EPIDEMIC MODEL \(saved result\) · 1 places at risk · 50 runs$/,
  );
  assert.equal(again.sent.at(-1).epidemic.places[0].id, 'UUEE');
  assert.equal(again.sent.at(-1).epidemic.startMs, startMs);
  const list = again.nodes.get('outbreak-epidemic').children;
  assert.match(list[0].children[0].textContent, /^R0 2\.5 · R now 2\.1/);
  assert.equal(again.nodes.get('outbreak-epi-curve').hidden, false);
  assert.equal(again.nodes.get('outbreak-epi-download').disabled, false);
  // CLEAR DATA drops it.
  again.nodes.get('outbreak-clear').click();
  assert.equal(saved().epidemic, null);
  assert.equal(again.nodes.get('outbreak-epidemic').children.length, 0);
  assert.equal(again.nodes.get('outbreak-epi-download').disabled, true);
  reloaded.destroy();

  // Opened once more: nothing saved, nothing said.
  const empty = epidemicPage();
  const third = new OutbreakPanel(
    null,
    options(empty.document, empty.windowRef),
  );
  assert.equal(empty.sent.at(-1).epidemic, null);
  assert.doesNotMatch(
    empty.nodes.get('outbreak-status').textContent,
    /saved result/,
  );
  third.destroy();
});

test('EPIDEMIC MODEL: a full storage drops the kept result and still saves the rest', async () => {
  const page = epidemicPage();
  const startMs = NOW - 48 * 3_600_000;
  page.storage.setItem(
    OUTBREAK_STORAGE_KEY,
    JSON.stringify({
      scan: { startMs, flights: [], surroundings: {}, flightSource: 'test' },
    }),
  );
  // The quota: any state that carries an epidemic result does not fit.
  const setItem = page.storage.setItem;
  page.storage.setItem = (key, value) => {
    if (JSON.parse(value).epidemic) throw new Error('QuotaExceededError');
    setItem(key, value);
  };
  const warned = [];
  const warn = console.warn;
  console.warn = (...args) => warned.push(args.join(' '));
  try {
    const panel = new OutbreakPanel(null, {
      document: page.document,
      windowRef: page.windowRef,
      storage: page.storage,
      fetch: async (url) => {
        if (!String(url).endsWith('/epidemic')) throw new Error('offline');
        return {
          ok: true,
          status: 200,
          json: async () => epidemicResult(startMs),
        };
      },
      now: () => NOW,
    });
    const saved = () => JSON.parse(page.stored.get(OUTBREAK_STORAGE_KEY));
    page.nodes.get('outbreak-epi-run').click();
    await settle();
    assert.equal(saved().epidemic, null, 'the result is not kept');
    assert.equal(page.sent.at(-1).epidemic.places.length, 1, 'in memory');
    // Later saves still land.
    panel._state.seed = 4242;
    panel._save();
    assert.equal(saved().seed, 4242);
    assert.equal(warned.length, 1);
    assert.match(warned[0], /storage is full/);
    panel.destroy();
  } finally {
    console.warn = warn;
  }
});

test('EPIDEMIC MODEL: a result too big to store is kept in memory only, with one warning', async () => {
  const page = epidemicPage();
  const startMs = NOW - 48 * 3_600_000;
  page.storage.setItem(
    OUTBREAK_STORAGE_KEY,
    JSON.stringify({
      scan: { startMs, flights: [], surroundings: {}, flightSource: 'test' },
    }),
  );
  const big = epidemicResult(startMs);
  big.places = Array.from({ length: 600 }, (_, i) => ({
    ...big.places[0],
    id: `P${i}`,
    name: 'x'.repeat(4000),
  }));
  const warned = [];
  const warn = console.warn;
  console.warn = (...args) => warned.push(args.join(' '));
  try {
    const panel = new OutbreakPanel(null, {
      document: page.document,
      windowRef: page.windowRef,
      storage: page.storage,
      fetch: async (url) => {
        if (!String(url).endsWith('/epidemic')) throw new Error('offline');
        return { ok: true, status: 200, json: async () => big };
      },
      now: () => NOW,
    });
    const saved = () => JSON.parse(page.stored.get(OUTBREAK_STORAGE_KEY));
    page.nodes.get('outbreak-epi-run').click();
    await settle();
    assert.equal(saved().epidemic, null, 'not kept');
    assert.equal(page.sent.at(-1).epidemic.places.length, 600, 'in memory');
    assert.match(
      page.nodes.get('outbreak-status').textContent,
      /EPIDEMIC MODEL DONE · 600 places at risk/,
    );
    page.nodes.get('outbreak-epi-run').click();
    await settle();
    assert.equal(warned.length, 1, 'warned once');
    assert.match(warned[0], /not kept across reloads/);
    panel.destroy();
  } finally {
    console.warn = warn;
  }
  // The trimming itself: the first 500 places, the known keys, else null.
  assert.equal(trimmedEpidemic(big), null);
  const fits = { ...big, places: big.places.slice(0, 300) };
  const trimmed = trimmedEpidemic(fits);
  assert.equal(trimmed.places.length, 300);
  assert.equal(trimmed.seed, 12);
  assert.equal('effectiveDistance' in trimmed, false);
  const many = {
    ...big,
    places: big.places.map((p) => ({ ...p, name: 'short' })),
  };
  assert.equal(trimmedEpidemic(many).places.length, EPIDEMIC_PERSIST_PLACES);
  assert.equal(trimmedEpidemic(null), null);
});

test('DOWNLOAD RESULTS and DOWNLOAD CSV save the result through a link, and say so when there is no browser', async () => {
  const page = epidemicPage();
  const startMs = NOW - 48 * 3_600_000;
  page.storage.setItem(
    OUTBREAK_STORAGE_KEY,
    JSON.stringify({
      epidemicSeed: 12,
      scan: {
        startMs,
        flights: [],
        surroundings: {},
        flightSource: 'test',
        airports: ['UIII'],
      },
    }),
  );
  const panel = new OutbreakPanel(null, {
    document: page.document,
    windowRef: page.windowRef,
    storage: page.storage,
    fetch: async (url) => {
      if (!String(url).endsWith('/epidemic')) throw new Error('offline');
      return {
        ok: true,
        status: 200,
        json: async () => epidemicResult(startMs),
      };
    },
    now: () => NOW,
  });
  const status = () => page.nodes.get('outbreak-status').textContent;
  // Nothing to save yet: the buttons are off and a click does nothing.
  page.nodes.get('outbreak-epi-download').click();
  assert.doesNotMatch(status(), /Saved|Downloads/);
  page.nodes.get('outbreak-epi-run').click();
  await settle();
  // Without Blob (a test runner, an old browser) it says so.
  const blob = globalThis.Blob;
  globalThis.Blob = undefined;
  try {
    page.nodes.get('outbreak-epi-download').click();
    assert.equal(status(), 'Downloads need a browser.');
    page.nodes.get('outbreak-epi-csv').click();
    assert.equal(status(), 'Downloads need a browser.');
  } finally {
    globalThis.Blob = blob;
  }
  // With one: a link named after the seed is clicked, built from the export
  // modules with the request that made the result.
  const urls = [];
  const create = URL.createObjectURL;
  const revoke = URL.revokeObjectURL;
  URL.createObjectURL = (b) => {
    urls.push(b);
    return `blob:${urls.length}`;
  };
  URL.revokeObjectURL = () => {};
  const made = [];
  const createElement = page.document.createElement;
  page.document.createElement = (tag) => {
    const node = createElement(tag);
    made.push(node);
    return node;
  };
  try {
    page.nodes.get('outbreak-epi-download').click();
    assert.equal(status(), 'Saved outbreak-epidemic-12.json.');
    const link = made.at(-1);
    assert.equal(link.download, 'outbreak-epidemic-12.json');
    assert.equal(link.href, 'blob:1');
    const json = JSON.parse(await urls[0].text());
    assert.equal(json.exportedAt, new Date(NOW).toISOString());
    assert.equal(json.request.seed, 12);
    assert.equal(json.request.runs, 200);
    assert.equal(json.request.flightCount, 0);
    assert.deepEqual(json.request.outbreakAirports, ['UIII']);
    assert.equal(json.result.places[0].id, 'UUEE');
    page.nodes.get('outbreak-epi-csv').click();
    assert.equal(status(), 'Saved outbreak-epidemic-12.csv.');
    const csv = await urls[1].text();
    assert.match(csv, /^id,code,name,kind,/);
    assert.match(csv, /\r\nUUEE,UUEE,Sheremetyevo,/);
    assert.match(csv, /\r\n\r\nday,p5,p50,p95,/);
    assert.match(csv, /\r\n2,70,90,130,/);
  } finally {
    URL.createObjectURL = create;
    URL.revokeObjectURL = revoke;
    page.document.createElement = createElement;
  }
  panel.destroy();
});

test('the epidemic results list, the log and DOWNLOAD CSV carry every place, with no cap', async () => {
  const page = epidemicPage();
  const startMs = NOW - 48 * 3_600_000;
  page.storage.setItem(
    OUTBREAK_STORAGE_KEY,
    JSON.stringify({
      epidemicSeed: 12,
      scan: {
        startMs,
        flights: [],
        surroundings: {},
        flightSource: 'test',
        airports: ['UIII'],
      },
    }),
  );
  const COUNT = 600;
  const places = Array.from({ length: COUNT }, (_, i) => ({
    id: `P${i}`,
    code: `P${i}`,
    name: `Place ${i}`,
    lat: 50 + i / 100,
    lon: 30 + i / 100,
    pArrive: 0.5,
    arrivalHours: Array(21).fill(30),
    etaP5: 20,
    etaP50: 30,
    etaP95: 60,
    casesP50: 4,
  }));
  const panel = new OutbreakPanel(null, {
    document: page.document,
    windowRef: page.windowRef,
    storage: page.storage,
    fetch: async (url) => {
      if (!String(url).endsWith('/epidemic')) throw new Error('offline');
      return {
        ok: true,
        status: 200,
        json: async () => epidemicResult(startMs, { places }),
      };
    },
    now: () => NOW,
  });
  page.nodes.get('outbreak-epi-run').click();
  await settle();
  // The list under the buttons: every place, once each, in order.
  const rows = page.nodes
    .get('outbreak-epidemic')
    .children.map((li) => li.children[0].textContent)
    .filter((text) => /^P\d+ Place \d+: 50 %/.test(text));
  assert.equal(rows.length, COUNT);
  assert.match(rows[0], /^P0 Place 0: 50 %/);
  assert.match(rows.at(-1), /^P599 Place 599: 50 %/);
  // The log: every place too.
  const log = page.nodes.get('outbreak-output').textContent;
  assert.equal(log.match(/^P\d+ Place \d+: 50 %/gm)?.length, COUNT);
  // DOWNLOAD CSV: one row per place plus the header, before the totals.
  const urls = [];
  const create = URL.createObjectURL;
  const revoke = URL.revokeObjectURL;
  URL.createObjectURL = (b) => {
    urls.push(b);
    return `blob:${urls.length}`;
  };
  URL.revokeObjectURL = () => {};
  try {
    page.nodes.get('outbreak-epi-csv').click();
    const csv = await urls[0].text();
    const placesCsv = csv.split('\r\n\r\n')[0].split('\r\n');
    assert.equal(placesCsv.length, COUNT + 1);
    assert.match(placesCsv[0], /^id,code,name,kind,/);
    assert.match(placesCsv.at(-1), /^P599,P599,Place 599,/);
  } finally {
    URL.createObjectURL = create;
    URL.revokeObjectURL = revoke;
  }
  panel.destroy();
});

/** An in-memory stand-in for fullResultStore (IndexedDB). */
function memoryResultStore() {
  const map = new Map();
  return {
    map,
    get: async (key) => map.get(key),
    put: async (key, value) => void map.set(key, value),
    delete: async (key) => void map.delete(key),
  };
}

test('after a reload the whole epidemic result comes back from IndexedDB: every place in the list and the CSV', async () => {
  const page = epidemicPage();
  const startMs = NOW - 48 * 3_600_000;
  page.storage.setItem(
    OUTBREAK_STORAGE_KEY,
    JSON.stringify({
      epidemicSeed: 12,
      scan: {
        startMs,
        flights: [],
        surroundings: {},
        flightSource: 'test',
        airports: ['UIII'],
      },
    }),
  );
  const COUNT = EPIDEMIC_PERSIST_PLACES + 200;
  const places = Array.from({ length: COUNT }, (_, i) => ({
    id: `P${i}`,
    code: `P${i}`,
    name: `Place ${i}`,
    lat: 50 + i / 1000,
    lon: 30 + i / 1000,
    pArrive: 0.5,
    etaP50: 30,
  }));
  const store = memoryResultStore();
  const options = {
    document: page.document,
    windowRef: page.windowRef,
    storage: page.storage,
    resultStore: store,
    fetch: async (url) => {
      if (!String(url).endsWith('/epidemic')) throw new Error('offline');
      return {
        ok: true,
        status: 200,
        json: async () => epidemicResult(startMs, { places }),
      };
    },
    now: () => NOW,
  };
  const first = new OutbreakPanel(null, options);
  page.nodes.get('outbreak-epi-run').click();
  await settle();
  const saved = JSON.parse(page.stored.get(OUTBREAK_STORAGE_KEY));
  assert.equal(saved.epidemic.places.length, EPIDEMIC_PERSIST_PLACES);
  assert.equal(saved.epidemic.trimmed, COUNT);
  assert.equal(saved.epidemicId, NOW);
  assert.deepEqual(
    [...store.map.keys()],
    [OUTBREAK_STORAGE_KEY],
    'the whole result went to IndexedDB',
  );
  assert.equal(store.map.get(OUTBREAK_STORAGE_KEY).result.places.length, COUNT);
  first.destroy();

  // The reload: the trimmed copy first, then the whole result.
  const panel = new OutbreakPanel(null, options);
  assert.equal(await panel._restored, true);
  const rows = page.nodes
    .get('outbreak-epidemic')
    .children.map((li) => li.children[0].textContent);
  assert.equal(
    rows.filter((text) => /^P\d+ Place \d+: 50 %/.test(text)).length,
    COUNT,
  );
  assert.equal(
    rows.some((text) => /trimmed/.test(text)),
    false,
    'nothing was left out, so no note',
  );
  assert.equal(page.sent.at(-1).epidemic.places.length, COUNT, 'the map too');
  const urls = [];
  const create = URL.createObjectURL;
  const revoke = URL.revokeObjectURL;
  URL.createObjectURL = (b) => {
    urls.push(b);
    return `blob:${urls.length}`;
  };
  URL.revokeObjectURL = () => {};
  try {
    page.nodes.get('outbreak-epi-csv').click();
    const placesCsv = (await urls[0].text()).split('\r\n\r\n')[0].split('\r\n');
    assert.equal(placesCsv.length, COUNT + 1);
  } finally {
    URL.createObjectURL = create;
    URL.revokeObjectURL = revoke;
  }
  // CLEAR drops the whole result too.
  page.nodes.get('outbreak-clear').click();
  await settle();
  assert.equal(store.map.size, 0);
  panel.destroy();
});

test('a trimmed saved result without IndexedDB says so in the list and on DOWNLOAD CSV and DOWNLOAD RESULTS', async () => {
  const page = epidemicPage();
  const startMs = NOW - 48 * 3_600_000;
  const COUNT = EPIDEMIC_PERSIST_PLACES + 20;
  const places = Array.from({ length: COUNT }, (_, i) => ({
    id: `P${i}`,
    code: `P${i}`,
    name: `Place ${i}`,
    lat: 50,
    lon: 30,
    pArrive: 0.5,
    etaP50: 30,
  }));
  const trimmed = trimmedEpidemic(epidemicResult(startMs, { places }));
  assert.equal(trimmed.trimmed, COUNT);
  assert.equal(
    epidemicTrimmedNote(trimmed),
    'Saved result trimmed to 500 of 520 places; run again for every place.',
  );
  assert.equal(epidemicTrimmedNote(epidemicResult(startMs)), '');
  // A result that fits is not marked.
  assert.equal(
    'trimmed' in
      trimmedEpidemic(epidemicResult(startMs, { places: places.slice(0, 10) })),
    false,
  );
  page.storage.setItem(
    OUTBREAK_STORAGE_KEY,
    JSON.stringify({
      epidemic: trimmed,
      // Named, but no store here: the trimmed copy stays.
      epidemicId: NOW,
      scan: {
        startMs,
        flights: [],
        surroundings: {},
        flightSource: 'test',
        airports: ['UIII'],
      },
    }),
  );
  const panel = new OutbreakPanel(null, {
    document: page.document,
    windowRef: page.windowRef,
    storage: page.storage,
    resultStore: null,
    fetch: async () => {
      throw new Error('offline');
    },
    now: () => NOW,
  });
  assert.equal(await panel._restored, false);
  const rows = page.nodes
    .get('outbreak-epidemic')
    .children.map((li) => li.children[0].textContent);
  assert.equal(
    rows.at(-1),
    'Saved result trimmed to 500 of 520 places; run again for every place.',
  );
  const status = () => page.nodes.get('outbreak-status').textContent;
  const create = URL.createObjectURL;
  const revoke = URL.revokeObjectURL;
  URL.createObjectURL = () => 'blob:1';
  URL.revokeObjectURL = () => {};
  try {
    page.nodes.get('outbreak-epi-csv').click();
    assert.equal(
      status(),
      'DOWNLOAD CSV: Saved result trimmed to 500 of 520 places; run again for every place.',
    );
    page.nodes.get('outbreak-epi-download').click();
    assert.equal(
      status(),
      'DOWNLOAD RESULTS: Saved result trimmed to 500 of 520 places; run again for every place.',
    );
  } finally {
    URL.createObjectURL = create;
    URL.revokeObjectURL = revoke;
  }
  panel.destroy();
});

test('a whole result from an older run in IndexedDB is not taken back', async () => {
  const page = epidemicPage();
  const startMs = NOW - 48 * 3_600_000;
  const store = memoryResultStore();
  store.map.set(OUTBREAK_STORAGE_KEY, {
    id: NOW - 1,
    result: epidemicResult(startMs, { seed: 99 }),
  });
  page.storage.setItem(
    OUTBREAK_STORAGE_KEY,
    JSON.stringify({ epidemic: epidemicResult(startMs), epidemicId: NOW }),
  );
  const panel = new OutbreakPanel(null, {
    document: page.document,
    windowRef: page.windowRef,
    storage: page.storage,
    resultStore: store,
    fetch: async () => {
      throw new Error('offline');
    },
    now: () => NOW,
  });
  assert.equal(await panel._restored, false);
  assert.equal(panel._epidemic.seed, 12);
  panel.destroy();
});

/** The epidemic page plus the seven phase-2 controls. */
function phase2Page() {
  const page = fakePage([
    'outbreak-r0',
    'outbreak-variants',
    'outbreak-strain2-day',
    'outbreak-strain2-cases',
    'outbreak-strain2-place',
    'outbreak-strain2-spread',
    'outbreak-strain2-severity',
    'outbreak-cross-immunity',
    'outbreak-compare',
    'outbreak-epi-run',
    'outbreak-epi-runs',
    'outbreak-epi-days',
    'outbreak-epi-seed',
    'outbreak-epi-download',
    'outbreak-epi-csv',
    'outbreak-epi-curve',
    'outbreak-mode-epidemic',
    'outbreak-epidemic',
  ]);
  page.document.createElementNS = (ns, tag) => ({
    ns,
    tag,
    attrs: {},
    children: [],
    setAttribute(key, value) {
      this.attrs[key] = value;
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
  });
  return page;
}

/** A panel on `page` that never reaches the network. */
function offlinePanel(page) {
  return new OutbreakPanel(null, {
    document: page.document,
    windowRef: page.windowRef,
    storage: page.storage,
    fetch: async () => {
      throw new Error('offline');
    },
    now: () => NOW,
  });
}

test('P2-1 EPIDEMIC MODEL: a result without the new fields draws no Rt, no new series and no third legend', () => {
  const page = phase2Page();
  const panel = offlinePanel(page);
  panel._epidemic = epidemicResult(NOW - 48 * 3_600_000);
  panel._renderCurve();
  const curve = page.nodes.get('outbreak-epi-curve');
  // No peak day and no hospital line: the svg and the first legend only.
  assert.equal(curve.children.length, 2);
  const [svg] = curve.children;
  assert.equal(svg.children.length, 6);
  assert.equal(
    svg.attrs['aria-label'],
    'Epidemic curve over 2 days: up to 130 infected',
  );
  panel.destroy();
});

test('P2-2 EPIDEMIC MODEL: the second strain, the comparison and Rt are drawn, with a third legend', () => {
  const page = phase2Page();
  const panel = offlinePanel(page);
  const base = epidemicResult(NOW - 48 * 3_600_000);
  panel._epidemic = {
    ...base,
    totals: [
      {
        ...base.totals[0],
        hospitalP50: 0,
        icuP50: 0,
        rtP5: null,
        rtP50: null,
        rtP95: null,
        strain2P50: 0,
        counterfactualP50: 70,
      },
      {
        ...base.totals[1],
        hospitalP50: 5,
        icuP50: 1,
        rtP5: 1.1,
        rtP50: 1.4,
        rtP95: 1.9,
        strain2P50: 20,
        counterfactualP50: 210,
      },
    ],
    summary: {
      ...base.summary,
      peakDayP50: 2,
      rtLastDay: 2,
      rtLastP50: 1.4,
      generationDays: 6.1,
      strain2Day: 0,
      strain2Seeded: true,
      strain2ShareEnd: 0.3,
      takeoverDayP50: null,
    },
    counterfactual: {
      compare: 'all',
      label: 'No interventions',
      runs: 50,
      averted: {
        infectedP50: 120,
        infectedP5: 10,
        infectedP95: 300,
        deathsP50: 2,
      },
    },
  };
  panel._renderCurve();
  const curve = page.nodes.get('outbreak-epi-curve');
  const [svg] = curve.children;
  assert.deepEqual(
    svg.children.map((c) => [c.tag, c.attrs.stroke ?? c.attrs.fill]),
    [
      ['polygon', '#19e6b0'],
      ['polyline', '#19e6b0'],
      ['polyline', '#ffb14a'],
      ['polyline', '#ff4a4a'],
      ['polyline', '#4a9bff'],
      ['polyline', '#9b5cff'],
      ['polyline', '#ff6bd6'],
      ['polyline', '#19e6b0'],
      ['line', '#ffffff'],
      ['polyline', '#c8f04a'],
      ['line', '#c8f04a'],
    ],
  );
  assert.equal(svg.children[6].attrs['stroke-dasharray'], '5 2');
  assert.equal(svg.children[7].attrs['stroke-dasharray'], '4 3');
  assert.equal(svg.children[7].attrs['stroke-opacity'], '0.7');
  // One Rt stretch (day 2 only); the Rt = 1 line is dashed.
  assert.equal(svg.children[9].attrs.points.split(' ').length, 1);
  assert.equal(svg.children[10].attrs['stroke-dasharray'], '2 3');
  // The comparison run sets the scale when it is above the band.
  assert.match(svg.attrs['aria-label'], /up to 210 infected/);
  assert.match(svg.attrs['aria-label'], /; Rt line on a 0 to 3 scale$/);
  assert.equal(curve.children.length, 4);
  const third = curve.children[3].textContent;
  assert.match(third, /^Rt in the runs, day 2: 1.4 /);
  assert.match(third, /generation 6\.1 d\)/);
  assert.match(third, /second strain 30 % of infections/);
  assert.doesNotMatch(third, /took over/);
  assert.ok(third.includes('vs no interventions: 120 fewer infected'));
  assert.ok(third.includes('(5–95 %: 10–300) · 2 fewer deaths'));

  // A comparison cut by the time limit and a strain never seeded.
  panel._epidemic = {
    ...panel._epidemic,
    summary: {
      ...panel._epidemic.summary,
      rtLastP50: null,
      strain2Seeded: false,
    },
    counterfactual: {
      compare: 'all',
      label: 'No interventions',
      runs: 0,
      cut: true,
    },
  };
  panel._renderCurve();
  assert.equal(
    curve.children[3].textContent,
    'second strain not seeded inside the window · comparison skipped (time limit)',
  );
  // With no pair run the model nulls every counterfactual: no flat line.
  panel._epidemic = {
    ...panel._epidemic,
    totals: panel._epidemic.totals.map((t) => ({
      ...t,
      counterfactualP50: null,
      avertedP50: null,
    })),
  };
  panel._renderCurve();
  const [skipped] = curve.children;
  assert.ok(
    skipped.children.every(
      (c) => !(c.tag === 'polyline' && c.attrs['stroke-dasharray'] === '4 3'),
    ),
  );
  assert.equal(
    skipped.children.filter((c) => c.tag === 'polyline').length,
    svg.children.filter((c) => c.tag === 'polyline').length - 1,
  );
  panel.destroy();
});

test('P2-3 EPIDEMIC MODEL: the seven new controls reach the profile; compare keeps the seed, the strain clears it', () => {
  const page = phase2Page();
  page.storage.setItem(
    OUTBREAK_STORAGE_KEY,
    JSON.stringify({ epidemicSeed: 9 }),
  );
  const panel = offlinePanel(page);
  const saved = () => JSON.parse(page.stored.get(OUTBREAK_STORAGE_KEY));
  const seedBox = page.nodes.get('outbreak-epi-seed');
  assert.equal(seedBox.value, '9');
  // Filled menus: compare with its five options, variants with the third.
  assert.deepEqual(
    page.nodes.get('outbreak-compare').children.map((c) => c.value),
    ['none', 'all', 'travel', 'distancing', 'vaccination'],
  );
  assert.ok(
    page.nodes
      .get('outbreak-variants')
      .children.some((c) => c.value === 'two-strain'),
  );
  const set = (id, value) => {
    const node = page.nodes.get(id);
    node.value = value;
    node.fire('change');
  };
  // The comparison is not part of the seed: it stays.
  set('outbreak-compare', 'all');
  assert.equal(saved().profile.compare, 'all');
  assert.equal(saved().epidemicSeed, 9);
  assert.equal(seedBox.value, '9');
  // A strain field is: the seed goes.
  set('outbreak-strain2-day', '20');
  assert.equal(saved().epidemicSeed, null);
  assert.equal(seedBox.value, '');
  set('outbreak-variants', 'two-strain');
  set('outbreak-strain2-cases', '25');
  set('outbreak-strain2-place', ' lhr ');
  set('outbreak-strain2-spread', '200');
  set('outbreak-strain2-severity', '150');
  set('outbreak-cross-immunity', '40');
  const profile = saved().profile;
  assert.deepEqual(
    [
      profile.variants,
      profile.strain2Day,
      profile.strain2Cases,
      profile.strain2Place,
      profile.strain2Pct,
      profile.strain2SeverityPct,
      profile.crossImmunityPct,
      profile.compare,
    ],
    ['two-strain', 20, 25, 'LHR', 200, 150, 40, 'all'],
  );
  assert.deepEqual(panel._state.profile, profile);
  // A code that is not 3-4 letters or digits is dropped.
  set('outbreak-strain2-place', 'X!');
  assert.equal('strain2Place' in saved().profile, false);
  panel.destroy();
});

test('P2-4 EPIDEMIC MODEL: the status names the paired runs and a run stopped by the time limit', () => {
  const page = phase2Page();
  const panel = offlinePanel(page);
  const base = epidemicResult(NOW - 48 * 3_600_000);
  panel._epidemic = {
    ...base,
    partial: false,
    counterfactual: { compare: 'all', label: 'No interventions', runs: 50 },
  };
  assert.match(
    panel._epidemicStatus('DONE'),
    /^EPIDEMIC MODEL DONE · 1 places at risk · 50 runs · 50 paired runs × 2 arms$/,
  );
  panel._epidemic = {
    ...base,
    runs: 1,
    hours: 240,
    stoppedAt: { run: 0, hour: 120 },
  };
  assert.match(
    panel._epidemicStatus('DONE'),
    /time limit: stopped at day 5 of 10 \(try fewer days\)$/,
  );
  // A cut later run keeps today's text; the paired runs come last.
  panel._epidemic = {
    ...base,
    stoppedAt: { run: 50, hour: 30 },
    counterfactual: { compare: 'all', label: 'No interventions', runs: 50 },
  };
  assert.match(
    panel._epidemicStatus('DONE'),
    / · time limit: 50 of 200 runs \(try 50\) · 50 paired runs × 2 arms$/,
  );
  // Every main run finished but the comparison was cut: the limit names
  // the paired runs, not the main ones.
  panel._epidemic = {
    ...base,
    runs: 200,
    runsAsked: 200,
    partial: true,
    counterfactual: { compare: 'all', label: 'No interventions', runs: 150 },
  };
  assert.match(
    panel._epidemicStatus('DONE'),
    /^EPIDEMIC MODEL DONE · 1 places at risk · 200 runs · time limit: 150 of 200 paired runs · 150 paired runs × 2 arms$/,
  );
  assert.doesNotMatch(panel._epidemicStatus('DONE'), /200 of 200 runs/);
  panel._epidemic = {
    ...base,
    runs: 200,
    runsAsked: 200,
    partial: true,
    counterfactual: {
      compare: 'all',
      label: 'No interventions',
      runs: 0,
      cut: true,
    },
  };
  assert.match(
    panel._epidemicStatus('DONE'),
    /^EPIDEMIC MODEL DONE · 1 places at risk · 200 runs · time limit: 0 of 200 paired runs$/,
  );
  panel.destroy();
});

test('P2-5 EPIDEMIC MODEL: the comparison and the stopped run survive a reload', async () => {
  const startMs = NOW - 48 * 3_600_000;
  const page = phase2Page();
  page.storage.setItem(
    OUTBREAK_STORAGE_KEY,
    JSON.stringify({
      scan: {
        startMs,
        flights: [],
        surroundings: {},
        flightSource: 'test',
        airports: ['UIII'],
      },
    }),
  );
  const counterfactual = {
    compare: 'travel',
    label: 'No travel measures',
    runs: 1,
    rControlled: 2.4,
    infectedP50: 300,
    deathsP50: 3,
    peakHospitalP50: 9,
    averted: {
      infectedP5: 0,
      infectedP50: 210,
      infectedP95: 400,
      infectedCi: [100, 300],
      deathsP5: 0,
      deathsP50: 2,
      deathsP95: 4,
      deathsCi: [1, 3],
      peakHospitalP5: 0,
      peakHospitalP50: 4,
      peakHospitalP95: 8,
      peakHospitalCi: [2, 6],
      reportedP50: 20,
    },
  };
  const options = (document, windowRef) => ({
    document,
    windowRef,
    storage: page.storage,
    fetch: async (url) => {
      if (!String(url).endsWith('/epidemic')) throw new Error('offline');
      return {
        ok: true,
        status: 200,
        json: async () =>
          epidemicResult(startMs, {
            runs: 1,
            stoppedAt: { run: 0, hour: 24 },
            counterfactual,
          }),
      };
    },
    now: () => NOW,
  });
  const panel = new OutbreakPanel(null, options(page.document, page.windowRef));
  page.nodes.get('outbreak-epi-run').click();
  await settle();
  const saved = () => JSON.parse(page.stored.get(OUTBREAK_STORAGE_KEY));
  assert.deepEqual(saved().epidemic.counterfactual, counterfactual);
  assert.deepEqual(saved().epidemic.stoppedAt, { run: 0, hour: 24 });
  panel.destroy();

  const again = phase2Page();
  const reloaded = new OutbreakPanel(
    null,
    options(again.document, again.windowRef),
  );
  assert.deepEqual(reloaded._epidemic.counterfactual, counterfactual);
  assert.deepEqual(reloaded._epidemic.stoppedAt, { run: 0, hour: 24 });
  assert.match(
    again.nodes.get('outbreak-status').textContent,
    /^EPIDEMIC MODEL \(saved result\) · 1 places at risk · 1 runs · time limit: stopped at day 1 of 2 \(try fewer days\) · 1 paired runs × 2 arms$/,
  );
  reloaded.destroy();
});

test('FIND FUTURE SPREAD LOCATIONS looks up to 30 days: one request a window, the choice kept, a failed window skipped', async () => {
  const page = fakePage([
    'outbreak-model',
    'outbreak-future',
    'outbreak-future-days',
    'outbreak-forecast',
  ]);
  const asked = [];
  const codes = ['UIUU', 'UNNT', 'UUEE', 'UHHH', 'ULLI', 'URSS'];
  const panel = new OutbreakPanel(null, {
    document: page.document,
    windowRef: page.windowRef,
    storage: page.storage,
    fetch: async (url, init = {}) => {
      if (url === '/api/llm/providers')
        return {
          ok: true,
          json: async () => ({
            providers: [{ id: 'openai', label: 'OpenAI', ready: true }],
          }),
        };
      if (String(url).startsWith('/api/outbreak/news'))
        return { ok: true, json: async () => ({ articles: [] }) };
      if (String(url).startsWith('/api/outbreak/airports/candidates'))
        return {
          ok: true,
          json: async () => ({
            airports: codes.map((code, i) => ({
              code,
              name: code,
              lat: 50 + i,
              lon: 100 + i,
            })),
          }),
        };
      if (url === '/api/llm/ask') {
        const body = JSON.parse(init.body);
        asked.push(body);
        const n = asked.length;
        if (n === 3)
          return {
            ok: false,
            status: 502,
            json: async () => ({ error: 'busy' }),
          };
        return {
          ok: true,
          status: 200,
          json: async () => ({
            answer: `Place ${n}, Russia | ${codes[n - 1]} | LOW | flights`,
          }),
        };
      }
      throw new Error(`unexpected ${url}`);
    },
    now: () => Date.UTC(2026, 9, 11, 12),
  });
  const select = page.nodes.get('outbreak-future-days');
  assert.deepEqual(
    select.children.map((o) => [o.value, o.textContent]),
    [
      ['24', 'Next 24 hours'],
      ['48', 'Next 48 hours'],
      ['72', 'Next 3 days'],
      ['120', 'Next 5 days'],
      ['168', 'Next 7 days'],
      ['336', 'Next 14 days'],
      ['504', 'Next 21 days'],
      ['720', 'Next 30 days'],
    ],
  );
  assert.equal(select.value, '720', 'the full 30 days is the default');
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
  page.nodes.get('outbreak-model').value = 'openai';
  select.value = '720';
  select.fire('change');
  const saved = () => JSON.parse(page.stored.get(OUTBREAK_STORAGE_KEY));
  assert.equal(saved().futureHours, 720, 'the choice is kept');
  assert.equal(
    saved().futureHoursChosen,
    true,
    'a reach picked from the menu is remembered',
  );

  await panel._futureSpread();
  assert.equal(asked.length, 6, 'six windows to 30 days');
  assert.match(asked[0].question, /within the next 24 hours/);
  assert.match(asked[1].question, /in the period 24 to 48 hours from now/);
  assert.match(asked[3].question, /in the period 3 to 7 days from now/);
  assert.match(asked[5].question, /in the period 14 to 30 days from now/);
  assert.deepEqual(asked[1].context.outbreakForecast.predictedEarlier, [
    'Place 1, Russia',
  ]);
  assert.deepEqual(
    asked[5].context.outbreakForecast.predictedEarlier,
    [
      'Place 1, Russia',
      'Place 2, Russia',
      'Place 4, Russia',
      'Place 5, Russia',
    ],
    'the failed 3-day window adds nothing',
  );
  assert.deepEqual(
    saved().forecast.map((f) => [f.name, f.within]),
    [
      ['Place 1, Russia', 24],
      ['Place 2, Russia', 48],
      ['Place 4, Russia', 168],
      ['Place 5, Russia', 336],
      ['Place 6, Russia', 720],
    ],
  );
  assert.equal(
    page.nodes.get('outbreak-status').textContent,
    'FUTURE SPREAD DONE · 1 within 24 h · 1 within 48 h · 1 within 7 d · 1 within 14 d · 1 within 30 d · no answer for 3 d',
  );
  assert.equal(
    page.nodes.get('outbreak-forecast').children[2].children[0].textContent,
    'WITHIN 7 D · Place 4, Russia · LOW · flights',
  );
  panel.destroy();

  // A reload keeps the reach and every window's places.
  const again = new OutbreakPanel(null, {
    document: page.document,
    windowRef: page.windowRef,
    storage: page.storage,
    fetch: async () => {
      throw new Error('offline');
    },
    now: () => Date.UTC(2026, 9, 11, 12),
  });
  assert.equal(select.value, '720');
  assert.equal(saved().forecast.length, 5);
  again.destroy();
});
