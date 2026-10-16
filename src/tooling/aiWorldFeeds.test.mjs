import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addNewsUrl,
  cleanNewsUrl,
  isPrivateHost,
  itemsFromFeed,
  titleFromHtml,
} from '../../server/shared/newsUrls.mjs';
import {
  changedQuotes,
  MARKET_SERIES,
  noteTwelveLimit,
  planMarketFetches,
  quoteFromChart,
  quotesFromOil,
  quotesFromSpark,
  quotesFromTwelve,
  SPARK_BATCH,
} from '../../server/shared/marketQuotes.mjs';

/** A Yahoo spark answer for every symbol the request names. */
function sparkAnswer(url, price) {
  const symbols = decodeURIComponent(
    new URL(url).searchParams.get('symbols') || '',
  ).split(',');
  return {
    ok: true,
    status: 200,
    headers: { get: () => '' },
    json: async () => ({
      spark: {
        result: symbols.reverse().map((symbol) => ({
          symbol,
          response: [
            { meta: { regularMarketPrice: price, regularMarketTime: 60 } },
          ],
        })),
      },
    }),
  };
}
import {
  NEWS_MARKET_CHANNELS,
  seriesMentioned,
} from '../../src/newsMarketMention.mjs';
import { MARKET_ASSETS, priceMove } from '../../src/marketAssets.mjs';
import marketsFeed from '../../server/shared/worldTape/feeds/markets.mjs';
import { sstRecord } from '../../server/shared/worldTape/feeds/sea-surface-temperature.mjs';
import { weatherRecord } from '../../server/shared/worldTape/feeds/observed-weather.mjs';
import { buildCatalog } from '../../server/shared/worldTape/catalog.mjs';
import cctvVideo from '../../server/shared/worldTape/feeds/cctv-video.mjs';
import { airRecord } from '../../server/shared/worldTape/feeds/air-quality.mjs';
import airQuality from '../../server/shared/worldTape/feeds/air-quality.mjs';
import {
  gaugeRecord,
  isUsPoint,
} from '../../server/shared/worldTape/feeds/stream-gauges.mjs';
import streamGauges from '../../server/shared/worldTape/feeds/stream-gauges.mjs';

test('a news URL is public https, and the list stops at 100', () => {
  assert.equal(cleanNewsUrl('http://example.com/a'), null);
  assert.equal(cleanNewsUrl('https://user:pw@example.com/a'), null);
  assert.equal(cleanNewsUrl('https://127.0.0.1/a'), null);
  assert.equal(isPrivateHost('10.1.2.3'), true);
  assert.equal(isPrivateHost('8.8.8.8'), false);
  const url = cleanNewsUrl('https://example.com/rss');
  assert.equal(url, 'https://example.com/rss');
  let list = [];
  for (let i = 0; i < 100; i += 1)
    list = addNewsUrl(list, `https://example.com/${i}`);
  assert.equal(list.length, 100);
  assert.throws(
    () => addNewsUrl(list, 'https://example.com/more'),
    (error) => error.status === 409,
  );
  assert.equal(addNewsUrl(list, list[0]).length, 100);
});

test('RSS keeps the title and link, and HTML keeps only the title', () => {
  const items = itemsFromFeed(
    '<rss><channel><item><title>Storm</title><link>https://news.example/storm</link><description>full body</description></item></channel></rss>',
    'https://news.example/rss',
  );
  assert.deepEqual(items, [
    { title: 'Storm', url: 'https://news.example/storm' },
  ]);
  assert.equal(JSON.stringify(items).includes('full body'), false);
  assert.equal(
    titleFromHtml('<html><title>Headline</title><p>body</p></html>'),
    'Headline',
  );
});

test('headline channels stay in the same order as the price series', () => {
  assert.deepEqual(
    NEWS_MARKET_CHANNELS,
    MARKET_SERIES.map((series) => series.id),
  );
});

