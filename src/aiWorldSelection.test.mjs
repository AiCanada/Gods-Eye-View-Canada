import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatSkill,
  measuredLinkLines,
  measuredLinkText,
  TRAINING_LINKS,
} from './trainingLinks.mjs';
import {
  AI_WORLD_DOMAINS,
  AI_WORLD_EXTRAS,
  agoLabel,
  allState,
  buildSelectionItems,
  clampInt,
  classTag,
  cleanClass,
  cleanPredictions,
  controlStates,
  deletePreviewView,
  domainNote,
  durationLabel,
  estimateLines,
  feedStatusText,
  fileCount,
  formatBytes,
  formatCount,
  horizonLabel,
  learningLabel,
  marketLines,
  pollDelay,
  postTrainNote,
  sameSelection,
  stageLines,
  stateLabel,
  stripExcluded,
  toggle,
  toggleAll,
} from './aiWorldSelection.mjs';

const NOW = Date.UTC(2026, 9, 13, 12);

test('TRAIN ON: one row per layer in DataManager order, then catalog-only items, then the five extras, once each', () => {
  const items = buildSelectionItems({
    layers: [
      { id: 'flights', name: 'Flights', showInTogglePanel: true },
      { id: 'transit', name: 'Transit' },
      // Scene machinery kept out of Data Layers is not training data.
      { id: 'bhote-koshi-locator', name: 'Locator', showInTogglePanel: false },
      { id: 'flights', name: 'Flights again' },
      { id: '', name: 'No id' },
      null,
    ],
    catalog: [
      {
        id: 'transit',
        label: 'Transit (GTFS-RT)',
        layers: ['transit'],
        kind: 'feed',
        class: 'open',
        licence: 'Per-feed open licences',
      },
      { id: 'traffic-tiles', label: 'Traffic tiles', class: 'restricted' },
      { id: 'news', label: 'News', kind: 'feed', class: 'nc' },
      { id: 'mystery', class: 'secret' },
      { id: 'transit', label: 'A second transit' },
      { label: 'No id' },
    ],
  });
  assert.deepEqual(
    items.map((item) => item.id),
    [
      'flights',
      'transit',
      'traffic-tiles',
      'mystery',
      'news',
      'demographics',
      'abundance',
      'outbreak-sim',
      'devices',
    ],
  );
  assert.deepEqual(
    items.map((item) => item.label),
    [
      'FLIGHTS',
      'TRANSIT (GTFS-RT)',
      'TRAFFIC TILES',
      'MYSTERY',
      'NEWS EVENTS',
      'POPULATION DEMOGRAPHICS',
      'GLOBAL ABUNDANCE',
      'OUTBREAK SIM EPISODES',
      'YOUR DEVICES',
    ],
  );
  // Unknown classes read STATIC; the owner's devices are PERSONAL.
  assert.deepEqual(
    items.map((item) => classTag(item.cls)),
    [
      'STATIC',
      'OPEN',
      'RESTRICTED',
      'STATIC',
      'NC',
      'STATIC',
      'OPEN',
      'STATIC',
      'PERSONAL',
    ],
  );
  assert.deepEqual(
    items.map((item) => item.source),
    [
      'layer',
      'layer',
      'catalog',
      'catalog',
      'extra',
      'extra',
      'extra',
      'extra',
      'extra',
    ],
  );
  assert.equal(items[1].licence, 'Per-feed open licences');
  assert.equal(items[1].kind, 'feed');
});

test('TRAIN ON: the five extras are there with no layers and no catalog; a layer that shares an id keeps its own place', () => {
  assert.deepEqual(
    buildSelectionItems().map((item) => [item.id, item.label]),
    AI_WORLD_EXTRAS.map((extra) => [extra.id, extra.label]),
  );
  assert.deepEqual(
    buildSelectionItems({ layers: 'nonsense', catalog: { items: [] } }).map(
      (item) => item.id,
    ),
    ['news', 'demographics', 'abundance', 'outbreak-sim', 'devices'],
  );
  const items = buildSelectionItems({
    layers: [
      { id: 'news', name: 'Headlines' },
      { id: 'cctv', name: 'Cameras' },
    ],
  });
  assert.deepEqual(
    items.map((item) => [item.id, item.label]),
    [
      ['news', 'HEADLINES'],
      ['cctv', 'CAMERAS'],
      ['demographics', 'POPULATION DEMOGRAPHICS'],
      ['abundance', 'GLOBAL ABUNDANCE'],
      ['outbreak-sim', 'OUTBREAK SIM EPISODES'],
      ['devices', 'YOUR DEVICES'],
    ],
  );
});

