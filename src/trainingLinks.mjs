/**
 * Study pairs for the world-model bins. A shared hour is not a cause.
 * A side with no reading stays blank. Channels the list does not name
 * are still in the same hour, so a link can show up that this list missed.
 * scripts/world-tape-bin.mjs writes the list beside the bins (links.json)
 * for ml.gevtape.links.
 *
 * The page text (the skill of a prediction, the measured links under STATUS)
 * is English, marked with tl() from src/i18n/marker.js; the server loads this
 * module through src/aiWorldSelection.mjs.
 */
import { localDigits, tl } from './i18n/marker.js';

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
 * The measured lines under STATUS (ml.gevtape.links via the status): the
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
