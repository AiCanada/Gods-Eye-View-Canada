/**
 * GLOBAL ABUNDANCE MAP, a left-stack tab under AI DISTILLATION (owner
 * request 2026-10-22: "Global abundance grid, idea to replace resource
 * scarcity with algorithmic orchestration … display Global abundance on
 * MAP … by country/state/province/city, all or just selected indicators").
 *
 * LEVEL picks countries, states and provinces, or cities; INDICATORS ticks
 * the measures that make the abundance score (ALL, or any of them); SHOW ON
 * MAP colours the globe from scarce (red) to abundant (green); ABUNDANCE
 * GRID links every scarce place to its nearest abundant one, a first model
 * of the owner's orchestration layer. SELECTED reads the unit the pointer
 * rests on or clicked, figure by figure, with where each came from; RANKING
 * lists the most and least abundant; DATA shows the sources, REFRESH DATA
 * fetches them again, and LOAD CSV puts the owner's own figures on top.
 *
 * The figures come from the dev server's /api/abundance routes
 * (server/providers/abundance.js); the scores, colours, ranking and links
 * are worked out here (src/abundanceCore.mjs) and handed to the globe on
 * the `abundance:view` and `abundance:card` events (src/abundanceOverlay.js),
 * which answers with `abundance:pick`. The text is marked with tl() and
 * tln(); the choice is kept in this browser.
 */
import {
  ABUNDANCE_CARD_EVENT,
  ABUNDANCE_INDICATOR_IDS,
  ABUNDANCE_INDICATORS,
  ABUNDANCE_LEVEL_LABELS,
  ABUNDANCE_LEVELS,
  ABUNDANCE_PICK_EVENT,
  ABUNDANCE_VIEW_EVENT,
  abundanceLinks,
  cleanIndicatorIds,
  cleanLevel,
  expandTable,
  formatFigure,
  indicatorMeasure,
  rankUnits,
  scoreColor,
  scoreUnits,
} from './abundanceCore.mjs';
import { formatCount } from './aiWorldSelection.mjs';
import { localDigits, msgl, tl, tln } from './i18n/index.js';
import {
  isOwnerRemovalRefusal,
  noteOwnerRemovalRefusal,
  watchOwnerRemoval,
} from './ui/ownerRemoval.js';

export const ABUNDANCE_API = '/api/abundance';
/** The choice kept in this browser: level, indicators, show, grid. */
export const ABUNDANCE_CHOICE_KEY = 'gev:abundance:v1';
const POLL_BUSY_MS = 5_000;
const POLL_IDLE_MS = 120_000;
const NOTE_MS = 15_000;
const RANKING_ROWS = 10;
const GRID_ROWS = 12;
const LINKS_MAX = 60;

const FROM_WORDS = Object.freeze({
  own: '',
  csv: msgl('YOUR CSV'),
  region: msgl('FROM ITS STATE OR PROVINCE'),
  country: msgl('FROM ITS COUNTRY'),
});
const SOURCE_WORDS = Object.freeze({
  worldbank: msgl('WORLD BANK'),
  owid: msgl('OUR WORLD IN DATA'),
  oecd: msgl('OECD REGIONS AND CITIES'),
});
const upper = (v) => String(v ?? '').toUpperCase();
const digits = (n, decimals = 0) =>
  localDigits(
    Number.isFinite(Number(n)) ? Number(n).toFixed(decimals) : String(n ?? ''),
  );

/** The choice from storage, cleaned; the defaults without one. */
export function readChoice(raw) {
  let parsed = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  const indicators = Array.isArray(parsed?.indicators)
    ? cleanIndicatorIds(parsed.indicators)
    : [...ABUNDANCE_INDICATOR_IDS];
  return {
    level: cleanLevel(parsed?.level),
    indicators,
    show: parsed?.show !== false,
    grid: parsed?.grid === true,
  };
}

