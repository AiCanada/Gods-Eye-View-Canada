import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { expandApplicationHtml } from '../build/application-html.js';
import {
  SOCIAL_ACCOUNT_PLATFORMS,
  SOCIAL_ACCOUNTS_KEY,
  SOCIAL_ANALYSIS_PLATFORMS,
  SOCIAL_GIG_HELP_NOTE,
  SOCIAL_OPEN_SAVED_LABELS,
  savedSiteUrls,
  SOCIAL_HELP_DELIVERY_KEY,
  helpDeliverySummary,
  normalizeHelpDelivery,
  readHelpDelivery,
  writeHelpDelivery,
  socialPowerUps,
  SOCIAL_LOCATION_OPTIONS,
  SOCIAL_NEWS_PLATFORMS,
  SOCIAL_REQUEST_LIMIT,
  SOCIAL_SHOW_LOCATION_KEY,
  acceptDeviceFix,
  buildSocialPublicSearch,
  cleanPlace,
  formatSocialSearchBody,
  liveLocationLabel,
  locationSharingAccounts,
  normalizePublicNewsReport,
  normalizeSocialHandle,
  officialOpenUrl,
  planSocialRequest,
  readShowLocation,
  readSocialAccounts,
  removeSocialAccount,
  saveSocialAccount,
  socialPublicNewsPath,
  writeShowLocation,
} from './socialMedia.js';
import { SOCIAL_LOCATION_FIX_ID, SocialMediaPanel } from './socialMediaPanel.js';

const html = expandApplicationHtml(readFileSync(new URL('../index.html', import.meta.url), 'utf8'));
const panelHtml = html.slice(html.indexOf('id="social-panel"'), html.indexOf('id="right-context-rail"'));

function selectOptions(source, id) {
  const start = source.indexOf(`id="${id}"`);
  const end = source.indexOf('</select>', start);
  assert.ok(start >= 0 && end > start, id);
  return [...source.slice(start, end).matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g)].map(
    (match) => [match[1], match[2]],
  );
}

function memoryStorage(initial) {
  const map = new Map(initial ? [[SOCIAL_ACCOUNTS_KEY, initial]] : []);
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
  };
}

test('the left stack has a collapsed Social Media Analysis box ahead of the right rail', () => {
  const socialAt = html.indexOf('id="social-panel"');
  const railAt = html.indexOf('id="right-context-rail"');
  assert.ok(html.indexOf('id="left-panel-stack"') < socialAt);
  assert.ok(socialAt < railAt);
  assert.equal(html.slice(railAt).includes('id="social-panel"'), false);
  assert.match(panelHtml, /id="social-panel" class="panel-collapsible collapsed" data-panel-id="social-panel"/);
  assert.match(panelHtml, /data-collapsed-title="SOCIAL MEDIA ANALYSIS"/);
  assert.match(panelHtml, /data-collapse-target="social-panel"/);
  assert.match(panelHtml, /id="social-account-password"[^>]*type="password"/);
  assert.match(panelHtml, /id="social-account-password"[^>]*autocomplete="off"/);
  // The accounts rows hold the only masked boxes, the password and the API
  // key; the bot swarms keep no login.
  assert.equal((panelHtml.match(/type="password"/gi) || []).length, 2);
  assert.match(panelHtml, /id="social-account-apikey"[^>]*type="password"/);
  // The owner's own words for the top note (2026-10-03), exactly.
  assert.ok(
    panelHtml.includes(
      "<p class=\"social-note social-flush\">Your API Keys, User Id's and Passwords stay encrypted on this computer for integrating AI Tools</p>",
    ),
  );
  assert.equal(panelHtml.includes('This box does not sign in and does not read private messages'), false);
  assert.match(panelHtml, /id="social-show-location"[^>]*type="checkbox"[^>]*checked/);
  assert.match(panelHtml, /id="social-location-note"/);
  // The owner's own words for the location note (2026-10-03), exactly; the
  // Enter note is gone.
  assert.ok(
    panelHtml.includes(
      '<p id="social-location-note" class="social-note">A hooked-up account that shares location displays live position on the map. If allowed by 3rd Party.</p>',
    ),
  );
  assert.equal(panelHtml.includes('Enter looks up public news'), false);
  assert.match(panelHtml, /id="social-query"/);
  assert.match(panelHtml, /id="social-analyze"/);
  assert.match(panelHtml, /id="social-news"/);
  assert.match(panelHtml, /id="social-search"/);
  assert.match(panelHtml, /id="social-help"/);
});

test('the menus match the platform catalogs', () => {
  // The swarms' own login slots sit beside their buttons, not in this menu.
  assert.deepEqual(
    selectOptions(panelHtml, 'social-account-platform'),
    SOCIAL_ACCOUNT_PLATFORMS.filter((item) => !item.swarmLogin).map((item) => [item.id, item.label]),
  );
  assert.deepEqual(
    selectOptions(panelHtml, 'social-analyze-platform'),
    SOCIAL_ANALYSIS_PLATFORMS.map((item) => [item.id, item.label]),
  );
  assert.deepEqual(
    selectOptions(panelHtml, 'social-news-platform'),
    SOCIAL_NEWS_PLATFORMS.map((item) => [item.id, item.label]),
  );
  assert.deepEqual(
    selectOptions(panelHtml, 'social-help-platform'),
    SOCIAL_LOCATION_OPTIONS.map((item) => [item.id, item.label]),
  );
  // The location apps open from the ACCOUNTS menu at the top (OPEN SITE); the
  // box keeps no second list of them at the bottom.
  assert.equal(panelHtml.includes('OPEN A LOCATION APP'), false);
  assert.equal(panelHtml.includes('data-social-open='), false);
  assert.equal(panelHtml.includes('social-location-list'), false);
  assert.match(panelHtml, /id="social-account-open"[^>]*>OPEN SITE</);
  const accountMenu = selectOptions(panelHtml, 'social-account-platform').map(([value]) => value);
  for (const id of ['find-my', 'google-maps', 'bump', 'blink', 'life360', 'radarly', 'buzzly', 'vicinity', 'nearjoy', 'happn', 'pure', 'sniffies']) {
    assert.ok(accountMenu.includes(id), id);
  }
});

test('a public handle is kept and a password or key is refused', () => {
  assert.deepEqual(normalizeSocialHandle('  @river.stone '), { ok: true, handle: 'river.stone' });
  assert.deepEqual(normalizeSocialHandle('https://x.com/river.stone'), { ok: true, handle: 'river.stone' });
  assert.equal(normalizeSocialHandle('').ok, false);
  assert.equal(normalizeSocialHandle('my password').ok, false);
  assert.match(normalizeSocialHandle('sk-live-secret').error, /passwords or keys/);
  assert.match(normalizeSocialHandle('https://x.com/river?token=abc').error, /carries a key/);
  assert.match(normalizeSocialHandle('https://user:pw@x.com/river').error, /login/);
  assert.match(normalizeSocialHandle('has a space').error, /public handle/);
  // A phone number is how Find My, Bump or Blink log in; it never leaves as a handle.
  for (const phone of ['5065551234', '+15065551234', '+1 (506) 555-1234', '506.555.1234', '@5065551234']) {
    assert.match(normalizeSocialHandle(phone).error, /phone number/, phone);
  }
  assert.equal(normalizeSocialHandle('river2024').ok, true, 'digits inside a name are fine');
  assert.equal(normalizeSocialHandle('911').ok, true, 'too short to be a phone number');
  assert.deepEqual(
    readSocialAccounts(memoryStorage(JSON.stringify([{ platform: 'find-my', handle: '5065551234' }]))),
    [],
    'one saved before this check is dropped on read',
  );

  const storage = memoryStorage();
  const saved = saveSocialAccount(storage, 'x', '@river');
  assert.equal(saved.ok, true);
  assert.deepEqual(readSocialAccounts(storage), [{ platform: 'x', handle: 'river' }]);
  saveSocialAccount(storage, 'x', 'other');
  assert.deepEqual(readSocialAccounts(storage), [{ platform: 'x', handle: 'other' }]);
  assert.equal(saveSocialAccount(storage, 'x', 'password').ok, false);
  assert.deepEqual(readSocialAccounts(storage), [{ platform: 'x', handle: 'other' }]);
  assert.deepEqual(removeSocialAccount(storage, 'x'), []);
  assert.deepEqual(readSocialAccounts(memoryStorage('{"platform":"x"}')), []);
  assert.deepEqual(readSocialAccounts(memoryStorage('not json')), []);
});

test('analyze, news, help, and search each build one limited question', () => {
  const analyze = planSocialRequest({
    action: 'analyze',
    text: 'tone of the replies',
    analysisId: 'snapchat',
    providerId: 'xai',
    accounts: [{ platform: 'x', handle: 'river' }, { platform: 'x', handle: 'my password' }],
    place: 'Halifax',
  });
  assert.equal(analyze.ok, true);
  assert.equal(analyze.kind, 'ANALYZE');
  assert.match(analyze.question, /tone of the replies/);
  assert.match(analyze.question, /Snapchat/);
  assert.match(analyze.question, /X @river/);
  assert.equal(analyze.question.includes('my password'), false);
  assert.ok(analyze.question.includes(SOCIAL_REQUEST_LIMIT));
  assert.match(analyze.question, /do not invent posts, names, or locations/);
  assert.match(analyze.question, /Current map place: Halifax/);

  const news = planSocialRequest({
    action: 'news',
    text: '',
    newsId: 'all',
    providerId: 'xai',
  });
  assert.equal(news.ok, true);
  assert.match(news.question, /breaking public news near the current map view/);
  assert.match(news.question, /Truth Social/);
  assert.match(news.question, /TikTok/);
  assert.equal(news.question.includes('Snapchat'), false);

  const help = planSocialRequest({
    action: 'help',
    text: 'flooded street',
    helpId: 'find-my',
    providerId: 'xai',
  });
  assert.match(help.question, /Apple Find My/);
  assert.match(help.question, /contacts they choose/);
  assert.match(help.question, /flooded street/);
  assert.equal(help.question.includes('Snapchat Snap Map'), false);

  const search = planSocialRequest({
    action: 'search',
    text: 'what changed today',
    analysisId: 'all',
    newsId: 'x',
    helpId: 'all',
    providerId: 'xai',
  });
  assert.equal(search.kind, 'SEARCH');
  assert.match(search.question, /what changed today/);
  assert.match(search.question, /ANALYSIS, BREAKING NEWS, FIND HELP/);
  assert.match(search.question, /Breaking-news platforms: X/);
  assert.match(search.question, /Sniffies/);
  assert.match(search.question, /X check-ins/);
  assert.equal(search.question.includes('One-time location share'), false);

  assert.equal(planSocialRequest({ action: 'analyze', text: '', providerId: 'xai', analysisId: 'all' }).error, 'Type the kind of analysis first.');
  assert.equal(planSocialRequest({ action: 'search', text: '', providerId: 'xai', analysisId: 'all', newsId: 'all', helpId: 'all' }).error, 'Type what you want searched.');
  assert.equal(planSocialRequest({ action: 'news', text: 'storm', newsId: 'all', providerId: '' }).error, 'No model key yet. Add one in POWER UP.');
  assert.equal(planSocialRequest({ action: 'analyze', text: 'x'.repeat(2001), analysisId: 'all', providerId: 'xai' }).error, 'That note is too long.');
  assert.match(help.question, /No public-post lookup was run with this question\./);
  assert.equal(/does not look up who is nearby|does not sign in/.test(help.question), false);

  const emptyNews = planSocialRequest({
    action: 'news',
    text: 'storm',
    newsId: 'tiktok',
    providerId: 'xai',
    place: 'Halifax',
    publicNews: { status: 'empty', articles: [] },
  });
  assert.match(emptyNews.question, /No public item was returned/);
  assert.match(emptyNews.question, /Do not invent posts, names, or locations/);
  assert.equal(emptyNews.question.includes('Harbour flood'), false);

  const failed = planSocialRequest({
    action: 'search',
    text: 'today',
    analysisId: 'all',
    newsId: 'all',
    helpId: 'all',
    providerId: 'xai',
    publicNews: { status: 'unavailable' },
  });
  assert.match(failed.question, /did not finish/);
  assert.match(failed.question, /Do not invent posts/);

  const mentioned = planSocialRequest({
    action: 'analyze',
    text: 'tone',
    analysisId: 'tiktok',
    providerId: 'xai',
    publicNews: {
      status: 'ready',
      match: 'mention',
      source: 'Google News RSS',
      lookbackDays: 30,
      platforms: ['TikTok'],
      articles: [{ title: 'Harbour flood', domain: 'cbc.ca', url: 'https://news.google.com/rss/articles/abc' }],
    },
  });
  assert.match(mentioned.question, /Harbour flood/);
  assert.match(mentioned.question, /not posts read from an account/);
  assert.match(mentioned.question, /cbc\.ca/);
  assert.equal(mentioned.question.includes('my password'), false);
});

