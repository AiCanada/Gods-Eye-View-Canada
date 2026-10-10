import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OutbreakPanel } from './outbreakPanel.js';
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
      { day: 1, p5: 50, p50: 60, p95: 80, reportedP50: 0, deathsP50: 0 },
      { day: 2, p5: 70, p50: 90, p95: 130, reportedP50: 6, deathsP50: 1 },
    ],
    summary: { r0: 15, rEffective: 12, rControlled: 12, doublingDays: 1.1 },
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
  // The curve: the 5–95 % band, then infected, reported and deaths.
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
    ],
  );
  assert.match(
    legend.textContent,
    /^Day 2: infected 90 \(5–95 %: 70–130\) · reported 6 · deaths 1$/,
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
  const cleared = open({ profileDefaults: 2, profile: { r0: 3 } });
  assert.deepEqual(cleared.profile, { r0: 3 });
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