test('licence classes: the known six, else STATIC', () => {
  for (const cls of [
    'open',
    'nc',
    'restricted',
    'unclear',
    'personal',
    'static',
  ])
    assert.equal(cleanClass(cls), cls);
  assert.equal(cleanClass(' OPEN '), 'open');
  assert.equal(cleanClass('cc-by'), 'static');
  assert.equal(cleanClass(undefined), 'static');
  assert.equal(classTag('nc'), 'NC');
  assert.equal(classTag(42), 'STATIC');
});

test('ALL: all, none or some; pressed, it ticks every row or none', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.equal(allState([], items), 'none');
  assert.equal(allState(['a'], items), 'some');
  assert.equal(allState(['c', 'a', 'b'], items), 'all');
  // An id no row has does not count toward ALL.
  assert.equal(allState(['a', 'b', 'c', 'gone'], items), 'all');
  assert.equal(allState(['gone'], items), 'none');
  assert.equal(allState(['a'], []), 'none');
  assert.equal(allState(null, ['a', 'b']), 'none');
  assert.equal(allState(['a', 'b'], ['a', 'b']), 'all');
  assert.deepEqual(toggleAll(items, true), ['a', 'b', 'c']);
  assert.deepEqual(toggleAll(items, false), []);
  assert.deepEqual(toggleAll([{ id: 'a' }, { id: 'a' }, {}], true), ['a']);
});

test('one tick on or off keeps the rest of the selection in order', () => {
  assert.deepEqual(toggle(['a', 'b'], 'c', true), ['a', 'b', 'c']);
  assert.deepEqual(toggle(['a', 'b', 'c'], 'b', false), ['a', 'c']);
  assert.deepEqual(toggle(['a', 'b'], 'a', true), ['b', 'a']);
  assert.deepEqual(toggle(['a'], 'z', false), ['a']);
  assert.deepEqual(toggle(null, 'a', true), ['a']);
  assert.deepEqual(toggle(['a', '', 7], '', true), ['a']);
  const before = ['a'];
  toggle(before, 'b', true);
  assert.deepEqual(before, ['a'], 'the selection given is not changed');
  assert.equal(sameSelection(['a', 'b'], ['b', 'a']), true);
  assert.equal(sameSelection(['a'], ['a', 'b']), false);
  assert.equal(sameSelection([], null), true);
});

test('bytes read like 1.2 GB', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(-5), '0 B');
  assert.equal(formatBytes(Number.NaN), '0 B');
  assert.equal(formatBytes(null), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(999.6), '1 KB');
  assert.equal(formatBytes(1500), '1.5 KB');
  assert.equal(formatBytes(12.4e6), '12.4 MB');
  assert.equal(formatBytes(123_456_789), '123 MB');
  assert.equal(formatBytes(999_960_000), '1 GB');
  assert.equal(formatBytes(1.2e9), '1.2 GB');
  assert.equal(formatBytes(600e9), '600 GB');
  assert.equal(formatBytes('2048'), '2 KB');
  assert.equal(formatBytes(3.25e12), '3.3 TB');
  assert.equal(formatBytes(5e15), '5 PB');
  assert.equal(formatBytes(2e18), '2000 PB');
});

test('counts, state words, times and durations', () => {
  assert.equal(formatCount(1234567), '1,234,567');
  assert.equal(formatCount(999), '999');
  assert.equal(formatCount(-1200.4), '-1,200');
  assert.equal(formatCount('x'), '0');
  assert.equal(fileCount(1), '1 FILE');
  assert.equal(fileCount(1200), '1,200 FILES');
  assert.equal(fileCount(0), '0 FILES');
  assert.equal(stateLabel('running'), 'RUNNING');
  assert.equal(stateLabel('outbreak-sim'), 'OUTBREAK SIM');
  assert.equal(stateLabel('  quota_hit '), 'QUOTA HIT');
  assert.equal(stateLabel(''), 'UNKNOWN');
  assert.equal(stateLabel(undefined), 'UNKNOWN');
  assert.equal(agoLabel(null, NOW), '');
  assert.equal(agoLabel(NOW - 30_000, NOW), 'JUST NOW');
  assert.equal(agoLabel(NOW + 5_000, NOW), 'JUST NOW');
  assert.equal(agoLabel(NOW - 125_000, NOW), '2 MIN AGO');
  assert.equal(agoLabel(NOW - 5 * 3_600_000, NOW), '5 H AGO');
  assert.equal(agoLabel(NOW - 3 * 86_400_000, NOW), '3 D AGO');
  assert.equal(durationLabel(null), '');
  assert.equal(durationLabel(20_000), 'UNDER 1 MIN');
  assert.equal(durationLabel(12 * 60_000), '12 MIN');
  assert.equal(durationLabel(5 * 3_600_000), '5 H');
  assert.equal(durationLabel(72 * 3_600_000), '3 D');
});

