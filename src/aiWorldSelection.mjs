/**
 * ARTIFICIAL INTELLIGENCE WORLD TRAINING SIM: the pure half of the left-hand
 * tab (src/aiWorldPanel.js, docs/AI-WORLD-TAB.md). No DOM, no Node: the tick
 * box list, the ALL box, the buttons each state allows, and every line of
 * text the tab shows, from the server's answers.
 *
 * TRAIN ON is one row per DataManager layer (in the DataManager's order),
 * then the server catalog's items that are not layers, then the four entries
 * that are never layers: NEWS EVENTS, POPULATION DEMOGRAPHICS, OUTBREAK SIM
 * EPISODES and YOUR DEVICES. One row per id. A layer's label is its catalog
 * label when the catalog knows its id, else the layer's own name; every label
 * is upper case. A licence class the catalog does not give reads STATIC.
 */

import { marketAsset } from './marketAssets.mjs';
import { formatSkill } from './trainingLinks.mjs';

/**
 * Military layers stay on the map. They are not training rows, not part of
 * ALL, and not a prediction. Military flights use the same ids.
 */
export const AI_WORLD_EXCLUDED = Object.freeze([
  'military',
  'military-awareness',
  'military-installations',
]);

const EXCLUDED_IDS = new Set(AI_WORLD_EXCLUDED);

/** Drop military ids. Other ids keep their order. */
export function stripExcluded(selection) {
  return (Array.isArray(selection) ? selection : []).filter(
    (id) => typeof id === 'string' && id && !EXCLUDED_IDS.has(id),
  );
}

/** The entries that are not data layers, always present, in this order. */
export const AI_WORLD_EXTRAS = Object.freeze([
  Object.freeze({ id: 'news', label: 'NEWS EVENTS', cls: 'static' }),
  Object.freeze({
    id: 'demographics',
    label: 'POPULATION DEMOGRAPHICS',
    cls: 'static',
  }),
  Object.freeze({
    id: 'outbreak-sim',
    label: 'OUTBREAK SIM EPISODES',
    cls: 'static',
  }),
  // The owner's own devices are personal data by definition
  // (docs/WORLD-MODEL-DATA.md, Licence classes).
  Object.freeze({ id: 'devices', label: 'YOUR DEVICES', cls: 'personal' }),
]);

/** Licence classes, in the order docs/WORLD-MODEL-DATA.md lists them. */
export const AI_WORLD_CLASSES = Object.freeze([
  'open',
  'nc',
  'restricted',
  'unclear',
  'personal',
  'static',
]);

/** What PREDICTIONS can draw on the globe (the Prediction's domain). */
export const AI_WORLD_DOMAINS = Object.freeze([
  Object.freeze({ id: 'outbreak', label: 'OUTBREAK' }),
  Object.freeze({ id: 'mobility', label: 'MOBILITY' }),
  Object.freeze({ id: 'trains', label: 'TRAINS' }),
  Object.freeze({ id: 'traffic', label: 'TRAFFIC' }),
  Object.freeze({ id: 'weather', label: 'WEATHER' }),
  Object.freeze({ id: 'hazards', label: 'HAZARDS' }),
  Object.freeze({ id: 'news', label: 'NEWS' }),
  Object.freeze({ id: 'tracks', label: 'TRACKS' }),
  Object.freeze({ id: 'flights', label: 'FLIGHTS' }),
  Object.freeze({ id: 'vessels', label: 'VESSELS' }),
  Object.freeze({ id: 'transit', label: 'TRANSIT' }),
  Object.freeze({ id: 'supply', label: 'SUPPLY' }),
  Object.freeze({ id: 'markets', label: 'PRICE MOVES' }),
  Object.freeze({ id: 'air-quality', label: 'AIR QUALITY' }),
  Object.freeze({ id: 'stream-gauges', label: 'STREAM GAUGES' }),
]);

/** The DELETE scopes, as the menu names them. */
export const AI_WORLD_DELETE_SCOPES = Object.freeze([
  Object.freeze({ id: 'all', label: 'ALL DATA' }),
  Object.freeze({ id: 'tape', label: 'TAPE' }),
  Object.freeze({ id: 'bins', label: 'BINS' }),
  Object.freeze({ id: 'datasets', label: 'SIM DATASETS' }),
  Object.freeze({ id: 'worlds', label: 'WORLDS' }),
  Object.freeze({ id: 'models', label: 'MODELS' }),
  Object.freeze({ id: 'predictions', label: 'PREDICTIONS' }),
  Object.freeze({ id: 'demographics', label: 'DEMOGRAPHICS' }),
]);

