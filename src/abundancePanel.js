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
 * FORECAST (owner request 2026-11-07: "create monte Carlo simulator for
 * future abundance (0-100 years), use fine grain detail and display on
 * map"): YEARS AHEAD slides the map 1 to 100 years out, PLAY runs the years;
 * every figure walks forward from its own history on hundreds of runs
 * (src/abundanceForecast.mjs, in a worker: src/abundanceForecastRun.js), and
 * the map shows the TYPICAL OUTCOME, the bad or good case, the CHANCE OF
 * ABUNDANCE or SCARCITY, or the CHANGE FROM TODAY; SELECTED reads a place's
 * band, chances, rank and each indicator's projection, with its fan chart,
 * and MODEL says what each figure's history gave the walk.
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
  WEIGHT_MAX,
  WEIGHT_MIN,
  WEIGHT_STEP,
  abundanceLinks,
  cleanIndicatorIds,
  cleanLevel,
  cleanWeights,
  expandTable,
  formatFigure,
  indicatorById,
  indicatorMeasure,
  indicatorStats,
  rankUnits,
  scoreColor,
  scoreUnits,
} from './abundanceCore.mjs';
import {
  FORECAST_FAMILY_LABELS,
  FORECAST_RUNS,
  FORECAST_SCALES,
  FORECAST_SCALE_LABELS,
  FORECAST_SCENARIOS,
  FORECAST_SCENARIO_LABELS,
  FORECAST_VIEWS,
  FORECAST_VIEW_LABELS,
  FORECAST_YEARS,
  cleanForecastView,
  cleanRuns,
  cleanScale,
  cleanScenario,
  cleanYear,
  forecastAt,
  hindcastScales,
  hindcastShifts,
  runsFor,
  viewRampScore,
  viewValue,
  worldAt,
} from './abundanceForecast.mjs';
import { createForecastRunner } from './abundanceForecastRun.js';
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
/** How long a level's figures, and the status poll, may take before they count as no answer. */
const LOAD_TIMEOUT_MS = 60_000;
const STATUS_TIMEOUT_MS = 20_000;
/**
 * After a load that got no answer (the dev server restarting for an edit,
 * the tailnet link down), the waits before the next tries, the last repeated:
 * a request that failed once used to leave its error on the line until the
 * level was changed or the page reloaded (owner report 2026-10-30, "STATES
 * AND PROVINCES · FAILED TO FETCH").
 */
export const RETRY_DELAYS_MS = Object.freeze([
  5_000, 10_000, 20_000, 40_000, 60_000,
]);
/** PLAY advances a year this often: the century in twenty seconds. */
export const PLAY_STEP_MS = 200;
/** A change to the ticks, weights, runs or crises waits this long for the next before the simulation runs. */
const FORECAST_DEBOUNCE_MS = 300;
/** Places whose detail is kept for the current run. */
const DETAILS_KEPT = 400;
/** The fan chart's size, in CSS pixels. */
const FAN_WIDTH = 240;
const FAN_HEIGHT = 72;

const FROM_WORDS = Object.freeze({
  own: '',
  csv: msgl('YOUR CSV'),
  region: msgl('FROM ITS STATE OR PROVINCE'),
  country: msgl('FROM ITS COUNTRY'),
  area: msgl('FROM ITS LARGER REGION'),
});
const SOURCE_WORDS = Object.freeze({
  worldbank: msgl('WORLD BANK'),
  owid: msgl('OUR WORLD IN DATA'),
  oecd: msgl('OECD REGIONS AND CITIES'),
});
const upper = (v) => String(v ?? '').toUpperCase();
/**
 * An indicator's name in the active language. UTILITIES (electricity and
 * water) shares its English with upstream's tools panel (#1469), so it reads
 * its own "abundance|UTILITIES" entry rather than the panel's.
 */
const indicatorLabel = (indicator) =>
  indicator.label === 'UTILITIES'
    ? tl('UTILITIES', { context: 'abundance' })
    : tl(indicator.label);
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
    weights: cleanWeights(parsed?.weights),
    // The forecast: the years ahead (0 is today), what the map shows for a
    // future year, the runs (null: the level's default) and whether crises
    // are in the runs.
    year: cleanYear(parsed?.year),
    view: cleanForecastView(parsed?.view),
    runs: cleanRuns(parsed?.runs),
    crises: parsed?.crises !== false,
    scale: cleanScale(parsed?.scale),
    scenario: cleanScenario(parsed?.scenario),
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

/**
 * What went wrong with a request, in the tab's words. The browser's own
 * wording for a connection that was never made ("Failed to fetch", "Load
 * failed", "NetworkError…") tells a reader nothing; a request that ran out
 * of time and an answer that is not the server's JSON (the page itself,
 * while the dev server restarts) are named too. Anything else is the server's
 * own message.
 */
export function failureText(err) {
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError')
    return tl('THE SERVER TOOK TOO LONG TO ANSWER');
  if (err?.kind === 'not-json')
    return tl('THE SERVER ANSWERED WITH SOMETHING OTHER THAN ITS FIGURES');
  const message = String(err?.message || err || '');
  if (
    err instanceof TypeError ||
    /failed to fetch|networkerror|load failed|network request failed/i.test(
      message,
    )
  )
    return tl('NO ANSWER FROM THE SERVER');
  return upper(message);
}

/**
 * The tab's status line. `error` is the server's message as text, or
 * `{ problem, retryInMs }` from a load that will be tried again.
 */
