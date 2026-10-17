/**
 * Study pairs for the world-model bins. A shared hour is not a cause.
 * A side with no reading stays blank. Channels the list does not name
 * are still in the same hour, so a link can show up that this list missed.
 *
 * The text is English, marked with tl() from src/i18n/marker.js (Quebec
 * French on the page); the server loads this module through
 * src/aiWorldSelection.mjs.
 */
import { localDigits, msgl, tl } from './i18n/marker.js';

export const TRAINING_LINKS = Object.freeze([
  Object.freeze({
    id: 'news-prices',
    rank: 'primary',
    reads: ['news.articles', 'news-urls.count', 'markets'],
    note: msgl(
      'News and a price share an hour. A headline that names a commodity or a currency is counted on that series. Some stories move a price and some do not. The bin does not decide which.',
    ),
  }),
  Object.freeze({
    id: 'unplanned',
    rank: 'secondary',
    reads: ['markets', 'every other non-military number in that hour'],
    note: msgl(
      'Any other recorded number can sit beside a price, including a link nobody named in advance.',
    ),
  }),
  Object.freeze({
    id: 'vessel-supply',
    rank: 'primary',
    reads: [
      'supply.tankers',
      'supply.cargoFood',
      'supply.cargoMetal',
      'supply.cargoRetail',
      'supply.cargo',
      'markets.crude',
      'markets.wheat',
      'markets.copper',
    ],
    note: msgl(
      'Tanker, food, metal, and container counts come only from the AIS type or destination text. Other cargo stays cargo. No tonnes are invented.',
    ),
  }),
  Object.freeze({
    id: 'traffic-fuel',
    rank: 'primary',
    reads: [
      'traffic.speedRatio',
      'traffic.segments',
      'cctv.count',
      'mobility',
      'markets.gasoline',
      'markets.crude',
    ],
    note: msgl(
      'Camera counts and road speed are the measured traffic. Regional fuel use is not metered, so it is not filled in. The gasoline print is a price, not gallons burned.',
    ),
  }),
  Object.freeze({
    id: 'farmland',
    rank: 'primary',
    reads: [
      'weather.t2m',
      'weather.precip',
      'observed-weather.precipitationMm',
      'observed-weather.cloudCoverPct',
      'markets.wheat',
    ],
    note: msgl(
      'Temperature, rain, and cloud sit beside the wheat price. Crop yield is not estimated.',
    ),
  }),
  Object.freeze({
    id: 'farmland-hazards',
    rank: 'secondary',
    reads: [
      'hazards.fireRadiativePower',
      'hazards.quakes',
      'weather.u10',
      'weather.v10',
      'observed-weather.windKph',
      'markets.wheat',
    ],
    note: msgl(
      'Fire, wind, and quakes are a second look at the same wheat price. They are not scored as damage.',
    ),
  }),
  Object.freeze({
    id: 'flights-jet',
    rank: 'primary',
    reads: ['mobility.aircraft', 'markets.jetfuel', 'markets.kerosene'],
    note: msgl(
      'Civil aircraft counts sit beside jet fuel and jet kerosene when those prints exist. A missing print stays blank.',
    ),
  }),
]);