test('a row’s live status: RECORDING · size · last record, or the state in words', () => {
  assert.equal(
    feedStatusText(
      {
        id: 'transit',
        state: 'recording',
        bytes: 12.4e6,
        lastAt: NOW - 125_000,
      },
      NOW,
    ),
    'RECORDING · 12.4 MB · 2 MIN AGO',
  );
  assert.equal(
    feedStatusText({ state: 'recording', bytes: 0, lastAt: null }, NOW),
    'RECORDING · 0 B',
  );
  assert.equal(feedStatusText({ state: 'paused', bytes: 5e6 }, NOW), 'PAUSED');
  assert.equal(feedStatusText({ state: 'off' }, NOW), 'OFF');
  assert.equal(feedStatusText({ state: 'quota' }, NOW), 'QUOTA');
  assert.equal(feedStatusText({ state: 'waiting' }, NOW), 'WAITING');
  assert.equal(feedStatusText({ state: 'error', error: null }, NOW), 'ERROR');
  assert.equal(
    feedStatusText({ state: 'error', error: 'HTTP 429 from the host' }, NOW),
    'ERROR · HTTP 429 from the host',
  );
  assert.equal(
    feedStatusText({ state: 'error', error: 'x'.repeat(200) }, NOW).length,
    'ERROR · '.length + 80,
  );
  assert.equal(
    feedStatusText(
      { state: 'static', bytes: 1.2e6, lastAt: NOW - 3 * 3_600_000 },
      NOW,
    ),
    'SNAPSHOT · 1.2 MB · 3 H AGO',
  );
  assert.equal(feedStatusText(undefined, NOW), '');
  assert.equal(feedStatusText({ id: 'x' }, NOW), '');
});

test('the buttons each state allows; PAUSE is CONTINUE while paused; no answer acts as idle', () => {
  const view = (state) => {
    const c = controlStates(state);
    return [
      c.initialize,
      c.pause,
      c.stop,
      c.delete,
      c.pauseLabel,
      c.pauseAction,
    ];
  };
  for (const state of ['idle', 'stopped', null, undefined, 'weird'])
    assert.deepEqual(
      view(state),
      [true, false, false, true, 'PAUSE', 'pause'],
      String(state),
    );
  for (const state of ['initializing', 'running'])
    assert.deepEqual(
      view(state),
      [false, true, true, false, 'PAUSE', 'pause'],
      state,
    );
  assert.deepEqual(view('paused'), [
    false,
    true,
    true,
    false,
    'CONTINUE',
    'continue',
  ]);
  assert.deepEqual(view('stopping'), [
    false,
    false,
    false,
    false,
    'PAUSE',
    'pause',
  ]);
});

test('the status is asked for every 3 s while the work moves, every 15 s otherwise', () => {
  for (const state of ['initializing', 'running', 'paused', 'stopping'])
    assert.equal(pollDelay(state), 3_000, state);
  for (const state of ['idle', 'stopped', null])
    assert.equal(pollDelay(state), 15_000, String(state));
});