export function statusText({
  level,
  table,
  status,
  loading,
  error,
  now = () => Date.now(),
}) {
  const levelName = tl(ABUNDANCE_LEVEL_LABELS[level] || upper(level));
  if (error) {
    const problem = typeof error === 'string' ? upper(error) : error.problem;
    const again = error?.retryInMs
      ? tl('TRYING AGAIN IN {seconds} S', {
          seconds: localDigits(String(Math.round(error.retryInMs / 1000))),
        })
      : '';
    return [levelName, problem, again].filter(Boolean).join(' · ');
  }
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
  if (cover.area)
    parts.push(
      tl('{count} FROM THEIR LARGER REGION', {
        count: formatCount(cover.area),
      }),
    );
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
/** A figure with its unit: a symbol ($, %, µg/m³) as it is, a word (YEARS) translated. */
export function valueWithUnit(indicator, value) {
  const text = localDigits(formatFigure(indicator, value));
  if (!text || !indicator?.unit) return text;
  return /[A-Z]/.test(indicator.unit)
    ? `${text} ${tl(indicator.unit)}`
    : `${text} ${indicator.unit}`;
}

/** The change of a figure since an earlier year: ▲ +2.1 SINCE 2019. */
export function trendText(indicator, figure) {
  const d = Number(figure?.d);
  if (!Number.isFinite(d) || !Number.isFinite(figure?.y0)) return '';
  // The arrow follows the change as shown: one that rounds to nothing is ■ 0.
  const decimals = Number.isFinite(indicator?.decimals)
    ? indicator.decimals
    : 1;
  const shown = Number(d.toFixed(decimals));
  const arrow = shown > 0 ? '▲' : shown < 0 ? '▼' : '■';
  const change = `${shown > 0 ? '+' : ''}${localDigits(formatFigure(indicator, shown))}`;
  return `${arrow} ${tl('{change} SINCE {year}', {
    change,
    year: localDigits(String(figure.y0)),
  })}`;
}

/**
 * What the legend's ends and middle read when one indicator is ticked: the
 * figure behind red (the scarce end), amber (the median) and green, in the
 * indicator's units; null with no figures.
 */
export function legendValues(units, indicator) {
  const stats = indicatorStats(units, indicator);
  if (!stats || !indicator) return null;
  const scarce = indicator.better === 'low' ? stats.max : stats.min;
  const abundant = indicator.better === 'low' ? stats.min : stats.max;
  return {
    low: valueWithUnit(indicator, scarce),
    mid: valueWithUnit(indicator, stats.median),
    high: valueWithUnit(indicator, abundant),
  };
}

/** The legend's ends and middle when more than one indicator is ticked: the score, 0, 50 and 100. */
export function scoreLegend() {
  return {
    low: localDigits(String(0)),
    mid: localDigits(String(50)),
    high: localDigits(String(100)),
  };
}

export function figureText(indicator, figure, rank, level) {
  const parts = [indicatorLabel(indicator), valueWithUnit(indicator, figure.v)];
  if (Number.isFinite(figure.year))
    parts.push(localDigits(String(figure.year)));
  const trend = trendText(indicator, figure);
  if (trend) parts.push(trend);
  if (Number.isFinite(rank))
    parts.push(tl('PLACE {n} OF 100', { n: digits(rank, 0) }));
  const from = FROM_WORDS[figure.from];
  if (from) parts.push(tl(from));
  // The measure of where the figure was taken: the place's own level, a
  // state's or a larger region's (the OECD's regional one), or the country's.
  const measuredAt =
    figure.from === 'own'
      ? level
      : figure.from === 'region' || figure.from === 'area'
        ? 'region'
        : 'country';
  parts.push(tl(indicatorMeasure(indicator, measuredAt)));
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

// --- The forecast's words -------------------------------------------------------------

/** The year readout: TODAY, or the calendar year and the years ahead. */
export function yearText(year, baseYear) {
  const ahead = cleanYear(year);
  if (!ahead) return tl('TODAY');
  return tln(ahead, '{year} · +{count} YEAR', '{year} · +{count} YEARS', {
    year: localDigits(String(baseYear + ahead)),
    count: formatCount(ahead),
  });
}

/** A change in points with its sign: +12, -3, 0. */
export function changeText(points) {
  const n = Math.round(Number(points));
  if (!Number.isFinite(n)) return '';
  return `${n > 0 ? '+' : ''}${localDigits(String(n))}`;
}

/**
 * The forecast's own line: the run under way, the level without figures,
 * the last run, or what to do.
 */
export function forecastNote({ year, running, result, scored }) {
  if (running)
    return tl('SIMULATING · {percent} %', {
      percent: localDigits(
        String(Math.round((100 * (running.year || 0)) / (running.years || 1))),
      ),
    });
  if (!scored) return tl('NO FORECAST: NO FIGURES AT THIS LEVEL');
  if (result)
    return tl('{runs} RUNS OVER {years} YEARS · SIMULATED IN {seconds} S', {
      runs: formatCount(result.runs),
      years: formatCount(result.years),
      seconds: localDigits(((result.ms || 0) / 1000).toFixed(1)),
    });
  if (!cleanYear(year))
    return tl('SLIDE YEARS AHEAD TO SEE THE FUTURE ON THE MAP');
  return '';
}

/**
 * The world's line: every place weighed by its people (each counted once
 * where none are known): at TODAY the people's score and the shares of them
 * in abundant and scarce places; at a future year today's figures, the
 * typical outcome with its band, and the shares then.
 * @param {object|null} world from worldAt
 * @param {{year?: number, baseYear?: number}} [options]
 */
export function worldText(world, { year = 0, baseYear = 2026 } = {}) {
  if (!world || !Number.isFinite(world.p50)) return '';
  const who = world.weighted
    ? tl('ALL PLACES BY POPULATION')
    : tl('ALL PLACES, EACH COUNTED ONCE');
  const percent = (value) => localDigits(String(Math.round(value)));
  if (!cleanYear(year))
    return tl(
      '{who} · ABUNDANCE {score} OF 100 · {up} % IN ABUNDANT PLACES · {down} % IN SCARCE ONES',
      {
        who,
        score: digits(world.p50, 0),
        up: percent(world.up),
        down: percent(world.down),
      },
    );
  return tl(
    '{who} · ABUNDANCE {today} OF 100 TODAY → {p50} IN {year} · {p10} TO {p90} IN 8 OF 10 RUNS · IN ABUNDANT PLACES {upToday} % → {up} % · IN SCARCE ONES {downToday} % → {down} %',
    {
      who,
      today: digits(world.today, 0),
      p50: digits(world.p50, 0),
      year: localDigits(String(baseYear + cleanYear(year))),
      p10: digits(world.p10, 0),
      p90: digits(world.p90, 0),
      upToday: percent(world.upToday),
      up: percent(world.up),
      downToday: percent(world.downToday),
      down: percent(world.down),
    },
  );
}

/**
 * A place's forecast lines at a year: its score's band against today,
 * its band among the others in that year (when the run ranked them), the
 * chances it is abundant or scarce on the scale shown, and its rank in
 * the ranking with its change from today.
 * @param {object|null} row the row against today
 * @param {object|null} others the row among the others, or null
 * @param {{year: number, baseYear: number, rank?: number|null, count?: number, scale?: string}} options
 */
export function forecastScoreLines(
  row,
  others,
  { year = 0, baseYear = 2026, rank = null, count = 0, scale = 'today' } = {},
) {
  if (!row) return [tl('NO FORECAST FOR THIS PLACE')];
  const calendar = localDigits(String(baseYear + cleanYear(year)));
  const chosen = cleanScale(scale) === 'others' && others ? others : row;
  const lines = [
    tl(
      '{year} · ABUNDANCE {p50} OF 100 TYPICALLY · {p10} TO {p90} IN 8 OF 10 RUNS',
      {
        year: calendar,
        p50: digits(row.p50, 0),
        p10: digits(row.p10, 0),
        p90: digits(row.p90, 0),
      },
    ),
  ];
  if (others)
    lines.push(
      tl(
        'AMONG THE OTHERS IN {year} · {p50} OF 100 TYPICALLY · {p10} TO {p90}',
        {
          year: calendar,
          p50: digits(others.p50, 0),
          p10: digits(others.p10, 0),
          p90: digits(others.p90, 0),
        },
      ),
    );
  lines.push(
    tl('CHANCE OF ABUNDANCE {up} % · CHANCE OF SCARCITY {down} %', {
      up: localDigits(String(chosen.up)),
      down: localDigits(String(chosen.down)),
    }),
  );
  const change = changeText(chosen.p50 - chosen.today);
  lines.push(
    Number.isFinite(rank) && rank > 0
      ? tl('RANKED {rank} OF {count} · {change} FROM TODAY', {
          rank: formatCount(rank),
          count: formatCount(count),
          change,
        })
      : tl('{change} FROM TODAY', { change }),
  );
  return lines;
}

/** One indicator's forecast line: the typical figure, its band, its place, and where the figure came from. */
export function forecastFigureText(indicator, entry, year, from) {
  const t = cleanYear(year);
  const parts = [
    indicatorLabel(indicator),
    valueWithUnit(indicator, entry.p50[t]),
    tl('{low} TO {high}', {
      low: localDigits(formatFigure(indicator, entry.p10[t])),
      high: localDigits(formatFigure(indicator, entry.p90[t])),
    }),
    tl('PLACE {n} OF 100', { n: digits(entry.placeMid[t], 0) }),
  ];
  const word = FROM_WORDS[from];
  if (word) parts.push(tl(word));
  return parts.join(' · ');
}

/**
 * What the model says of one indicator's walk, in the figure's own units,
 * with the hindcast's word on it (the swing scale and the trend shift it
 * gave, and how often its band held).
 */
export function modelLine(indicator, summary, hindcastEntry = null) {
  if (!indicator || !summary) return '';
  const decimals = Number.isFinite(indicator.decimals) ? indicator.decimals : 1;
  const shown = Number(Number(summary.trend).toFixed(decimals));
  const parts = [
    indicatorLabel(indicator),
    tl('{change} A YEAR', {
      change: `${shown > 0 ? '+' : ''}${valueWithUnit(indicator, shown)}`,
    }),
    `±${valueWithUnit(indicator, summary.spread)}`,
  ];
  if (summary.saturated) parts.push(tl('AT ITS CEILING, STAYS THERE'));
  else {
    const label = FORECAST_FAMILY_LABELS[summary.family];
    if (label)
      parts.push(
        tl(label, {
          frontier: valueWithUnit(indicator, summary.frontier),
          floor: valueWithUnit(indicator, summary.floor),
          cap: valueWithUnit(indicator, summary.cap),
          level: valueWithUnit(indicator, summary.level),
        }),
      );
  }
  parts.push(
    summary.n >= 1
      ? tln(summary.n, '{count} STEP OF HISTORY', '{count} STEPS OF HISTORY', {
          count: formatCount(summary.n),
        })
      : tl('NO HISTORY: THE LEVEL’S TYPICAL FIGURES'),
  );
  if (Number.isFinite(summary.scale) && summary.scale !== 1)
    parts.push(
      tl('SWING ×{scale}', { scale: localDigits(String(summary.scale)) }),
    );
  if (summary.shift && Number.isFinite(summary.trendShift)) {
    const shift = Number(Number(summary.trendShift).toFixed(decimals));
    if (shift !== 0)
      parts.push(
        tl('HINDCAST TREND {change} A YEAR', {
          change: `${shift > 0 ? '+' : ''}${valueWithUnit(indicator, shift)}`,
        }),
      );
  }
  if (Number.isFinite(hindcastEntry?.held))
    parts.push(
      tl('HINDCAST BAND HELD {held} %', {
        held: localDigits(String(hindcastEntry.held)),
      }),
    );
  return parts.join(' · ');
}

/** The hindcast's line: what the replay from ten years ago held. */
export function hindcastText(report) {
  if (!report || !(report.tested > 0)) return '';
  return tl(
    'HINDCAST {from}→{to} · THE 8-OF-10 BAND HELD {held} % OF {tested} FIGURES · THE TRENDS AND SWINGS ARE CALIBRATED BY IT',
    {
      from: localDigits(String(report.from)),
      to: localDigits(String(report.to)),
      held: localDigits(String(report.held)),
      tested: formatCount(report.tested),
    },
  );
}

/** The legend's ends and middle for a forecast view: scores, chances, or a change. */
export function forecastLegend(view) {
  switch (cleanForecastView(view)) {
    case 'up':
      return {
        low: `${localDigits('0')} %`,
        mid: `${localDigits('50')} %`,
        high: `${localDigits('100')} %`,
      };
    case 'down':
      return {
        low: `${localDigits('100')} %`,
        mid: `${localDigits('50')} %`,
        high: `${localDigits('0')} %`,
      };
    case 'change':
      return {
        low: localDigits('-50'),
        mid: localDigits('0'),
        high: `+${localDigits('50')}`,
      };
    default:
      return scoreLegend();
  }
}

/** A ranking row's figure for a view: a score, a signed change, or a chance in percent. */
export function viewText(value, view) {
  if (!Number.isFinite(value)) return '';
  switch (cleanForecastView(view)) {
    case 'up':
    case 'down':
      return `${localDigits(String(Math.round(value)))} %`;
    case 'change':
      return changeText(value);
    default:
      return digits(value, 0);
  }
}

/**
 * The fan chart of a place's score over the century: the band between the
 * bad and the good case, the typical line, the abundant and scarce marks,
 * and the chosen year. Nothing where the canvas cannot draw (a test).
 */
export function drawFan(canvas, series, year) {
  const ctx = canvas?.getContext?.('2d');
  if (!ctx || !series?.p50?.length) return false;
  const w = canvas.width;
  const h = canvas.height;
  const last = series.p50.length - 1;
  const x = (t) => (t / last) * (w - 1) + 0.5;
  const y = (s) => h - 0.5 - (Math.max(0, Math.min(100, s)) / 100) * (h - 1);
  ctx.clearRect(0, 0, w, h);
  ctx.beginPath();
  for (let t = 0; t <= last; t++) ctx.lineTo(x(t), y(series.p90[t]));
  for (let t = last; t >= 0; t--) ctx.lineTo(x(t), y(series.p10[t]));
  ctx.closePath();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(25, 230, 176, 0.5)';
  ctx.beginPath();
  ctx.moveTo(0, y(75));
  ctx.lineTo(w, y(75));
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255, 42, 42, 0.5)';
  ctx.beginPath();
  ctx.moveTo(0, y(25));
  ctx.lineTo(w, y(25));
  ctx.stroke();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#00d4ff';
  ctx.beginPath();
  for (let t = 0; t <= last; t++) ctx.lineTo(x(t), y(series.p50[t]));
  ctx.stroke();
  const at = cleanYear(year);
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
  ctx.beginPath();
  ctx.moveTo(x(at), 0);
  ctx.lineTo(x(at), h);
  ctx.stroke();
  return true;
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
 * @param {{documentRef?: Document, fetchImpl?: typeof fetch, signal?: AbortSignal, timers?: object, now?: () => number, storage?: Storage|null, readFile?: (file: File) => Promise<string>, forecast?: object}} options
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
  /** The forecast runner (src/abundanceForecastRun.js); a test passes one without a worker. */
  forecast: givenForecast = null,
} = {}) {
  const doc = documentRef;
  const host = doc?.getElementById?.('abundance-body');
  const line = doc?.getElementById?.('abundance-status');
  if (!host || !doc?.createElement)
    return { refresh() {}, render() {}, destroy() {} };
  const doFetch = fetchImpl || ((...args) => globalThis.fetch(...args));
  const forecast = givenForecast || createForecastRunner();
  /** The calendar year the slider counts from. */
  const baseYear = new Date(now()).getUTCFullYear();
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
  /** The next try of a load that got no answer, and how many have failed in a row. */
  let retryTimer = null;
  let retries = 0;
  /** Status polls that failed in a row: the next one comes sooner than the idle poll. */
  let pollFailures = 0;
  let rankingSide = 'top';
  let pinnedId = null;
  let hoverId = null;
  let scores = new Map();
  let links = [];
  let ranking = [];
  /**
   * The forecast: the last result (`{ key, level, stamp, data, byId,
   * indicatorIds }`), the run under way, the details and the level's
   * typical model for that result, the view's values when a future year is
   * shown, the draw's seed, and the timers of the debounce and of PLAY.
   */
  let result = null;
  let running = null;
  let forecastTimer = null;
  let playTimer = null;
  let seed = 1;
  const details = new Map();
  const detailsAsked = new Set();
  let typical = null;
  let forecastScores = null;

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

  /** The tab's lifetime and a request's own time limit, as one signal. */
  const requestSignal = (timeoutMs) => {
    if (
      !timeoutMs ||
      typeof AbortSignal?.timeout !== 'function' ||
      typeof AbortSignal?.any !== 'function'
    )
      return lifetime.signal;
    return AbortSignal.any([lifetime.signal, AbortSignal.timeout(timeoutMs)]);
  };

  const call = async (route, { method = 'GET', body, timeoutMs } = {}) => {
    const request = doFetch(`${ABUNDANCE_API}/${route}`, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: requestSignal(timeoutMs),
    });
    const response = await (method === 'DELETE'
      ? watchOwnerRemoval(request)
      : request);
    let payload = null;
    let json = true;
    try {
      payload = await response.json();
    } catch {
      json = false;
      payload = {};
    }
    if (isOwnerRemovalRefusal(response, payload)) {
      // Only the PC removes: nothing changes, and nothing is said.
      noteOwnerRemovalRefusal();
      return null;
    }
    if (!response.ok)
      throw new Error(payload?.error || `HTTP ${response.status}`);
    if (!json || !payload || typeof payload !== 'object') {
      // The page itself, or nothing: the dev server was between restarts.
      const answered = new Error(
        'The server answered with something other than its figures.',
      );
      answered.kind = 'not-json';
      throw answered;
    }
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
    stopPlay();
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
    afterForecastChange(false);
  });
  host.append(all.label);
  ui.rows = new Map();
  const rows = element(doc, 'ul', 'abundance-list abundance-indicators');
  rows.setAttribute('aria-label', tl('Indicators of abundance'));
  for (const indicator of ABUNDANCE_INDICATORS) {
    const li = element(doc, 'li', 'abundance-row');
    li.dataset.indicator = indicator.id;
    const row = tick(doc, indicatorLabel(indicator), '');
    row.box.dataset.indicator = indicator.id;
    row.box.addEventListener('change', () => {
      const set = new Set(choice.indicators);
      if (row.box.checked) set.add(indicator.id);
      else set.delete(indicator.id);
      choice.indicators = cleanIndicatorIds([...set]);
      keepChoice();
      afterForecastChange(false);
    });
    // The weight: how much this indicator counts in the score, ×0.5 to ×3.
    const weight = element(doc, 'input', 'abundance-weight');
    weight.type = 'range';
    weight.min = String(WEIGHT_MIN);
    weight.max = String(WEIGHT_MAX);
    weight.step = String(WEIGHT_STEP);
    weight.value = '1';
    weight.dataset.indicator = indicator.id;
    weight.setAttribute(
      'aria-label',
      tl('Weight of {indicator} in the score', {
        indicator: indicatorLabel(indicator),
      }),
    );
    weight.title = tl('How much this indicator counts in the score');
    const times = element(doc, 'span', 'abundance-times');
    const onWeight = () => {
      choice.weights = cleanWeights({
        ...choice.weights,
        [indicator.id]: Number(weight.value),
      });
      keepChoice();
      afterForecastChange(false);
    };
    weight.addEventListener('input', onWeight);
    weight.addEventListener('change', onWeight);
    const head = element(doc, 'div', 'abundance-row-head');
    head.append(row.label, weight, times);
    const measure = element(doc, 'span', 'abundance-measure');
    const cover = element(doc, 'span', 'abundance-cover');
    li.append(head, measure, cover);
    rows.append(li);
    ui.rows.set(indicator.id, { box: row.box, measure, cover, weight, times });
  }
  host.append(rows);
  ui.resetWeights = button(
    doc,
    tl('RESET WEIGHTS'),
    'reset-weights',
    tl('Every indicator counts once again'),
  );
  ui.resetWeights.addEventListener('click', () => {
    choice.weights = {};
    keepChoice();
    afterForecastChange(false);
  });
  host.append(ui.resetWeights);

  const legend = element(doc, 'div', 'abundance-legend');
  legend.append(
    element(doc, 'span', 'abundance-legend-word', tl('SCARCE')),
    element(doc, 'span', 'abundance-legend-bar'),
    element(doc, 'span', 'abundance-legend-word', tl('ABUNDANT')),
  );
  host.append(legend);
  // Under the bar: with one indicator ticked, the figure behind each end
  // and the middle, in its units; with more, the score.
  ui.legendLow = element(doc, 'span', 'abundance-legend-value');
  ui.legendMid = element(doc, 'span', 'abundance-legend-value');
  ui.legendHigh = element(doc, 'span', 'abundance-legend-value');
  const legendValuesRow = element(doc, 'div', 'abundance-legend-values');
  legendValuesRow.append(ui.legendLow, ui.legendMid, ui.legendHigh);
  host.append(legendValuesRow);
  host.append(
    element(
      doc,
      'p',
      'abundance-note',
      tl(
        'The score is the mean place of a unit among the others, 0 to 100, over the ticked indicators it has a figure for, each counted by its weight.',
      ),
    ),
  );

  // --- FORECAST: the years ahead, what the map shows, the runs ------------------
  host.append(element(doc, 'div', 'abundance-label', tl('FORECAST')));
  const yearRow = element(doc, 'div', 'abundance-forecast-row');
  ui.year = element(doc, 'input', 'abundance-year');
  ui.year.type = 'range';
  ui.year.min = '0';
  ui.year.max = String(FORECAST_YEARS);
  ui.year.step = '1';
  ui.year.value = String(choice.year);
  ui.year.setAttribute('aria-label', tl('Years ahead'));
  ui.year.title = tl('Today at the left, a hundred years ahead at the right');
  const onYear = () => {
    const year = cleanYear(ui.year.value);
    if (year === choice.year) return;
    choice.year = year;
    keepChoice();
    afterForecastChange(false);
  };
  ui.year.addEventListener('input', onYear);
  ui.year.addEventListener('change', onYear);
  ui.yearText = element(doc, 'span', 'abundance-year-text');
  yearRow.append(ui.year, ui.yearText);
  host.append(yearRow);
  const forecastActions = element(
    doc,
    'div',
    'cctv-controls abundance-actions',
  );
  // PLAY in its own context: the page's PLAY is a sound's (ESCUCHAR, ÉCOUTER).
  ui.play = button(
    doc,
    tl('PLAY', { context: 'forecast' }),
    'play',
    tl('Runs the years forward on the map'),
  );
  ui.play.addEventListener('click', () =>
    playTimer === null ? play() : stopPlay(),
  );
  ui.redraw = button(
    doc,
    tl('NEW DRAW'),
    'redraw',
    tl('Runs the simulation again with other random draws'),
  );
  ui.redraw.addEventListener('click', () => {
    seed += 1;
    afterForecastChange(true);
  });
  ui.view = element(doc, 'select', 'abundance-view');
  ui.view.setAttribute(
    'aria-label',
    tl('What the map shows for the chosen year'),
  );
  for (const view of FORECAST_VIEWS) {
    const option = element(doc, 'option', '', tl(FORECAST_VIEW_LABELS[view]));
    option.value = view;
    ui.view.append(option);
  }
  ui.view.value = choice.view;
  ui.view.addEventListener('change', () => {
    choice.view = cleanForecastView(ui.view.value);
    keepChoice();
    afterForecastChange(false);
  });
  ui.runs = element(doc, 'select', 'abundance-runs');
  ui.runs.setAttribute('aria-label', tl('How many runs the simulation makes'));
  ui.runs.title = tl('More runs give steadier chances and take longer');
  for (const runs of FORECAST_RUNS) {
    const option = element(
      doc,
      'option',
      '',
      tln(runs, '{count} RUN', '{count} RUNS', { count: formatCount(runs) }),
    );
    option.value = String(runs);
    ui.runs.append(option);
  }
  ui.runs.value = String(runsFor(choice.level, choice.runs));
  ui.runs.addEventListener('change', () => {
    choice.runs = cleanRuns(ui.runs.value);
    keepChoice();
    afterForecastChange(true);
  });
  const crises = tick(doc, tl('CRISES'), 'abundance-all');
  ui.crises = crises.box;
  ui.crises.checked = choice.crises;
  ui.crises.title = tl(
    'World and local crises in the runs: a year or two of cuts, then three years of partial recovery',
  );
  ui.crises.addEventListener('change', () => {
    choice.crises = Boolean(ui.crises.checked);
    keepChoice();
    afterForecastChange(true);
  });
  ui.scale = element(doc, 'select', 'abundance-scale');
  ui.scale.setAttribute(
    'aria-label',
    tl('What a future score is measured against'),
  );
  ui.scale.title = tl(
    'Today’s figures, where 100 is the best any place has today, or the other places in that year, each counted by its population',
  );
  for (const scale of FORECAST_SCALES) {
    const option = element(doc, 'option', '', tl(FORECAST_SCALE_LABELS[scale]));
    option.value = scale;
    ui.scale.append(option);
  }
  ui.scale.value = choice.scale;
  ui.scale.addEventListener('change', () => {
    choice.scale = cleanScale(ui.scale.value);
    keepChoice();
    afterForecastChange(false);
  });
  ui.scenario = element(doc, 'select', 'abundance-scenario');
  ui.scenario.setAttribute('aria-label', tl('Which world the runs assume'));
  ui.scenario.title = tl(
    'The long-run growth of the frontier, how often crises come and how deep they cut',
  );
  for (const scenario of FORECAST_SCENARIOS) {
    const option = element(
      doc,
      'option',
      '',
      tl(FORECAST_SCENARIO_LABELS[scenario]),
    );
    option.value = scenario;
    ui.scenario.append(option);
  }
  ui.scenario.value = choice.scenario;
  ui.scenario.addEventListener('change', () => {
    choice.scenario = cleanScenario(ui.scenario.value);
    keepChoice();
    afterForecastChange(true);
  });
  forecastActions.append(
    ui.play,
    ui.redraw,
    ui.view,
    ui.scale,
    ui.scenario,
    ui.runs,
    crises.label,
  );
  host.append(forecastActions);
  ui.forecastNote = element(doc, 'p', 'abundance-note abundance-forecast-note');
  ui.worldNote = element(doc, 'p', 'abundance-note abundance-forecast-note');
  ui.hindcastNote = element(doc, 'p', 'abundance-note abundance-forecast-note');
  host.append(ui.forecastNote, ui.worldNote, ui.hindcastNote);
  host.append(
    element(
      doc,
      'p',
      'abundance-note',
      tl(
        'Each figure walks forward a year at a time from its own history, pulled toward a moving frontier (the best places’ figures, money in today’s dollars) with its own trend fading over decades, back to its usual level for inflation, unemployment and prices; the swings are the world’s, the country’s, the place’s and the figure’s own, so a place’s figures move together; crises last a year or two and are followed by a partial recovery; and each trend and swing is calibrated by the hindcast, a replay from ten years ago. A future score is measured against today’s figures (100 is the best any place has today) or among the other places in that year.',
      ),
    ),
  );
  ui.modelLabel = element(doc, 'div', 'abundance-label', tl('MODEL'));
  ui.modelNote = element(
    doc,
    'p',
    'abundance-note',
    tl(
      'What each figure’s history gave the walk: the change of a typical year and its usual swing, the floor, ceiling or usual level, and the steps of history behind it. The selected place’s, else the level’s typical ones.',
    ),
  );
  ui.model = element(doc, 'ul', 'abundance-list abundance-model');
  ui.model.setAttribute('aria-label', tl('The model behind the forecast'));
  host.append(ui.modelLabel, ui.modelNote, ui.model);

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
  // The fan chart: the selected place's score over the century.
  ui.fan = element(doc, 'canvas', 'abundance-fan');
  ui.fan.width = FAN_WIDTH;
  ui.fan.height = FAN_HEIGHT;
  ui.fan.hidden = true;
  ui.fan.setAttribute(
    'aria-label',
    tl('The selected place’s score over the next hundred years'),
  );
  ui.clear = button(doc, tl('CLEAR'), 'clear');
  ui.clear.addEventListener('click', () => {
    pinnedId = null;
    render();
    publishCard();
  });
  host.append(ui.selectedName, ui.selected, ui.fan, ui.clear);

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

  const cancelRetry = () => {
    if (retryTimer !== null) timers.clearTimeout(retryTimer);
    retryTimer = null;
  };

  /**
   * One level's figures. A load that gets no answer says so on the line and
   * is tried again after a growing wait (RETRY_DELAYS_MS); a level change or
   * an answer ends the tries.
   */
  const loadLevel = async (level) => {
    cancelRetry();
    loading = true;
    error = null;
    render();
    try {
      const payload = await call(`data?level=${encodeURIComponent(level)}`, {
        timeoutMs: LOAD_TIMEOUT_MS,
      });
      if (lifetime.signal.aborted || !payload) return;
      retries = 0;
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
        hindcast: payload.hindcast || null,
        newestYear,
        scored: 0,
        // The figures' own stamp: a forecast is for one load of them.
        stamp: payload.builtAt || now(),
      });
      if (payload.refreshing) schedulePoll(POLL_BUSY_MS);
    } catch (err) {
      if (lifetime.signal.aborted) return;
      const wait =
        RETRY_DELAYS_MS[Math.min(retries, RETRY_DELAYS_MS.length - 1)];
      retries += 1;
      error = { problem: failureText(err), retryInMs: wait };
      retryTimer = timers.setTimeout(() => {
        retryTimer = null;
        if (!lifetime.signal.aborted && level === choice.level)
          void loadLevel(level);
      }, wait);
    } finally {
      loading = false;
    }
    if (level === choice.level) {
      compute();
      render();
      publish();
      ensureForecast();
    }
  };

  // --- The forecast ---------------------------------------------------------------
  /** Everything a run depends on: the level and its figures, the ticks, the weights, the runs, the crises, the draw. */
  const forecastKey = () => {
    const t = table();
    return JSON.stringify([
      choice.level,
      t?.stamp ?? 0,
      choice.indicators,
      choice.weights,
      runsFor(choice.level, choice.runs),
      choice.crises,
      choice.scenario,
      choice.scale === 'others',
      seed,
    ]);
  };

  /** The result stands for the level's figures on screen (its settings may be a run behind). */
  const resultUsable = () => {
    const t = table();
    return Boolean(
      result && t && result.level === choice.level && result.stamp === t.stamp,
    );
  };

  /** A future year is shown and a result is there to show it. */
  const forecastShown = () => choice.year > 0 && resultUsable();

  const cancelForecastTimer = () => {
    if (forecastTimer !== null) timers.clearTimeout(forecastTimer);
    forecastTimer = null;
  };

  /** A run for the current key, unless one is there or under way; waits for the next change first. */
  const ensureForecast = () => {
    if (!choice.year) return;
    const t = table();
    if (!t || !t.scored) return;
    const key = forecastKey();
    if ((result && result.key === key) || (running && running.key === key))
      return;
    cancelForecastTimer();
    forecastTimer = timers.setTimeout(() => {
      forecastTimer = null;
      void runForecast();
    }, FORECAST_DEBOUNCE_MS);
  };

  const runForecast = async () => {
    const t = table();
    if (!t || lifetime.signal.aborted) return;
    const key = forecastKey();
    if (result && result.key === key) return;
    running = { key, year: 0, years: FORECAST_YEARS };
    renderForecastNote();
    const answer = await forecast.run(
      {
        planId: key,
        level: choice.level,
        units: t.units,
        indicators: choice.indicators,
        weights: choice.weights,
        runs: runsFor(choice.level, choice.runs),
        seed,
        crises: choice.crises,
        scenario: choice.scenario,
        scales: hindcastScales(t.hindcast),
        shifts: hindcastShifts(t.hindcast),
        among: choice.scale === 'others',
      },
      (progress) => {
        if (running?.key !== key) return;
        running.year = progress.year;
        running.years = progress.years;
        renderForecastNote();
      },
    );
    if (lifetime.signal.aborted) return;
    if (running?.key === key) running = null;
    if (answer?.type !== 'done' || !answer.result) {
      renderForecastNote();
      return;
    }
    result = {
      key,
      level: choice.level,
      stamp: t.stamp,
      data: answer.result,
      byId: new Map(answer.result.ids.map((id, k) => [id, k])),
      indicatorIds: cleanIndicatorIds(choice.indicators),
    };
    details.clear();
    detailsAsked.clear();
    typical = null;
    void forecast.model(key).then((reply) => {
      if (reply?.model && result?.key === key) {
        typical = reply.model;
        render();
      }
    });
    compute();
    render();
    publish();
    // The key may have moved on while the run went (another tick): run again.
    ensureForecast();
  };

  /** A place's detail for the current result, asked once; the lists fill when it comes. */
  const requestDetail = (id) => {
    if (!result || !id || details.has(id) || detailsAsked.has(id)) return;
    detailsAsked.add(id);
    const key = result.key;
    void forecast.detail(key, id).then((reply) => {
      if (lifetime.signal.aborted || result?.key !== key || reply?.stale)
        return;
      if (!reply?.detail) return;
      if (details.size >= DETAILS_KEPT) details.clear();
      details.set(id, { detail: reply.detail, model: reply.model });
      render();
      if (pinnedId === id) publishCard();
    });
  };

  /** A result's row for a unit at the chosen year, on a scale (the chosen one unless said). */
  const forecastRow = (id, scale = choice.scale) =>
    result
      ? forecastAt(result.data, result.byId.get(id), choice.year, scale)
      : null;

  /** Every unit's figure for the view at the chosen year: the value, its place on the ramp, the typical score. */
  const viewScoresMap = (t) => {
    const out = new Map();
    for (const u of t.units) {
      const row = forecastRow(u.id);
      if (!row) continue;
      const value = viewValue(row, choice.view);
      const ramp = viewRampScore(value, choice.view);
      if (ramp === null) continue;
      out.set(u.id, { value, ramp, p50: row.p50 });
    }
    return out;
  };

  /** After a change to the forecast's choice: `rerun` when the runs must be made again. */
  const afterForecastChange = (rerun) => {
    if (rerun) {
      result = null;
      typical = null;
      details.clear();
      detailsAsked.clear();
    }
    compute();
    render();
    publish();
    ensureForecast();
  };

  const play = () => {
    if (playTimer !== null) return;
    if (choice.year >= FORECAST_YEARS) choice.year = 0;
    const step = () => {
      playTimer = null;
      if (lifetime.signal.aborted) return;
      choice.year = cleanYear(choice.year + 1);
      keepChoice();
      compute();
      render();
      publish();
      ensureForecast();
      if (choice.year < FORECAST_YEARS)
        playTimer = timers.setTimeout(step, PLAY_STEP_MS);
      else render();
    };
    playTimer = timers.setTimeout(step, PLAY_STEP_MS);
    render();
  };

  const stopPlay = () => {
    if (playTimer !== null) timers.clearTimeout(playTimer);
    playTimer = null;
    render();
  };

  const compute = () => {
    const t = table();
    if (!t) {
      scores = new Map();
      forecastScores = null;
      links = [];
      ranking = [];
      return;
    }
    scores = scoreUnits(
      t.units,
      choice.indicators,
      ABUNDANCE_INDICATORS,
      choice.weights,
    );
    t.scored = rankUnits(t.units, scores).length;
    forecastScores = forecastShown() ? viewScoresMap(t) : null;
    if (forecastScores) {
      const ramp = new Map();
      const typicalScores = new Map();
      for (const [id, entry] of forecastScores) {
        ramp.set(id, { score: entry.ramp });
        typicalScores.set(id, { score: entry.p50 });
      }
      ranking = rankUnits(t.units, ramp);
      links = choice.grid
        ? abundanceLinks(t.units, typicalScores, { max: LINKS_MAX })
        : [];
      return;
    }
    ranking = rankUnits(t.units, scores);
    links = choice.grid
      ? abundanceLinks(t.units, scores, { max: LINKS_MAX })
      : [];
  };

  /** The colour a unit takes on the map now: the view's, or today's score's. */
  const colorOf = (id) =>
    forecastScores
      ? scoreColor(forecastScores.get(id)?.ramp ?? null)
      : scoreColor(scores.get(id)?.score);

  /** A unit's lines for a future year, for SELECTED and its card. */
  const forecastUnitLines = (unit) => {
    const lines = [];
    if (unit.country && unit.country !== unit.name)
      lines.push([unit.adm1, unit.country].filter(Boolean).join(', '));
    if (Number.isFinite(unit.pop) && unit.pop > 0)
      lines.push(tl('POPULATION {n}', { n: formatCount(unit.pop) }));
    const row = forecastRow(unit.id, 'today');
    const others = result?.data?.rp50 ? forecastRow(unit.id, 'others') : null;
    const at = ranking.findIndex((r) => r.id === unit.id);
    lines.push(
      ...forecastScoreLines(row, others, {
        year: choice.year,
        baseYear,
        rank: at >= 0 ? at + 1 : null,
        count: ranking.length,
        scale: choice.scale,
      }),
    );
    const detail = details.get(unit.id)?.detail;
    if (row && detail)
      for (const id of result.indicatorIds) {
        const entry = detail.indicators?.[id];
        const indicator = indicatorById(id);
        if (!entry || !indicator) continue;
        lines.push(
          forecastFigureText(
            indicator,
            entry,
            choice.year,
            unit.values?.[id]?.from,
          ),
        );
      }
    return lines;
  };

  /** A unit's score series over the century from the result, for its fan chart. */
  const forecastSeries = (id) => {
    const k = result?.byId.get(id);
    if (k === undefined) return null;
    const T1 = result.data.years + 1;
    if (Number.isNaN(result.data.p50[k * T1])) return null;
    return {
      p10: result.data.p10.subarray(k * T1, (k + 1) * T1),
      p50: result.data.p50.subarray(k * T1, (k + 1) * T1),
      p90: result.data.p90.subarray(k * T1, (k + 1) * T1),
    };
  };

  const renderForecastNote = () => {
    const t = table();
    const usable = resultUsable();
    ui.forecastNote.textContent = forecastNote({
      year: choice.year,
      running,
      result: usable ? result.data : null,
      scored: t?.scored ?? 0,
    });
    ui.worldNote.textContent = worldText(
      usable ? worldAt(result.data, choice.year) : null,
      { year: choice.year, baseYear },
    );
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
    if (forecastScores) requestDetail(unit.id);
    return {
      id: unit.id,
      lat: unit.lat,
      lon: unit.lon,
      title: unit.name,
      details: forecastScores
        ? forecastUnitLines(unit)
        : unitLines(unit, score, choice.indicators, choice.level),
      accent: colorOf(unit.id),
    };
  };

  const publish = () => {
    const t = table();
    const byId = t?.byId || new Map();
    const detail = {
      level: choice.level,
      show: choice.show,
      units: (t?.units || []).map((u) => {
        const value = forecastScores
          ? (forecastScores.get(u.id)?.ramp ?? null)
          : (scores.get(u.id)?.score ?? null);
        return {
          id: u.id,
          score: value,
          color: colorOf(u.id),
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
      say(failureText(err));
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

  /**
   * The sources' state. A poll that fails leaves a loaded level alone (its
   * line keeps the level's own words) and comes back sooner than the idle
   * poll; one that answers while the level has no table loads it, so a
   * server that is back is used at once.
   */
  const pollStatus = async () => {
    try {
      const next = await call('status', { timeoutMs: STATUS_TIMEOUT_MS });
      if (lifetime.signal.aborted || !next) return;
      pollFailures = 0;
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
      } else if (!table() && !loading) await loadLevel(choice.level);
      else render();
      schedulePoll(busy ? POLL_BUSY_MS : POLL_IDLE_MS);
    } catch (err) {
      if (lifetime.signal.aborted) return;
      pollFailures += 1;
      if (!table() && !loading && retryTimer === null)
        error = { problem: failureText(err), retryInMs: null };
      render();
      schedulePoll(
        Math.min(
          POLL_IDLE_MS,
          RETRY_DELAYS_MS[
            Math.min(pollFailures - 1, RETRY_DELAYS_MS.length - 1)
          ],
        ),
      );
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
      const w = choice.weights[indicator.id] ?? 1;
      if (Number(row.weight.value) !== w) row.weight.value = String(w);
      row.weight.disabled = !on;
      row.times.textContent = tl('×{n}', { n: localDigits(String(w)) });
      row.measure.textContent = tl(indicatorMeasure(indicator, choice.level));
      row.cover.textContent = coverageText(
        t?.coverage?.[indicator.id],
        choice.level,
      );
    }
    ui.resetWeights.hidden = !Object.keys(choice.weights).length;
    const single =
      choice.indicators.length === 1
        ? indicatorById(choice.indicators[0])
        : null;
    const legendText = forecastScores
      ? forecastLegend(choice.view)
      : single
        ? legendValues(t?.units, single)
        : null;
    const ends = legendText || scoreLegend();
    ui.legendLow.textContent = ends.low;
    ui.legendMid.textContent = ends.mid;
    ui.legendHigh.textContent = ends.high;
    // FORECAST: the slider and its readout, PLAY, the view, the runs, the note, the model.
    if (cleanYear(ui.year.value) !== choice.year)
      ui.year.value = String(choice.year);
    ui.yearText.textContent = yearText(choice.year, baseYear);
    // The label is made first: a quoted word in a textContent assignment
    // reads as a glyph name to the icon subset's check.
    const playLabel =
      playTimer === null ? tl('PLAY', { context: 'forecast' }) : tl('STOP');
    ui.play.textContent = playLabel;
    ui.play.disabled = !t?.scored;
    ui.redraw.disabled = !t?.scored;
    if (ui.view.value !== choice.view) ui.view.value = choice.view;
    const runs = String(runsFor(choice.level, choice.runs));
    if (ui.runs.value !== runs) ui.runs.value = runs;
    if (ui.crises.checked !== choice.crises) ui.crises.checked = choice.crises;
    if (ui.scale.value !== choice.scale) ui.scale.value = choice.scale;
    if (ui.scenario.value !== choice.scenario)
      ui.scenario.value = choice.scenario;
    renderForecastNote();
    ui.hindcastNote.textContent = hindcastText(t?.hindcast);
    const unit = selectedUnit();
    const usable = resultUsable();
    const unitDetail = unit && usable ? details.get(unit.id) : null;
    if (unit && usable) requestDetail(unit.id);
    const modelLines = usable
      ? (unitDetail?.model || typical || []).map((summary) =>
          modelLine(
            indicatorById(summary.id),
            summary,
            t?.hindcast?.indicators?.[summary.id] ?? null,
          ),
        )
      : [];
    ui.modelLabel.hidden = !usable;
    ui.modelNote.hidden = !usable;
    fillList(doc, ui.model, modelLines);
    ui.selectedNote.hidden = Boolean(unit);
    ui.selectedName.textContent = unit ? unit.name : '';
    ui.selectedName.hidden = !unit;
    fillList(
      doc,
      ui.selected,
      unit
        ? forecastScores
          ? forecastUnitLines(unit)
          : unitLines(
              unit,
              scores.get(unit.id),
              choice.indicators,
              choice.level,
            )
        : [],
    );
    const fan = unit && usable ? forecastSeries(unit.id) : null;
    ui.fan.hidden = !(fan && drawFan(ui.fan, fan, choice.year));
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
        text: `${localDigits(String(rankingSide === 'top' ? k + 1 : ranking.length - k))}. ${r.name} · ${
          forecastScores
            ? viewText(forecastScores.get(r.id)?.value, choice.view)
            : digits(r.score, 0)
        }`,
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
    cancelRetry();
    cancelForecastTimer();
    if (playTimer !== null) timers.clearTimeout(playTimer);
    playTimer = null;
    forecast.destroy?.();
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
    /** Test seams: the forecast result on screen, if any, and whether a run is under way. */
    get forecast() {
      return resultUsable() ? result.data : null;
    },
    get simulating() {
      return Boolean(running);
    },
  };
}