test('every asset has a symbol or a keyed source, unique ids, and a place on the globe unless it has no home', () => {
  const ids = MARKET_ASSETS.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length);
  const groups = new Set(MARKET_ASSETS.map((a) => a.group));
  for (const group of [
    'fx',
    'yield',
    'commodity',
    'equity',
    'volatility',
    'crypto',
  ])
    assert.ok(groups.has(group), group);
  for (const a of MARKET_ASSETS) {
    assert.ok(a.symbol || ['jetfuel', 'kerosene'].includes(a.id), a.id);
    assert.ok(a.mentions.length > 0, a.id);
    if (a.group === 'crypto') assert.equal(a.hub, null, a.id);
    else {
      assert.ok(Math.abs(a.hub.lat) <= 90 && Math.abs(a.hub.lon) <= 180, a.id);
      assert.ok(a.hub.name, a.id);
    }
  }
  // A Yahoo spark answer, in any order, maps back by symbol.
  const quotes = quotesFromSpark({
    spark: {
      result: [
        {
          symbol: '^GSPTSE',
          response: [
            { meta: { regularMarketPrice: 36000, regularMarketTime: 5 } },
          ],
        },
        { symbol: 'NOPE', response: [{ meta: { regularMarketPrice: 1 } }] },
        { symbol: 'BTC-USD', response: [{ meta: {} }] },
      ],
    },
  });
  assert.deepEqual(
    quotes.map((q) => [q.series, q.value, q.quotedAt]),
    [['tsx', 36000, 5000]],
  );
  assert.deepEqual(
    seriesMentioned('Nikkei slides as yen firms; bitcoin flat'),
    ['usdjpy', 'nikkei', 'bitcoin'],
  );
  assert.deepEqual(
    seriesMentioned('Europe weighs a new plan'),
    [],
    'Europe is not the euro',
  );
  assert.equal(priceMove(100, 101).text, '▲ 1.00%');
  assert.equal(priceMove(100, 99.5).text, '▼ 0.50%');
  assert.equal(priceMove(null, 1), null);
});

test('a live quote is the latest price, and an unknown symbol or a repeat is dropped', () => {
  const quote = quoteFromChart('EURUSD=X', {
    chart: {
      result: [{ meta: { regularMarketPrice: 1.08, regularMarketTime: 100 } }],
    },
  });
  assert.equal(quote.series, 'eurusd');
  assert.equal(quote.value, 1.08);
  assert.equal(quote.cadence, 'live');
  assert.equal(
    quoteFromChart('NOPE', {
      chart: { result: [{ meta: { regularMarketPrice: 1 } }] },
    }),
    null,
  );
  assert.equal(
    quoteFromChart('CL=F', { chart: { result: [{ meta: {} }] } }),
    null,
  );
  const first = changedQuotes(new Map(), [quote]);
  assert.equal(first.quotes.length, 1);
  const again = changedQuotes(first.state, [quote]);
  assert.equal(again.quotes.length, 0);
});

test('SST and observed weather records keep the number and skip a blank reading', () => {
  const area = { key: '1,2', name: 'Here', lat: 1, lon: 2 };
  const sst = sstRecord(area, {
    sstRange: { min: 10, max: 14 },
    startDate: '2026-10-13',
    fronts: { cells: 3 },
  });
  assert.equal(sst.value, 12);
  assert.equal(sst.fronts, 3);
  assert.equal(sstRecord(area, {}), null);
  const weather = weatherRecord(area, {
    temperatureC: 21.2,
    precipitationMm: 0,
    observedAt: '2026-10-14T00:00:00Z',
  });
  assert.equal(weather.value, 21.2);
  assert.equal(weatherRecord(area, {}), null);
});

test('a school camera is not asked for a clip', async () => {
  let called = false;
  const got = await cctvVideo.poll({
    now: () => Date.UTC(2026, 9, 14),
    areas: [{ key: '1,2', name: 'Here', lat: 42.3, lon: -71, radiusKm: 50 }],
    state: {},
    fetch: async () => {
      called = true;
      return {
        ok: false,
        headers: { get: () => '' },
        body: { cancel: async () => {} },
      };
    },
    services: {
      cctv: {
        async getCatalog() {
          return {
            sources: [
              {
                id: 'school-1',
                name: 'Lincoln Elementary School',
                lat: 42.3,
                lon: -71,
                feedType: 'hls',
                videoUrl: 'https://cameras.example/school.m3u8',
              },
            ],
          };
        },
      },
    },
  });
  assert.equal(called, false);
  assert.deepEqual(got.files, []);
});