test('public news queries stay on the news index and drop secrets', () => {
  const news = buildSocialPublicSearch({
    action: 'news',
    newsId: 'all',
    place: 'Halifax',
    text: 'flood',
  });
  assert.equal(news.ok, true);
  assert.equal(news.lookbackDays, 7);
  assert.ok(news.siteQuery.length <= 240);
  assert.match(news.siteQuery, /site:tiktok\.com/);
  assert.match(news.siteQuery, /site:truthsocial\.com/);
  assert.match(news.siteQuery, /Halifax/);
  assert.match(news.siteQuery, /flood/);
  assert.equal(news.siteQuery.includes('snapchat'), false);
  assert.match(news.gdeltSiteQuery, /domainis:tiktok\.com/);
  assert.equal(news.mentionQuery.includes('site:'), false);
  assert.match(news.mentionQuery, /TikTok/);

  const hidden = buildSocialPublicSearch({
    action: 'news',
    newsId: 'tiktok',
    place: 'Halifax',
    text: 'hunter2 password',
    accounts: [
      { platform: 'happn', handle: 'nearbyname' },
      { platform: 'tiktok', handle: 'cbc' },
      { platform: 'tiktok', handle: 'my password' },
    ],
  });
  assert.equal(hidden.siteQuery.includes('hunter2'), false);
  assert.equal(hidden.siteQuery.includes('password'), false);
  assert.equal(hidden.siteQuery.includes('nearbyname'), false);
  assert.match(hidden.siteQuery, /"cbc"/);
  assert.match(hidden.siteQuery, /site:tiktok\.com/);

  const narrowed = buildSocialPublicSearch({
    action: 'analyze',
    analysisId: 'snapchat',
    place: 'Halifax',
    text: 'site:evil.com today',
  });
  assert.equal(narrowed.lookbackDays, 30);
  assert.equal(narrowed.siteQuery.includes('site:evil.com'), false);
  assert.match(narrowed.siteQuery, /site:snapchat\.com/);
  assert.match(narrowed.siteQuery, /today/);
  assert.match(narrowed.siteQuery, /when:30d/);

  const search = buildSocialPublicSearch({
    action: 'search',
    analysisId: 'x',
    newsId: 'tiktok',
    place: 'Halifax',
    text: 'today',
    accounts: [{ platform: 'happn', handle: 'nearbyname' }, { platform: 'x', handle: 'river' }],
  });
  assert.match(search.siteQuery, /site:x\.com/);
  assert.match(search.siteQuery, /site:twitter\.com/);
  assert.match(search.siteQuery, /site:tiktok\.com/);
  assert.match(search.siteQuery, /"river"/);
  assert.equal(search.siteQuery.includes('happn'), false);
  assert.equal(search.siteQuery.includes('nearbyname'), false);
  assert.equal(search.placeQuery.includes('site:'), false);

  assert.equal(buildSocialPublicSearch({ action: 'news', newsId: 'x' }).empty, true);
  assert.equal(buildSocialPublicSearch({ action: 'help', place: 'Halifax', text: 'flood' }).ok, false);
  assert.equal(buildSocialPublicSearch({ action: 'news', newsId: 'snapchat', place: 'Halifax' }).ok, false);

  const path = socialPublicNewsPath({
    action: 'news',
    newsId: 'tiktok',
    place: 'Halifax',
    text: 'hunter2 password',
    accounts: [{ platform: 'tiktok', handle: 'cbc' }, { platform: 'happn', handle: 'nearbyname' }],
  });
  assert.equal(path.includes('password'), false);
  assert.equal(path.includes('hunter2'), false);
  assert.equal(path.includes('happn'), false);
  assert.equal(path.includes('nearbyname'), false);
  assert.match(path, /tiktok%3Acbc/);
  assert.match(path, /place=Halifax/);

  const cleaned = normalizePublicNewsReport({
    status: 'ready',
    match: 'site',
    articles: [
      { title: 'Harbour flood', url: 'javascript:alert(1)', domain: 'x.com' },
      { title: 'Real item', url: 'https://news.google.com/rss/articles/abc', domain: 'tiktok.com' },
    ],
  });
  assert.equal(cleaned.articles.length, 1);
  assert.equal(cleaned.articles[0].title, 'Real item');
  assert.match(formatSocialSearchBody({ status: 'empty', articles: [] }), /No public item was returned/);
  assert.match(formatSocialSearchBody({ status: 'unavailable' }), /did not finish/);
  assert.equal(formatSocialSearchBody({ status: 'empty', articles: [] }).includes('Harbour flood'), false);
  const placeBody = formatSocialSearchBody({
    status: 'ready',
    match: 'place',
    source: 'Google News RSS',
    lookbackDays: 7,
    platforms: ['TikTok'],
    articles: [{ title: 'City desk', url: 'https://example.com/city', domain: 'example.com' }],
  });
  assert.match(placeBody, /not from a platform account/);
  assert.match(placeBody, /City desk/);
  const placePlan = planSocialRequest({
    action: 'news',
    text: 'flood',
    newsId: 'tiktok',
    providerId: 'xai',
    place: 'Halifax',
    publicNews: {
      status: 'ready',
      match: 'place',
      platforms: ['TikTok'],
      articles: [{ title: 'City desk', domain: 'example.com', url: 'https://example.com/city' }],
    },
  });
  assert.match(placePlan.question, /not posts from the selected platforms/);
  assert.match(placePlan.question, /Do not describe them as posts on TikTok/);
  assert.match(placePlan.question, /City desk/);
  assert.equal(placePlan.question.includes('my password'), false);
});

test('open links stay on the official https host', () => {
  assert.equal(officialOpenUrl('nope'), null);
  assert.equal(officialOpenUrl('one-time-share'), null);
  assert.equal(officialOpenUrl('find-my'), 'https://www.icloud.com/find');
  assert.equal(officialOpenUrl('bump'), 'https://apps.apple.com/app/id6471519217');
  const maps = officialOpenUrl('google-maps', { latitude: 44.6488, longitude: -63.5752 });
  assert.equal(new URL(maps).hostname, 'www.google.com');
  assert.match(maps, /query=44\.64880,-63\.57520/);
  const posts = officialOpenUrl('x-checkin', { place: 'Halifax <script>' });
  assert.equal(new URL(posts).hostname, 'x.com');
  assert.equal(posts.includes('<script>'), false);
  assert.equal(cleanPlace('  Halifax \n harbour  '), 'Halifax harbour');
  for (const option of [...SOCIAL_LOCATION_OPTIONS, ...SOCIAL_ACCOUNT_PLATFORMS]) {
    if (!option.openUrl) continue;
    const opened = officialOpenUrl(option.id);
    assert.equal(opened.startsWith('https://'), true, option.id);
    assert.equal(new URL(opened).hostname, new URL(option.openUrl).hostname, option.id);
  }
});

function element() {
  const listeners = {};
  return {
    value: '',
    textContent: '',
    disabled: false,
    dataset: {},
    className: '',
    type: '',
    scrollTop: 0,
    children: [],
    addEventListener(type, fn) {
      (listeners[type] ||= []).push(fn);
    },
    click() {
      for (const fn of listeners.click || []) fn({ preventDefault() {}, key: 'Enter', shiftKey: false });
    },
    replaceChildren() {
      this.children = [];
    },
    append(...nodes) {
      this.children.push(...nodes);
    },
    querySelectorAll() {
      return [];
    },
  };
}