test('STATUS: the job, each stage, storage against the cap, gaps and compute', () => {
  const waiting = stageLines(null, NOW);
  assert.equal(waiting.state, 'STATE · WAITING FOR THE SERVER');
  assert.equal(waiting.recorder, 'RECORDING · OFF');
  assert.equal(waiting.compute, 'COMPUTE · WAITING FOR THE SERVER');
  assert.equal(waiting.links, '', 'no measured links before a report');
  const lines = stageLines(
    {
      state: 'running',
      since: NOW - 125_000,
      capBytes: 600e9,
      stages: {
        recorder: { state: 'running', feeds: 12, bytesPerDay: 1.2e9 },
        generator: {
          state: 'running',
          done: 120,
          total: 2000,
          episodes: 960,
          etaMs: 3 * 3_600_000,
          error: null,
        },
        trainer: {
          state: 'waiting',
          model: 'world-v1',
          epoch: 3,
          epochs: 20,
          loss: 0.012345,
          error: null,
          skill: { model: 0.2, persistence: 0.25 },
        },
        predictor: {
          state: 'error',
          domains: ['outbreak', 'weather'],
          updatedAt: NOW - 5 * 60_000,
          error: 'serve exited',
        },
      },
      storage: { usedBytes: 12.4e9, freeBytes: 1.5e12 },
      compute: {
        workers: 8,
        busy: 3,
        gpu: 'NVIDIA GeForce RTX 4060 Laptop GPU',
      },
      gaps: [
        { from: 1, to: 2, reason: 'restart' },
        { from: 3, to: 4, reason: 'paused' },
      ],
    },
    NOW,
  );
  assert.deepEqual(lines, {
    state: 'STATE · RUNNING · CHANGED 2 MIN AGO',
    recorder: 'RECORDING · RUNNING · 12 FEEDS · 1.2 GB A DAY',
    generator: 'SIM EPISODES · RUNNING · 120 / 2,000 · 960 EPISODES · ETA 3 H',
    trainer:
      'TRAINING · WAITING · world-v1 · EPOCH 3 / 20 · LOSS 0.0123 · MAE 0.200 VS PERSISTENCE 0.250',
    predictor:
      'PREDICTING · ERROR · OUTBREAK, WEATHER · UPDATED 5 MIN AGO · ERROR serve exited',
    storage: 'STORAGE · 12.4 GB / 600 GB · 2% · 1.5 TB FREE ON DISK',
    gaps: 'GAPS · 2 · LAST PAUSED',
    compute:
      'COMPUTE · 3 / 8 WORKERS BUSY · GPU NVIDIA GeForce RTX 4060 Laptop GPU',
    links: '',
  });
  const bare = stageLines(
    { state: 'idle', stages: {}, compute: { gpu: null } },
    NOW,
  );
  assert.equal(bare.state, 'STATE · IDLE');
  assert.equal(bare.trainer, 'TRAINING · OFF');
  const fresh = stageLines(
    {
      state: 'running',
      stages: {
        trainer: {
          state: 'running',
          model: 'world',
          epoch: 0,
          epochs: 20,
          channelMismatch: true,
        },
      },
    },
    NOW,
  );
  assert.match(fresh.trainer, /NEW CHANNELS, NEW MODEL/);
  assert.equal(bare.storage, 'STORAGE · 0 B USED');
  assert.equal(bare.gaps, 'GAPS · NONE');
  assert.equal(bare.compute, 'COMPUTE · NO WORKERS · NO GPU · CPU ONLY');
});

test('the estimate before INITIALIZE: a day of recording, days to the cap, the heaviest feeds, workers and GPU', () => {
  const labels = { transit: 'TRANSIT', flights: 'FLIGHTS', cctv: 'CAMERAS' };
  assert.deepEqual(
    estimateLines(
      {
        bytesPerDay: 1.2e9,
        feeds: [
          { id: 'flights', bytesPerDay: 0.3e9 },
          { id: 'transit', bytesPerDay: 0.8e9 },
          { id: 'cctv', bytesPerDay: 0.1e9 },
          { id: 'radio', bytesPerDay: 0 },
          { id: 'news', bytesPerDay: 0.05e9 },
        ],
        workers: 8,
        gpu: 'RTX 4060',
        capBytes: 600e9,
        daysToCap: 500,
      },
      (id) => labels[id] || id,
    ),
    [
      'RECORDS ABOUT 1.2 GB A DAY',
      'STORAGE CAP 600 GB · FULL IN ABOUT 500 DAYS',
      'HEAVIEST · TRANSIT 800 MB · FLIGHTS 300 MB · CAMERAS 100 MB',
      '8 WORKERS',
      'GPU RTX 4060',
    ],
  );
  // Days to the cap from the rate when the server leaves it out.
  assert.deepEqual(
    estimateLines({
      bytesPerDay: 400e9,
      capBytes: 600e9,
      workers: 1,
      gpu: null,
    }),
    [
      'RECORDS ABOUT 400 GB A DAY',
      'STORAGE CAP 600 GB · FULL IN ABOUT 1.5 DAYS',
      '1 WORKER',
      'NO GPU · CPU ONLY',
    ],
  );
  assert.deepEqual(
    estimateLines({ bytesPerDay: 0, capBytes: 600e9, workers: 0 }),
    [
      'RECORDS NOTHING LIVE: SNAPSHOTS AND SIM ONLY',
      'STORAGE CAP 600 GB',
      'NO WORKERS',
      'NO GPU · CPU ONLY',
    ],
  );
  assert.deepEqual(estimateLines(null), []);
});