test('a keyed quote is used until its free cap, and a minute limit falls back to Yahoo', async () => {
  const twelve = quotesFromTwelve(
    { 'EUR/USD': { close: '1.08', last_quote_at: 100 } },
    [{ id: 'eurusd' }],
  );
  assert.equal(twelve[0].source, 'Twelve Data');
  assert.equal(twelve[0].value, 1.08);
  assert.equal(twelve[0].quotedAt, 100000);
  const oil = quotesFromOil(
    {
      data: {
        prices: [
          { code: 'WTI_USD', price: 70.5, updated_at: '2026-10-14T00:00:00Z' },
        ],
      },
    },
    [{ id: 'crude' }],
  );
  assert.equal(oil[0].source, 'OilPriceAPI');
  assert.equal(oil[0].value, 70.5);
  const open = planMarketFetches({
    now: Date.UTC(2026, 9, 14),
    keys: { twelveData: 'k', oilPrice: 'o' },
  });
  assert.deepEqual(
    open.twelve.map((series) => series.id),
    ['eurusd', 'usdjpy', 'gbpusd', 'usdchf', 'usdcad', 'gold'],
  );
  assert.deepEqual(
    open.oil.map((series) => series.id),
    ['crude', 'copper', 'gasoline', 'jetfuel', 'kerosene'],
  );
  // Everything else with a Yahoo symbol: yields, the other currencies and
  // commodities, stock indexes, volatility and crypto.
  assert.deepEqual(
    open.yahoo.map((series) => series.id),
    MARKET_SERIES.filter(
      (series) =>
        series.symbol &&
        !open.twelve.includes(series) &&
        !open.oil.includes(series),
    ).map((series) => series.id),
  );
  for (const id of [
    'us10y',
    'wheat',
    'sp500',
    'tsx',
    'nikkei',
    'bitcoin',
    'vix',
    'brent',
  ])
    assert.ok(
      open.yahoo.some((series) => series.id === id),
      id,
    );
  const full = planMarketFetches({
    now: Date.UTC(2026, 9, 14),
    keys: { twelveData: 'k', oilPrice: 'o' },
    budget: {
      day: '2026-10-14',
      twelve: 800,
      oil: 0,
      oilCap: 50,
      minute: '2026-10-14T00:00',
      twelveMinute: 0,
    },
  });
  assert.equal(full.twelve.length, 0);
  assert.equal(
    full.yahoo.some((series) => series.id === 'eurusd'),
    true,
  );
  assert.equal(
    full.oil.some((series) => series.id === 'gold'),
    true,
  );
  assert.equal(
    noteTwelveLimit({ twelveMinute: 0 }, 429, 'current minute').twelveMinute,
    8,
  );

  const urls = [];
  const headers = [];
  const got = await marketsFeed.poll({
    now: () => Date.UTC(2026, 9, 14),
    state: {},
    marketKeys: { twelveData: 'test-twelve', oilPrice: 'test-oil' },
    saveMarkets() {},
    fetch: async (url, init) => {
      urls.push(String(url));
      headers.push(init?.headers || {});
      if (String(url).includes('twelvedata')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => '6' },
          json: async () => ({
            'EUR/USD': { close: '1.1', last_quote_at: 50 },
            'USD/JPY': { close: '150', last_quote_at: 50 },
            'GBP/USD': { close: '1.3', last_quote_at: 50 },
            'USD/CHF': { close: '0.8', last_quote_at: 50 },
            'USD/CAD': { close: '1.3', last_quote_at: 50 },
            'XAU/USD': { close: '2400', last_quote_at: 50 },
          }),
        };
      }
      if (String(url).includes('oilpriceapi')) {
        return {
          ok: true,
          status: 200,
          headers: {
            get: (name) =>
              name === 'x-ratelimit-tier' ? 'professional_trial' : '10000',
          },
          json: async () => ({
            data: {
              prices: [
                {
                  code: 'WTI_USD',
                  price: 70,
                  updated_at: '2026-10-14T00:00:00Z',
                },
                {
                  code: 'COPPER_USD',
                  price: 4,
                  updated_at: '2026-10-14T00:00:00Z',
                },
                {
                  code: 'GASOLINE_USD',
                  price: 2,
                  updated_at: '2026-10-14T00:00:00Z',
                },
                {
                  code: 'JET_FUEL_USD',
                  price: 80,
                  updated_at: '2026-10-14T00:00:00Z',
                },
                {
                  code: 'SINGAPORE_JET_KEROSENE_USD',
                  price: 79,
                  updated_at: '2026-10-14T00:00:00Z',
                },
              ],
            },
          }),
        };
      }
      return sparkAnswer(url, 4.2);
    },
  });
  assert.equal(
    urls.some(
      (url) => url.includes('twelvedata.com') && url.includes('EUR%2FUSD'),
    ),
    true,
  );
  assert.equal(
    urls.some((url) => /apikey|test-twelve/i.test(url)),
    false,
    'the Twelve Data key never rides in the address',
  );
  assert.equal(
    headers.some((h) => h.Authorization === 'apikey test-twelve'),
    true,
  );
  assert.equal(
    urls.some(
      (url) => url.includes('oilpriceapi.com') && url.includes('WTI_USD'),
    ),
    true,
  );
  const yahooUrls = urls.filter((url) => url.includes('finance.yahoo.com'));
  assert.equal(
    yahooUrls.length,
    Math.ceil(open.yahoo.length / SPARK_BATCH),
    'the rest in batches of 20',
  );
  assert.equal(got.records.length, MARKET_SERIES.length);
  assert.equal(
    got.records.find((row) => row.series === 'eurusd').source,
    'Twelve Data',
  );
  assert.equal(
    got.records.find((row) => row.series === 'crude').source,
    'OilPriceAPI',
  );
  assert.equal(
    got.records.find((row) => row.series === 'wheat').source,
    'Yahoo Finance',
  );

  const limited = [];
  await marketsFeed.poll({
    now: () => Date.UTC(2026, 9, 14, 0, 5),
    state: {},
    marketKeys: { twelveData: 'test-twelve' },
    fetch: async (url) => {
      limited.push(String(url));
      if (String(url).includes('twelvedata')) {
        return {
          ok: false,
          status: 429,
          headers: { get: () => '' },
          json: async () => ({
            message: 'You have run out of API credits for the current minute.',
          }),
        };
      }
      return sparkAnswer(url, 1);
    },
  });
  assert.equal(limited.filter((url) => url.includes('twelvedata')).length, 1);
  assert.equal(
    limited.some((url) => decodeURIComponent(url).includes('EURUSD=X')),
    true,
    'a limited series falls back to Yahoo',
  );
});