test('Analyze posts one question to the existing model route and keeps the answer', async () => {
  const nodes = {};
  for (const id of [
    'social-panel',
    'social-account-platform',
    'social-account-handle',
    'social-account-list',
    'social-account-save',
    'social-account-open',
    'social-query',
    'social-model',
    'social-analyze-platform',
    'social-news-platform',
    'social-help-platform',
    'social-status',
    'social-output',
    'social-analyze',
    'social-news',
    'social-search',
    'social-help',
  ]) {
    nodes[id] = element();
  }
  const calls = [];
  const newsUrls = [];
  const fetch = async (url, init) => {
    if (url === '/api/llm/providers') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ providers: [{ id: 'xai', label: 'xAI Grok', ready: true }], askTimeoutMs: 5000 }),
      };
    }
    if (String(url).startsWith('/api/social/public-news')) {
      newsUrls.push(String(url));
      if (String(url).includes('action=news')) {
        return { ok: true, status: 200, json: async () => ({ status: 'empty', articles: [] }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: 'ready',
          match: 'site',
          source: 'Google News RSS',
          lookbackDays: 30,
          platforms: ['X'],
          articles: [{
            title: 'Harbour flood',
            url: 'https://news.google.com/rss/articles/abc',
            domain: 'x.com',
            publishedAt: '2026-09-29T12:00:00.000Z',
          }],
        }),
      };
    }
    calls.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ answer: 'Public posts only.', model: 'grok-4.6' }) };
  };
  const storage = memoryStorage();
  const doc = {
    getElementById: (id) => nodes[id] || null,
    createElement: () => element(),
  };
  const panel = new SocialMediaPanel(null, {
    document: doc,
    storage,
    fetch,
    sceneContext: async () => ({ selectedLocation: 'Halifax', view: { latitude: 44.6, longitude: -63.5 } }),
  });
  assert.ok(panel);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(nodes['social-model'].value, 'xai');
  saveSocialAccount(storage, 'x', 'river');
  saveSocialAccount(storage, 'happn', 'nearbyname');
  nodes['social-query'].value = 'tone of the replies';
  nodes['social-analyze-platform'].value = 'x';
  nodes['social-analyze'].click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(newsUrls.length, 1);
  assert.match(newsUrls[0], /action=analyze/);
  assert.match(newsUrls[0], /analysis=x/);
  assert.match(newsUrls[0], /place=Halifax/);
  assert.match(newsUrls[0], /x%3Ariver/);
  assert.equal(newsUrls[0].includes('happn'), false);
  assert.equal(newsUrls[0].includes('nearbyname'), false);
  assert.equal(newsUrls[0].includes('password'), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'xai');
  assert.match(calls[0].question, /tone of the replies/);
  assert.match(calls[0].question, /Harbour flood/);
  assert.match(calls[0].question, /not a private feed/);
  assert.ok(calls[0].question.includes(SOCIAL_REQUEST_LIMIT));
  assert.equal(calls[0].question.includes('my password'), false);
  assert.equal(calls[0].context.selectedLocation, 'Halifax');
  assert.equal(calls[0].context.socialPublicNews.articles[0].title, 'Harbour flood');
  assert.match(nodes['social-output'].textContent, /Harbour flood/);
  assert.match(nodes['social-output'].textContent, /Public posts only/);
  assert.match(nodes['social-status'].textContent, /grok-4\.6/);

  nodes['social-news-platform'].value = 'all';
  nodes['social-news'].click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(newsUrls.length, 2);
  assert.equal(newsUrls[1].includes('happn'), false);
  assert.equal(newsUrls[1].includes('nearbyname'), false);
  assert.equal(calls.length, 2);
  assert.match(calls[1].question, /No public item was returned/);
  assert.match(calls[1].question, /TikTok/);
  assert.equal(calls[1].question.includes('Snapchat'), false);
  assert.equal(calls[1].question.includes('Harbour flood'), false);
  assert.match(nodes['social-output'].textContent, /No public item was returned/);

  nodes['social-help-platform'].value = 'find-my';
  nodes['social-help'].click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(newsUrls.length, 2);
  assert.equal(calls.length, 3);
  assert.match(calls[2].question, /No public-post lookup was run with this question\./);
  assert.equal(calls[2].context.socialPublicNews.status, 'skipped');

  nodes['location-mini-city'] = element();
  nodes['location-mini-city'].textContent = '📍 Halifax';
  const opened = [];
  const opener = new SocialMediaPanel(
    {
      camera: {
        positionCartographic: {
          latitude: (44.6 * Math.PI) / 180,
          longitude: (-63.5 * Math.PI) / 180,
        },
      },
    },
    {
      document: doc,
      storage,
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ providers: [] }) }),
      openWindow: (url) => opened.push(url),
    },
  );
  opener._open('google-maps');
  assert.equal(opened.length, 1);
  assert.match(opened[0], /query=44\.60000,-63\.50000/);
  opener._open('x-checkin');
  assert.equal(new URL(opened[1]).hostname, 'x.com');
  assert.match(opened[1], /Halifax/);
  opener._open('one-time-share');
  assert.equal(nodes['social-status'].textContent, 'Open that app on your phone.');
  assert.equal(opened.length, 2);
  assert.equal(panelHtml.includes('One-time location share'), false);

  nodes['social-account-handle'].value = 'my password';
  nodes['social-account-platform'].value = 'x';
  nodes['social-account-save'].click();
  assert.match(nodes['social-status'].textContent, /passwords or keys/);
  const stored = storage.getItem(SOCIAL_ACCOUNTS_KEY);
  assert.equal(stored.includes('password'), false);
  assert.match(stored, /"handle":"river"/);
});

test('a saved password stays on this computer and out of the question', async () => {
  const secret = 's3al-check-value-not-a-platform-login';
  const userId = 'river.operator@example.com';
  const nodes = {};
  for (const id of [
    'social-panel',
    'social-account-platform',
    'social-account-handle',
    'social-account-password',
    'social-account-list',
    'social-account-save',
    'social-query',
    'social-model',
    'social-analyze-platform',
    'social-news-platform',
    'social-help-platform',
    'social-status',
    'social-output',
    'social-analyze',
    'social-news',
    'social-search',
    'social-help',
  ]) {
    nodes[id] = element();
  }
  const posts = [];
  const newsUrls = [];
  const asks = [];
  const fetch = async (url, init) => {
    if (url === '/api/llm/providers') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ providers: [{ id: 'xai', label: 'xAI Grok', ready: true }] }),
      };
    }
    if (url === '/api/social/accounts' && init?.method === 'POST') {
      posts.push(JSON.parse(init.body));
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, platform: 'x', userId }),
      };
    }
    if (url === '/api/social/accounts') {
      return { ok: true, status: 200, json: async () => ({ accounts: [] }) };
    }
    if (String(url).startsWith('/api/social/public-news')) {
      newsUrls.push(String(url));
      return { ok: true, status: 200, json: async () => ({ status: 'empty', articles: [] }) };
    }
    asks.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ answer: 'Public posts only.', model: 'grok-4.6' }) };
  };
  const storage = memoryStorage();
  const doc = {
    getElementById: (id) => nodes[id] || null,
    createElement: () => element(),
  };
  const panel = new SocialMediaPanel(null, {
    document: doc,
    storage,
    fetch,
    sceneContext: async () => ({ selectedLocation: 'Halifax' }),
  });
  assert.ok(panel);
  await new Promise((resolve) => setTimeout(resolve, 0));
  nodes['social-account-platform'].value = 'x';
  nodes['social-account-handle'].value = userId;
  nodes['social-account-password'].value = secret;
  nodes['social-account-save'].click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].platform, 'x');
  assert.equal(posts[0].userId, userId);
  assert.equal(posts[0].password === secret, true);
  assert.equal(nodes['social-account-password'].value, '');
  assert.equal(nodes['social-status'].textContent.includes(secret), false);
  const stored = storage.getItem(SOCIAL_ACCOUNTS_KEY);
  assert.equal(stored, null);
  const listed = [];
  const walk = (node) => {
    if (!node) return;
    if (node.textContent) listed.push(node.textContent);
    for (const child of node.children || []) walk(child);
  };
  walk(nodes['social-account-list']);
  const listText = listed.join('\n');
  assert.match(listText, /password saved/);
  assert.match(listText, /river\.operator@example\.com/);
  assert.equal(listText.includes(secret), false);
  nodes['social-query'].value = 'tone of the replies';
  nodes['social-analyze-platform'].value = 'x';
  nodes['social-analyze'].click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(newsUrls.length, 1);
  assert.equal(newsUrls[0].includes(secret), false);
  assert.equal(newsUrls[0].includes('example.com'), false);
  assert.equal(asks.length, 1);
  assert.equal(asks[0].question.includes(secret), false);
  assert.equal(asks[0].question.includes('example.com'), false);
  assert.equal(JSON.stringify(asks[0].context).includes(secret), false);
});

test('only a hooked-up account that shares your own location can name the marker', () => {
  assert.equal(SOCIAL_LOCATION_FIX_ID, 'social-location-fix');
  assert.deepEqual(
    SOCIAL_ACCOUNT_PLATFORMS.filter((item) => item.sharesLocation === true).map((item) => item.id),
    ['instagram', 'snapchat', 'find-my', 'google-maps', 'bump', 'blink', 'life360'],
  );
  assert.equal(readShowLocation(memoryStorage()), true);
  assert.equal(readShowLocation({ getItem: () => '0' }), false);
  assert.equal(readShowLocation({ getItem: () => '1' }), true);
  assert.equal(readShowLocation({ getItem() { throw new Error('blocked'); } }), true);
  assert.equal(readShowLocation(null), true);
  const storage = memoryStorage();
  writeShowLocation(storage, false);
  assert.equal(storage.getItem(SOCIAL_SHOW_LOCATION_KEY), '0');
  writeShowLocation(storage, true);
  assert.equal(storage.getItem(SOCIAL_SHOW_LOCATION_KEY), '1');
  writeShowLocation(null, false);

  const secret = 's3al-check-value-not-a-platform-login';
  const latitude = 12.25;
  const longitude = -67.5;
  assert.equal(locationSharingAccounts(null).length, 0);
  assert.equal(locationSharingAccounts([{ platform: 'life360', passwordSaved: true }]).length, 1);
  assert.equal(locationSharingAccounts([{ platform: 'life360', passwordSaved: false }]).length, 0);
  assert.equal(locationSharingAccounts([{ platform: 'life360' }]).length, 0);
  assert.equal(locationSharingAccounts([{ platform: 'happn', passwordSaved: true }]).length, 0);
  assert.equal(locationSharingAccounts([{ platform: 'x', passwordSaved: true }]).length, 0);
  assert.equal(locationSharingAccounts([{ platform: 'radarly', passwordSaved: true }]).length, 0);
  assert.equal(locationSharingAccounts([{ platform: 'sniffies', passwordSaved: true }]).length, 0);
  assert.equal(
    locationSharingAccounts([
      { platform: 'life360', passwordSaved: true },
      { platform: 'life360', passwordSaved: true },
    ]).length,
    1,
  );
  assert.equal(
    liveLocationLabel([
      { platform: 'instagram', passwordSaved: true },
      { platform: 'life360', passwordSaved: true },
    ]) === 'You · Instagram, Life360',
    true,
  );
  assert.equal(liveLocationLabel([{ platform: 'happn', passwordSaved: true }]), '');

  const fix = acceptDeviceFix({
    coords: { latitude, longitude, accuracy: 4, password: secret },
    password: secret,
  });
  assert.equal(fix.latitude === latitude, true);
  assert.equal(fix.longitude === longitude, true);
  assert.equal(fix.accuracy === 4, true);
  assert.deepEqual(Object.keys(fix).sort(), ['accuracy', 'latitude', 'longitude']);
  assert.equal(JSON.stringify(fix).includes(secret), false);
  assert.equal(acceptDeviceFix({ latitude: 999, longitude: 0 }), null);
  assert.equal(acceptDeviceFix({ coords: { latitude: Number.NaN, longitude: 0 } }), null);
  assert.equal(acceptDeviceFix({ coords: { latitude: 0, longitude: 181 } }), null);
  assert.equal(acceptDeviceFix(null), null);
  const edge = acceptDeviceFix({ coords: { latitude: 90, longitude: -180, accuracy: -1, password: secret } });
  assert.equal(edge.latitude === 90, true);
  assert.equal(edge.longitude === -180, true);
  assert.equal(edge.accuracy, null);
  assert.equal(JSON.stringify(edge).includes(secret), false);
});

