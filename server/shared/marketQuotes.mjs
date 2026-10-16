/**
 * Live market quotes for the AI World tab.
 *
 * The latest traded price: Twelve Data and OilPriceAPI while their free caps
 * have room, else Yahoo Finance (its spark endpoint, up to 20 symbols a
 * request). This is not the ECB daily fix and not a monthly commodity file.
 * A missing price is omitted. Nothing here is a recommendation.
 */
import { MARKET_ASSETS } from '../../src/marketAssets.mjs';

/**
 * Every recorded series: the shared asset catalog (src/marketAssets.mjs),
 * so the tape, the bins, the headline counts and the globe agree.
 */
export const MARKET_SERIES = MARKET_ASSETS;

const BY_SYMBOL = new Map(
  MARKET_SERIES.filter((series) => series.symbol).map((series) => [
    series.symbol,
    series,
  ]),
);
const BY_ID = new Map(MARKET_SERIES.map((series) => [series.id, series]));

/** Free-plan symbols. Yields and wheat stay on the Yahoo symbol above. */
const KEYED = Object.freeze({
  eurusd: Object.freeze({ twelve: 'EUR/USD' }),
  usdjpy: Object.freeze({ twelve: 'USD/JPY' }),
  gbpusd: Object.freeze({ twelve: 'GBP/USD' }),
  usdchf: Object.freeze({ twelve: 'USD/CHF' }),
  usdcad: Object.freeze({ twelve: 'USD/CAD' }),
  gold: Object.freeze({ twelve: 'XAU/USD', oil: 'GOLD_USD' }),
  crude: Object.freeze({ oil: 'WTI_USD' }),
  copper: Object.freeze({ oil: 'COPPER_USD' }),
  gasoline: Object.freeze({ oil: 'GASOLINE_USD' }),
  jetfuel: Object.freeze({ oil: 'JET_FUEL_USD' }),
  kerosene: Object.freeze({ oil: 'SINGAPORE_JET_KEROSENE_USD' }),
});

export const TWELVE_DAY_CAP = 800;
export const TWELVE_MINUTE_CAP = 8;
export const OIL_DAY_CAP = 50;

function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function utcMinute(ms) {
  return new Date(ms).toISOString().slice(0, 16);
}

function quote(series, value, quotedAt, source, symbol) {
  return {
    series: series.id,
    symbol,
    label: series.label,
    unit: series.unit,
    group: series.group,
    value,
    quotedAt,
    source,
    cadence: 'live',
  };
}

/** A new UTC day clears the counters. A new minute clears only the minute count. */
export function rollBudget(budget, nowMs) {
  const day = utcDay(nowMs);
  const minute = utcMinute(nowMs);
  const sameDay = budget && budget.day === day;
  const next = {
    day,
    twelve: sameDay ? Number(budget.twelve) || 0 : 0,
    oil: sameDay ? Number(budget.oil) || 0 : 0,
    oilCap:
      sameDay && Number(budget.oilCap) > OIL_DAY_CAP
        ? Number(budget.oilCap)
        : OIL_DAY_CAP,
    minute,
    twelveMinute:
      sameDay && budget.minute === minute
        ? Number(budget.twelveMinute) || 0
        : 0,
  };
  return next;
}

/**
 * Twelve Data first for forex and gold, then OilPriceAPI for WTI, copper,
 * and gold when the Twelve Data cap is used. One OilPriceAPI call covers
 * every series sent there. The rest stay on Yahoo.
 */
export function planMarketFetches({
  now = Date.now(),
  keys,
  budget,
  series = MARKET_SERIES,
} = {}) {
  const state = rollBudget(budget, now);
  const twelveKey = String(keys?.twelveData || '').trim();
  const oilKey = String(keys?.oilPrice || '').trim();
  let twelveRoom = Math.min(
    TWELVE_DAY_CAP - state.twelve,
    TWELVE_MINUTE_CAP - state.twelveMinute,
  );
  const oilOpen = Boolean(oilKey) && state.oil < state.oilCap;
  const twelve = [];
  const oil = [];
  const yahoo = [];
  for (const item of series) {
    const feed = KEYED[item.id] || {};
    if (feed.twelve && twelveKey && twelveRoom > 0) {
      twelve.push(item);
      twelveRoom -= 1;
      continue;
    }
    if (feed.oil && oilOpen) {
      oil.push(item);
      continue;
    }
    if (item.symbol) yahoo.push(item);
  }
  return { twelve, oil, yahoo, budget: state };
}

export function spendTwelve(budget, credits) {
  const used = Math.max(0, Number(credits) || 0);
  return {
    ...budget,
    twelve: (Number(budget.twelve) || 0) + used,
    twelveMinute: (Number(budget.twelveMinute) || 0) + used,
  };
}