/** Feeds and price series each study pair needs. Military is not in this list. */
const LINK_NEEDS = Object.freeze({
  'news-prices': Object.freeze([
    Object.freeze({ feed: 'news', label: msgl('news') }),
    Object.freeze({ feed: 'news-urls', label: msgl('news urls') }),
    Object.freeze({ feed: 'markets', label: msgl('prices') }),
  ]),
  unplanned: Object.freeze([
    Object.freeze({ feed: 'markets', label: msgl('prices') }),
  ]),
  'vessel-supply': Object.freeze([
    Object.freeze({ feed: 'ais-live-vessels', label: msgl('ships') }),
    Object.freeze({ feed: 'markets', series: 'crude', label: msgl('crude') }),
    Object.freeze({ feed: 'markets', series: 'wheat', label: msgl('wheat') }),
    Object.freeze({ feed: 'markets', series: 'copper', label: msgl('copper') }),
  ]),
  'traffic-fuel': Object.freeze([
    Object.freeze({ feed: 'traffic', label: msgl('traffic') }),
    Object.freeze({ feed: 'cctv', label: msgl('cameras') }),
    Object.freeze({ feed: 'flights', label: msgl('flights') }),
    Object.freeze({
      feed: 'markets',
      series: 'gasoline',
      label: msgl('gasoline'),
    }),
    Object.freeze({ feed: 'markets', series: 'crude', label: msgl('crude') }),
  ]),
  farmland: Object.freeze([
    Object.freeze({ feed: 'wind', label: msgl('forecast weather') }),
    Object.freeze({
      feed: 'observed-weather',
      label: msgl('observed weather'),
    }),
    Object.freeze({ feed: 'markets', series: 'wheat', label: msgl('wheat') }),
  ]),
  'farmland-hazards': Object.freeze([
    Object.freeze({ feed: 'local-firms', label: msgl('fires') }),
    Object.freeze({ feed: 'earthquakes', label: msgl('quakes') }),
    Object.freeze({ feed: 'wind', label: msgl('wind') }),
    Object.freeze({ feed: 'markets', series: 'wheat', label: msgl('wheat') }),
  ]),
  'flights-jet': Object.freeze([
    Object.freeze({ feed: 'flights', label: msgl('flights') }),
    Object.freeze({
      feed: 'markets',
      series: 'jetfuel',
      label: msgl('jet fuel'),
    }),
    Object.freeze({
      feed: 'markets',
      series: 'kerosene',
      label: msgl('kerosene'),
    }),
  ]),
});

/** Every feed the study pairs train on, once, military excluded. */
export function linkFeedIds() {
  const ids = [];
  for (const needs of Object.values(LINK_NEEDS)) {
    for (const need of needs) {
      if (need.feed && !ids.includes(need.feed)) ids.push(need.feed);
    }
  }
  return ids;
}

function recorded(feed) {
  if (!feed) return false;
  return (
    Number(feed.records) > 0 ||
    Number(feed.recordsToday) > 0 ||
    Number.isFinite(Number(feed.lastAt))
  );
}

/**
 * What the tab should say for one study pair, from the ticks, the feed
 * status, and the latest prices. A missing side is named. Nothing is inferred.
 */
export function linkStatus(
  link,
  { selection = [], feeds = [], quotes = [] } = {},
) {
  const needs = LINK_NEEDS[link?.id] || [];
  const selected = new Set(selection);
  const byId = new Map(
    (Array.isArray(feeds) ? feeds : [])
      .filter((feed) => feed && typeof feed.id === 'string')
      .map((feed) => [feed.id, feed]),
  );
  const priced = new Set(
    (Array.isArray(quotes) ? quotes : [])
      .filter((quote) => Number.isFinite(Number(quote?.value)))
      .map((quote) => quote.series),
  );
  const missing = [];
  const waiting = [];
  for (const need of needs) {
    const feed = byId.get(need.feed);
    const on =
      selected.has(need.feed) || (feed && feed.state && feed.state !== 'off');
    if (need.series) {
      if (!priced.has(need.series)) missing.push(tl(need.label));
      continue;
    }
    if (recorded(feed)) continue;
    if (on) waiting.push(tl(need.label));
    else missing.push(tl(need.label));
  }
  if (link?.id === 'unplanned') {
    const other = [...byId.values()].some(
      (feed) => feed.id !== 'markets' && recorded(feed),
    );
    if (!other) missing.push(tl('another recorded feed'));
  }
  const rank = link?.rank === 'primary' ? tl('PRIMARY') : tl('SECONDARY');
  const state = missing.length
    ? tl('MISSING {what}', { what: missing.join(', ') })
    : waiting.length
      ? tl('WAITING {what}', { what: waiting.join(', ') })
      : tl('BOTH SIDES');
  const note = link?.note ? tl(link.note) : '';
  return { state, text: tl('{rank}: {state}. {note}', { rank, state, note }) };
}

/** Held-out error against a persist-the-last-value baseline. Blank if either number is missing. */
export function formatSkill(skill) {
  const model = Number(skill?.model);
  const base = Number(skill?.persistence);
  if (!Number.isFinite(model) || !Number.isFinite(base)) return '';
  return tl('MAE {model} VS PERSISTENCE {base}', {
    model: localDigits(model.toFixed(3)),
    base: localDigits(base.toFixed(3)),
  });
}