function hookNode(node) {
  const handlers = {};
  const listen = node.addEventListener.bind(node);
  node.addEventListener = (type, fn) => {
    (handlers[type] ||= []).push(fn);
    listen(type, fn);
  };
  node.fire = (type) => {
    for (const fn of handlers[type] || []) fn({ preventDefault() {}, key: '', shiftKey: false });
  };
  return node;
}

function countingStorage(seed) {
  const map = new Map(seed || []);
  const writes = [];
  return {
    writes,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      writes.push(key);
      map.set(key, String(value));
    },
  };
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function findRemove(list) {
  const found = [];
  const walk = (node) => {
    if (!node) return;
    if (node.textContent === 'REMOVE') found.push(node);
    for (const child of node.children || []) walk(child);
  };
  walk(list);
  return found;
}

function fakeGeolocation() {
  const state = { success: null, failure: null, options: [], cleared: [], nextId: 1 };
  return {
    state,
    watchPosition(success, failure, options) {
      state.success = success;
      state.failure = failure;
      state.options.push(options);
      const id = state.nextId;
      state.nextId += 1;
      return id;
    },
    clearWatch(id) {
      state.cleared.push(id);
    },
    push(position) {
      state.success?.(position);
    },
    fail() {
      state.failure?.();
    },
  };
}

function mountLocationPanel({ accounts, storage, geolocation, placeFix, clearFix, openWindow }) {
  const nodes = {};
  for (const id of [
    'social-panel',
    'social-account-platform',
    'social-account-handle',
    'social-account-password',
    'social-account-list',
    'social-account-save',
    'social-query',
    'social-model',
    'social-analyze-platform',
    'social-news-platform',
    'social-help-platform',
    'social-status',
    'social-output',
    'social-analyze',
    'social-news',
    'social-search',
    'social-help',
    'social-show-location',
    'social-location-note',
    'social-account-note',
    'social-account-apikey',
    'social-open-kind',
    'social-open-saved',
    'social-powerup',
    'social-help-kind',
    'social-help-destination',
    'social-help-entries',
    'social-help-item-1',
    'social-help-item-2',
    'social-help-save',
    'social-help-default',
  ]) {
    nodes[id] = element();
  }
  hookNode(nodes['social-show-location']);
  hookNode(nodes['social-account-platform']);
  hookNode(nodes['social-open-kind']);
  hookNode(nodes['social-help-kind']);
  nodes['social-help-kind'].value = 'medicine';
  const newsUrls = [];
  const asks = [];
  const posts = [];
  const fetch = async (url, init) => {
    if (url === '/api/llm/providers') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ providers: [{ id: 'xai', label: 'xAI Grok', ready: true }] }),
      };
    }
    if (url === '/api/social/accounts' && init?.method === 'POST') {
      const body = JSON.parse(init.body);
      posts.push(body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, platform: body.platform, userId: body.userId }),
      };
    }
    if (url === '/api/social/accounts' && init?.method === 'DELETE') {
      return { ok: true, status: 200, json: async () => ({ ok: true, platform: 'life360' }) };
    }
    if (url === '/api/social/accounts') {
      return { ok: true, status: 200, json: async () => ({ accounts }) };
    }
    if (String(url).startsWith('/api/social/public-news')) {
      newsUrls.push(String(url));
      return { ok: true, status: 200, json: async () => ({ status: 'empty', articles: [] }) };
    }
    asks.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ answer: 'Public posts only.', model: 'grok-4.6' }) };
  };
  const viewer = { name: 'map' };
  const panel = new SocialMediaPanel(viewer, {
    document: { getElementById: (id) => nodes[id] || null, createElement: () => element() },
    storage,
    fetch,
    geolocation,
    placeFix,
    clearFix,
    openWindow,
    sceneContext: async () => ({ selectedLocation: 'Halifax' }),
  });
  return { panel, nodes, viewer, newsUrls, asks, posts };
}

test('a hooked-up location share shows this device and stays off the question', async () => {
  const secret = 's3al-check-value-not-a-platform-login';
  const latitude = 12.25;
  const longitude = -67.5;
  const movedLongitude = -67.25;
  const geo = fakeGeolocation();
  const placed = [];
  const cleared = [];
  const storage = countingStorage();
  const mounted = mountLocationPanel({
    accounts: [{ platform: 'life360', userId: 'circle.member', passwordSaved: true }],
    storage,
    geolocation: geo,
    placeFix: (viewer, fix, label) => {
      placed.push({ viewer, fix, label });
    },
    clearFix: (viewer) => {
      cleared.push(viewer);
    },
  });
  await tick();
  assert.equal(mounted.nodes['social-show-location'].checked, true);
  assert.equal(storage.writes.includes(SOCIAL_SHOW_LOCATION_KEY), false);
  assert.equal(geo.state.options.length, 1);
  assert.equal(geo.state.options[0].enableHighAccuracy, true);
  assert.equal(geo.state.options[0].maximumAge, 5000);
  assert.equal(geo.state.options[0].timeout, 20000);
  assert.equal(JSON.stringify(geo.state.options).includes(secret), false);

  geo.fail();
  assert.equal(mounted.nodes['social-location-note'].textContent === 'This browser did not share a location.', true);
  geo.push({ coords: { latitude: 999, longitude: 0, password: secret }, password: secret });
  await tick();
  assert.equal(placed.length, 0);
  assert.equal(mounted.nodes['social-location-note'].textContent === 'This browser did not share a location.', true);
  assert.equal(mounted.nodes['social-status'].textContent.includes(secret), false);

  geo.push({
    coords: { latitude, longitude, accuracy: 4, password: secret },
    password: secret,
  });
  await tick();
  assert.equal(placed.length, 1);
  assert.equal(placed[0].viewer === mounted.viewer, true);
  assert.equal(placed[0].fix.latitude === latitude, true);
  assert.equal(placed[0].fix.longitude === longitude, true);
  assert.equal(placed[0].label === 'You · Life360', true);
  assert.equal(JSON.stringify(placed[0].fix).includes(secret), false);
  assert.equal(placed[0].label.includes(secret), false);
  assert.equal(mounted.nodes['social-location-note'].textContent === 'Your live position is on the map.', true);
  assert.equal(mounted.nodes['social-location-note'].textContent.includes(String(latitude)), false);
  assert.equal(mounted.nodes['social-status'].textContent.includes(String(latitude)), false);
  assert.equal(cleared.length, 0);

  geo.push({ coords: { latitude, longitude: movedLongitude, accuracy: 4 } });
  await tick();
  assert.equal(placed.length, 2);
  assert.equal(placed[1].fix.longitude === movedLongitude, true);
  assert.equal(cleared.length, 0);

  mounted.nodes['social-show-location'].checked = false;
  mounted.nodes['social-show-location'].fire('change');
  assert.equal(geo.state.cleared[0] === 1, true);
  assert.equal(cleared.length, 1);
  assert.equal(storage.getItem(SOCIAL_SHOW_LOCATION_KEY), '0');
  assert.equal(mounted.nodes['social-location-note'].textContent === 'Live position is hidden.', true);
  geo.push({ coords: { latitude, longitude, accuracy: 4, password: secret } });
  await tick();
  assert.equal(placed.length, 2);

  mounted.nodes['social-show-location'].checked = true;
  mounted.nodes['social-show-location'].fire('change');
  assert.equal(geo.state.options.length, 2);
  assert.equal(storage.getItem(SOCIAL_SHOW_LOCATION_KEY), '1');
  geo.push({ coords: { latitude, longitude, accuracy: 4 } });
  await tick();
  assert.equal(placed.length, 3);

  mounted.nodes['social-query'].value = 'tone of the replies';
  mounted.nodes['social-analyze-platform'].value = 'x';
  mounted.nodes['social-analyze'].click();
  await tick();
  assert.equal(mounted.newsUrls.length, 1);
  assert.equal(mounted.newsUrls[0].includes(secret), false);
  assert.equal(mounted.newsUrls[0].includes(String(latitude)), false);
  assert.equal(mounted.newsUrls[0].includes(String(longitude)), false);
  assert.equal(mounted.asks.length, 1);
  assert.equal(mounted.asks[0].question.includes(secret), false);
  assert.equal(mounted.asks[0].question.includes(String(latitude)), false);
  assert.equal(mounted.asks[0].question.includes(String(longitude)), false);
  assert.equal(JSON.stringify(mounted.asks[0].context).includes(secret), false);
  assert.equal(JSON.stringify(mounted.asks[0].context).includes(String(latitude)), false);
  assert.equal(mounted.nodes['social-status'].textContent.includes(secret), false);
  assert.equal(mounted.nodes['social-output'].textContent.includes(String(latitude)), false);
  assert.equal(mounted.nodes['social-location-note'].textContent === 'Your live position is on the map.', true);

  const remove = findRemove(mounted.nodes['social-account-list']);
  assert.equal(remove.length, 1);
  remove[0].click();
  await tick();
  assert.equal(geo.state.cleared[1] === 2, true);
  assert.equal(cleared.length, 2);
  assert.equal(
    mounted.nodes['social-location-note'].textContent ===
      'A hooked-up account that shares location displays live position on the map. If allowed by 3rd Party.',
    true,
  );
  geo.push({ coords: { latitude, longitude, accuracy: 4, password: secret } });
  await tick();
  assert.equal(placed.length, 3);
  assert.equal(mounted.nodes['social-location-note'].textContent.includes(secret), false);
});

