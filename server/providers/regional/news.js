import { fetchRegionalText, fetchRegionalJson } from './http.js';
import { normalizeRegionalArticles } from '../../../src/data/regionalBrief.js';
import { fetchStatCanCrimeOutliers } from './statcan-crime.js';
import { buildSocialPublicSearch } from '../../../src/socialMedia.js';

function decodeRssText(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function rssTag(block, tag) {
  return decodeRssText(
    new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(
      block,
    )?.[1] || '',
  );
}

function normalizeRssArticles(xml, limit = 5) {
  const seen = new Set();
  const articles = [];
  for (const match of String(xml || '').matchAll(
    /<item>([\s\S]*?)<\/item>/gi,
  )) {
    const item = match[1];
    const title = rssTag(item, 'title').slice(0, 180);
    const url = rssTag(item, 'link');
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      continue;
    }
    if (!title || !['http:', 'https:'].includes(parsedUrl.protocol)) continue;
    const source = rssTag(item, 'source');
    const signature = `${title.toLowerCase()}|${source.toLowerCase() || parsedUrl.hostname}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    const rawDate = rssTag(item, 'pubDate');
    articles.push({
      title,
      url: parsedUrl.href,
      domain: source || parsedUrl.hostname.replace(/^www\./, ''),
      publishedAt: Number.isNaN(Date.parse(rawDate))
        ? null
        : new Date(rawDate).toISOString(),
      sourceCountry: null,
    });
    if (articles.length >= limit) break;
  }
  return articles;
}

async function fetchRegionalNews(place) {
  const query = place?.locality || place?.region || place?.country;
  if (!query)
    return { status: 'unavailable', query: null, articles: [], source: null };
  const rssParams = new URLSearchParams({
    q: String(query).replace(/["\\]/g, ' ').trim(),
    hl: 'en-US',
    gl: 'US',
    ceid: 'US:en',
  });
  try {
    const xml = await fetchRegionalText(
      `https://news.google.com/rss/search?${rssParams}`,
      {
        headers: { 'User-Agent': 'GodsEyeView/0.1' },
        timeoutMs: 12_000,
      },
    );
    const articles = normalizeRssArticles(xml, 5);
    if (articles.length)
      return { status: 'ready', query, articles, source: 'Google News RSS' };
  } catch {
    /* fall through to the existing free index */
  }
  const params = new URLSearchParams({
    query: `"${String(query).replace(/["\\]/g, ' ').trim()}"`,
    mode: 'artlist',
    format: 'json',
    maxrecords: '5',
    sort: 'datedesc',
    timespan: '48h',
  });
  try {
    const payload = await fetchRegionalJson(
      `https://api.gdeltproject.org/api/v2/doc/doc?${params}`,
      {
        headers: { 'User-Agent': 'GodsEyeView/0.1' },
        timeoutMs: 12_000,
      },
    );
    const articles = normalizeRegionalArticles(payload, 5);
    return {
      status: articles.length ? 'ready' : 'empty',
      query,
      articles,
      source: 'GDELT fallback',
    };
  } catch {
    return { status: 'unavailable', query, articles: [], source: null };
  }
}

const RISK_NEWS_RADIUS_KM = 100;
const RISK_NEWS_LOOKBACK_DAYS = 30;
const RISK_NEWS_MAX_ARTICLES = 8;
const RISK_NEWS_QUERY_MAX_CHARS = 240;

