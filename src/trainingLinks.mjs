/**
 * Study pairs for the world-model bins. A shared hour is not a cause.
 * A side with no reading stays blank. Channels the list does not name
 * are still in the same hour, so a link can show up that this list missed.
 */
export const TRAINING_LINKS = Object.freeze([
  Object.freeze({
    id: 'news-prices',
    rank: 'primary',
    reads: ['news.articles', 'news-urls.count', 'markets'],
    note: 'News and a price share an hour. A headline that names a commodity or a currency is counted on that series. Some stories move a price and some do not. The bin does not decide which.',
  }),
  Object.freeze({
    id: 'unplanned',
    rank: 'secondary',
    reads: ['markets', 'every other non-military number in that hour'],
    note: 'Any other recorded number can sit beside a price, including a link nobody named in advance.',
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
    note: 'Tanker, food, metal, and container counts come only from the AIS type or destination text. Other cargo stays cargo. No tonnes are invented.',
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
    note: 'Camera counts and road speed are the measured traffic. Regional fuel use is not metered, so it is not filled in. The gasoline print is a price, not gallons burned.',
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
    note: 'Temperature, rain, and cloud sit beside the wheat price. Crop yield is not estimated.',
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
    note: 'Fire, wind, and quakes are a second look at the same wheat price. They are not scored as damage.',
  }),
  Object.freeze({
    id: 'flights-jet',
    rank: 'primary',
    reads: ['mobility.aircraft', 'markets.jetfuel', 'markets.kerosene'],
    note: 'Civil aircraft counts sit beside jet fuel and jet kerosene when those prints exist. A missing print stays blank.',
  }),
]);

/** Feeds and price series each study pair needs. Military is not in this list. */
const LINK_NEEDS = Object.freeze({
  'news-prices': Object.freeze([
    Object.freeze({ feed: 'news', label: 'news' }),
    Object.freeze({ feed: 'news-urls', label: 'news urls' }),
    Object.freeze({ feed: 'markets', label: 'prices' }),
  ]),
  unplanned: Object.freeze([
    Object.freeze({ feed: 'markets', label: 'prices' }),
  ]),
  'vessel-supply': Object.freeze([
    Object.freeze({ feed: 'ais-live-vessels', label: 'ships' }),
    Object.freeze({ feed: 'markets', series: 'crude', label: 'crude' }),
    Object.freeze({ feed: 'markets', series: 'wheat', label: 'wheat' }),
    Object.freeze({ feed: 'markets', series: 'copper', label: 'copper' }),
  ]),
  'traffic-fuel': Object.freeze([
    Object.freeze({ feed: 'traffic', label: 'traffic' }),
    Object.freeze({ feed: 'cctv', label: 'cameras' }),
    Object.freeze({ feed: 'flights', label: 'flights' }),
    Object.freeze({ feed: 'markets', series: 'gasoline', label: 'gasoline' }),
    Object.freeze({ feed: 'markets', series: 'crude', label: 'crude' }),
  ]),
  farmland: Object.freeze([
    Object.freeze({ feed: 'wind', label: 'forecast weather' }),
    Object.freeze({ feed: 'observed-weather', label: 'observed weather' }),
    Object.freeze({ feed: 'markets', series: 'wheat', label: 'wheat' }),
  ]),
  'farmland-hazards': Object.freeze([
    Object.freeze({ feed: 'local-firms', label: 'fires' }),
    Object.freeze({ feed: 'earthquakes', label: 'quakes' }),
    Object.freeze({ feed: 'wind', label: 'wind' }),
    Object.freeze({ feed: 'markets', series: 'wheat', label: 'wheat' }),
  ]),
  'flights-jet': Object.freeze([
    Object.freeze({ feed: 'flights', label: 'flights' }),
    Object.freeze({ feed: 'markets', series: 'jetfuel', label: 'jet fuel' }),
    Object.freeze({ feed: 'markets', series: 'kerosene', label: 'kerosene' }),
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
      if (!priced.has(need.series)) missing.push(need.label);
      continue;
    }
    if (recorded(feed)) continue;
    if (on) waiting.push(need.label);
    else missing.push(need.label);
  }
  if (link?.id === 'unplanned') {
    const other = [...byId.values()].some(
      (feed) => feed.id !== 'markets' && recorded(feed),
    );
    if (!other) missing.push('another recorded feed');
  }
  const rank = link?.rank === 'primary' ? 'PRIMARY' : 'SECONDARY';
  const state = missing.length
    ? `MISSING ${missing.join(', ')}`
    : waiting.length
      ? `WAITING ${waiting.join(', ')}`
      : 'BOTH SIDES';
  return { state, text: `${rank}: ${state}. ${link?.note || ''}` };
}

/** Held-out error against a persist-the-last-value baseline. Blank if either number is missing. */
export function formatSkill(skill) {
  const model = Number(skill?.model);
  const base = Number(skill?.persistence);
  if (!Number.isFinite(model) || !Number.isFinite(base)) return '';
  return `MAE ${model.toFixed(3)} VS PERSISTENCE ${base.toFixed(3)}`;
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
      ? `${channel} MOVES ${lag} H BEFORE ${asset}`
      : lag < 0
        ? `${asset} MOVES ${-lag} H BEFORE ${channel}`
        : `${channel} AND ${asset} IN THE SAME HOUR`;
  const test = Number(row.rTest);
  const later = row.holds
    ? `HOLDS ON LATER HOURS (R ${Number.isFinite(test) ? test.toFixed(2) : '?'})`
    : 'NOT CONFIRMED ON LATER HOURS';
  return `${order} · R ${r.toFixed(2)} · N ${Number(row.n) || 0} · ${later}`;
}

/**
 * The LINKS list's measured lines (ml.gevtape.links via the status): the
 * strongest links found in the recorded hours, or why there are none yet.
 * A correlation is not a cause and not advice.
 */
export function measuredLinkLines(report, max = 6) {
  if (!report || typeof report !== 'object') return [];
  if (report.reason)
    return [
      `MEASURED: ${String(report.reason).toUpperCase()} (${Number(report.hours) || 0} H BINNED)`,
    ];
  const rows = (Array.isArray(report.top) ? report.top : [])
    .map(measuredLinkText)
    .filter(Boolean)
    .slice(0, max);
  return rows.length
    ? rows.map((line) => `MEASURED: ${line}`)
    : [`MEASURED: NO LINK YET (${Number(report.hours) || 0} H BINNED)`];
}

/** The strongest measured link between a study pair's two sides, or ''. */
export function linkMeasured(link, report) {
  const pair = (
    Array.isArray(report?.studyPairs) ? report.studyPairs : []
  ).find((p) => p?.id === link?.id);
  const text = measuredLinkText(pair?.best);
  return text ? `MEASURED BEST: ${text}` : '';
}