test('a hidden choice, a public handle, and a nearby app do not place a marker', async () => {
  const secret = 's3al-check-value-not-a-platform-login';
  const latitude = 12.25;
  const longitude = -67.5;
  const hiddenGeo = fakeGeolocation();
  const hiddenPlaced = [];
  const hiddenStorage = countingStorage([[SOCIAL_SHOW_LOCATION_KEY, '0']]);
  const hidden = mountLocationPanel({
    accounts: [{ platform: 'find-my', userId: 'circle.member', passwordSaved: true }],
    storage: hiddenStorage,
    geolocation: hiddenGeo,
    placeFix: () => hiddenPlaced.push('placed'),
    clearFix: () => {},
  });
  await tick();
  assert.equal(hidden.nodes['social-show-location'].checked, false);
  assert.equal(hiddenGeo.state.options.length, 0);
  assert.equal(hiddenPlaced.length, 0);
  assert.equal(hiddenStorage.writes.includes(SOCIAL_SHOW_LOCATION_KEY), false);
  hidden.nodes['social-show-location'].checked = true;
  hidden.nodes['social-show-location'].fire('change');
  assert.equal(hiddenStorage.getItem(SOCIAL_SHOW_LOCATION_KEY), '1');
  hiddenGeo.push({ coords: { latitude, longitude, accuracy: 4, password: secret } });
  await tick();
  assert.equal(hiddenPlaced.length, 1);
  assert.equal(hidden.nodes['social-location-note'].textContent.includes(secret), false);
  assert.equal(hidden.nodes['social-location-note'].textContent.includes(String(latitude)), false);

  const happnGeo = fakeGeolocation();
  const happnPlaced = [];
  const happn = mountLocationPanel({
    accounts: [{ platform: 'happn', userId: 'nearbyname', passwordSaved: true, password: secret }],
    storage: countingStorage(),
    geolocation: happnGeo,
    placeFix: () => happnPlaced.push('placed'),
    clearFix: () => {},
  });
  await tick();
  assert.equal(happnGeo.state.options.length, 0);
  assert.equal(happnPlaced.length, 0);
  assert.equal(happn.nodes['social-location-note'].textContent.includes(secret), false);

  const handleStorage = countingStorage();
  saveSocialAccount(handleStorage, 'life360', 'circle.member');
  const handleGeo = fakeGeolocation();
  const handlePlaced = [];
  mountLocationPanel({
    accounts: [],
    storage: handleStorage,
    geolocation: handleGeo,
    placeFix: () => handlePlaced.push('placed'),
    clearFix: () => {},
  });
  await tick();
  assert.equal(handleGeo.state.options.length, 0);
  assert.equal(handlePlaced.length, 0);

  const quiet = mountLocationPanel({
    accounts: [{ platform: 'google-maps', userId: 'circle.member', passwordSaved: true }],
    storage: countingStorage(),
    geolocation: null,
    placeFix: () => {
      throw new Error('marker');
    },
    clearFix: () => {},
  });
  await tick();
  assert.equal(quiet.nodes['social-location-note'].textContent === 'This browser did not share a location.', true);
  assert.equal(quiet.nodes['social-status'].textContent, '');

  const savedGeo = fakeGeolocation();
  const savedPlaced = [];
  const saved = mountLocationPanel({
    accounts: [],
    storage: countingStorage(),
    geolocation: savedGeo,
    placeFix: (_viewer, fix, label) => savedPlaced.push({ fix, label }),
    clearFix: () => {},
  });
  const realFetch = saved.posts;
  await tick();
  assert.equal(savedGeo.state.options.length, 0);
  saved.nodes['social-account-platform'].value = 'blink';
  saved.nodes['social-account-handle'].value = 'circle.member';
  saved.nodes['social-account-password'].value = secret;
  saved.nodes['social-account-save'].click();
  await tick();
  assert.equal(realFetch.length, 1);
  assert.equal(realFetch[0].password === secret, true);
  assert.equal(saved.nodes['social-account-password'].value, '');
  assert.equal(saved.nodes['social-status'].textContent.includes(secret), false);
  assert.equal(savedGeo.state.options.length, 1);
  savedGeo.push({ coords: { latitude, longitude, accuracy: 3, password: secret }, password: secret });
  await tick();
  assert.equal(savedPlaced.length, 1);
  assert.equal(savedPlaced[0].label === 'You · Blink', true);
  assert.equal(JSON.stringify(savedPlaced[0].fix).includes(secret), false);
  assert.equal(saved.nodes['social-location-note'].textContent.includes(secret), false);
  assert.equal(saved.nodes['social-location-note'].textContent.includes(String(latitude)), false);
});

// ---- bot swarms -------------------------------------------------------------

const SWARM_IDS = [
  'social-panel',
  'social-account-list',
  'social-status',
  'social-output',
  ...['xai', 'openai'].flatMap((id) =>
    ['open', 'instructions', 'run', 'status'].map((part) => `social-swarm-${id}-${part}`),
  ),
];

/**
 * The box with its two swarms. `keys` is what /api/social/swarm/status says
 * (null: the server could not say); `chief` answers the Chief of Staff
 * hand-off and `open` the Grok Bot opener.
 */
function swarmPage({
  answer = () => ({ ok: true, status: 200, json: async () => ({ ok: true, text: '' }) }),
  keys = { xai: { key: true, chiefOfStaff: false }, openai: { key: true } },
  chief = () => ({ ok: true, status: 200, json: async () => ({ ok: true, sent: true }) }),
  open = () => ({ ok: true, status: 200, json: async () => ({ ok: true, opened: 'shortcut' }) }),
  clipboard = null,
  opened = [],
  context = { selectedLocation: 'Halifax' },
  point = null,
  city = '',
} = {}) {
  const nodes = {};
  for (const id of SWARM_IDS) nodes[id] = element();
  nodes['social-swarm-xai-run'].textContent = 'GROK BOT SWARM';
  nodes['social-swarm-openai-run'].textContent = 'OPENAI BOT SWARM';
  const bots = [];
  const handoffs = [];
  const opens = [];
  const statusAsks = [];
  const cityAsks = [];
  const fetch = async (url, init = {}) => {
    if (String(url).startsWith('/api/social/swarm/nearest-city?')) {
      cityAsks.push(String(url));
      return { ok: true, status: 200, json: async () => ({ city }) };
    }
    if (url === '/api/llm/providers') {
      return { ok: true, status: 200, json: async () => ({ providers: [], askTimeoutMs: 5000 }) };
    }
    if (url === '/api/social/accounts') {
      return { ok: true, status: 200, json: async () => ({ accounts: [] }) };
    }
    if (url === '/api/social/swarm/status') {
      statusAsks.push(init.method || 'GET');
      if (!keys) throw new Error('offline');
      return { ok: true, status: 200, json: async () => keys };
    }
    if (url === '/api/social/swarm') {
      const body = JSON.parse(init.body);
      bots.push(body);
      return answer(body);
    }
    if (url === '/api/social/swarm/chief-of-staff') {
      const body = JSON.parse(init.body);
      handoffs.push(body);
      return chief(body);
    }
    if (url === '/api/social/grok-bot/open') {
      opens.push(init.method);
      return open();
    }
    throw new Error(`unexpected ${url}`);
  };
  const storage = memoryStorage();
  // A camera over `point` ({ latitude, longitude } in degrees), as Cesium reports it.
  const viewer = point
    ? {
        camera: {
          positionCartographic: {
            latitude: (point.latitude * Math.PI) / 180,
            longitude: (point.longitude * Math.PI) / 180,
          },
        },
      }
    : null;
  const panel = new SocialMediaPanel(viewer, {
    document: { getElementById: (id) => nodes[id] || null, createElement: () => element() },
    storage,
    fetch,
    clipboard,
    openWindow: (url) => opened.push(url),
    sceneContext: async () => context,
  });
  return { panel, nodes, bots, handoffs, opens, statusAsks, cityAsks, storage };
}

const settleSwarm = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

test('GROK BOT SWARM spins up on the press and sends one bot per platform at once', async () => {
  const held = [];
  const page = swarmPage({
    answer: (body) =>
      new Promise((resolve) => {
        held.push(() =>
          resolve(
            body.bot === 'tiktok'
              ? { ok: false, status: 502, json: async () => ({ error: 'xAI refused the bot (HTTP 500)' }) }
              : {
                  ok: true,
                  status: 200,
                  json: async () => ({
                    ok: true,
                    bot: body.bot,
                    text: body.bot === 'x' ? '14:05 · Spring Garden Rd · police activity' : 'NOTHING FOUND',
                    sources: body.bot === 'x' ? [{ url: 'https://x.com/hfxpolice/status/1', title: 'HRP' }] : [],
                  }),
                },
          ),
        );
      }),
  });
  await settleSwarm();
  const run = page.nodes['social-swarm-xai-run'];
  run.click();
  // On the press itself, before anything is back.
  assert.equal(run.textContent, 'SPINNING UP SWARM…');
  assert.equal(run.disabled, true);
  assert.equal(page.nodes['social-swarm-xai-status'].textContent, 'SPINNING UP SWARM · 7 BOTS');
  await settleSwarm();
  assert.deepEqual(page.statusAsks, ['GET'], 'the keys are asked about once, before any bot');
  assert.deepEqual(
    page.bots.map((bot) => bot.bot),
    ['x', 'facebook', 'instagram', 'threads', 'tiktok', 'truth', 'news'],
  );
  for (const bot of page.bots) {
    assert.equal(bot.provider, 'xai');
    assert.equal(bot.place, 'Halifax');
    assert.equal(bot.instructions, '');
  }
  assert.deepEqual(page.handoffs, [], 'with its own key nothing goes to the Chief of Staff');
  assert.equal(page.nodes['social-swarm-xai-status'].textContent, 'SPINNING UP SWARM · 7 BOTS · Halifax');
  // A second press while the bots are out sends nothing more.
  run.click();
  await settleSwarm();
  assert.equal(page.bots.length, 7);
  assert.equal(page.nodes['social-swarm-xai-status'].textContent, 'The swarm is still out.');
  // They come back one at a time.
  held[0]();
  await settleSwarm();
  assert.equal(page.nodes['social-swarm-xai-status'].textContent, 'SWARM OUT · 1/7 BACK');
  assert.match(page.nodes['social-output'].textContent, /GROK BOT SWARM · X · Halifax/);
  assert.match(page.nodes['social-output'].textContent, /Spring Garden Rd · police activity/);
  assert.match(page.nodes['social-output'].textContent, /- HRP · https:\/\/x\.com\/hfxpolice\/status\/1/);
  for (const release of held.slice(1)) release();
  await settleSwarm();
  assert.match(
    page.nodes['social-output'].textContent,
    /GROK BOT SWARM · TikTok · Halifax[^\n]*\nBOT FAILED: xAI refused the bot \(HTTP 500\)/,
  );
  assert.match(page.nodes['social-output'].textContent, /GROK BOT SWARM · Facebook · Halifax[^\n]*\nNOTHING FOUND/);
  assert.match(
    page.nodes['social-swarm-xai-status'].textContent,
    /^SWARM DONE .+ · 1 with reports · 5 found nothing · 1 failed$/,
  );
  assert.equal(run.textContent, 'GROK BOT SWARM');
  assert.equal(run.disabled, false);
  // The other swarm was never touched.
  assert.equal(page.nodes['social-swarm-openai-status'].textContent, '');
});

test('OPENAI BOT SWARM runs on its own key: without the OPENAI DOTS key it sends nothing and says where it goes', async () => {
  const page = swarmPage({ keys: { xai: { key: false, chiefOfStaff: false }, openai: { key: false } } });
  await settleSwarm();
  page.nodes['social-swarm-openai-instructions'].value = 'Flooding reports by the harbour';
  page.nodes['social-swarm-openai-run'].click();
  await settleSwarm();
  assert.equal(page.bots.length, 0);
  assert.deepEqual(page.handoffs, []);
  assert.deepEqual(page.opens, []);
  assert.equal(
    page.nodes['social-swarm-openai-status'].textContent,
    'No OPENAI DOTS key yet. Add it in POWER UP → OPENAI DOTS.',
  );
  assert.equal(page.nodes['social-output'].textContent, '');
  assert.equal(page.nodes['social-swarm-openai-run'].textContent, 'OPENAI BOT SWARM');
  assert.equal(page.nodes['social-swarm-openai-run'].disabled, false);
  // When the server cannot say which keys are in, the bots go out and the
  // first refusal is said once.
  const unknown = swarmPage({
    keys: null,
    answer: () => ({
      ok: false,
      status: 501,
      json: async () => ({ error: 'No OPENAI DOTS key yet. Add it in POWER UP → OPENAI DOTS.', unconfigured: true }),
    }),
  });
  await settleSwarm();
  unknown.nodes['social-swarm-openai-run'].click();
  await settleSwarm();
  assert.equal(unknown.bots.length, 7);
  assert.ok(unknown.bots.every((bot) => bot.provider === 'openai'));
  assert.equal(
    unknown.nodes['social-swarm-openai-status'].textContent,
    'No OPENAI DOTS key yet. Add it in POWER UP → OPENAI DOTS.',
  );
  assert.equal(unknown.nodes['social-output'].textContent, '');
});