/** States in which the work moves, so the status is asked for often. */
export const AI_WORLD_ACTIVE_STATES = Object.freeze([
  'initializing',
  'running',
  'paused',
  'stopping',
]);

export const AI_WORLD_POLL_ACTIVE_MS = 3_000;
export const AI_WORLD_POLL_IDLE_MS = 15_000;
export const AI_WORLD_HORIZON_DEFAULT = 24;
export const AI_WORLD_HORIZON_MIN = 1;
export const AI_WORLD_HORIZON_MAX = 168;

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
const DOMAIN_IDS = new Set(AI_WORLD_DOMAINS.map((domain) => domain.id));

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** A known licence class, else 'static'. */
export function cleanClass(value) {
  const cls = text(value).toLowerCase();
  return AI_WORLD_CLASSES.includes(cls) ? cls : 'static';
}

/** The tag a row shows for its licence class: OPEN, NC, … STATIC. */
export function classTag(value) {
  return cleanClass(value).toUpperCase();
}

function catalogItem(raw) {
  const id = text(raw?.id);
  if (!id) return null;
  return {
    id,
    label: text(raw.label),
    cls: cleanClass(raw.class),
    kind: text(raw.kind) || 'static',
    licence: text(raw.licence),
  };
}

/**
 * Every TRAIN ON row: `{ id, label, cls, kind, licence, source }`, source
 * 'layer', 'catalog' or 'extra'.
 * @param {{layers?: Array<{id: string, name?: string, showInTogglePanel?: boolean}>, catalog?: Array<object>}} [input]
 */
export function buildSelectionItems({ layers = [], catalog = [] } = {}) {
  const known = new Map();
  for (const raw of Array.isArray(catalog) ? catalog : []) {
    const item = catalogItem(raw);
    if (item && !known.has(item.id)) known.set(item.id, item);
  }
  const items = [];
  const seen = new Set();
  const add = (item) => {
    if (!item.id || seen.has(item.id)) return;
    seen.add(item.id);
    items.push(item);
  };
  for (const layer of Array.isArray(layers) ? layers : []) {
    const id = text(layer?.id);
    // A layer kept out of the Data Layers list is scene machinery, not data.
    if (!id || layer.showInTogglePanel === false || EXCLUDED_IDS.has(id))
      continue;
    const entry = known.get(id);
    add({
      id,
      label: (entry?.label || text(layer.name) || id).toUpperCase(),
      cls: entry ? entry.cls : 'static',
      kind: entry ? entry.kind : 'static',
      licence: entry?.licence || '',
      source: 'layer',
    });
  }
  const extraIds = new Set(AI_WORLD_EXTRAS.map((extra) => extra.id));
  for (const entry of known.values()) {
    if (extraIds.has(entry.id) || EXCLUDED_IDS.has(entry.id)) continue;
    add({
      ...entry,
      label: (entry.label || entry.id).toUpperCase(),
      source: 'catalog',
    });
  }
  for (const extra of AI_WORLD_EXTRAS) {
    const entry = known.get(extra.id);
    add({
      id: extra.id,
      label: extra.label,
      cls: entry ? entry.cls : extra.cls,
      kind: entry ? entry.kind : 'static',
      licence: entry?.licence || '',
      source: 'extra',
    });
  }
  return items;
}

function idsOf(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => (typeof item === 'string' ? item : item?.id))
    .filter((id) => typeof id === 'string' && id);
}

/**
 * The ALL box: 'all' when every row is ticked, 'none' when none is (or there
 * are no rows), 'some' otherwise.
 * @param {string[]} selection
 * @param {Array<{id: string}|string>} items
 * @returns {'all'|'none'|'some'}
 */
export function allState(selection, items) {
  const ids = idsOf(items);
  if (!ids.length) return 'none';
  const ticked = new Set(Array.isArray(selection) ? selection : []);
  const count = ids.filter((id) => ticked.has(id)).length;
  if (count === 0) return 'none';
  return count === ids.length ? 'all' : 'some';
}