const LINK_SKILL = Object.freeze({
  'news-prices': ['news-markets', 'markets'],
  unplanned: ['markets'],
  'vessel-supply': ['supply', 'markets'],
  'traffic-fuel': ['traffic', 'markets'],
  farmland: ['weather', 'markets'],
  'farmland-hazards': ['hazards', 'weather'],
  'flights-jet': ['mobility', 'markets'],
});

/** Skill lines for the domains this pair is scored on. Missing scores are left out. */
export function linkSkill(link, domains) {
  const parts = [];
  for (const id of LINK_SKILL[link?.id] || []) {
    const line = formatSkill(domains?.[id]);
    if (line) parts.push(`${id} ${line}`);
  }
  return parts.join(' · ');
}

/** One measured link as the tab says it: who moves first, by how much, and whether later hours agree. */
export function measuredLinkText(row) {
  if (!row || typeof row.channel !== 'string' || typeof row.asset !== 'string')
    return '';
  const r = Number(row.r);
  const lag = Number(row.lagHours);
  if (!Number.isFinite(r) || !Number.isFinite(lag)) return '';
  const channel = row.channel.toUpperCase();
  const asset = row.asset.toUpperCase();
  const order =
    lag > 0
      ? tl('{first} MOVES {lag} H BEFORE {second}', {
          first: channel,
          lag,
          second: asset,
        })
      : lag < 0
        ? tl('{first} MOVES {lag} H BEFORE {second}', {
            first: asset,
            lag: -lag,
            second: channel,
          })
        : tl('{first} AND {second} IN THE SAME HOUR', {
            first: channel,
            second: asset,
          });
  const test = Number(row.rTest);
  const later = row.holds
    ? tl('HOLDS ON LATER HOURS (R {r})', {
        r: Number.isFinite(test) ? localDigits(test.toFixed(2)) : '?',
      })
    : tl('NOT CONFIRMED ON LATER HOURS');
  return `${order} · R ${localDigits(r.toFixed(2))} · N ${Number(row.n) || 0} · ${later}`;
}

/**
 * Why ml.gevtape.links found no link yet, in the page's words. The three
 * reasons it gives are known; any other shows as given, upper case.
 */
function linkReason(reason) {
  const words = String(reason).toUpperCase();
  if (words === 'NO MARKET PRICES IN THE BINS YET')
    return tl('NO MARKET PRICES IN THE BINS YET');
  if (words === 'NO OTHER RECORDED CHANNEL YET')
    return tl('NO OTHER RECORDED CHANNEL YET');
  const fewer = /^FEWER THAN (\d+) PAIRED HOURS FOR EVERY PAIR$/.exec(words);
  if (fewer)
    return tl('FEWER THAN {hours} PAIRED HOURS FOR EVERY PAIR', {
      hours: fewer[1],
    });
  return words;
}

/**
 * The LINKS list's measured lines (ml.gevtape.links via the status): the
 * strongest links found in the recorded hours, or why there are none yet.
 * A correlation is not a cause and not advice.
 */
export function measuredLinkLines(report, max = 6) {
  if (!report || typeof report !== 'object') return [];
  const hours = Number(report.hours) || 0;
  if (report.reason)
    return [
      tl('MEASURED: {reason} ({hours} H BINNED)', {
        reason: linkReason(report.reason),
        hours,
      }),
    ];
  const rows = (Array.isArray(report.top) ? report.top : [])
    .map(measuredLinkText)
    .filter(Boolean)
    .slice(0, max);
  return rows.length
    ? rows.map((line) => tl('MEASURED: {line}', { line }))
    : [tl('MEASURED: NO LINK YET ({hours} H BINNED)', { hours })];
}

/** The strongest measured link between a study pair's two sides, or ''. */
export function linkMeasured(link, report) {
  const pair = (
    Array.isArray(report?.studyPairs) ? report.studyPairs : []
  ).find((p) => p?.id === link?.id);
  const text = measuredLinkText(pair?.best);
  return text ? tl('MEASURED BEST: {text}', { text }) : '';
}