/** How long ago a time was, in the tab's words: JUST NOW, 5 MINUTES AGO, 2 HOURS AGO, 3 DAYS AGO. */
export function agoText(at, now = Date.now()) {
  const ms = Math.max(0, now - Number(at));
  if (ms < 60_000) return tl('JUST NOW');
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60)
    return tln(minutes, '{count} MINUTE AGO', '{count} MINUTES AGO', {
      count: formatCount(minutes),
    });
  const hours = Math.round(ms / 3_600_000);
  if (hours < 48)
    return tln(hours, '{count} HOUR AGO', '{count} HOURS AGO', {
      count: formatCount(hours),
    });
  const days = Math.round(ms / 86_400_000);
  return tln(days, '{count} DAY AGO', '{count} DAYS AGO', {
    count: formatCount(days),
  });
}

/** The tab's status line. */
export function statusText({
  level,
  table,
  status,
  loading,
  error,
  now = () => Date.now(),
}) {
  const levelName = tl(ABUNDANCE_LEVEL_LABELS[level] || upper(level));
  if (error) return `${levelName} · ${upper(error)}`;
  const busy = status?.refreshing || table?.refreshing;
  if (busy)
    return tl('FETCHING THE SOURCES · {done}/{total} · {current}', {
      done: formatCount(busy.done),
      total: formatCount(busy.total),
      current: busy.current || '',
    });
  if (loading || !table) return tl('LOADING {level}…', { level: levelName });
  const scored = table.scored ?? 0;
  if (!scored)
    return tl('{level} · NO FIGURES YET: PRESS REFRESH DATA', {
      level: levelName,
    });
  const parts = [
    levelName,
    tln(scored, '{count} PLACE WITH FIGURES', '{count} PLACES WITH FIGURES', {
      count: formatCount(scored),
    }),
  ];
  if (table.newestYear)
    parts.push(
      tl('DATA TO {year}', { year: localDigits(String(table.newestYear)) }),
    );
  if (table.refreshedAt)
    parts.push(
      tl('FETCHED {when}', { when: agoText(table.refreshedAt, now()) }),
    );
  return parts.join(' · ');
}

/** An indicator row's coverage: how many places have their own figure, how many take the one above. */
export function coverageText(cover, level) {
  if (!cover) return '';
  const parts = [
    tln(cover.own, '{count} OWN FIGURE', '{count} OWN FIGURES', {
      count: formatCount(cover.own),
    }),
  ];
  if (cover.inherited)
    parts.push(
      level === 'city'
        ? tl('{count} FROM THEIR STATE OR COUNTRY', {
            count: formatCount(cover.inherited),
          })
        : tl('{count} FROM THEIR COUNTRY', {
            count: formatCount(cover.inherited),
          }),
    );
  if (cover.year) parts.push(localDigits(String(cover.year)));
  return parts.join(' · ');
}

/** The score line of a unit. */
export function scoreText(score) {
  if (!score || !Number.isFinite(score.score))
    return tl('NO FIGURES FOR THE CHOSEN INDICATORS');
  return tl('ABUNDANCE {score} OF 100 · {n} OF {of} INDICATORS', {
    score: digits(score.score, 0),
    n: formatCount(score.counted),
    of: formatCount(score.of),
  });
}

/** One figure's line: the indicator, its value, its year, its place, and where it came from. */
export function figureText(indicator, figure, rank, level) {
  const parts = [tl(indicator.label)];
  const value = localDigits(formatFigure(indicator, figure.v));
  parts.push(
    indicator.unit === '$'
      ? `${value} $`
      : indicator.unit === '%'
        ? `${value} %`
        : indicator.unit
          ? `${value} ${tl(indicator.unit)}`
          : value,
  );
  if (Number.isFinite(figure.year))
    parts.push(localDigits(String(figure.year)));
  if (Number.isFinite(rank))
    parts.push(tl('PLACE {n} OF 100', { n: digits(rank, 0) }));
  const from = FROM_WORDS[figure.from];
  if (from) parts.push(tl(from));
  parts.push(
    tl(indicatorMeasure(indicator, figure.from === 'own' ? level : 'country')),
  );
  return parts.join(' · ');
}