/** ALL pressed: every row ticked, or none. */
export function toggleAll(items, on) {
  return on ? [...new Set(idsOf(items))] : [];
}

/** One row ticked or unticked; the rest of the selection keeps its order. */
export function toggle(selection, id, on) {
  const current = stripExcluded(selection);
  if (typeof id !== 'string' || !id || EXCLUDED_IDS.has(id))
    return [...current];
  const without = current.filter((entry) => entry !== id);
  return on ? [...without, id] : without;
}

/** The same ids, whatever their order. */
export function sameSelection(a, b) {
  const left = new Set(Array.isArray(a) ? a : []);
  const right = new Set(Array.isArray(b) ? b : []);
  if (left.size !== right.size) return false;
  for (const id of left) if (!right.has(id)) return false;
  return true;
}

/** Bytes as "1.2 GB" (decimal units, as the storage cap is given). */
export function formatBytes(n) {
  const bytes = Number(n);
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  let unit = 0;
  let value = bytes;
  for (;;) {
    const shown =
      unit === 0 || value >= 100
        ? Math.round(value)
        : Math.round(value * 10) / 10;
    if (shown >= 1000 && unit < BYTE_UNITS.length - 1) {
      value /= 1000;
      unit += 1;
      continue;
    }
    const number = Number.isInteger(shown) ? String(shown) : shown.toFixed(1);
    return `${number} ${BYTE_UNITS[unit]}`;
  }
}

/** A whole number with thousands separators: 12,345. */
export function formatCount(n) {
  const value = Math.round(Number(n));
  if (!Number.isFinite(value)) return '0';
  const sign = value < 0 ? '-' : '';
  return `${sign}${String(Math.abs(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

/** A state name as upper-case words: 'outbreak-sim' → 'OUTBREAK SIM'. */
export function stateLabel(state) {
  const words = String(state ?? '')
    .trim()
    .replace(/[-_\s]+/g, ' ')
    .trim()
    .toUpperCase();
  return words || 'UNKNOWN';
}

/** How long ago: JUST NOW, 2 MIN AGO, 5 H AGO, 3 D AGO; '' without a time. */
export function agoLabel(atMs, nowMs = Date.now()) {
  const at = Number(atMs);
  if (!Number.isFinite(at) || at <= 0) return '';
  const seconds = Math.max(0, (Number(nowMs) - at) / 1000);
  if (!(seconds >= 60)) return 'JUST NOW';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} MIN AGO`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} H AGO`;
  return `${Math.floor(hours / 24)} D AGO`;
}

/** A duration: UNDER 1 MIN, 12 MIN, 5 H, 3 D; '' without one. */
export function durationLabel(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return '';
  const minutes = Math.round(value / 60_000);
  if (minutes < 1) return 'UNDER 1 MIN';
  if (minutes < 60) return `${minutes} MIN`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} H`;
  return `${Math.round(hours / 24)} D`;
}

/** A count and its noun: 1 FILE, 1,200 FILES. */
export function countLabel(n, word) {
  return `${formatCount(n)} ${word}${Math.round(Number(n)) === 1 ? '' : 'S'}`;
}

function shortError(value) {
  const error = text(value);
  return error.length > 80 ? `${error.slice(0, 79)}…` : error;
}

function line(parts) {
  return parts.filter(Boolean).join(' · ');
}

/**
 * A row's live status from `status.feeds`: RECORDING · 12.4 MB · 2 MIN AGO,
 * PAUSED, OFF, WAITING, QUOTA, ERROR · why; '' when the server says nothing.
 */
export function feedStatusText(feed, nowMs = Date.now()) {
  if (!feed || typeof feed !== 'object') return '';
  const state = text(feed.state).toLowerCase();
  if (!state) return '';
  const size = Number(feed.bytes) > 0 ? formatBytes(feed.bytes) : '';
  const ago = agoLabel(feed.lastAt, nowMs);
  switch (state) {
    case 'recording':
      return line(['RECORDING', size || '0 B', ago]);
    case 'static':
      // A one-off snapshot of a layer with no live feed.
      return line(['SNAPSHOT', size, ago]);
    case 'error':
      return line(['ERROR', shortError(feed.error)]);
    case 'paused':
    case 'off':
    case 'waiting':
    case 'quota':
    default:
      return stateLabel(state);
  }
}