test('GROK BOT SWARM with no Grok Bot key sends its task to the Chief of Staff webhook routine', async () => {
  const page = swarmPage({
    keys: { xai: { key: false, chiefOfStaff: true }, openai: { key: false } },
    point: { latitude: 44.6488, longitude: -63.5752 },
    city: 'Halifax, Nova Scotia',
  });
  await settleSwarm();
  page.nodes['social-swarm-xai-instructions'].value = 'Road closures and fires only';
  page.nodes['social-swarm-xai-run'].click();
  assert.equal(page.nodes['social-swarm-xai-run'].textContent, 'SPINNING UP SWARM…');
  await settleSwarm();
  assert.equal(page.bots.length, 0, 'no paid bot is sent');
  assert.deepEqual(page.opens, [], 'the app is not opened: the routine takes the task');
  assert.equal(page.handoffs.length, 1);
  assert.equal(page.handoffs[0].instructions, 'Road closures and fires only');
  assert.equal(page.handoffs[0].place, 'Halifax');
  assert.equal(page.handoffs[0].nearestCity, 'Halifax, Nova Scotia');
  assert.deepEqual(page.cityAsks, ['/api/social/swarm/nearest-city?lat=44.6488&lon=-63.5752']);
  assert.match(
    page.nodes['social-swarm-xai-status'].textContent,
    /^SENT TO CHIEF OF STAFF .+ · ITS REPORT COMES BACK IN GROK BOT$/,
  );
  const log = page.nodes['social-output'].textContent;
  assert.match(log, /GROK BOT SWARM · CHIEF OF STAFF · Halifax/);
  assert.match(log, /Sent to your Chief of Staff bot's webhook routine in Grok Bot\./);
  assert.match(log, /Chief of Staff: run a GROK BOT SWARM sweep of public social media\./);
  assert.match(log, /Operator's instructions: Road closures and fires only/);
  assert.equal(page.nodes['social-swarm-xai-run'].textContent, 'GROK BOT SWARM');
  assert.equal(page.nodes['social-swarm-xai-run'].disabled, false);
  // A refusal from the route is said as it is, and nothing is logged.
  const refused = swarmPage({
    keys: { xai: { key: false, chiefOfStaff: true }, openai: { key: false } },
    chief: () => ({ ok: false, status: 502, json: async () => ({ error: 'Grok Bot refused the task (HTTP 401)' }) }),
  });
  await settleSwarm();
  refused.nodes['social-swarm-xai-run'].click();
  await settleSwarm();
  assert.equal(refused.nodes['social-swarm-xai-status'].textContent, 'Grok Bot refused the task (HTTP 401)');
  assert.equal(refused.nodes['social-output'].textContent, '');
});

test('GROK BOT SWARM with no key and no webhook opens Grok Bot with the task copied for the Chief of Staff bot', async () => {
  const copied = [];
  // A bare map point (no place name on screen): the nearest city is looked up.
  const page = swarmPage({
    keys: { xai: { key: false, chiefOfStaff: false }, openai: { key: true } },
    clipboard: { writeText: async (text) => copied.push(text) },
    context: {},
    point: { latitude: 44.4276, longitude: -63.8535 },
    city: 'Halifax, Nova Scotia',
  });
  await settleSwarm();
  page.nodes['social-swarm-xai-run'].click();
  await settleSwarm();
  assert.equal(page.bots.length, 0);
  assert.equal(page.handoffs.length, 0);
  assert.deepEqual(page.opens, ['POST'], 'the server opens the app, once');
  assert.equal(copied.length, 1);
  assert.match(copied[0], /^Chief of Staff: run a GROK BOT SWARM sweep of public social media\./);
  assert.match(copied[0], /Platforms: X, Facebook, Instagram, Threads, TikTok, Truth Social, local news sites and official agency pages\./);
  assert.ok(copied[0].includes('\nPlace: the map point 44.4276, -63.8535. Nearest city: Halifax, Nova Scotia.\n'));
  assert.deepEqual(page.cityAsks, ['/api/social/swarm/nearest-city?lat=44.4276&lon=-63.8535']);
  assert.match(copied[0], /Task: Find threat incidents reported near that place in the last 24 hours/);
  assert.ok(copied[0].includes('\nRules: situational-awareness map, through its GROK BOT SWARM button.\n'));
  assert.match(copied[0], /do not identify, or profile a private person, even when the instructions ask/);
  assert.equal(
    page.nodes['social-swarm-xai-status'].textContent,
    'GROK BOT OPENED · TASK COPIED · PASTE IT TO YOUR CHIEF OF STAFF BOT',
  );
  assert.match(page.nodes['social-output'].textContent, /Copied for your Chief of Staff bot in Grok Bot:/);
  assert.ok(page.nodes['social-output'].textContent.includes(copied[0]), 'the task is kept in the log too');
  // No clipboard and an app that will not open: the task is still in the log.
  const stuck = swarmPage({
    keys: { xai: { key: false, chiefOfStaff: false }, openai: { key: true } },
    clipboard: { writeText: async () => Promise.reject(new Error('denied')) },
    open: () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: 'Grok Bot answers only the machine running the server' }),
    }),
  });
  await settleSwarm();
  stuck.nodes['social-swarm-xai-run'].click();
  await settleSwarm();
  assert.equal(
    stuck.nodes['social-swarm-xai-status'].textContent,
    'Grok Bot answers only the machine running the server · COPY THE TASK FROM THE LOG TO YOUR CHIEF OF STAFF BOT',
  );
  assert.match(stuck.nodes['social-output'].textContent, /For your Chief of Staff bot in Grok Bot:/);
  // A key pasted into the instructions is refused before anything is copied, sent or opened.
  const keyed = swarmPage({
    keys: { xai: { key: false, chiefOfStaff: true }, openai: { key: true } },
    clipboard: { writeText: async (text) => copied.push(text) },
  });
  await settleSwarm();
  keyed.nodes['social-swarm-xai-instructions'].value = `use xai-${'k'.repeat(24)}`;
  keyed.nodes['social-swarm-xai-run'].click();
  await settleSwarm();
  assert.equal(keyed.nodes['social-swarm-xai-status'].textContent, 'Take the key out of the instructions. The bots never need one.');
  assert.deepEqual([keyed.handoffs.length, keyed.opens.length, copied.length], [0, 0, 1]);
});

test('OPEN GROK BOT opens the desktop app, OPEN CHATGPT opens ChatGPT, and no swarm keeps a login', async () => {
  const opened = [];
  const page = swarmPage({ opened });
  await settleSwarm();
  page.nodes['social-swarm-xai-open'].click();
  await settleSwarm();
  assert.deepEqual(page.opens, ['POST']);
  assert.equal(page.nodes['social-swarm-xai-status'].textContent, 'GROK BOT OPENED');
  page.nodes['social-swarm-openai-open'].click();
  assert.deepEqual(opened, ['https://chatgpt.com/']);
  // The swarms' login slots are gone: not a platform, not a saved account.
  assert.equal(SOCIAL_ACCOUNT_PLATFORMS.some((item) => item.id === 'grok' || item.id === 'openai'), false);
  assert.equal(saveSocialAccount(page.storage, 'grok', 'river.ops').ok, false);
  assert.deepEqual(readSocialAccounts(memoryStorage(JSON.stringify([{ platform: 'grok', handle: 'river.ops' }]))), []);
  const plan = planSocialRequest({
    action: 'analyze',
    text: 'tone',
    analysisId: 'x',
    providerId: 'xai',
    accounts: [
      { platform: 'grok', handle: 'river.ops' },
      { platform: 'x', handle: 'river' },
    ],
  });
  assert.match(plan.question, /Saved public handles: X @river\./);
  assert.equal(plan.question.includes('river.ops'), false);
});

test('the box carries both swarms: instructions, the button and OPEN, with no note under them and no login', () => {
  for (const [id, title, open] of [
    ['xai', 'GROK BOT SWARM', 'OPEN GROK BOT'],
    ['openai', 'OPENAI BOT SWARM', 'OPEN CHATGPT'],
  ]) {
    assert.ok(panelHtml.includes(`<div class="cctv-summary-label">${title}</div>`), title);
    for (const part of ['instructions', 'run', 'open', 'status']) {
      assert.match(panelHtml, new RegExp(`id="social-swarm-${id}-${part}"`), `${id} ${part}`);
    }
    for (const part of ['id', 'password', 'save']) {
      assert.equal(panelHtml.includes(`id="social-swarm-${id}-${part}"`), false, `${id} ${part} is gone`);
    }
    assert.match(panelHtml, new RegExp(`id="social-swarm-${id}-run"[^>]*>${title}<`));
    assert.match(panelHtml, new RegExp(`id="social-swarm-${id}-open"[^>]*>${open}<`));
    assert.match(panelHtml, new RegExp(`id="social-swarm-${id}-instructions"[^>]*maxlength="1000"`));
  }
  // The owner removed both notes under the swarms (2026-10-01).
  for (const gone of [
    'Seven bots cover X, Facebook, Instagram, Threads, TikTok, Truth Social and local news at once.',
    'The same seven bots, each one OpenAI request with web search',
    'The login stays encrypted on this computer and is never sent to a bot.',
  ]) {
    assert.equal(panelHtml.includes(gone), false, gone);
  }
  const swarms = panelHtml.slice(
    panelHtml.indexOf('<div class="cctv-summary-label">GROK BOT SWARM</div>'),
    panelHtml.indexOf('id="social-output"'),
  );
  assert.equal(swarms.includes('class="social-note"'), false, 'no note between the swarms and the log');
  // The swarms sit above the log their bots write into, the last thing in the box.
  assert.ok(panelHtml.indexOf('id="social-swarm-openai-status"') < panelHtml.indexOf('id="social-output"'));
  assert.match(panelHtml, /<div id="social-output"[^>]*><\/div>\n      <\/div>\n    <\/div>\n  <\/div>\n/);
});

