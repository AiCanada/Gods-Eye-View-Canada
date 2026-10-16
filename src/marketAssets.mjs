/**
 * The financial assets the Artificial Intelligence World Training Sim
 * records, trains on and predicts (owner request 2026-10-15: "financial
 * assets … Predict all actions and price movements on globe").
 *
 * One row per asset:
 * - `id`: the channel name in the bins (`markets.<id>`, `news-markets.<id>`);
 * - `symbol`: its Yahoo Finance symbol ('' when only a keyed source has it);
 * - `group`: fx, yield, commodity, equity, volatility or crypto;
 * - `hub`: where its benchmark is priced or delivered, so a predicted move
 *   can be drawn there on the globe. Null for an asset with no home (crypto
 *   trades everywhere): listed, never placed;
 * - `mentions`: the words in a headline that name it. A mention is a count,
 *   not a claim that the story moved the price.
 *
 * Prices are a readout, not advice.
 */

const hub = (name, lat, lon) => Object.freeze({ name, lat, lon });

// Places several assets share.
const NEW_YORK = hub('New York', 40.7069, -74.0113);
const NEW_YORK_HARBOR = hub('New York Harbor', 40.6676, -74.0446);
const CHICAGO = hub('Chicago', 41.8781, -87.6298);
const LONDON = hub('London', 51.5136, -0.089);
const FRANKFURT = hub('Frankfurt', 50.1109, 8.6821);
const TOKYO = hub('Tokyo', 35.6812, 139.7671);
const MUMBAI = hub('Mumbai', 18.9298, 72.8333);
const SYDNEY = hub('Sydney', -33.8688, 151.2093);

const asset = (fields) =>
  Object.freeze({ ...fields, mentions: Object.freeze(fields.mentions) });