/**
 * Which buttons each state allows. PAUSE becomes CONTINUE while paused;
 * a state the tab does not know yet (no answer) acts as idle.
 */
export function controlStates(state) {
  switch (state) {
    case 'initializing':
    case 'running':
      return {
        initialize: false,
        pause: true,
        pauseLabel: 'PAUSE',
        pauseAction: 'pause',
        stop: true,
        delete: false,
      };
    case 'paused':
      return {
        initialize: false,
        pause: true,
        pauseLabel: 'CONTINUE',
        pauseAction: 'continue',
        stop: true,
        delete: false,
      };
    case 'stopping':
      return {
        initialize: false,
        pause: false,
        pauseLabel: 'PAUSE',
        pauseAction: 'pause',
        stop: false,
        delete: false,
      };
    default:
      return {
        initialize: true,
        pause: false,
        pauseLabel: 'PAUSE',
        pauseAction: 'pause',
        stop: false,
        delete: true,
      };
  }
}

/** How long until the status is asked for again. */
export function pollDelay(state) {
  return AI_WORLD_ACTIVE_STATES.includes(state)
    ? AI_WORLD_POLL_ACTIVE_MS
    : AI_WORLD_POLL_IDLE_MS;
}

function stageState(stage) {
  return stateLabel(stage?.state || 'off');
}

function stageError(stage) {
  return stage?.error ? `ERROR ${shortError(stage.error)}` : '';
}

function formatLoss(value) {
  // No loss yet (null) is no loss shown, not 0.
  if (value === null || value === undefined || value === '') return '';
  const loss = Number(value);
  if (!Number.isFinite(loss)) return '';
  return Math.abs(loss) >= 100 ? loss.toFixed(0) : loss.toPrecision(3);
}

/** The keys of `stageLines`, in the order the STATUS list shows them. */
export const AI_WORLD_STAGE_KEYS = Object.freeze([
  'state',
  'recorder',
  'generator',
  'trainer',
  'predictor',
  'storage',
  'gaps',
  'compute',
]);

/**
 * The STATUS lines: the job's state, then each stage (recording, sim
 * episodes, training, predicting), storage against the cap, gaps and
 * compute. Without a status yet, each says it is waiting.
 * @param {object|null} status The server's `status`.
 * @param {number} [nowMs]
 * @returns {Record<string, string>}
 */