test('the log at the bottom of the box is taller than the Ask panel’s, and still hidden while empty', () => {
  const css = readFileSync(new URL('./ui/styles/social.css', import.meta.url), 'utf8');
  const shared = readFileSync(new URL('./ui/styles/ask.css', import.meta.url), 'utf8');
  const rule = /#social-panel \.ask-output \{([^}]*)\}/.exec(css);
  assert.ok(rule, 'the box sizes its own log');
  assert.match(rule[1], /min-height: 200px;/);
  assert.match(rule[1], /max-height: min\(70vh, 640px\);/);
  assert.equal(/display\s*:/.test(rule[1]), false, 'the rule never shows an empty log');
  assert.match(shared, /\.ask-output \{[^}]*max-height: 240px;/);
  assert.match(shared, /\.ask-output:empty \{\s*display: none;/);
});

test('the map point is the ground at the middle of the screen; the camera itself only when the view is above the horizon', () => {
  const deg = Math.PI / 180;
  const picks = [];
  let ground = { carto: { latitude: 44.6488 * deg, longitude: -63.5752 * deg } };
  const viewer = {
    scene: {
      canvas: { clientWidth: 800, clientHeight: 600 },
      globe: { ellipsoid: { cartesianToCartographic: (cartesian) => cartesian.carto } },
    },
    camera: {
      // A tilted camera out at sea, looking at the city.
      positionCartographic: { latitude: 44.4276 * deg, longitude: -63.8535 * deg },
      pickEllipsoid: (windowPosition, ellipsoid) => {
        picks.push({ windowPosition, ellipsoid: Boolean(ellipsoid) });
        return ground;
      },
    },
  };
  const panel = new SocialMediaPanel(viewer, { document: { getElementById: () => null } });
  const point = (view) => [view.latitude.toFixed(4), view.longitude.toFixed(4)];
  assert.deepEqual(point(panel._openView()), ['44.6488', '-63.5752']);
  assert.deepEqual(picks, [{ windowPosition: { x: 400, y: 300 }, ellipsoid: true }]);
  // The middle of the screen is sky: the camera's own point.
  ground = undefined;
  assert.deepEqual(point(panel._openView()), ['44.4276', '-63.8535']);
  // No scene yet: the camera's own point; no camera: no point at all.
  assert.deepEqual(point(new SocialMediaPanel({ camera: viewer.camera }, { document: { getElementById: () => null } })._openView()), ['44.4276', '-63.8535']);
  const none = new SocialMediaPanel(null, { document: { getElementById: () => null } })._openView();
  assert.equal('latitude' in none, false);
});

test('a point in no town gets the nearest city from the built-in gazetteer, with its distance', async () => {
  const copied = [];
  // Out at sea off Halifax: the server's reverse lookup finds no town.
  const page = swarmPage({
    keys: { xai: { key: false, chiefOfStaff: false }, openai: { key: true } },
    clipboard: { writeText: async (text) => copied.push(text) },
    context: {},
    point: { latitude: 44.4276, longitude: -63.8535 },
    city: '',
  });
  await settleSwarm();
  page.nodes['social-swarm-xai-run'].click();
  await settleSwarm();
  assert.deepEqual(page.cityAsks, ['/api/social/swarm/nearest-city?lat=44.4276&lon=-63.8535']);
  assert.ok(
    copied[0].includes('\nPlace: the map point 44.4276, -63.8535. Nearest city: Halifax NS (about 33 km away).\n'),
    copied[0],
  );
  // Far from every city the gazetteer knows: the bot is asked to find it.
  const far = swarmPage({
    keys: { xai: { key: false, chiefOfStaff: false }, openai: { key: true } },
    clipboard: { writeText: async (text) => copied.push(text) },
    context: {},
    point: { latitude: -40.5, longitude: -120.25 },
    city: '',
  });
  await settleSwarm();
  far.nodes['social-swarm-xai-run'].click();
  await settleSwarm();
  assert.ok(
    copied[1].includes(
      '\nPlace: the map point -40.5000, -120.2500. Nearest city: find the nearest city or town to this point and search there.\n',
    ),
    copied[1],
  );
});

test('the place the location readout shows is named once, even when landmark and city are the same', () => {
  const lines = { 'location-mini-city': '📍 Saint John Danger Zone', 'location-mini-poi': 'Saint John Danger Zone' };
  const doc = { getElementById: (id) => (id in lines ? { textContent: lines[id] } : null) };
  const panel = new SocialMediaPanel(null, { document: doc });
  assert.equal(panel._openView().place, 'Saint John Danger Zone');
  lines['location-mini-poi'] = 'Reversing Falls';
  assert.equal(panel._openView().place, 'Reversing Falls, Saint John Danger Zone');
});

// ---- every LLM button has a place --------------------------------------------

/** The box with a map looking at a point, and no place picked unless `picked`. */
function placePage({ latitude, longitude, picked = '', town = '', townStatus = 200 } = {}) {
  const nodes = {};
  for (const id of [
    'social-panel',
    'social-account-list',
    'social-query',
    'social-model',
    'social-analyze-platform',
    'social-news-platform',
    'social-help-platform',
    'social-status',
    'social-output',
    'social-analyze',
    'social-news',
    'social-search',
    'social-help',
  ]) {
    nodes[id] = element();
  }
  nodes['social-analyze-platform'].value = 'all';
  nodes['social-news-platform'].value = 'all';
  nodes['social-help-platform'].value = 'all';
  const asked = [];
  const newsUrls = [];
  const townUrls = [];
  const fetch = async (url, init = {}) => {
    const text = String(url);
    if (text === '/api/llm/providers') {
      return { ok: true, status: 200, json: async () => ({ providers: [{ id: 'xai', label: 'xAI Grok', ready: true }], askTimeoutMs: 5000 }) };
    }
    if (text === '/api/social/accounts') return { ok: true, status: 200, json: async () => ({ accounts: [] }) };
    if (text.startsWith('/api/social/swarm/nearest-city')) {
      townUrls.push(text);
      return { ok: townStatus === 200, status: townStatus, json: async () => ({ city: town }) };
    }
    if (text.startsWith('/api/social/public-news')) {
      newsUrls.push(text);
      return { ok: true, status: 200, json: async () => ({ status: 'empty', articles: [] }) };
    }
    if (text === '/api/llm/ask') {
      asked.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ answer: 'Nothing new.', model: 'grok-4.6' }) };
    }
    throw new Error(`unexpected ${text}`);
  };
  const radians = (degrees) => (degrees * Math.PI) / 180;
  const viewer = { camera: { positionCartographic: { latitude: radians(latitude), longitude: radians(longitude) } } };
  const panel = new SocialMediaPanel(viewer, {
    document: { getElementById: (id) => nodes[id] || null, createElement: () => element() },
    storage: memoryStorage(),
    fetch,
    sceneContext: async () => (picked ? { selectedLocation: picked } : {}),
  });
  const press = async (action, typed = '') => {
    nodes['social-query'].value = typed;
    nodes[`social-${action}`].click();
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { panel, nodes, asked, newsUrls, townUrls, press };
}

const settlePlace = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

test('BREAKING NEWS with no place picked looks up the town at the middle of the map and uses it', async () => {
  const page = placePage({ latitude: 45.2731, longitude: -66.0633, town: 'Saint John, New Brunswick' });
  await settlePlace();
  assert.equal(page.nodes['social-model'].value, 'xai');
  await page.press('news');
  assert.equal(page.townUrls.length, 1, 'the town is looked up once');
  assert.match(page.townUrls[0], /lat=45\.2731&lon=-66\.0633/);
  assert.equal(page.newsUrls.length, 1);
  assert.equal(new URL(page.newsUrls[0], 'http://localhost').searchParams.get('place'), 'Saint John, New Brunswick');
  assert.equal(page.asked.length, 1);
  assert.match(page.asked[0].question, /Current map place: Saint John, New Brunswick \(45\.2731, -66\.0633\)\./);
  assert.equal(page.asked[0].question.includes('No place name is on the map yet.'), false);
  assert.match(page.nodes['social-output'].textContent, /PUBLIC NEWS · Saint John, New Brunswick/);
});

test('every LLM button gets a place: ANALYZE, BREAKING NEWS, SEARCH and FIND HELP', async () => {
  const page = placePage({ latitude: 45.2731, longitude: -66.0633, town: 'Saint John, New Brunswick' });
  await settlePlace();
  await page.press('analyze', 'tone of the replies');
  await page.press('news');
  await page.press('search', 'road closures');
  await page.press('help');
  assert.equal(page.asked.length, 4);
  for (const ask of page.asked) {
    assert.match(ask.question, /Current map place: Saint John, New Brunswick \(45\.2731, -66\.0633\)\./);
  }
  // Every news lookup is for that place too (FIND HELP runs none).
  assert.equal(page.newsUrls.length, 3);
  for (const url of page.newsUrls) {
    assert.equal(new URL(url, 'http://localhost').searchParams.get('place'), 'Saint John, New Brunswick');
  }
});

test('a place the operator picked is used as it is, with no lookup; with no town, the nearest known city, then the point', async () => {
  const picked = placePage({ latitude: 44.6488, longitude: -63.5752, picked: 'Halifax', town: 'Elsewhere' });
  await settlePlace();
  await picked.press('news');
  assert.deepEqual(picked.townUrls, [], 'a picked place needs no lookup');
  assert.match(picked.asked[0].question, /Current map place: Halifax \(44\.6488, -63\.5752\)\./);
  // The town lookup answers nothing (or fails): the built-in gazetteer's nearest city.
  for (const [town, townStatus] of [['', 200], ['', 503]]) {
    const near = placePage({ latitude: 45.2731, longitude: -66.0633, town, townStatus });
    await settlePlace();
    await near.press('news');
    assert.equal(new URL(near.newsUrls[0], 'http://localhost').searchParams.get('place'), 'Saint John');
    assert.match(near.asked[0].question, /Current map place: Saint John \(45\.2731, -66\.0633\)\./);
  }
  // Open water far from any known city: the map point itself.
  const sea = placePage({ latitude: -60.1234, longitude: -30.5678, town: '' });
  await settlePlace();
  await sea.press('news');
  assert.match(sea.asked[0].question, /Current map place: -60\.1234, -30\.5678\./);
});

test('the account menu covers the gig economy and on-demand delivery, whose HELP use is under development', () => {
  assert.ok(
    panelHtml.includes('<div class="cctv-summary-label social-flush">Social Media/The Gig Economy/On-Demand Delivery Platforms</div>'),
  );
  assert.equal(panelHtml.includes('>ACCOUNTS<'), false);
  const gig = SOCIAL_ACCOUNT_PLATFORMS.filter((item) => item.gig === true);
  assert.deepEqual(
    gig.map((item) => item.label),
    ['DoorDash', 'Uber', 'Lyft', 'Just Eat Takeaway', 'Delivery Hero', 'Grubhub'],
  );
  for (const item of gig) {
    // A delivery or ride login draws no live marker of its own.
    assert.notEqual(item.sharesLocation, true, item.id);
    assert.equal(new URL(officialOpenUrl(item.id)).hostname, new URL(item.openUrl).hostname, item.id);
  }
  const start = panelHtml.indexOf('id="social-account-platform"');
  const menu = panelHtml.slice(start, panelHtml.indexOf('</select>', start));
  assert.match(menu, /<optgroup label="Social Media">/);
  assert.match(menu, /<optgroup label="The Gig Economy \/ On-Demand Delivery">/);
  assert.match(panelHtml, /<p id="social-account-note" class="social-note" hidden><\/p>/);
  assert.match(SOCIAL_GIG_HELP_NOTE, /Find Ultra Help: under development/);
});