export function spendOil(budget, headers) {
  const next = { ...budget, oil: (Number(budget.oil) || 0) + 1 };
  const tier = String(headerValue(headers, 'x-ratelimit-tier') || '');
  const limit = Number(headerValue(headers, 'x-ratelimit-limit'));
  if (/trial/i.test(tier) && Number.isFinite(limit) && limit > next.oilCap) {
    next.oilCap = Math.min(limit, 10000);
  }
  return next;
}

function headerValue(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return headers.get(name);
  return headers[name] || headers[name.toLowerCase()] || '';
}

/** A minute limit blocks the rest of this minute. A day limit blocks the rest of the UTC day. */
export function noteTwelveLimit(budget, status, message) {
  if (Number(status) !== 429) return budget;
  const text = String(message || '').toLowerCase();
  if (text.includes('day')) return { ...budget, twelve: TWELVE_DAY_CAP };
  return { ...budget, twelveMinute: TWELVE_MINUTE_CAP };
}

export function noteOilLimit(budget, status) {
  if (Number(status) !== 429) return budget;
  return { ...budget, oil: Number(budget.oilCap) || OIL_DAY_CAP };
}

export function quotesFromTwelve(body, seriesList) {
  const out = [];
  for (const item of seriesList || []) {
    const series = BY_ID.get(item.id || item);
    const symbol = KEYED[series?.id]?.twelve;
    if (!series || !symbol) continue;
    const row = twelveRow(body, symbol);
    const value = Number(row?.close ?? row?.price);
    if (!Number.isFinite(value)) continue;
    const seconds = Number(row.last_quote_at ?? row.timestamp);
    out.push(
      quote(
        series,
        value,
        Number.isFinite(seconds) ? seconds * 1000 : null,
        'Twelve Data',
        symbol,
      ),
    );
  }
  return out;
}

function twelveRow(body, symbol) {
  if (!body || typeof body !== 'object') return null;
  const direct = body[symbol];
  if (direct && typeof direct === 'object') return direct;
  if (body.symbol === symbol) return body;
  return null;
}

export function quotesFromOil(body, seriesList) {
  const rows = oilRows(body);
  const byCode = new Map(rows.map((row) => [row.code, row]));
  const out = [];
  for (const item of seriesList || []) {
    const series = BY_ID.get(item.id || item);
    const code = KEYED[series?.id]?.oil;
    const row = code ? byCode.get(code) : null;
    const value = Number(row?.price);
    if (!series || !Number.isFinite(value)) continue;
    const parsed = Date.parse(row.updated_at || row.collected_at || '');
    out.push(
      quote(
        series,
        value,
        Number.isFinite(parsed) ? parsed : null,
        'OilPriceAPI',
        code,
      ),
    );
  }
  return out;
}

function oilRows(body) {
  const data = body?.data;
  if (Array.isArray(data?.prices)) return data.prices;
  if (data?.code) return [data];
  return [];
}

export function twelveSymbolOf(series) {
  return KEYED[series?.id]?.twelve || '';
}

export function oilCodeOf(series) {
  return KEYED[series?.id]?.oil || '';
}

/**
 * One Yahoo chart body into a quote, or null when the price is missing.
 * An unknown symbol is ignored.
 */
export function quoteFromChart(symbol, body) {
  const series = BY_SYMBOL.get(symbol);
  if (!series) return null;
  const meta = body?.chart?.result?.[0]?.meta;
  const value = Number(meta?.regularMarketPrice);
  if (!Number.isFinite(value)) return null;
  const seconds = Number(meta?.regularMarketTime);
  return {
    series: series.id,
    symbol,
    label: series.label,
    unit: series.unit,
    group: series.group,
    value,
    quotedAt: Number.isFinite(seconds) ? seconds * 1000 : null,
    source: 'Yahoo Finance',
    cadence: 'live',
  };
}

/** Yahoo's spark endpoint answers at most this many symbols a request. */
export const SPARK_BATCH = 20;

/**
 * One Yahoo spark body into quotes, by symbol (the answer's order is not
 * the request's). A symbol with no price, or one not in the catalog, is
 * left out.
 */
export function quotesFromSpark(body) {
  const out = [];
  for (const row of Array.isArray(body?.spark?.result)
    ? body.spark.result
    : []) {
    const quote = quoteFromChart(row?.symbol, {
      chart: { result: [{ meta: row?.response?.[0]?.meta }] },
    });
    if (quote) out.push(quote);
  }
  return out;
}

/** Keep a quote only when its price or exchange time changed. */
export function changedQuotes(previous, quotes) {
  const prior = previous instanceof Map ? previous : new Map();
  const next = [];
  for (const quote of quotes || []) {
    if (!quote || !Number.isFinite(quote.value)) continue;
    const sig = `${quote.value}|${quote.quotedAt ?? ''}`;
    if (prior.get(quote.series) === sig) continue;
    prior.set(quote.series, sig);
    next.push(quote);
  }
  return { quotes: next, state: prior };
}