test('the DELETE preview: one line per group, the total and the confirm label', () => {
  const view = deletePreviewView({
    scope: 'all',
    token: 'abc123',
    root: '.gev-data',
    groups: [
      {
        kind: 'tape',
        id: 'transit',
        path: 'tape/transit',
        files: 1200,
        bytes: 123_456_789,
      },
      {
        kind: 'models',
        id: 'world-v1',
        path: 'ai-world/models/world-v1',
        files: 1,
        bytes: 2.5e9,
      },
    ],
    totalFiles: 1201,
    totalBytes: 2_623_456_789,
  });
  assert.deepEqual(view.groups, [
    'TAPE · transit · tape/transit · 1,200 FILES · 123 MB',
    'MODELS · world-v1 · ai-world/models/world-v1 · 1 FILE · 2.5 GB',
  ]);
  assert.equal(view.total, 'TOTAL · 1,201 FILES · 2.6 GB · IN .gev-data');
  assert.equal(view.confirm, 'DELETE 1,201 FILES · 2.6 GB');
  assert.equal(view.canDelete, true);
  const empty = deletePreviewView({
    token: 't',
    groups: [],
    totalFiles: 0,
    totalBytes: 0,
  });
  assert.equal(empty.confirm, 'NOTHING TO DELETE');
  assert.equal(empty.canDelete, false);
  assert.equal(empty.total, 'TOTAL · 0 FILES · 0 B');
  // Without the token there is nothing the server would accept.
  assert.equal(
    deletePreviewView({ groups: [], totalFiles: 3 }).canDelete,
    false,
  );
  assert.equal(deletePreviewView(null).canDelete, false);
});

test('held-out error reads beside its persistence baseline; the study pairs read no military feed', () => {
  assert.equal(formatSkill(null), '');
  assert.equal(
    formatSkill({ model: 0.12, persistence: 0.2 }),
    'MAE 0.120 VS PERSISTENCE 0.200',
  );
  assert.equal(domainNote(true, 'LEARNING', null), 'READY');
  assert.equal(
    domainNote(false, 'LEARNING', { model: 0.2, persistence: 0.4 }),
    'LEARNING · MAE 0.200 VS PERSISTENCE 0.400',
  );
  // scripts/world-tape-bin.mjs writes these beside the bins for ml.gevtape.links.
  for (const link of TRAINING_LINKS) {
    assert.match(link.id, /^[a-z-]+$/);
    assert.ok(['primary', 'secondary'].includes(link.rank), link.id);
    assert.ok(link.reads.length > 0, link.id);
    assert.equal(typeof link.note, 'string', link.id);
    assert.ok(
      link.reads.every((read) => !read.startsWith('military')),
      link.id,
    );
  }
});

test('PREDICTIONS: known domains once each, a 1–168 h horizon, LEARNING until the predictor can draw', () => {
  assert.deepEqual(
    AI_WORLD_DOMAINS.map((domain) => domain.id),
    [
      'outbreak',
      'mobility',
      'trains',
      'traffic',
      'weather',
      'hazards',
      'news',
      'tracks',
      'flights',
      'vessels',
      'transit',
      'supply',
      'markets',
      'air-quality',
      'stream-gauges',
    ],
  );
  assert.deepEqual(cleanPredictions(null), { domains: [], horizonHours: 24 });
  assert.deepEqual(
    cleanPredictions({
      domains: ['weather', 'bogus', 'weather', 'news'],
      horizonHours: 500,
    }),
    { domains: ['weather', 'news'], horizonHours: 168 },
  );
  assert.deepEqual(cleanPredictions({ horizonHours: '0' }).horizonHours, 1);
  assert.deepEqual(cleanPredictions({ horizonHours: '48' }).horizonHours, 48);
  assert.equal(horizonLabel(48), '48 H');
  assert.equal(horizonLabel('nope'), '24 H');
  assert.equal(learningLabel(undefined), 'LEARNING');
  assert.equal(learningLabel(1), 'LEARNING · 1 DAY RECORDED');
  assert.equal(learningLabel(3.7), 'LEARNING · 3 DAYS RECORDED');
  assert.equal(clampInt('', 1, 10, 5), 5);
  assert.equal(clampInt(null, 1, 10, 5), 5);
  assert.equal(clampInt('12', 1, 10, 5), 10);
  assert.equal(clampInt('2.6', 1, 10, 5), 3);
});