export const MARKET_ASSETS = Object.freeze([
  // Currencies, each at its central bank's city.
  asset({
    id: 'eurusd',
    symbol: 'EURUSD=X',
    label: 'EUR / USD',
    unit: 'usd',
    group: 'fx',
    hub: FRANKFURT,
    mentions: ['eur usd', 'euro'],
  }),
  asset({
    id: 'usdjpy',
    symbol: 'USDJPY=X',
    label: 'USD / JPY',
    unit: 'jpy',
    group: 'fx',
    hub: TOKYO,
    mentions: ['usd jpy', 'yen'],
  }),
  asset({
    id: 'gbpusd',
    symbol: 'GBPUSD=X',
    label: 'GBP / USD',
    unit: 'usd',
    group: 'fx',
    hub: LONDON,
    mentions: ['gbp usd', 'sterling'],
  }),
  asset({
    id: 'usdchf',
    symbol: 'USDCHF=X',
    label: 'USD / CHF',
    unit: 'chf',
    group: 'fx',
    hub: hub('Zurich', 47.3769, 8.5417),
    mentions: ['usd chf', 'swiss franc'],
  }),
  asset({
    id: 'usdcad',
    symbol: 'USDCAD=X',
    label: 'USD / CAD',
    unit: 'cad',
    group: 'fx',
    hub: hub('Ottawa', 45.4206, -75.7036),
    mentions: ['usd cad', 'canadian dollar', 'loonie'],
  }),
  asset({
    id: 'audusd',
    symbol: 'AUDUSD=X',
    label: 'AUD / USD',
    unit: 'usd',
    group: 'fx',
    hub: SYDNEY,
    mentions: ['aud usd', 'australian dollar'],
  }),
  asset({
    id: 'usdcny',
    symbol: 'USDCNY=X',
    label: 'USD / CNY',
    unit: 'cny',
    group: 'fx',
    hub: hub('Beijing', 39.9042, 116.4074),
    mentions: ['usd cny', 'yuan', 'renminbi'],
  }),
  asset({
    id: 'usdinr',
    symbol: 'USDINR=X',
    label: 'USD / INR',
    unit: 'inr',
    group: 'fx',
    hub: MUMBAI,
    mentions: ['usd inr', 'rupee'],
  }),
  asset({
    id: 'usdmxn',
    symbol: 'USDMXN=X',
    label: 'USD / MXN',
    unit: 'mxn',
    group: 'fx',
    hub: hub('Mexico City', 19.4326, -99.1332),
    mentions: ['usd mxn', 'mexican peso'],
  }),
  asset({
    id: 'dxy',
    symbol: 'DX-Y.NYB',
    label: 'US dollar index',
    unit: 'index',
    group: 'fx',
    hub: NEW_YORK,
    mentions: ['dollar index', 'dxy'],
  }),
  // US Treasury yields.
  asset({
    id: 'us5y',
    symbol: '^FVX',
    label: 'US 5-year yield',
    unit: 'percent',
    group: 'yield',
    hub: NEW_YORK,
    mentions: ['5 year'],
  }),
  asset({
    id: 'us10y',
    symbol: '^TNX',
    label: 'US 10-year yield',
    unit: 'percent',
    group: 'yield',
    hub: NEW_YORK,
    mentions: ['10 year'],
  }),
  asset({
    id: 'us30y',
    symbol: '^TYX',
    label: 'US 30-year yield',
    unit: 'percent',
    group: 'yield',
    hub: NEW_YORK,
    mentions: ['30 year'],
  }),
  // Commodities, each at its benchmark's delivery or pricing point.
  asset({
    id: 'crude',
    symbol: 'CL=F',
    label: 'WTI crude',
    unit: 'usd',
    group: 'commodity',
    hub: hub('Cushing, Oklahoma', 35.9851, -96.767),
    mentions: ['crude', 'wti', 'oil'],
  }),
  asset({
    id: 'brent',
    symbol: 'BZ=F',
    label: 'Brent crude',
    unit: 'usd',
    group: 'commodity',
    hub: hub('North Sea (Brent)', 61.03, 1.71),
    mentions: ['brent'],
  }),
  asset({
    id: 'natgas',
    symbol: 'NG=F',
    label: 'Natural gas (Henry Hub)',
    unit: 'usd',
    group: 'commodity',
    hub: hub('Henry Hub, Louisiana', 29.9593, -92.036),
    mentions: ['natural gas', 'henry hub', 'lng'],
  }),
  asset({
    id: 'gold',
    symbol: 'GC=F',
    label: 'Gold',
    unit: 'usd',
    group: 'commodity',
    hub: LONDON,
    mentions: ['gold'],
  }),
  asset({
    id: 'silver',
    symbol: 'SI=F',
    label: 'Silver',
    unit: 'usd',
    group: 'commodity',
    hub: NEW_YORK,
    mentions: ['silver'],
  }),
  asset({
    id: 'wheat',
    symbol: 'ZW=F',
    label: 'Wheat',
    unit: 'usd',
    group: 'commodity',
    hub: CHICAGO,
    mentions: ['wheat', 'grain'],
  }),
  asset({
    id: 'corn',
    symbol: 'ZC=F',
    label: 'Corn',
    unit: 'usd',
    group: 'commodity',
    hub: CHICAGO,
    mentions: ['corn', 'maize'],
  }),
  asset({
    id: 'soybeans',
    symbol: 'ZS=F',
    label: 'Soybeans',
    unit: 'usd',
    group: 'commodity',
    hub: CHICAGO,
    mentions: ['soybean', 'soybeans', 'soy'],
  }),
  asset({
    id: 'copper',
    symbol: 'HG=F',
    label: 'Copper',
    unit: 'usd',
    group: 'commodity',
    hub: NEW_YORK,
    mentions: ['copper'],
  }),
  asset({
    id: 'gasoline',
    symbol: 'RB=F',
    label: 'RBOB gasoline',
    unit: 'usd',
    group: 'commodity',
    hub: NEW_YORK_HARBOR,
    mentions: ['gasoline', 'petrol', 'rbob'],
  }),
  asset({
    id: 'heatingoil',
    symbol: 'HO=F',
    label: 'Heating oil',
    unit: 'usd',
    group: 'commodity',
    hub: NEW_YORK_HARBOR,
    mentions: ['heating oil', 'diesel'],
  }),
  asset({
    id: 'jetfuel',
    symbol: '',
    label: 'Jet fuel',
    unit: 'usd',
    group: 'commodity',
    hub: hub('US Gulf Coast', 29.7604, -95.3698),
    mentions: ['jet fuel'],
  }),
  asset({
    id: 'kerosene',
    symbol: '',
    label: 'Jet kerosene',
    unit: 'usd',
    group: 'commodity',
    hub: hub('Singapore', 1.2903, 103.8519),
    mentions: ['kerosene'],
  }),
  // Stock indexes, each at its exchange.
  asset({
    id: 'sp500',
    symbol: '^GSPC',
    label: 'S&P 500',
    unit: 'points',
    group: 'equity',
    hub: NEW_YORK,
    mentions: ['s&p 500', 's&p500', 'wall street'],
  }),
  asset({
    id: 'dow',
    symbol: '^DJI',
    label: 'Dow Jones',
    unit: 'points',
    group: 'equity',
    hub: NEW_YORK,
    mentions: ['dow jones', 'the dow'],
  }),
  asset({
    id: 'nasdaq',
    symbol: '^IXIC',
    label: 'Nasdaq Composite',
    unit: 'points',
    group: 'equity',
    hub: NEW_YORK,
    mentions: ['nasdaq'],
  }),
  asset({
    id: 'tsx',
    symbol: '^GSPTSE',
    label: 'S&P/TSX Composite',
    unit: 'points',
    group: 'equity',
    hub: hub('Toronto', 43.6481, -79.3815),
    mentions: ['tsx', 'bay street'],
  }),
  asset({
    id: 'ftse',
    symbol: '^FTSE',
    label: 'FTSE 100',
    unit: 'points',
    group: 'equity',
    hub: LONDON,
    mentions: ['ftse'],
  }),
  asset({
    id: 'dax',
    symbol: '^GDAXI',
    label: 'DAX',
    unit: 'points',
    group: 'equity',
    hub: FRANKFURT,
    mentions: ['dax'],
  }),
  asset({
    id: 'cac40',
    symbol: '^FCHI',
    label: 'CAC 40',
    unit: 'points',
    group: 'equity',
    hub: hub('Paris', 48.869, 2.3412),
    mentions: ['cac 40'],
  }),
  asset({
    id: 'nikkei',
    symbol: '^N225',
    label: 'Nikkei 225',
    unit: 'points',
    group: 'equity',
    hub: TOKYO,
    mentions: ['nikkei'],
  }),
  asset({
    id: 'hangseng',
    symbol: '^HSI',
    label: 'Hang Seng',
    unit: 'points',
    group: 'equity',
    hub: hub('Hong Kong', 22.2835, 114.1588),
    mentions: ['hang seng'],
  }),
  asset({
    id: 'shanghai',
    symbol: '000001.SS',
    label: 'Shanghai Composite',
    unit: 'points',
    group: 'equity',
    hub: hub('Shanghai', 31.2304, 121.4737),
    mentions: ['shanghai composite'],
  }),
  asset({
    id: 'sensex',
    symbol: '^BSESN',
    label: 'BSE Sensex',
    unit: 'points',
    group: 'equity',
    hub: MUMBAI,
    mentions: ['sensex'],
  }),
  asset({
    id: 'asx200',
    symbol: '^AXJO',
    label: 'S&P/ASX 200',
    unit: 'points',
    group: 'equity',
    hub: SYDNEY,
    mentions: ['asx'],
  }),
  asset({
    id: 'bovespa',
    symbol: '^BVSP',
    label: 'Ibovespa',
    unit: 'points',
    group: 'equity',
    hub: hub('São Paulo', -23.5475, -46.6361),
    mentions: ['bovespa', 'ibovespa'],
  }),
  asset({
    id: 'vix',
    symbol: '^VIX',
    label: 'VIX volatility index',
    unit: 'points',
    group: 'volatility',
    hub: CHICAGO,
    mentions: ['vix', 'volatility index'],
  }),
  // Crypto has no home exchange: listed and predicted, never placed.
  asset({
    id: 'bitcoin',
    symbol: 'BTC-USD',
    label: 'Bitcoin',
    unit: 'usd',
    group: 'crypto',
    hub: null,
    mentions: ['bitcoin', 'btc'],
  }),
  asset({
    id: 'ether',
    symbol: 'ETH-USD',
    label: 'Ether',
    unit: 'usd',
    group: 'crypto',
    hub: null,
    mentions: ['ethereum', 'ether'],
  }),
]);

export const MARKET_ASSET_GROUPS = Object.freeze([
  'fx',
  'yield',
  'commodity',
  'equity',
  'volatility',
  'crypto',
]);

const BY_ID = new Map(MARKET_ASSETS.map((a) => [a.id, a]));

/** The asset with this id, or null. */
export function marketAsset(id) {
  return BY_ID.get(id) || null;
}

/**
 * A predicted move as the globe and the tab show it: signed percent, with
 * an arrow. Blank when either price is missing.
 * @param {number} last The last recorded price.
 * @param {number} predicted The predicted price.
 */
export function priceMove(last, predicted) {
  const a = Number(last);
  const b = Number(predicted);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) return null;
  const pct = ((b - a) / Math.abs(a)) * 100;
  return {
    pct,
    text: `${pct > 0 ? '▲' : pct < 0 ? '▼' : '■'} ${Math.abs(pct).toFixed(2)}%`,
  };
}
