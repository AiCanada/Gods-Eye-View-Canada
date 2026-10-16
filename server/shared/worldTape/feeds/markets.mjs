/**
 * Live market quotes for every asset in src/marketAssets.mjs (currencies,
 * yields, commodities, stock indexes, volatility, crypto), polled every five
 * minutes. Twelve Data covers forex and gold, and OilPriceAPI covers WTI,
 * copper and fuels, while that source's free cap still has room; its key
 * rides in a header, never the address. Yahoo Finance covers the rest and
 * whatever a cap or a missing key leaves out, 20 symbols a request. A series
 * is written only when its price or exchange time changes. A missing price
 * is not stored as zero. Not a recommendation.
 */
import {
  changedQuotes,
  noteOilLimit,
  noteTwelveLimit,
  oilCodeOf,
  planMarketFetches,
  quotesFromOil,
  quotesFromSpark,
  quotesFromTwelve,
  rollBudget,
  SPARK_BATCH,
  spendOil,
  spendTwelve,
  twelveSymbolOf,
} from '../../marketQuotes.mjs';

const PERIOD_MS = 5 * 60 * 1000;

/** Up to SPARK_BATCH Yahoo symbols in one request. */
export function sparkUrl(symbols) {
  return `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${encodeURIComponent(symbols.join(','))}&range=1d&interval=5m`;
}

/** The address carries the symbols only; the key goes in a header. */
export function twelveQuoteUrl(symbols) {
  return `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(symbols.join(','))}`;
}

export function oilQuoteUrl(codes) {
  return `https://api.oilpriceapi.com/v1/prices/latest?by_code=${encodeURIComponent(codes.join(','))}`;
}

async function readBody(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function creditsUsed(response, fallback) {
  const parsed = Number(response?.headers?.get?.('api-credits-request'));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export default {
  id: 'markets',
  label: 'Financial assets (live quotes)',
  layers: [],
  kind: 'feed',
  class: 'unclear',
  licence:
    'Twelve Data forex and gold, OilPriceAPI WTI, copper and fuels, and Yahoo Finance for yields, stock indexes, other commodities, crypto, and whatever a free cap leaves out. Not a recommendation.',
  cadenceMs: PERIOD_MS,
  phase: 2,
  bytesPerDay: 0.2e6,
  async poll({
    fetch,
    state,
    saveMarkets,
    loadMarketBudget,
    marketKeys,
    signal,
    now,
  }) {
    const impl = fetch || globalThis.fetch;
    const at = typeof now === 'function' ? now() : Date.now();
    state.prints ??= new Map();
    if (!state.budget && typeof loadMarketBudget === 'function')
      state.budget = loadMarketBudget();
    state.budget = rollBudget(state.budget, at);
    const keys = marketKeys || {};
    const plan = planMarketFetches({ now: at, keys, budget: state.budget });
    const parsed = [];
    const filled = new Set();
    const yahoo = [...plan.yahoo];

    if (plan.twelve.length && keys.twelveData) {
      try {
        const symbols = plan.twelve.map(twelveSymbolOf).filter(Boolean);
        const response = await impl(twelveQuoteUrl(symbols), {
          signal,
          headers: {
            Accept: 'application/json',
            Authorization: `apikey ${keys.twelveData}`,
          },
        });
        const body = await readBody(response);
        if (response.status === 429) {
          state.budget = noteTwelveLimit(
            state.budget,
            429,
            body?.message || '',
          );
        } else {
          state.budget = spendTwelve(
            state.budget,
            creditsUsed(response, symbols.length),
          );
        }
        if (response.ok) {
          for (const row of quotesFromTwelve(body, plan.twelve)) {
            parsed.push(row);
            filled.add(row.series);
          }
        }
      } catch {
        /* these series fall through to Yahoo */
      }
      for (const series of plan.twelve)
        if (!filled.has(series.id) && series.symbol) yahoo.push(series);
    }

    if (plan.oil.length && keys.oilPrice) {
      try {
        const codes = plan.oil.map(oilCodeOf).filter(Boolean);
        const response = await impl(oilQuoteUrl(codes), {
          signal,
          headers: {
            Accept: 'application/json',
            Authorization: `Token ${keys.oilPrice}`,
          },
        });
        const body = await readBody(response);
        if (response.status === 429)
          state.budget = noteOilLimit(state.budget, 429);
        else state.budget = spendOil(state.budget, response.headers);
        if (response.ok) {
          for (const row of quotesFromOil(body, plan.oil)) {
            parsed.push(row);
            filled.add(row.series);
          }
        }
      } catch {
        /* these series fall through to Yahoo */
      }
      for (const series of plan.oil)
        if (!filled.has(series.id) && series.symbol) yahoo.push(series);
    }

    const symbols = [
      ...new Set(
        yahoo
          .filter((series) => !filled.has(series.id) && series.symbol)
          .map((series) => series.symbol),
      ),
    ];
    for (let i = 0; i < symbols.length; i += SPARK_BATCH) {
      try {
        const response = await impl(
          sparkUrl(symbols.slice(i, i + SPARK_BATCH)),
          { signal, headers: { Accept: 'application/json' } },
        );
        if (!response.ok) continue;
        for (const row of quotesFromSpark(await readBody(response)))
          parsed.push(row);
      } catch {
        /* these series are skipped this time */
      }
    }

    const { quotes, state: prints } = changedQuotes(state.prints, parsed);
    state.prints = prints;
    if (typeof saveMarkets === 'function') saveMarkets(parsed, state.budget);
    return { records: quotes };
  },
};
