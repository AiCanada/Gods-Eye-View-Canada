import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { fetchSocialPublicNews } from '../../server/providers/regional/news.js';
import { regionalBriefProxy } from '../../server/providers/regional/briefing.js';

function rssItem(title) {
  return `<rss><channel><item><title>${title}</title><link>https://news.google.com/rss/articles/abc</link><source>TikTok</source><pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`;
}

function install(plugin) {
  const routes = new Map();
  plugin.configureServer({
    middlewares: { use: (route, handler) => routes.set(route, handler) },
  });
  return routes;
}

function request(handler, { method = 'GET', url = '/', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = Readable.from([]);
    Object.assign(req, {
      method,
      url,
      headers: { host: 'localhost:4173', origin: 'http://localhost:4173', ...headers },
      socket: { remoteAddress: '127.0.0.1' },
    });
    const res = {
      statusCode: 200,
      writeHead(status, values) {
        this.statusCode = status;
        this.headers = values;
      },
      end(body = '') {
        resolve({ status: this.statusCode, headers: this.headers, body: String(body), json: () => JSON.parse(String(body)) });
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

test('a platform hit is kept and the wider searches are not run', async () => {
  const urls = [];
  const report = await fetchSocialPublicNews({
    action: 'news',
    newsId: 'tiktok',
    place: 'Halifax',
    text: 'flood',
    readText: async (url) => {
      urls.push(decodeURIComponent(String(url)));
      return rssItem('Harbour flood');
    },
    readJson: async (url) => {
      urls.push(decodeURIComponent(String(url)));
      return { articles: [] };
    },
  });
  assert.equal(report.status, 'ready');
  assert.equal(report.match, 'site');
  assert.equal(report.source, 'Google News RSS');
  assert.equal(report.articles[0].title, 'Harbour flood');
  assert.equal(report.articles[0].url.startsWith('https://'), true);
  assert.ok(urls.some((url) => url.includes('site:tiktok.com')));
  assert.equal(urls.some((url) => url.includes('TikTok')), false);
  assert.equal(urls.some((url) => !url.includes('site:') && !url.includes('domainis:')), false);
  for (const url of urls) {
    assert.ok(
      url.startsWith('https://news.google.com/') || url.startsWith('https://api.gdeltproject.org/'),
      url,
    );
  }
});

test('an article that names the platform is used when the site search is empty', async () => {
  const urls = [];
  const report = await fetchSocialPublicNews({
    action: 'news',
    newsId: 'tiktok',
    place: 'Halifax',
    text: 'flood',
    readText: async (url) => {
      const text = decodeURIComponent(String(url));
      urls.push(text);
      if (text.includes('site:') || !text.includes('TikTok')) return '<rss></rss>';
      return rssItem('Named on TikTok');
    },
    readJson: async () => ({ articles: [] }),
  });
  assert.equal(report.status, 'ready');
  assert.equal(report.match, 'mention');
  assert.equal(report.articles[0].title, 'Named on TikTok');
  assert.equal(urls.some((url) => url.includes('site:tiktok.com')), true);
  assert.equal(
    urls.some((url) => url.includes('Halifax') && !url.includes('site:') && !url.includes('domainis:') && !url.includes('TikTok')),
    false,
  );
});

test('place headlines are labeled as place news when the platform searches are empty', async () => {
  const report = await fetchSocialPublicNews({
    action: 'news',
    newsId: 'tiktok',
    place: 'Halifax',
    text: 'flood',
    readText: async (url) => {
      const text = decodeURIComponent(String(url));
      if (text.includes('site:') || text.includes('TikTok')) return '<rss></rss>';
      return rssItem('City desk');
    },
    readJson: async () => ({ articles: [] }),
  });
  assert.equal(report.status, 'ready');
  assert.equal(report.match, 'place');
  assert.equal(report.articles[0].title, 'City desk');
  assert.equal(report.platforms.includes('TikTok'), true);
});

test('a failed lookup returns no articles', async () => {
  const report = await fetchSocialPublicNews({
    action: 'news',
    newsId: 'x',
    place: 'Halifax',
    text: 'flood',
    readText: async () => {
      throw new Error('down');
    },
    readJson: async () => {
      throw new Error('down');
    },
  });
  assert.equal(report.status, 'unavailable');
  assert.deepEqual(report.articles, []);
});

test('an empty index is not filled with an invented post', async () => {
  const report = await fetchSocialPublicNews({
    action: 'analyze',
    analysisId: 'tiktok',
    place: 'Halifax',
    text: 'tone',
    readText: async () => '<rss></rss>',
    readJson: async () => ({ articles: [] }),
  });
  assert.equal(report.status, 'empty');
  assert.deepEqual(report.articles, []);
});

test('the public news route refuses a people search and keeps secrets off the upstream URL', async (t) => {
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    urls.push(decodeURIComponent(String(url)));
    return new Response(rssItem('Harbour flood'), { status: 200 });
  });
  const routes = install(regionalBriefProxy());
  const handler = routes.get('/api/social/public-news');
  const denied = await request(handler, {
    url: '/api/social/public-news?action=help&place=Halifax&q=flood',
  });
  assert.equal(denied.status, 400);
  assert.equal(denied.json().error, 'Pick a platform.');
  const snap = await request(handler, {
    url: '/api/social/public-news?action=news&news=snapchat&place=Halifax',
  });
  assert.equal(snap.status, 400);
  const missing = await request(handler, {
    url: '/api/social/public-news?action=news&news=tiktok',
  });
  assert.equal(missing.status, 200);
  assert.equal(missing.json().status, 'empty');
  assert.deepEqual(missing.json().articles, []);
  const method = await request(handler, { method: 'DELETE', url: '/api/social/public-news' });
  assert.equal(method.status, 405);
  assert.equal(urls.length, 0);

  const found = await request(handler, {
    url: '/api/social/public-news?action=news&news=tiktok&place=Halifax&q=flood',
  });
  assert.equal(found.status, 200);
  assert.equal(found.json().status, 'ready');
  assert.equal(found.json().articles[0].title, 'Harbour flood');
  assert.equal(JSON.stringify(found.json()).includes('siteQuery'), false);
  const leaked = await request(handler, {
    url: '/api/social/public-news?action=news&news=tiktok&place=Halifax&q=hunter2%20password&handles=happn:nearbyname,tiktok:cbc',
  });
  assert.equal(leaked.status, 200);
  const upstream = urls.map((url) => url);
  assert.ok(upstream.some((url) => url.includes('site:tiktok.com') && url.includes('flood')));
  assert.equal(upstream.some((url) => url.includes('password') || url.includes('hunter2') || url.includes('nearbyname') || url.includes('happn')), false);
  for (const url of upstream) {
    const host = new URL(url).hostname;
    assert.ok(host === 'news.google.com' || host === 'api.gdeltproject.org');
  }
});

test('the public news route answers this page only: not another site, not a rebound host name', async (t) => {
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    urls.push(String(url));
    return new Response(rssItem('Harbour flood'), { status: 200 });
  });
  const handler = install(regionalBriefProxy()).get('/api/social/public-news');
  const url = '/api/social/public-news?action=news&news=tiktok&place=Halifax&q=flood';
  for (const headers of [
    { host: 'rebind.evil:4173', origin: 'http://rebind.evil:4173' },
    { host: '' },
    { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'same-site' },
  ]) {
    const refused = await request(handler, { url, headers });
    assert.equal(refused.status, 403, JSON.stringify(headers));
    assert.equal(refused.json().error, 'Same-origin requests only');
    assert.equal(refused.headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(refused.headers['Cache-Control'], 'no-store');
  }
  assert.equal(urls.length, 0, 'a refused request looks nothing up');
  for (const site of ['same-origin', 'none']) {
    const answered = await request(handler, { url, headers: { 'sec-fetch-site': site } });
    assert.equal(answered.status, 200, site);
    assert.equal(answered.json().status, 'ready');
  }
});