test('AREAS rows: the name upper case, the point once; no loss is no loss shown', async () => {
  const { areaRows, stageLines } = await import('./aiWorldSelection.mjs');
  assert.deepEqual(
    areaRows([
      {
        key: '43.6532,-79.3832',
        name: 'Toronto',
        lat: 43.65321,
        lon: -79.38318,
      },
      { key: '1.0000,2.0000', name: '1.000, 2.000', lat: 1, lon: 2 },
      { key: '', name: 'no key', lat: 0, lon: 0 },
      { key: 'x', name: 'bad', lat: 'north', lon: 0 },
    ]),
    [
      { key: '43.6532,-79.3832', name: 'TORONTO', where: '43.653, -79.383' },
      { key: '1.0000,2.0000', name: '1.000, 2.000', where: '' },
    ],
  );
  const lines = stageLines({
    state: 'running',
    stages: { trainer: { state: 'waiting', loss: null } },
  });
  assert.equal(lines.trainer, 'TRAINING · WAITING');
});

test('military layers are not training rows and cannot be ticked', () => {
  const items = buildSelectionItems({
    layers: [
      { id: 'flights', name: 'Flights' },
      { id: 'military', name: 'Military flights' },
      { id: 'military-awareness', name: 'Military awareness' },
      { id: 'military-installations', name: 'Installations' },
    ],
  });
  assert.deepEqual(
    items.map((item) => item.id).filter((id) => id.startsWith('military')),
    [],
  );
  assert.ok(items.some((item) => item.id === 'flights'));
  assert.deepEqual(
    stripExcluded(['flights', 'military', 'military-installations', 'news']),
    ['flights', 'news'],
  );
  assert.deepEqual(toggle(['flights'], 'military', true), ['flights']);
  assert.deepEqual(
    toggleAll(items, true).filter((id) => id.startsWith('military')),
    [],
  );
});

test('MARKETS: each quote, its predicted move beside it, and a predicted asset with no quote', () => {
  const quotes = [
    {
      series: 'sp500',
      label: 'S&P 500',
      value: 7744.06,
      unit: 'points',
      source: 'Yahoo Finance',
    },
    { series: 'gold', label: 'Gold', value: 4199.6, unit: 'usd' },
  ];
  assert.deepEqual(marketLines(quotes, null, 24), [
    'S&P 500: 7744.06 points · Yahoo Finance',
    'Gold: 4199.6 usd',
  ]);
  const prediction = {
    domain: 'markets',
    assets: [
      { series: 'sp500', value: 0.4 },
      { series: 'gold', value: null },
      { series: 'bitcoin', label: 'Bitcoin', value: -2.5 },
    ],
  };
  assert.deepEqual(marketLines(quotes, prediction, 24), [
    'S&P 500: 7744.06 points · Yahoo Finance · 24 H ▲ 0.40%',
    'Gold: 4199.6 usd',
    'Bitcoin: 24 H ▼ 2.50%',
  ]);
  // Still learning: quotes only, nothing predicted is invented.
  assert.deepEqual(
    marketLines(quotes, { ...prediction, learning: { daysRecorded: 1 } }, 24),
    marketLines(quotes, null, 24),
  );
});