test('air quality skips a blank, and a gauge outside the US is not fetched', async () => {
  const area = { key: 'a', name: 'Here', lat: 42.36, lon: -71.06 };
  assert.equal(airRecord(area, { current: {} }), null);
  assert.equal(
    airRecord(area, { current: { pm2_5: 12.2, time: '2026-10-14T00:00' } })
      .pm25,
    12.2,
  );
  assert.equal(isUsPoint(51.5, -0.12), false);
  assert.equal(isUsPoint(42.36, -71.06), true);
  let called = false;
  const abroad = await streamGauges.poll({
    areas: [
      { key: 'lon', name: 'London', lat: 51.5, lon: -0.12, radiusKm: 30 },
    ],
    state: {},
    fetch: async () => {
      called = true;
      return { ok: true, json: async () => ({}) };
    },
  });
  assert.equal(called, false);
  assert.deepEqual(abroad.records, []);
  assert.equal(
    gaugeRecord(
      area,
      { value: { timeSeries: [{ sourceInfo: { siteName: 'Dry' } }] } },
      () => 1,
    ),
    null,
  );
  const hit = gaugeRecord(
    area,
    {
      value: {
        timeSeries: [
          {
            sourceInfo: {
              siteName: 'Charles',
              siteCode: [{ value: '01104500' }],
              geoLocation: {
                geogLocation: { latitude: 42.36, longitude: -71.06 },
              },
            },
            values: [
              { value: [{ value: '120', dateTime: '2026-10-14T00:00:00Z' }] },
            ],
          },
        ],
      },
    },
    () => 2,
  );
  assert.equal(hit.dischargeCfs, 120);
  assert.equal(hit.site, '01104500');
  const quiet = await airQuality.poll({
    areas: [area],
    state: {},
    fetch: async () => ({ ok: true, json: async () => ({ current: {} }) }),
  });
  assert.deepEqual(quiet.records, []);
});

test('the catalog lists the new feeds and still omits nothing military from the id list by accident', () => {
  const ids = buildCatalog().map((item) => item.id);
  for (const id of [
    'sea-surface-temperature',
    'observed-weather',
    'cctv-video',
    'news-urls',
    'markets',
    'air-quality',
    'stream-gauges',
  ])
    assert.ok(ids.includes(id), id);
});

test('a news URL that redirects into this machine’s own network is refused; a public page is read', async () => {
  const { default: newsUrlsFeed } =
    await import('../../server/shared/worldTape/feeds/news-urls.mjs');
  const asked = [];
  const fetch = async (url, init) => {
    asked.push([url, init.redirect]);
    if (url.includes('/sneaky'))
      return {
        ok: false,
        status: 302,
        headers: {
          get: (n) =>
            n === 'location' ? 'https://router.internal/admin' : null,
        },
        body: { cancel: async () => {} },
      };
    return {
      ok: true,
      status: 200,
      headers: { get: (n) => (n === 'content-type' ? 'text/html' : null) },
      text: async () => '<html><title>Port reopens</title></html>',
    };
  };
  const lookup = async (host) =>
    host === 'router.internal'
      ? [{ address: '192.168.1.1' }]
      : [{ address: '93.184.216.34' }];
  const got = await newsUrlsFeed.poll({
    fetch,
    lookup,
    newsUrls: ['https://news.example/sneaky', 'https://news.example/page'],
    state: {},
  });
  assert.deepEqual(
    got.records.map((r) => r.title),
    ['Port reopens'],
  );
  assert.ok(asked.every(([, redirect]) => redirect === 'manual'));
  assert.equal(
    asked.some(([url]) => url.includes('router.internal')),
    false,
    'the private address was never asked',
  );
});