function sanitizeRiskNewsQuery(value) {
  return String(value || '')
    .replace(/[\u0000-\u001F\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, RISK_NEWS_QUERY_MAX_CHARS);
}

function filterRiskNewsArticles(
  articles,
  lookbackDays = RISK_NEWS_LOOKBACK_DAYS,
  now = Date.now(),
) {
  const days = Math.max(1, Number(lookbackDays) || RISK_NEWS_LOOKBACK_DAYS);
  const windowMs = days * 24 * 60 * 60 * 1000;
  return (Array.isArray(articles) ? articles : []).filter((article) => {
    if (!article?.publishedAt) return true;
    const published = Date.parse(article.publishedAt);
    if (Number.isNaN(published)) return true;
    return (
      published <= now + 24 * 60 * 60 * 1000 && now - published <= windowMs
    );
  });
}

function emptyRiskNews(query, status = 'empty') {
  return {
    status,
    query: query || null,
    articles: [],
    source: null,
    radiusKm: RISK_NEWS_RADIUS_KM,
    lookbackDays: RISK_NEWS_LOOKBACK_DAYS,
  };
}

const AL_JAZEERA_LOOKBACK_DAYS = 90;
const AL_JAZEERA_MAX_ARTICLES = 5;

/** Place name reduced to what a quoted news query can carry. */
function sanitizeCoveragePlace(place) {
  return String(place || '')
    .replace(/["\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function alJazeeraResult(status, place, articles = []) {
  return {
    status,
    place: place || null,
    articles,
    source: 'aljazeera.com via Google News RSS',
    url: 'https://www.aljazeera.com/',
    lookbackDays: AL_JAZEERA_LOOKBACK_DAYS,
  };
}

/**
 * Whether aljazeera.com has carried anything naming this place in the last 90
 * days. 'ready' = at least one item, 'empty' = searched and found none,
 * 'unavailable' = the search itself failed, which is NOT the same as none.
 * @param {{place?: string}} [options]
 */
async function fetchAlJazeeraCoverage(options = {}) {
  const place = sanitizeCoveragePlace(options.place);
  if (!place) return alJazeeraResult('empty', null);
  const rssParams = new URLSearchParams({
    q: `"${place}" site:aljazeera.com when:${AL_JAZEERA_LOOKBACK_DAYS}d`,
    hl: 'en-US',
    gl: 'US',
    ceid: 'US:en',
  });
  try {
    const xml = await fetchRegionalText(
      `https://news.google.com/rss/search?${rssParams}`,
      { headers: { 'User-Agent': 'GodsEyeView/0.1' }, timeoutMs: 12_000 },
    );
    const articles = filterRiskNewsArticles(
      normalizeRssArticles(xml, 12),
      AL_JAZEERA_LOOKBACK_DAYS,
    ).slice(0, AL_JAZEERA_MAX_ARTICLES);
    return alJazeeraResult(
      articles.length ? 'ready' : 'empty',
      place,
      articles,
    );
  } catch {
    return alJazeeraResult('unavailable', place);
  }
}

async function fetchRiskNews(options = {}) {
  const query = sanitizeRiskNewsQuery(options.query);
  if (!query) return emptyRiskNews(null);
  const rssParams = new URLSearchParams({
    q: query,
    hl: 'en-US',
    gl: 'US',
    ceid: 'US:en',
  });
  try {
    const xml = await fetchRegionalText(
      `https://news.google.com/rss/search?${rssParams}`,
      {
        headers: { 'User-Agent': 'GodsEyeView/0.1' },
        timeoutMs: 12_000,
      },
    );
    const articles = filterRiskNewsArticles(
      normalizeRssArticles(xml, 12),
    ).slice(0, RISK_NEWS_MAX_ARTICLES);
    if (articles.length) {
      return {
        status: 'ready',
        query,
        articles,
        source: 'Google News RSS',
        radiusKm: RISK_NEWS_RADIUS_KM,
        lookbackDays: RISK_NEWS_LOOKBACK_DAYS,
      };
    }
  } catch {
    /* fall through to the existing free index */
  }
  const params = new URLSearchParams({
    query,
    mode: 'artlist',
    format: 'json',
    maxrecords: String(RISK_NEWS_MAX_ARTICLES),
    sort: 'datedesc',
    timespan: '1month',
  });
  try {
    const payload = await fetchRegionalJson(
      `https://api.gdeltproject.org/api/v2/doc/doc?${params}`,
      {
        headers: { 'User-Agent': 'GodsEyeView/0.1' },
        timeoutMs: 12_000,
      },
    );
    const articles = filterRiskNewsArticles(
      normalizeRegionalArticles(payload, RISK_NEWS_MAX_ARTICLES),
    ).slice(0, RISK_NEWS_MAX_ARTICLES);
    return {
      status: articles.length ? 'ready' : 'empty',
      query,
      articles,
      source: 'GDELT fallback',
      radiusKm: RISK_NEWS_RADIUS_KM,
      lookbackDays: RISK_NEWS_LOOKBACK_DAYS,
    };
  } catch {
    return emptyRiskNews(query, 'unavailable');
  }
}

const GOV_CRIME_LOOKBACK_DAYS = 730;
const GOV_CRIME_QUERY_MAX_CHARS = 400;
const GOV_CRIME_TERMS =
  'crime statistics OR crime rate OR "crime severity" OR homicide OR "violent crime"';
const GOV_CRIME_SITES = Object.freeze({
  canada: Object.freeze([
    'statcan.gc.ca',
    'canada.ca',
    'gc.ca',
    'publicsafety.gc.ca',
    'justice.gc.ca',
  ]),
  usa: Object.freeze([
    'fbi.gov',
    'bjs.gov',
    'usa.gov',
    'justice.gov',
    'cde.ucr.cjis.gov',
  ]),
  international: Object.freeze(['unodc.org', 'dataunodc.un.org']),
});

function sanitizeGovCrimeQuery(value) {
  return String(value || '')
    .replace(/[\u0000-\u001F\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, GOV_CRIME_QUERY_MAX_CHARS);
}

function govCrimeRegion(value) {
  const key = String(value || '')
    .trim()
    .toLowerCase();
  if (key === 'canada' || key === 'usa' || key === 'international') return key;
  return 'international';
}

function buildGovCrimeQuery(place, region) {
  const sites = GOV_CRIME_SITES[govCrimeRegion(region)];
  const siteClause = sites.map((site) => `site:${site}`).join(' OR ');
  const named = String(place || '')
    .replace(/["\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const placePart = named ? `"${named}"` : '';
  return sanitizeGovCrimeQuery(
    [placePart, `(${GOV_CRIME_TERMS})`, `(${siteClause})`]
      .filter(Boolean)
      .join(' '),
  );
}

function gdeltGovCrimeQuery(place, region) {
  const sites = GOV_CRIME_SITES[govCrimeRegion(region)].slice(0, 3);
  const domainClause = sites.map((site) => `domainis:${site}`).join(' OR ');
  const named = String(place || '')
    .replace(/["\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const placePart = named ? `"${named}"` : '';
  return sanitizeGovCrimeQuery(
    [placePart, `(${GOV_CRIME_TERMS})`, `(${domainClause})`]
      .filter(Boolean)
      .join(' '),
  );
}

function emptyGovCrimeNews(query, status = 'empty') {
  return {
    status,
    query: query || null,
    articles: [],
    source: null,
  };
}

async function fetchGovCrimeNews(options = {}) {
  const region = govCrimeRegion(options.region);
  const place = String(options.place || '').trim();
  if (region === 'canada' && place) {
    const table = await fetchStatCanCrimeOutliers(place);
    if (table.articles.length) return table;
  }
  const query = buildGovCrimeQuery(options.place, options.region);
  if (!query) return emptyGovCrimeNews(null);
  const rssParams = new URLSearchParams({
    q: query,
    hl: 'en-US',
    gl: 'US',
    ceid: 'US:en',
  });
  try {
    const xml = await fetchRegionalText(
      `https://news.google.com/rss/search?${rssParams}`,
      {
        headers: { 'User-Agent': 'GodsEyeView/0.1' },
        timeoutMs: 12_000,
      },
    );
    const articles = filterRiskNewsArticles(
      normalizeRssArticles(xml, 12),
      GOV_CRIME_LOOKBACK_DAYS,
    ).slice(0, RISK_NEWS_MAX_ARTICLES);
    if (articles.length) {
      return {
        status: 'ready',
        query,
        articles,
        source: 'Google News RSS',
      };
    }
  } catch {
    /* fall through to the existing free index */
  }
  const gdeltQuery = gdeltGovCrimeQuery(options.place, options.region);
  const params = new URLSearchParams({
    query: gdeltQuery,
    mode: 'artlist',
    format: 'json',
    maxrecords: String(RISK_NEWS_MAX_ARTICLES),
    sort: 'datedesc',
    timespan: '1year',
  });
  try {
    const payload = await fetchRegionalJson(
      `https://api.gdeltproject.org/api/v2/doc/doc?${params}`,
      {
        headers: { 'User-Agent': 'GodsEyeView/0.1' },
        timeoutMs: 12_000,
      },
    );
    const articles = filterRiskNewsArticles(
      normalizeRegionalArticles(payload, RISK_NEWS_MAX_ARTICLES),
      GOV_CRIME_LOOKBACK_DAYS,
    ).slice(0, RISK_NEWS_MAX_ARTICLES);
    return {
      status: articles.length ? 'ready' : 'empty',
      query: gdeltQuery,
      articles,
      source: 'GDELT fallback',
    };
  } catch {
    return emptyGovCrimeNews(query, 'unavailable');
  }
}

function googleNewsUrl(query) {
  const rssParams = new URLSearchParams({
    q: query,
    hl: 'en-US',
    gl: 'US',
    ceid: 'US:en',
  });
  return `https://news.google.com/rss/search?${rssParams}`;
}

function gdeltNewsUrl(query, timespan) {
  const params = new URLSearchParams({
    query,
    mode: 'artlist',
    format: 'json',
    maxrecords: String(RISK_NEWS_MAX_ARTICLES),
    sort: 'datedesc',
    timespan,
  });
  return `https://api.gdeltproject.org/api/v2/doc/doc?${params}`;
}

function publicSocialArticle(article) {
  const title = String(article?.title || '')
    .replace(/[\u0000-\u001f]/g, ' ')
    .trim()
    .slice(0, 180);
  let url = '';
  try {
    const parsed = new URL(String(article?.url || ''));
    if (parsed.username || parsed.password) return null;
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      return null;
    url = parsed.href.slice(0, 300);
  } catch {
    return null;
  }
  if (!title) return null;
  const domain = String(article?.domain || '')
    .replace(/[\u0000-\u001f]/g, ' ')
    .trim()
    .slice(0, 80);
  const publishedAt =
    typeof article?.publishedAt === 'string'
      ? article.publishedAt.slice(0, 40)
      : null;
  return { title, url, domain, publishedAt };
}

function emptySocialNews(status) {
  return {
    status,
    match: null,
    source: null,
    lookbackDays: null,
    platforms: [],
    articles: [],
  };
}

async function indexedSocialArticles(
  url,
  kind,
  lookbackDays,
  readText,
  readJson,
) {
  try {
    if (kind === 'rss') {
      const xml = await readText(url);
      return filterRiskNewsArticles(
        normalizeRssArticles(xml, 12),
        lookbackDays,
      ).slice(0, RISK_NEWS_MAX_ARTICLES);
    }
    const payload = await readJson(url);
    return filterRiskNewsArticles(
      normalizeRegionalArticles(payload, RISK_NEWS_MAX_ARTICLES),
      lookbackDays,
    ).slice(0, RISK_NEWS_MAX_ARTICLES);
  } catch {
    return null;
  }
}

async function socialNewsPass(rssQuery, gdeltQuery, plan, readText, readJson) {
  if (!rssQuery && !gdeltQuery)
    return { articles: [], failed: false, skipped: true };
  const [rss, gdelt] = await Promise.all([
    rssQuery
      ? indexedSocialArticles(
          googleNewsUrl(rssQuery),
          'rss',
          plan.lookbackDays,
          readText,
          readJson,
        )
      : [],
    gdeltQuery
      ? indexedSocialArticles(
          gdeltNewsUrl(gdeltQuery, plan.timespan),
          'gdelt',
          plan.lookbackDays,
          readText,
          readJson,
        )
      : [],
  ]);
  if (rss?.length)
    return { articles: rss, source: 'Google News RSS', failed: false };
  if (gdelt?.length)
    return { articles: gdelt, source: 'GDELT fallback', failed: false };
  return { articles: [], source: null, failed: rss === null && gdelt === null };
}

/**
 * Public pages and headlines for Social Media Analysis. Google News first,
 * then GDELT. A platform site hit wins, then an article that names the
 * platform, then headlines about the place. Nothing here signs in or reads
 * a private account.
 * @param {object} [options]
 */
async function fetchSocialPublicNews(options = {}) {
  const plan = buildSocialPublicSearch(options);
  if (!plan.ok) return emptySocialNews(plan.empty ? 'empty' : 'invalid');
  const readText =
    options.readText ||
    ((url) =>
      fetchRegionalText(url, {
        headers: { 'User-Agent': 'GodsEyeView/0.1' },
        timeoutMs: 12_000,
      }));
  const readJson =
    options.readJson ||
    ((url) =>
      fetchRegionalJson(url, {
        headers: { 'User-Agent': 'GodsEyeView/0.1' },
        timeoutMs: 12_000,
      }));
  const site = await socialNewsPass(
    plan.siteQuery,
    plan.gdeltSiteQuery,
    plan,
    readText,
    readJson,
  );
  const mention = site.articles.length
    ? null
    : await socialNewsPass(
        plan.mentionQuery,
        plan.gdeltMentionQuery,
        plan,
        readText,
        readJson,
      );
  const place =
    site.articles.length || mention?.articles.length
      ? null
      : await socialNewsPass(
          plan.placeQuery,
          plan.gdeltPlaceQuery,
          plan,
          readText,
          readJson,
        );
  const hit = site.articles.length
    ? site
    : mention?.articles.length
      ? mention
      : place?.articles.length
        ? place
        : null;
  const match = site.articles.length
    ? 'site'
    : mention?.articles.length
      ? 'mention'
      : place?.articles.length
        ? 'place'
        : null;
  const articles = (hit?.articles || [])
    .map(publicSocialArticle)
    .filter(Boolean);
  if (articles.length) {
    return {
      status: 'ready',
      match,
      source: hit.source,
      lookbackDays: plan.lookbackDays,
      platforms: plan.labels,
      articles,
    };
  }
  const sawAnswer = [site, mention, place].some(
    (pass) => pass && !pass.failed && !pass.skipped,
  );
  return {
    status: sawAnswer ? 'empty' : 'unavailable',
    match: null,
    source: null,
    lookbackDays: plan.lookbackDays,
    platforms: plan.labels,
    articles: [],
  };
}

export {
  GOV_CRIME_SITES,
  RISK_NEWS_LOOKBACK_DAYS,
  RISK_NEWS_RADIUS_KM,
  AL_JAZEERA_LOOKBACK_DAYS,
  buildGovCrimeQuery,
  fetchAlJazeeraCoverage,
  fetchGovCrimeNews,
  fetchRegionalNews,
  fetchRiskNews,
  fetchSocialPublicNews,
  filterRiskNewsArticles,
  sanitizeRiskNewsQuery,
};