test('STATUS: measured links say who moves first, how strongly, and whether later hours agree', () => {
  const row = {
    channel: 'hazards.quakes',
    asset: 'crude',
    lagHours: 3,
    r: 0.312,
    n: 480,
    rTest: 0.25,
    holds: true,
  };
  assert.equal(
    measuredLinkText(row),
    'HAZARDS.QUAKES MOVES 3 H BEFORE CRUDE · R 0.31 · N 480 · HOLDS ON LATER HOURS (R 0.25)',
  );
  assert.equal(
    measuredLinkText({ ...row, lagHours: -2, holds: false }),
    'CRUDE MOVES 2 H BEFORE HAZARDS.QUAKES · R 0.31 · N 480 · NOT CONFIRMED ON LATER HOURS',
  );
  assert.match(measuredLinkText({ ...row, lagHours: 0 }), /IN THE SAME HOUR/);
  assert.equal(measuredLinkText({ channel: 'x' }), '');
  assert.deepEqual(measuredLinkLines(null), []);
  assert.deepEqual(
    measuredLinkLines({
      hours: 20,
      reason: 'fewer than 48 paired hours for every pair',
    }),
    ['MEASURED: FEWER THAN 48 PAIRED HOURS FOR EVERY PAIR (20 H BINNED)'],
  );
  assert.equal(
    measuredLinkLines({ hours: 500, top: Array(9).fill(row) }).length,
    6,
  );
  assert.deepEqual(measuredLinkLines({ hours: 500, top: [] }), [
    'MEASURED: NO LINK YET (500 H BINNED)',
  ]);
  // Under STATUS, one measured link per line after the other metrics.
  assert.equal(
    stageLines(
      {
        state: 'running',
        stages: {},
        links: { hours: 0, reason: 'no market prices in the bins yet' },
      },
      NOW,
    ).links,
    'MEASURED: NO MARKET PRICES IN THE BINS YET (0 H BINNED)',
  );
  assert.equal(
    stageLines(
      { state: 'running', stages: {}, links: { hours: 500, top: [row, row] } },
      NOW,
    ).links.split('\n').length,
    2,
  );
});

test('POST-TRAIN line: what the kit does by itself, what is saved, the last score', () => {
  assert.match(
    postTrainNote(null),
    /^THE KIT'S OWN WORLD MODEL POST-TRAINS ITSELF EVERY DAY/,
  );
  assert.equal(
    postTrainNote({ adapter: 'a:B', daily: false, last: null }),
    'SAVED a:B · NOT RUN YET',
  );
  assert.equal(
    postTrainNote({
      adapter: 'a:B',
      daily: true,
      last: { before: 0.3, after: 0.31, helped: false },
    }),
    'SAVED a:B · DAILY · LAST: HELD-OUT LOSS 0.300 → 0.310 · DID NOT HELP',
  );
  assert.match(
    postTrainNote({ adapter: 'a:B', last: { before: null, after: null } }),
    /NO HELD-OUT SCORE/,
  );
});

test('STATUS: the trainer says what it waits for, and LEARNING counts binned days too', () => {
  const line = (trainer) =>
    stageLines({ state: 'running', stages: { trainer } }, NOW).trainer;
  assert.equal(
    line({
      state: 'waiting',
      model: 'world',
      note: 'NEEDS 3 BINNED DAYS · 1 SO FAR',
    }),
    'TRAINING · WAITING · world · NEEDS 3 BINNED DAYS · 1 SO FAR',
  );
  assert.equal(
    line({
      state: 'waiting',
      model: 'world',
      note: 'BINNING 2026-09-13 · 29 DAYS LEFT',
    }),
    'TRAINING · WAITING · world · BINNING 2026-09-13 · 29 DAYS LEFT',
  );
  assert.equal(
    line({
      state: 'error',
      model: 'world',
      error: 'not enough bins',
      note: 'TRIED AGAIN WHEN A NEW DAY IS BINNED',
    }),
    'TRAINING · ERROR · world · TRIED AGAIN WHEN A NEW DAY IS BINNED · ERROR not enough bins',
  );
  assert.equal(
    line({ state: 'waiting', model: 'world', note: null }),
    'TRAINING · WAITING · world',
  );
  assert.equal(
    learningLabel({ daysRecorded: 2.4, daysBinned: 31 }),
    'LEARNING · 2 DAYS RECORDED · 31 DAYS BINNED',
  );
  assert.equal(
    learningLabel({ daysRecorded: 3, daysBinned: 3 }),
    'LEARNING · 3 DAYS RECORDED',
  );
  assert.equal(
    learningLabel({ daysRecorded: 0, daysBinned: 1 }),
    'LEARNING · 0 DAYS RECORDED · 1 DAY BINNED',
  );
  assert.equal(learningLabel({}), 'LEARNING');
});