export function stageLines(status, nowMs = Date.now()) {
  if (!status || typeof status !== 'object') {
    return {
      state: 'STATE · WAITING FOR THE SERVER',
      recorder: 'RECORDING · OFF',
      generator: 'SIM EPISODES · OFF',
      trainer: 'TRAINING · OFF',
      predictor: 'PREDICTING · OFF',
      storage: 'STORAGE · NOTHING RECORDED',
      gaps: 'GAPS · NONE',
      compute: 'COMPUTE · WAITING FOR THE SERVER',
    };
  }
  const stages = status.stages || {};
  const recorder = stages.recorder || {};
  const generator = stages.generator || {};
  const trainer = stages.trainer || {};
  const predictor = stages.predictor || {};
  const storage = status.storage || {};
  const compute = status.compute || {};
  const gaps = Array.isArray(status.gaps) ? status.gaps : [];
  const since = agoLabel(status.since, nowMs);
  const used = Number(storage.usedBytes) || 0;
  const cap = Number(status.capBytes) || 0;
  const free = Number(storage.freeBytes) || 0;
  const domains = (Array.isArray(predictor.domains) ? predictor.domains : [])
    .map((domain) => stateLabel(domain))
    .join(', ');
  const lastGap = gaps.at(-1);
  const workers = Number(compute.workers) || 0;
  return {
    state: line([
      'STATE',
      stateLabel(status.state),
      since ? `CHANGED ${since}` : '',
    ]),
    recorder: line([
      'RECORDING',
      stageState(recorder),
      Number(recorder.feeds) > 0 ? countLabel(recorder.feeds, 'FEED') : '',
      Number(recorder.bytesPerDay) > 0
        ? `${formatBytes(recorder.bytesPerDay)} A DAY`
        : '',
      stageError(recorder),
    ]),
    generator: line([
      'SIM EPISODES',
      stageState(generator),
      Number(generator.total) > 0
        ? `${formatCount(generator.done)} / ${formatCount(generator.total)}`
        : '',
      Number(generator.episodes) > 0
        ? countLabel(generator.episodes, 'EPISODE')
        : '',
      durationLabel(generator.etaMs)
        ? `ETA ${durationLabel(generator.etaMs)}`
        : '',
      stageError(generator),
    ]),
    trainer: line([
      'TRAINING',
      stageState(trainer),
      // The model's id as written: it names its folder under ai-world/models.
      text(trainer.model),
      Number(trainer.epochs) > 0
        ? `EPOCH ${formatCount(trainer.epoch)} / ${formatCount(trainer.epochs)}`
        : '',
      formatLoss(trainer.loss) ? `LOSS ${formatLoss(trainer.loss)}` : '',
      formatSkill(trainer.skill),
      trainer.channelsGrown
        ? 'NEW CHANNELS: MODEL GROWN, WHAT IT KNEW KEPT'
        : trainer.channelMismatch
          ? 'NEW CHANNELS, NEW MODEL'
          : '',
      // What it waits for: BINNING 2026-09-13 · 29 DAYS LEFT, NEEDS 3 BINNED
      // DAYS · 1 SO FAR, TRIED AGAIN WHEN A NEW DAY IS BINNED.
      text(trainer.note),
      stageError(trainer),
    ]),
    predictor: line([
      'PREDICTING',
      stageState(predictor),
      domains,
      agoLabel(predictor.updatedAt, nowMs)
        ? `UPDATED ${agoLabel(predictor.updatedAt, nowMs)}`
        : '',
      stageError(predictor),
    ]),
    storage: line([
      'STORAGE',
      cap > 0
        ? `${formatBytes(used)} / ${formatBytes(cap)}`
        : `${formatBytes(used)} USED`,
      cap > 0 ? `${Math.min(100, Math.round((used / cap) * 100))}%` : '',
      free > 0 ? `${formatBytes(free)} FREE ON DISK` : '',
    ]),
    gaps: line([
      'GAPS',
      gaps.length ? formatCount(gaps.length) : 'NONE',
      lastGap?.reason ? `LAST ${stateLabel(lastGap.reason)}` : '',
    ]),
    compute: line([
      'COMPUTE',
      workers > 0
        ? `${formatCount(compute.busy)} / ${countLabel(workers, 'WORKER')} BUSY`
        : 'NO WORKERS',
      text(compute.gpu) ? `GPU ${text(compute.gpu)}` : 'NO GPU · CPU ONLY',
    ]),
  };
}

function dayCount(days) {
  if (!Number.isFinite(days) || days <= 0) return '';
  return days < 10 ? days.toFixed(1).replace(/\.0$/, '') : formatCount(days);
}

/**
 * What the estimate block says before INITIALIZE starts anything.
 * @param {object} estimate The server's `Estimate`.
 * @param {(id: string) => string} [labelFor] A row's label, for the heaviest feeds.
 * @returns {string[]}
 */
export function estimateLines(estimate, labelFor = (id) => stateLabel(id)) {
  if (!estimate || typeof estimate !== 'object') return [];
  const perDay = Number(estimate.bytesPerDay) || 0;
  const cap = Number(estimate.capBytes) || 0;
  let days = Number(estimate.daysToCap);
  if (!(days > 0) && perDay > 0 && cap > 0) days = cap / perDay;
  const feeds = (Array.isArray(estimate.feeds) ? estimate.feeds : [])
    .filter((feed) => text(feed?.id) && Number(feed.bytesPerDay) > 0)
    .sort((a, b) => Number(b.bytesPerDay) - Number(a.bytesPerDay));
  const lines = [
    perDay > 0
      ? `RECORDS ABOUT ${formatBytes(perDay)} A DAY`
      : 'RECORDS NOTHING LIVE: SNAPSHOTS AND SIM ONLY',
  ];
  const shownDays = perDay > 0 ? dayCount(days) : '';
  if (cap > 0)
    lines.push(
      shownDays
        ? `STORAGE CAP ${formatBytes(cap)} · FULL IN ABOUT ${shownDays} DAY${shownDays === '1' ? '' : 'S'}`
        : `STORAGE CAP ${formatBytes(cap)}`,
    );
  if (feeds.length)
    lines.push(
      `HEAVIEST · ${feeds
        .slice(0, 3)
        .map((feed) => `${labelFor(feed.id)} ${formatBytes(feed.bytesPerDay)}`)
        .join(' · ')}`,
    );
  const workers = Number(estimate.workers) || 0;
  lines.push(workers > 0 ? countLabel(workers, 'WORKER') : 'NO WORKERS');
  lines.push(
    text(estimate.gpu) ? `GPU ${text(estimate.gpu)}` : 'NO GPU · CPU ONLY',
  );
  return lines;
}