/** The selected unit's lines, for SELECTED and for its card on the globe. */
export function unitLines(unit, score, indicatorIds, level) {
  if (!unit) return [];
  const lines = [];
  if (unit.country && unit.country !== unit.name) {
    const where = [unit.adm1, unit.country].filter(Boolean).join(', ');
    lines.push(where);
  }
  if (Number.isFinite(unit.pop) && unit.pop > 0)
    lines.push(tl('POPULATION {n}', { n: formatCount(unit.pop) }));
  lines.push(scoreText(score));
  for (const id of cleanIndicatorIds(indicatorIds)) {
    const figure = unit.values?.[id];
    const indicator = ABUNDANCE_INDICATORS.find((i) => i.id === id);
    if (!figure || !indicator) continue;
    lines.push(figureText(indicator, figure, score?.ranks?.[id], level));
  }
  return lines;
}

/** A grid link's line: the abundant place that answers a scarce one. */
export function linkText(link, byId) {
  const from = byId.get(link.from)?.name || link.from;
  const to = byId.get(link.to)?.name || link.to;
  return tl('{from} → {to} · GAP {gap} · {km} KM', {
    from,
    to,
    gap: digits(link.gap, 0),
    km: formatCount(link.km),
  });
}

/** The DATA lines: each source family, its series, when it was fetched, what failed. */
export function sourceLines(status, now = () => Date.now()) {
  const groups = new Map();
  for (const s of status?.sources || []) {
    const g = groups.get(s.kind) || { n: 0, at: 0, failed: 0 };
    g.n += 1;
    if (s.fetchedAt > g.at) g.at = s.fetchedAt;
    if (s.error) g.failed += 1;
    groups.set(s.kind, g);
  }
  const lines = [];
  for (const [kind, g] of groups) {
    const parts = [
      tl(SOURCE_WORDS[kind] || upper(kind)),
      tln(g.n, '{count} SERIES', '{count} SERIES', { count: formatCount(g.n) }),
      g.at ? agoText(g.at, now()) : tl('NOT FETCHED YET'),
    ];
    if (g.failed)
      parts.push(
        tln(g.failed, '{count} SOURCE FAILED', '{count} SOURCES FAILED', {
          count: formatCount(g.failed),
        }),
      );
    lines.push(parts.join(' · '));
  }
  return lines;
}

/** The owner's CSV line for a level. */
export function importText(imported) {
  if (!imported) return '';
  const parts = [
    tl('YOUR CSV'),
    tln(imported.rows, '{count} ROW', '{count} ROWS', {
      count: formatCount(imported.rows),
    }),
    tl('{n} MATCHED', { n: formatCount(imported.matched) }),
  ];
  if (imported.ignored?.length)
    parts.push(
      tl('COLUMNS NOT USED: {columns}', {
        columns: imported.ignored.join(', '),
      }),
    );
  if (imported.error) parts.push(upper(imported.error));
  return parts.join(' · ');
}