test('picking a gig or delivery platform says its HELP use is under development', async () => {
  const { nodes } = mountLocationPanel({
    accounts: [],
    storage: memoryStorage(),
    geolocation: null,
    placeFix: () => {},
    clearFix: () => {},
  });
  await tick();
  const menu = nodes['social-account-platform'];
  const note = nodes['social-account-note'];
  for (const id of ['doordash', 'uber', 'lyft', 'just-eat-takeaway', 'delivery-hero', 'grubhub']) {
    menu.value = id;
    menu.fire('change');
    assert.equal(note.hidden, false, id);
    assert.equal(note.textContent, SOCIAL_GIG_HELP_NOTE, id);
  }
  menu.value = 'facebook';
  menu.fire('change');
  assert.equal(note.hidden, true);
  assert.equal(note.textContent, '');
});

test('a platform counts one Power Up however it is saved, and the count sits flush under the note', () => {
  const withApi = SOCIAL_ACCOUNT_PLATFORMS.filter((item) => item.api).map((item) => item.id);
  assert.deepEqual(withApi, ['facebook', 'instagram', 'threads', 'x', 'tiktok', 'uber', 'lyft']);
  // Truth Social publishes no API.
  assert.equal(SOCIAL_ACCOUNT_PLATFORMS.find((item) => item.id === 'truth').api, undefined);
  const total = SOCIAL_ACCOUNT_PLATFORMS.length;
  assert.deepEqual(socialPowerUps([]), { attained: 0, total, label: `0/${total} Power Ups Attained` });
  const some = socialPowerUps([
    // A login and a key on one platform: still one Power Up.
    { platform: 'x', passwordSaved: true, apiKeySaved: true },
    { platform: 'facebook', passwordSaved: false, apiKeySaved: true },
    { platform: 'happn', passwordSaved: true },
    // An API key for a platform with none is not counted.
    { platform: 'truth', passwordSaved: false, apiKeySaved: true },
  ]);
  assert.equal(some.attained, 3);
  // Note, count and heading in that order, flush.
  const note = panelHtml.indexOf("Passwords stay encrypted on this computer for integrating AI Tools</p>");
  const count = panelHtml.indexOf('<p id="social-powerup" class="social-powerup social-flush">');
  const heading = panelHtml.indexOf('<div class="cctv-summary-label social-flush">Social Media/The Gig Economy/On-Demand Delivery Platforms</div>');
  assert.ok(note > 0 && count > note && heading > count);
  assert.equal(panelHtml.indexOf('<div class="cctv-summary-label', 0) >= heading, true);
  const css = readFileSync(new URL('./ui/styles/social.css', import.meta.url), 'utf8');
  assert.match(css, /.social-powerup {[^}]*color: #39ff14/);
  assert.match(css, /.social-flush {[^}]*margin-top: 0;[^}]*margin-bottom: 0;/);
  // No save menu and no OPEN LOGIN per account any more.
  assert.equal(panelHtml.includes('social-account-mode'), false);
});

test('OPEN SAVED opens the saved sites of the kind its menu picks, and is named for it', () => {
  const start = panelHtml.indexOf('id="social-open-kind"');
  const menu = panelHtml.slice(start, panelHtml.indexOf('</select>', start));
  assert.deepEqual([...menu.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]), ['login', 'api', 'all']);
  assert.match(menu, /<option value="login" selected>/);
  assert.match(panelHtml, /id="social-open-saved"[^>]*>OPEN ID &amp; PASS SITES</);
  assert.deepEqual(SOCIAL_OPEN_SAVED_LABELS, {
    login: 'OPEN ID & PASS SITES',
    api: 'OPEN API SITES',
    all: 'OPEN ALL SAVED SITES',
  });
  const rows = [
    { platform: 'x', passwordSaved: true, apiKeySaved: true },
    { platform: 'uber', passwordSaved: false, apiKeySaved: true },
    { platform: 'happn', passwordSaved: true },
  ];
  assert.deepEqual(savedSiteUrls(rows, 'login').map((site) => site.url), ['https://x.com/', 'https://www.happn.com/']);
  assert.deepEqual(savedSiteUrls(rows, 'api').map((site) => site.url), [
    'https://developer.x.com/',
    'https://developer.uber.com/',
  ]);
  assert.equal(savedSiteUrls(rows, 'all').length, 4);
  for (const item of SOCIAL_ACCOUNT_PLATFORMS.filter((entry) => entry.apiUrl)) {
    assert.equal(new URL(item.apiUrl).protocol, 'https:', item.id);
  }
});

test('an API key saves on its own, stays out of the status, and raises the Power Ups', async () => {
  const { nodes, posts } = mountLocationPanel({
    accounts: [],
    storage: memoryStorage(),
    geolocation: null,
    placeFix: () => {},
    clearFix: () => {},
  });
  await tick();
  const total = socialPowerUps([]).total;
  assert.equal(nodes['social-powerup'].textContent, `0/${total} Power Ups Attained`);
  const key = 'x-developer-key-0123456789abcdef';
  nodes['social-account-platform'].value = 'x';
  nodes['social-account-apikey'].value = key;
  nodes['social-account-save'].click();
  await tick();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].mode, 'api');
  assert.equal(posts[0].apiKey, key);
  assert.equal(posts[0].password, '');
  assert.equal('social-account-mode' in posts[0], false);
  assert.equal(nodes['social-account-apikey'].value, '');
  assert.equal(nodes['social-status'].textContent.includes(key), false);
  assert.equal(nodes['social-powerup'].textContent, `1/${total} Power Ups Attained`);
});

test('the OPEN SAVED button follows its menu and opens each saved site of that kind', async () => {
  const opened = [];
  const { nodes } = mountLocationPanel({
    accounts: [
      { platform: 'x', userId: 'river.stone', passwordSaved: true, apiKeySaved: true },
      { platform: 'life360', userId: 'circle.member', passwordSaved: true, apiKeySaved: false },
    ],
    storage: memoryStorage(),
    geolocation: null,
    placeFix: () => {},
    clearFix: () => {},
    openWindow: (url) => opened.push(url),
  });
  await tick();
  assert.equal(nodes['social-open-saved'].textContent, 'OPEN ID & PASS SITES');
  nodes['social-open-kind'].value = 'api';
  nodes['social-open-kind'].fire('change');
  assert.equal(nodes['social-open-saved'].textContent, 'OPEN API SITES');
  nodes['social-open-saved'].click();
  assert.deepEqual(opened, ['https://developer.x.com/']);
  nodes['social-open-kind'].value = 'all';
  nodes['social-open-kind'].fire('change');
  assert.equal(nodes['social-open-saved'].textContent, 'OPEN ALL SAVED SITES');
  opened.length = 0;
  nodes['social-open-saved'].click();
  assert.deepEqual(opened, ['https://x.com/', 'https://developer.x.com/', 'https://www.life360.com/']);
  assert.match(nodes['social-status'].textContent, /Opened 3 saved sites/);
  assert.equal(nodes['social-powerup'].textContent.startsWith('2/'), true);
});

test('HELP DELIVERY takes a kind and up to two entries, or a destination for Transportation', () => {
  assert.deepEqual(normalizeHelpDelivery({ kind: 'medicine', items: [' Insulin ', 'Ventolin', 'Third'] }), {
    ok: true,
    value: { kind: 'medicine', items: ['Insulin', 'Ventolin'], destination: '' },
  });
  assert.equal(normalizeHelpDelivery({ kind: 'medicine', items: ['', ' '] }).ok, false);
  assert.equal(normalizeHelpDelivery({ kind: 'food', items: ['x'.repeat(81)] }).ok, false);
  assert.equal(normalizeHelpDelivery({ kind: 'drone', items: ['Pizza'] }).ok, false);
  assert.deepEqual(normalizeHelpDelivery({ kind: 'transportation', destination: 'hospital', items: ['ignored'] }).value, {
    kind: 'transportation',
    items: [],
    destination: 'hospital',
  });
  assert.equal(normalizeHelpDelivery({ kind: 'transportation', destination: 'airport' }).ok, false);
  assert.equal(helpDeliverySummary({ kind: 'items', items: ['Heart Defib'] }), 'Items: Heart Defib');
  assert.equal(
    helpDeliverySummary({ kind: 'transportation', destination: 'home' }),
    'Transportation: from current location to Home',
  );
  const storage = memoryStorage();
  assert.equal(readHelpDelivery(storage), null);
  writeHelpDelivery(storage, { kind: 'liquid', items: ['Water', 'Electrolytes'] });
  assert.deepEqual(readHelpDelivery(storage), { kind: 'liquid', items: ['Water', 'Electrolytes'], destination: '' });
  storage.setItem(SOCIAL_HELP_DELIVERY_KEY, '{not json');
  assert.equal(readHelpDelivery(storage), null);
  for (const kind of ['medicine', 'transportation', 'food', 'liquid', 'items']) {
    assert.match(panelHtml, new RegExp(`<option value="${kind}">`));
  }
});

test("HELP DELIVERY saves this computer's default and fills the form with it next time", async () => {
  const storage = memoryStorage();
  const first = mountLocationPanel({ accounts: [], storage, geolocation: null, placeFix: () => {}, clearFix: () => {} });
  await tick();
  assert.match(first.nodes['social-help-default'].textContent, /No default saved yet/);
  first.nodes['social-help-kind'].value = 'transportation';
  first.nodes['social-help-kind'].fire('change');
  assert.equal(first.nodes['social-help-destination'].hidden, false);
  assert.equal(first.nodes['social-help-entries'].hidden, true);
  first.nodes['social-help-destination'].value = 'hospital';
  first.nodes['social-help-save'].click();
  assert.match(first.nodes['social-help-default'].textContent, /Transportation: from current location to Hospital/);
  assert.match(first.nodes['social-help-default'].textContent, /under development/);
  const second = mountLocationPanel({ accounts: [], storage, geolocation: null, placeFix: () => {}, clearFix: () => {} });
  await tick();
  assert.equal(second.nodes['social-help-kind'].value, 'transportation');
  assert.equal(second.nodes['social-help-destination'].value, 'hospital');
  second.nodes['social-help-kind'].value = 'medicine';
  second.nodes['social-help-kind'].fire('change');
  assert.equal(second.nodes['social-help-entries'].hidden, false);
  assert.equal(second.nodes['social-help-item-1'].placeholder, 'Medication 1');
  second.nodes['social-help-item-1'].value = 'Insulin';
  second.nodes['social-help-save'].click();
  assert.deepEqual(readHelpDelivery(storage), { kind: 'medicine', items: ['Insulin'], destination: '' });
});