/**
 * What DELETE will remove, from the server's `DeletePreview`: one line per
 * group, the total, and the confirm button's label.
 */
export function deletePreviewView(preview) {
  const groups = (Array.isArray(preview?.groups) ? preview.groups : []).map(
    (group) =>
      line([
        stateLabel(group?.kind),
        text(group?.id),
        text(group?.path),
        countLabel(group?.files || 0, 'FILE'),
        formatBytes(group?.bytes),
      ]),
  );
  const files = Math.max(0, Math.round(Number(preview?.totalFiles) || 0));
  const bytes = Math.max(0, Number(preview?.totalBytes) || 0);
  const root = text(preview?.root);
  return {
    groups,
    files,
    bytes,
    total: line([
      'TOTAL',
      countLabel(files, 'FILE'),
      formatBytes(bytes),
      root ? `IN ${root}` : '',
    ]),
    confirm:
      files > 0
        ? `DELETE ${countLabel(files, 'FILE')} · ${formatBytes(bytes)}`
        : 'NOTHING TO DELETE',
    canDelete: files > 0 && Boolean(text(preview?.token)),
  };
}

/** What AREAS says with no area: the feeds that wait for one. */
export const AI_WORLD_NO_AREAS =
  'NO AREAS · CAMERAS, TRAFFIC, NEWS AND IMAGERY RECORD AROUND AN AREA';

/**
 * The AREAS rows from the server's `status.areas`: `{ key, name, where }`,
 * the name upper case and the point to three decimals. Entries without a key
 * or a finite point are left out.
 * @param {Array<{key?: string, name?: string, lat?: number, lon?: number}>} areas
 */