function element(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(doc, text, action, title) {
  const node = element(doc, 'button', 'scene-btn', text);
  node.type = 'button';
  node.dataset.action = action;
  if (title) node.title = title;
  return node;
}

function tick(doc, text, className) {
  const label = element(
    doc,
    'label',
    `outbreak-mode ${className || ''}`.trim(),
  );
  const box = element(doc, 'input');
  box.type = 'checkbox';
  const swatch = element(doc, 'span', 'outbreak-swatch');
  const name = element(doc, 'span', 'abundance-name', text);
  label.append(box, swatch, name);
  return { label, box, name };
}

function fillList(doc, ul, lines, onClick) {
  ul.textContent = '';
  for (const line of lines) {
    const li = element(
      doc,
      'li',
      '',
      typeof line === 'string' ? line : line.text,
    );
    if (onClick && typeof line === 'object' && line.id) {
      li.dataset.unit = line.id;
      li.tabIndex = 0;
      li.setAttribute('role', 'button');
      li.addEventListener('click', () => onClick(line.id));
    }
    ul.append(li);
  }
  ul.hidden = lines.length === 0;
}

/**
 * Mount the tab on #abundance-panel.
 * @param {{documentRef?: Document, fetchImpl?: typeof fetch, signal?: AbortSignal, timers?: object, now?: () => number, storage?: Storage|null, readFile?: (file: File) => Promise<string>}} options
 */
export function initAbundancePanel({
  documentRef = globalThis.document,
  fetchImpl,
  signal,
  timers = {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id) => globalThis.clearTimeout(id),
  },
  now = () => Date.now(),
  storage = (() => {
    try {
      return globalThis.localStorage ?? null;
    } catch {
      return null;
    }
  })(),
  readFile = (file) => file.text(),
} = {}) {
  const doc = documentRef;
  const host = doc?.getElementById?.('abundance-body');
  const line = doc?.getElementById?.('abundance-status');
  if (!host || !doc?.createElement)
    return { refresh() {}, render() {}, destroy() {} };
  const doFetch = fetchImpl || ((...args) => globalThis.fetch(...args));
  const lifetime = new AbortController();
  if (signal) {
    if (signal.aborted) lifetime.abort();
    else
      signal.addEventListener('abort', () => lifetime.abort(), { once: true });
  }
  let stored = null;
  try {
    stored = storage?.getItem?.(ABUNDANCE_CHOICE_KEY) ?? null;
  } catch {
    stored = null;
  }
  const choice = readChoice(stored);
  /** The levels fetched: level → { units, byId, coverage, refreshedAt, refreshing, imported, scored, newestYear }. */
  const tables = new Map();
  let status = null;
  let loading = false;
  let error = null;
  let note = null;
  let pollTimer = null;
  let rankingSide = 'top';
  let pinnedId = null;
  let hoverId = null;
  let scores = new Map();
  let links = [];
  let ranking = [];

  const say = (text) => {
    note = { text: String(text), until: now() + NOTE_MS };
  };

  const keepChoice = () => {
    try {
      storage?.setItem?.(ABUNDANCE_CHOICE_KEY, JSON.stringify(choice));
    } catch {
      /* a per-viewer convenience only */
    }
  };

  const call = async (route, { method = 'GET', body } = {}) => {
    const request = doFetch(`${ABUNDANCE_API}/${route}`, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: lifetime.signal,
    });
    const response = await (method === 'DELETE'
      ? watchOwnerRemoval(request)
      : request);
    const payload = await response.json().catch(() => ({}));
    if (isOwnerRemovalRefusal(response, payload)) {
      // Only the PC removes: nothing changes, and nothing is said.
      noteOwnerRemovalRefusal();
      return null;
    }
    if (!response.ok)
      throw new Error(payload.error || `HTTP ${response.status}`);
    return payload;
  };

  // --- The frame, built once ---------------------------------------------------------
  const ui = {};
  const top = element(doc, 'div', 'abundance-controls cctv-controls');
  ui.level = element(doc, 'select');
  ui.level.setAttribute('aria-label', tl('Level'));
  for (const level of ABUNDANCE_LEVELS) {
    const option = element(
      doc,
      'option',
      '',
      tl(ABUNDANCE_LEVEL_LABELS[level]),
    );
    option.value = level;
    ui.level.append(option);
  }
  ui.level.value = choice.level;
  ui.level.addEventListener('change', () => {
    choice.level = cleanLevel(ui.level.value);
    pinnedId = null;
    hoverId = null;
    keepChoice();
    void loadLevel(choice.level);
  });
  top.append(ui.level);
  const show = tick(doc, tl('SHOW ON MAP'), 'abundance-all');
  ui.show = show.box;
  ui.show.checked = choice.show;
  ui.show.addEventListener('change', () => {
    choice.show = Boolean(ui.show.checked);
    keepChoice();
    publish();
  });
  const grid = tick(doc, tl('ABUNDANCE GRID'), 'abundance-all');
  ui.grid = grid.box;
  ui.grid.checked = choice.grid;
  ui.grid.title = tl('Links every scarce place to its nearest abundant one');
  ui.grid.addEventListener('change', () => {
    choice.grid = Boolean(ui.grid.checked);
    keepChoice();
    compute();
    render();
    publish();
  });
  host.append(top, show.label, grid.label);

  host.append(element(doc, 'div', 'abundance-label', tl('INDICATORS')));
  const all = tick(doc, tl('ALL'), 'abundance-all');
  ui.all = all.box;
  ui.all.addEventListener('change', () => {
    choice.indicators = ui.all.checked ? [...ABUNDANCE_INDICATOR_IDS] : [];
    keepChoice();
    compute();
    render();
    publish();
  });
  host.append(all.label);
  ui.rows = new Map();
  const rows = element(doc, 'ul', 'abundance-list abundance-indicators');
  rows.setAttribute('aria-label', tl('Indicators of abundance'));
  for (const indicator of ABUNDANCE_INDICATORS) {
    const li = element(doc, 'li', 'abundance-row');
    li.dataset.indicator = indicator.id;
    const row = tick(doc, tl(indicator.label), '');
    row.box.dataset.indicator = indicator.id;
    row.box.addEventListener('change', () => {
      const set = new Set(choice.indicators);
      if (row.box.checked) set.add(indicator.id);
      else set.delete(indicator.id);
      choice.indicators = cleanIndicatorIds([...set]);
      keepChoice();
      compute();
      render();
      publish();
    });
    const measure = element(doc, 'span', 'abundance-measure');
    const cover = element(doc, 'span', 'abundance-cover');
    li.append(row.label, measure, cover);
    rows.append(li);
    ui.rows.set(indicator.id, { box: row.box, measure, cover });
  }
  host.append(rows);

  const legend = element(doc, 'div', 'abundance-legend');
  legend.append(
    element(doc, 'span', 'abundance-legend-word', tl('SCARCE')),
    element(doc, 'span', 'abundance-legend-bar'),
    element(doc, 'span', 'abundance-legend-word', tl('ABUNDANT')),
  );
  host.append(legend);
  host.append(
    element(
      doc,
      'p',
      'abundance-note',
      tl(
        'The score is the mean place of a unit among the others, 0 to 100, over the ticked indicators it has a figure for.',
      ),
    ),
  );

  host.append(element(doc, 'div', 'abundance-label', tl('SELECTED')));
  ui.selectedNote = element(
    doc,
    'p',
    'abundance-note',
    tl('Rest the pointer on a place on the map, or click it to keep it here.'),
  );
  host.append(ui.selectedNote);
  ui.selectedName = element(doc, 'div', 'abundance-selected-name');
  ui.selected = element(doc, 'ul', 'abundance-list abundance-selected');
  ui.selected.setAttribute('aria-label', tl('The selected place'));
  ui.clear = button(doc, tl('CLEAR'), 'clear');
  ui.clear.addEventListener('click', () => {
    pinnedId = null;
    render();
    publishCard();
  });
  host.append(ui.selectedName, ui.selected, ui.clear);

  host.append(element(doc, 'div', 'abundance-label', tl('RANKING')));
  const sides = element(doc, 'div', 'cctv-controls abundance-actions');
  ui.top = button(doc, tl('MOST ABUNDANT'), 'ranking-top');
  ui.bottom = button(doc, tl('LEAST ABUNDANT'), 'ranking-bottom');
  ui.top.addEventListener('click', () => {
    rankingSide = 'top';
    render();
  });
  ui.bottom.addEventListener('click', () => {
    rankingSide = 'bottom';
    render();
  });
  sides.append(ui.top, ui.bottom);
  ui.ranking = element(doc, 'ul', 'abundance-list abundance-ranking');
  ui.ranking.setAttribute('aria-label', tl('Ranking'));
  host.append(sides, ui.ranking);

  ui.gridLabel = element(doc, 'div', 'abundance-label', tl('ABUNDANCE GRID'));
  ui.gridNote = element(
    doc,
    'p',
    'abundance-note',
    tl(
      'A first model of the orchestration layer: every scarce place (a score of 25 or under) is linked to its nearest abundant one (75 or over), the scarcest first.',
    ),
  );
  ui.links = element(doc, 'ul', 'abundance-list abundance-links');
  ui.links.setAttribute('aria-label', tl('Grid links'));
  host.append(ui.gridLabel, ui.gridNote, ui.links);

  host.append(element(doc, 'div', 'abundance-label', tl('DATA')));
  ui.sources = element(doc, 'ul', 'abundance-list abundance-sources');
  ui.sources.setAttribute('aria-label', tl('Data sources'));
  ui.imported = element(doc, 'p', 'abundance-note');
  const actions = element(doc, 'div', 'cctv-controls abundance-actions');
  ui.refresh = button(
    doc,
    tl('REFRESH DATA'),
    'refresh',
    tl('Fetches every source again; the tab keeps working meanwhile'),
  );
  ui.refresh.addEventListener(
    'click',
    () => void act('refresh', { force: true }),
  );
  ui.file = element(doc, 'input');
  ui.file.type = 'file';
  ui.file.accept = '.csv,text/csv';
  ui.file.hidden = true;
  ui.file.setAttribute('aria-label', tl('CSV file of your own figures'));
  ui.file.addEventListener('change', () => void importFile());
  ui.load = button(
    doc,
    tl('LOAD CSV'),
    'load-csv',
    tl(
      'Your own figures for this level: an id or name column, an optional year, then one column per indicator',
    ),
  );
  ui.load.addEventListener('click', () => ui.file.click?.());
  ui.clearCsv = button(doc, tl('CLEAR CSV'), 'clear-csv');
  ui.clearCsv.addEventListener(
    'click',
    () => void act('import', { level: choice.level }, 'DELETE'),
  );
  actions.append(ui.refresh, ui.load, ui.clearCsv, ui.file);
  host.append(ui.sources, ui.imported, actions);
  host.hidden = false;

  // --- Data ----------------------------------------------------------------------
  const table = () => tables.get(choice.level) || null;

  const loadLevel = async (level) => {
    loading = true;
    error = null;
    render();
    try {
      const payload = await call(`data?level=${encodeURIComponent(level)}`);
      if (lifetime.signal.aborted || !payload) return;
      const units = expandTable(payload);
      let newestYear = null;
      for (const c of Object.values(payload.coverage || {}))
        if (
          Number.isFinite(c?.year) &&
          (newestYear === null || c.year > newestYear)
        )
          newestYear = c.year;
      tables.set(level, {
        units,
        byId: new Map(units.map((u) => [u.id, u])),
        coverage: payload.coverage || {},
        refreshedAt: payload.refreshedAt || null,
        refreshing: payload.refreshing || null,
        imported: payload.imported || null,
        newestYear,
        scored: 0,
      });
      if (payload.refreshing) schedulePoll(POLL_BUSY_MS);
    } catch (err) {
      if (lifetime.signal.aborted) return;
      error = err?.message || String(err);
    } finally {
      loading = false;
    }
    if (level === choice.level) {
      compute();
      render();
      publish();
    }
  };

  const compute = () => {
    const t = table();
    if (!t) {
      scores = new Map();
      links = [];
      ranking = [];
      return;
    }
    scores = scoreUnits(t.units, choice.indicators);
    ranking = rankUnits(t.units, scores);
    t.scored = ranking.length;
    links = choice.grid
      ? abundanceLinks(t.units, scores, { max: LINKS_MAX })
      : [];
  };

  const selectedUnit = () => {
    const t = table();
    if (!t) return null;
    return (
      (hoverId && t.byId.get(hoverId)) ||
      (pinnedId && t.byId.get(pinnedId)) ||
      null
    );
  };

  const cardFor = (unit) => {
    if (!unit || !Number.isFinite(unit.lat) || !Number.isFinite(unit.lon))
      return null;
    const score = scores.get(unit.id);
    return {
      id: unit.id,
      lat: unit.lat,
      lon: unit.lon,
      title: unit.name,
      details: unitLines(unit, score, choice.indicators, choice.level),
      accent: scoreColor(score?.score),
    };
  };

  const publish = () => {
    const t = table();
    const byId = t?.byId || new Map();
    const detail = {
      level: choice.level,
      show: choice.show,
      units: (t?.units || []).map((u) => {
        const s = scores.get(u.id);
        return {
          id: u.id,
          score: s?.score ?? null,
          color: scoreColor(s?.score),
        };
      }),
      links: links.map((l) => {
        const from = byId.get(l.from);
        const to = byId.get(l.to);
        return {
          from: { id: l.from, lat: from?.lat, lon: from?.lon },
          to: { id: l.to, lat: to?.lat, lon: to?.lon },
          gap: l.gap,
          km: l.km,
        };
      }),
      selected: pinnedId,
      card: cardFor(pinnedId ? byId.get(pinnedId) : null),
    };
    doc.dispatchEvent?.(new CustomEvent(ABUNDANCE_VIEW_EVENT, { detail }));
  };

  const publishCard = () => {
    const t = table();
    const unit = pinnedId ? t?.byId.get(pinnedId) : null;
    doc.dispatchEvent?.(
      new CustomEvent(ABUNDANCE_CARD_EVENT, {
        detail: { selected: pinnedId, card: cardFor(unit) },
      }),
    );
  };

  const act = async (route, body = {}, method = 'POST') => {
    try {
      const next = await call(route, { method, body });
      if (next === null) return null;
      note = null;
      if (next?.status) status = next.status;
      else if (next?.sources) status = next;
      if (route === 'import') {
        tables.delete(choice.level);
        if (next?.imported) say(importText(next.imported));
        await loadLevel(choice.level);
      } else {
        schedulePoll(POLL_BUSY_MS);
        render();
      }
      return next;
    } catch (err) {
      if (lifetime.signal.aborted) return null;
      say(err?.message || err);
      render();
      return null;
    }
  };

  const importFile = async () => {
    const file = ui.file.files?.[0];
    if (!file) return;
    let csv = '';
    try {
      csv = await readFile(file);
    } catch (err) {
      say(err?.message || err);
      render();
      return;
    }
    ui.file.value = '';
    await act('import', { level: choice.level, csv });
  };

  const pollStatus = async () => {
    try {
      const next = await call('status');
      if (lifetime.signal.aborted || !next) return;
      const wasBusy = Boolean(status?.refreshing);
      const refreshedBefore = status?.refreshedAt || null;
      status = next;
      const busy = Boolean(next.refreshing);
      if (
        (wasBusy && !busy) ||
        (refreshedBefore && next.refreshedAt !== refreshedBefore)
      ) {
        tables.clear();
        await loadLevel(choice.level);
      } else render();
      schedulePoll(busy ? POLL_BUSY_MS : POLL_IDLE_MS);
    } catch (err) {
      if (lifetime.signal.aborted) return;
      error = err?.message || String(err);
      render();
      schedulePoll(POLL_IDLE_MS);
    }
  };

  const schedulePoll = (ms) => {
    timers.clearTimeout(pollTimer);
    if (lifetime.signal.aborted) return;
    pollTimer = timers.setTimeout(() => void pollStatus(), ms);
  };

  // --- Rendering --------------------------------------------------------------------
  const render = () => {
    const t = table();
    if (line) {
      const current = note && note.until > now() ? note.text : null;
      line.textContent =
        current ||
        statusText({
          level: choice.level,
          table: t,
          status,
          loading,
          error,
          now,
        });
      line.dataset.state = error ? 'error' : loading ? 'busy' : 'ok';
    }
    const chosen = new Set(choice.indicators);
    const allOn = chosen.size === ABUNDANCE_INDICATOR_IDS.length;
    if (ui.all.checked !== allOn) ui.all.checked = allOn;
    const mixed = chosen.size > 0 && !allOn;
    if (ui.all.indeterminate !== mixed) ui.all.indeterminate = mixed;
    for (const indicator of ABUNDANCE_INDICATORS) {
      const row = ui.rows.get(indicator.id);
      const on = chosen.has(indicator.id);
      if (row.box.checked !== on) row.box.checked = on;
      row.measure.textContent = tl(indicatorMeasure(indicator, choice.level));
      row.cover.textContent = coverageText(
        t?.coverage?.[indicator.id],
        choice.level,
      );
    }
    const unit = selectedUnit();
    ui.selectedNote.hidden = Boolean(unit);
    ui.selectedName.textContent = unit ? unit.name : '';
    ui.selectedName.hidden = !unit;
    fillList(
      doc,
      ui.selected,
      unit
        ? unitLines(unit, scores.get(unit.id), choice.indicators, choice.level)
        : [],
    );
    ui.clear.hidden = !pinnedId;
    ui.top.disabled = rankingSide === 'top';
    ui.bottom.disabled = rankingSide === 'bottom';
    const side =
      rankingSide === 'top'
        ? ranking.slice(0, RANKING_ROWS)
        : ranking.slice(-RANKING_ROWS).reverse();
    fillList(
      doc,
      ui.ranking,
      side.map((r, k) => ({
        id: r.id,
        text: `${localDigits(String(rankingSide === 'top' ? k + 1 : ranking.length - k))}. ${r.name} · ${digits(r.score, 0)}`,
      })),
      (id) => {
        pinnedId = pinnedId === id ? null : id;
        render();
        publishCard();
      },
    );
    ui.gridLabel.hidden = !choice.grid;
    ui.gridNote.hidden = !choice.grid;
    const byId = t?.byId || new Map();
    fillList(
      doc,
      ui.links,
      choice.grid
        ? links.slice(0, GRID_ROWS).map((l) => linkText(l, byId))
        : [],
    );
    fillList(doc, ui.sources, sourceLines(status, now));
    ui.imported.textContent = importText(t?.imported);
    ui.imported.hidden = !t?.imported;
    ui.clearCsv.hidden = !t?.imported;
    ui.refresh.disabled = Boolean(status?.refreshing);
  };

  const onPick = (event) => {
    const detail = event?.detail || {};
    if (detail.level && detail.level !== choice.level) return;
    const id = typeof detail.id === 'string' ? detail.id : null;
    if (detail.hover) {
      if (id === hoverId) return;
      hoverId = id;
      render();
      return;
    }
    if (!id) return;
    pinnedId = pinnedId === id ? null : id;
    hoverId = null;
    render();
    publishCard();
  };
  doc.addEventListener?.(ABUNDANCE_PICK_EVENT, onPick);

  render();
  void loadLevel(choice.level);
  void pollStatus();

  const destroy = () => {
    lifetime.abort();
    timers.clearTimeout(pollTimer);
    doc.removeEventListener?.(ABUNDANCE_PICK_EVENT, onPick);
    doc.dispatchEvent?.(
      new CustomEvent(ABUNDANCE_VIEW_EVENT, {
        detail: { level: choice.level, show: false, units: [], links: [] },
      }),
    );
  };
  signal?.addEventListener?.('abort', destroy, { once: true });
  return {
    refresh: () => loadLevel(choice.level),
    render,
    destroy,
    get choice() {
      return { ...choice, indicators: [...choice.indicators] };
    },
    get selected() {
      return pinnedId;
    },
  };
}