export function areaRows(areas) {
  const rows = [];
  for (const area of Array.isArray(areas) ? areas : []) {
    const key = text(area?.key);
    const lat = Number(area?.lat);
    const lon = Number(area?.lon);
    if (!key || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const point = `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
    const name = (text(area.name) || point).toUpperCase();
    // An area named by its point shows the point once.
    rows.push({ key, name, where: name === point ? '' : point });
  }
  return rows;
}

/**
 * A PREDICTIONS domain the predictor cannot draw yet: the days recorded so
 * far and, when more days are binned than recorded (backfilled history
 * counts for the world model too), the days binned. A bare number is the
 * recorded days.
 */
export function learningLabel(learning) {
  const object = learning && typeof learning === 'object';
  const days = Number(object ? learning.daysRecorded : learning);
  if (!Number.isFinite(days) || days < 0) return 'LEARNING';
  const parts = ['LEARNING', `${countLabel(Math.floor(days), 'DAY')} RECORDED`];
  const binned = object ? Number(learning.daysBinned) : NaN;
  if (Number.isFinite(binned) && binned > Math.floor(days))
    parts.push(`${countLabel(Math.floor(binned), 'DAY')} BINNED`);
  return parts.join(' · ');
}

/** A whole number within bounds, else the fallback. */
export function clampInt(value, min, max, fallback) {
  const number = Math.round(Number(value));
  if (value === '' || value === null || !Number.isFinite(number))
    return fallback;
  return Math.min(max, Math.max(min, number));
}

/** The PREDICTIONS choice as stored: known domains and a 1–168 h horizon. */
export function cleanPredictions(raw, allowed = null) {
  const known = allowed ? new Set(allowed) : DOMAIN_IDS;
  const domains = [];
  for (const id of Array.isArray(raw?.domains) ? raw.domains : [])
    if (
      known.has(id) &&
      id !== 'military' &&
      !String(id).startsWith('military-') &&
      !domains.includes(id)
    )
      domains.push(id);
  return {
    domains,
    horizonHours: clampInt(
      raw?.horizonHours,
      AI_WORLD_HORIZON_MIN,
      AI_WORLD_HORIZON_MAX,
      AI_WORLD_HORIZON_DEFAULT,
    ),
  };
}

/** A prediction row: READY or LEARNING, plus a held-out score when one exists. */
export function domainNote(ready, learning, skill) {
  const score = formatSkill(skill);
  return [ready ? 'READY' : learning, score].filter(Boolean).join(' · ');
}

/** The horizon's value label: 24 H. */
export function horizonLabel(hours) {
  return `${clampInt(hours, AI_WORLD_HORIZON_MIN, AI_WORLD_HORIZON_MAX, AI_WORLD_HORIZON_DEFAULT)} H`;
}

/** A predicted move as the MARKETS list shows it: `24 H ▲ 0.40%`. */
function moveText(value, horizonHours) {
  if (value === null || value === '' || value === undefined) return '';
  const pct = Number(value);
  if (!Number.isFinite(pct)) return '';
  const arrow = pct > 0 ? '▲' : pct < 0 ? '▼' : '■';
  return `${horizonLabel(horizonHours)} ${arrow} ${Math.abs(pct).toFixed(2)}%`;
}

/**
 * The MARKETS list: each live quote, with the world model's predicted move
 * beside it when there is one, then any asset predicted but not quoted
 * (a quote the server no longer has). A price is a readout, not advice.
 * @param {Array<object>} quotes The server's latest quotes.
 * @param {object|null} prediction GET /predict?domain=markets (its `assets`).
 * @param {number} horizonHours
 * @returns {string[]}
 */
export function marketLines(quotes, prediction, horizonHours) {
  const moves = new Map();
  const ready = prediction && !prediction.learning;
  for (const asset of ready && Array.isArray(prediction.assets)
    ? prediction.assets
    : [])
    if (typeof asset?.series === 'string') moves.set(asset.series, asset);
  const lines = [];
  const shown = new Set();
  for (const quote of Array.isArray(quotes) ? quotes : []) {
    if (typeof quote?.series !== 'string') continue;
    shown.add(quote.series);
    const label =
      quote.label || marketAsset(quote.series)?.label || quote.series;
    const source = quote.source ? ` · ${quote.source}` : '';
    const move = moveText(moves.get(quote.series)?.value, horizonHours);
    lines.push(
      `${label}: ${quote.value} ${quote.unit || ''}`.trim() +
        source +
        (move ? ` · ${move}` : ''),
    );
  }
  for (const [series, asset] of moves) {
    if (shown.has(series)) continue;
    const move = moveText(asset.value, horizonHours);
    if (!move) continue;
    lines.push(
      `${asset.label || marketAsset(series)?.label || series}: ${move}`,
    );
  }
  return lines;
}

/**
 * The POST-TRAIN line: the last run's held-out loss before and after, or
 * what is saved, or what the kit already does by itself.
 * @param {{adapter?: string, checkpoint?: string, daily?: boolean, last?: object|null}|null} posttrain
 */
export function postTrainNote(posttrain) {
  const own =
    "THE KIT'S OWN WORLD MODEL POST-TRAINS ITSELF EVERY DAY ON ALL RECORDED DAYS, AND GROWS WHEN A NEW LAYER OR ASSET ARRIVES.";
  if (!posttrain?.adapter) return own;
  const last = posttrain.last;
  const saved = `SAVED ${posttrain.adapter}${posttrain.daily ? ' · DAILY' : ''}`;
  if (!last) return `${saved} · NOT RUN YET`;
  // A blank score (null) is no score: Number(null) would read 0.
  const num = (v) =>
    v === null || v === undefined || v === '' ? NaN : Number(v);
  const before = num(last.before);
  const after = num(last.after);
  const score =
    Number.isFinite(before) && Number.isFinite(after)
      ? `HELD-OUT LOSS ${before.toFixed(3)} → ${after.toFixed(3)} · ${last.helped ? 'HELPED' : 'DID NOT HELP'}`
      : 'NO HELD-OUT SCORE';
  const through = last.trainedThrough
    ? ` · TRAINED THROUGH ${last.trainedThrough}`
    : '';
  return `${saved} · LAST: ${score}${through}`;
}
