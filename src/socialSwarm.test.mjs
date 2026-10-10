import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { SOCIAL_PUBLIC_SITES } from './socialMedia.js';
import {
  SOCIAL_SWARM_ANSWER_TOKENS,
  SOCIAL_SWARM_BOTS,
  SOCIAL_SWARM_DEFAULT_PURPOSE,
  SOCIAL_SWARM_HANDOFF_RULES,
  SOCIAL_SWARM_PROVIDERS,
  SOCIAL_SWARM_RULES,
  GROK_BOT_UNCONFIGURED,
  formatSwarmBotLog,
  planSwarmBot,
  planSwarmHandoff,
  readSwarmAnswer,
  readSwarmHandoffSections,
  swarmBotFoundNothing,
} from './socialSwarm.mjs';
import {
  CHIEF_OF_STAFF_PER_MINUTE,
  GROK_BOT_COMPUTER_PER_MINUTE,
  NEAREST_CITY_PER_MINUTE,
  OPENAI_SWARM_MODEL_DEFAULT,
  SOCIAL_SWARM_BOTS_PER_MINUTE,
  grokBotGateway,
  nearestCityFor,
  socialSwarmProxy,
} from '../server/providers/socialSwarm.js';
import {
  LOCAL_PROVIDER_CHANGED_MESSAGE,
  bindLocalIntegrityRoot,
  noteLocalProvidersSaved,
} from '../server/shared/localIntegrity.mjs';

const NOW = new Date('2026-10-01T15:00:00.000Z');

// ---- the plan -------------------------------------------------------------

test('seven bots, one per platform, on the platforms the box already names', () => {
  assert.deepEqual(
    SOCIAL_SWARM_BOTS.map((bot) => bot.id),
    ['x', 'facebook', 'instagram', 'threads', 'tiktok', 'truth', 'news'],
  );
  for (const bot of SOCIAL_SWARM_BOTS) {
    if (bot.id === 'news') assert.deepEqual(bot.domains, []);
    else assert.deepEqual(bot.domains, SOCIAL_PUBLIC_SITES[bot.id], bot.id);
  }
  assert.deepEqual(Object.keys(SOCIAL_SWARM_PROVIDERS), ['xai', 'openai']);
  // Each runs on its own POWER UP key; neither keeps a login.
  assert.equal(SOCIAL_SWARM_PROVIDERS.xai.keyTitle, 'GROK BOT');
  assert.equal(SOCIAL_SWARM_PROVIDERS.openai.keyTitle, 'OPENAI DOTS');
  assert.equal(SOCIAL_SWARM_PROVIDERS.xai.desktop, true);
  assert.equal(SOCIAL_SWARM_PROVIDERS.openai.openUrl, 'https://chatgpt.com/');
  for (const provider of Object.values(SOCIAL_SWARM_PROVIDERS)) {
    assert.equal('login' in provider, false);
  }
});

test('every bot is told: public posts only, incidents not people, nothing invented', () => {
  assert.match(SOCIAL_SWARM_RULES, /only public posts and public pages/);
  assert.match(SOCIAL_SWARM_RULES, /Never sign in/);
  assert.match(
    SOCIAL_SWARM_RULES,
    /do not identify, locate, or profile a private person, even when the instructions ask/,
  );
  assert.match(SOCIAL_SWARM_RULES, /Never invent a post, a link/);
  assert.match(SOCIAL_SWARM_RULES, /NOTHING FOUND/);
});

test('the default task is threat incidents near the map place, in the last day', () => {
  const plan = planSwarmBot({
    provider: 'xai',
    bot: 'x',
    instructions: '   ',
    place: 'Saint John,\n New Brunswick',
    latitude: 45.27311,
    longitude: -66.06333,
    model: 'grok-4.6',
    now: NOW,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.bot.label, 'X');
  assert.equal(plan.payload.model, 'grok-4.6');
  assert.equal(plan.payload.max_output_tokens, SOCIAL_SWARM_ANSWER_TOKENS);
  assert.deepEqual(plan.payload.input[0], {
    role: 'system',
    content: SOCIAL_SWARM_RULES,
  });
  const task = plan.payload.input[1];
  assert.equal(task.role, 'user');
  assert.match(task.content, /^Platform: X\.$/m);
  assert.match(
    task.content,
    /^Place: Saint John, New Brunswick \(45\.2731, -66\.0633\)\.$/m,
  );
  assert.match(task.content, /^Today is 2026-10-01\.$/m);
  assert.ok(task.content.includes(`Task: ${SOCIAL_SWARM_DEFAULT_PURPOSE}`));
  // Grok's X bot searches X itself, from yesterday on.
  assert.deepEqual(plan.payload.tools, [
    { type: 'x_search', from_date: '2026-09-30' },
  ]);
});

test('typed instructions replace the default task, and the time window is theirs', () => {
  const plan = planSwarmBot({
    provider: 'xai',
    bot: 'x',
    instructions: 'Road closures on the Harbour Bridge this week',
    place: 'Saint John',
    model: 'grok-4.6',
    now: NOW,
  });
  const task = plan.payload.input[1].content;
  assert.match(
    task,
    /Operator's instructions: Road closures on the Harbour Bridge this week/,
  );
  assert.match(
    task,
    /Stay near the place unless the instructions name another one\./,
  );
  assert.equal(task.includes(SOCIAL_SWARM_DEFAULT_PURPOSE), false);
  assert.deepEqual(plan.payload.tools, [{ type: 'x_search' }]);
  // The rules still lead, whatever was typed.
  assert.equal(plan.payload.input[0].content, SOCIAL_SWARM_RULES);
});

test('the other bots search the web, kept to the platform; local news is not filtered', () => {
  const grok = (bot) =>
    planSwarmBot({ provider: 'xai', bot, model: 'm', now: NOW }).payload.tools;
  const openai = (bot) =>
    planSwarmBot({ provider: 'openai', bot, model: 'm', now: NOW }).payload
      .tools;
  assert.deepEqual(grok('facebook'), [
    { type: 'web_search', allowed_domains: ['facebook.com'] },
  ]);
  assert.deepEqual(grok('news'), [{ type: 'web_search' }]);
  assert.deepEqual(openai('x'), [
    {
      type: 'web_search',
      filters: { allowed_domains: ['x.com', 'twitter.com'] },
    },
  ]);
  assert.deepEqual(openai('instagram'), [
    { type: 'web_search', filters: { allowed_domains: ['instagram.com'] } },
  ]);
  assert.deepEqual(openai('news'), [{ type: 'web_search' }]);
  assert.match(
    planSwarmBot({ provider: 'openai', bot: 'news', model: 'm', now: NOW })
      .payload.input[1].content,
    /^Platform: Local news \(local news sites and official agency pages\)\.$/m,
  );
});

test('no place and no point is the current map view; a point alone is named', () => {
  const task = (input) =>
    planSwarmBot({ provider: 'xai', bot: 'x', model: 'm', now: NOW, ...input })
      .payload.input[1].content;
  assert.match(task({}), /^Place: the current map view\.$/m);
  assert.match(
    task({ latitude: 45.27, longitude: -66.06 }),
    /^Place: the map point 45\.2700, -66\.0600\.$/m,
  );
  assert.match(
    task({ latitude: '45.27', longitude: 200 }),
    /^Place: the current map view\.$/m,
  );
});

test('an unknown swarm or bot, a long note, or a pasted key is refused', () => {
  for (const provider of ['', 'nvidia', 'constructor', '__proto__', 7]) {
    assert.deepEqual(
      planSwarmBot({ provider, bot: 'x', now: NOW }),
      { ok: false, error: 'Unknown swarm.' },
      String(provider),
    );
  }
  for (const bot of ['', 'snapchat', 'constructor', null]) {
    assert.deepEqual(
      planSwarmBot({ provider: 'xai', bot, now: NOW }),
      { ok: false, error: 'Unknown bot.' },
      String(bot),
    );
  }
  assert.equal(
    planSwarmBot({
      provider: 'xai',
      bot: 'x',
      instructions: 'x'.repeat(1001),
      now: NOW,
    }).error,
    'Keep the instructions under 1000 characters.',
  );
  assert.equal(
    planSwarmBot({
      provider: 'xai',
      bot: 'x',
      instructions: 'x'.repeat(1000),
      now: NOW,
    }).ok,
    true,
  );
  for (const pasted of [
    'use xai-AbCdEfGhIjKlMnOpQrSt please',
    'key sk-proj-abcdefghijklmnop123',
    'ghp_abcdefghijklmnopqrstuvwx',
    'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIi.sig',
  ]) {
    assert.equal(
      planSwarmBot({
        provider: 'xai',
        bot: 'x',
        instructions: pasted,
        now: NOW,
      }).error,
      'Take the key out of the instructions. The bots never need one.',
      pasted,
    );
  }
  // Talking about passwords is not a password.
  assert.equal(
    planSwarmBot({
      provider: 'xai',
      bot: 'x',
      instructions: 'reports of stolen passwords at the library',
      now: NOW,
    }).ok,
    true,
  );
});

// ---- the answer -----------------------------------------------------------

test('an answer is its text and the links it cites, from either provider', () => {
  // OpenAI: url_citation annotations on the message text.
  const openai = readSwarmAnswer({
    output: [
      { type: 'web_search_call', status: 'completed' },
      {
        type: 'message',
        content: [
          {
            type: 'output_text',
            text: '14:05 · King St · fire reported · https://example.com/a',
            annotations: [
              {
                type: 'url_citation',
                url: 'https://example.com/a',
                title: 'Fire on\nKing St',
              },
              { type: 'url_citation', url: 'https://example.com/a' },
              { type: 'url_citation', url: 'javascript:alert(1)' },
              { type: 'url_citation', url: 'https://user:pw@example.com/' },
            ],
          },
        ],
      },
    ],
  });
  assert.equal(
    openai.text,
    '14:05 · King St · fire reported · https://example.com/a',
  );
  assert.deepEqual(openai.sources, [
    { url: 'https://example.com/a', title: 'Fire on King St' },
  ]);
  // xAI: a top-level citations list as well.
  const grok = readSwarmAnswer({
    output: [
      {
        type: 'message',
        content: [{ type: 'output_text', text: 'NOTHING FOUND\u0007' }],
      },
    ],
    citations: [
      'https://x.com/a/status/1',
      { url: 'https://x.com/b/status/2', title: 'Post' },
      'data:text/html,hi',
      42,
    ],
  });
  assert.equal(grok.text, 'NOTHING FOUND');
  assert.deepEqual(grok.sources, [
    { url: 'https://x.com/a/status/1', title: '' },
    { url: 'https://x.com/b/status/2', title: 'Post' },
  ]);
  // A convenience output_text when there is no message item; at most ten links.
  const flat = readSwarmAnswer({
    output_text: 'one line',
    citations: Array.from({ length: 15 }, (_, i) => `https://e.com/${i}`),
  });
  assert.equal(flat.text, 'one line');
  assert.equal(flat.sources.length, 10);
  assert.deepEqual(readSwarmAnswer(null), { text: '', sources: [] });
});

test('the log entry is the list, then the links; an empty answer reads NOTHING FOUND', () => {
  assert.equal(swarmBotFoundNothing(''), true);
  assert.equal(swarmBotFoundNothing(' Nothing found. '), true);
  assert.equal(swarmBotFoundNothing('one item'), false);
  assert.equal(
    formatSwarmBotLog({
      text: '14:05 · King St · fire',
      sources: [
        { url: 'https://example.com/a', title: 'Fire' },
        { url: 'https://example.com/b', title: '' },
        { url: 'file:///etc/passwd', title: 'nope' },
      ],
    }),
    '14:05 · King St · fire\nSources:\n- Fire · https://example.com/a\n- https://example.com/b',
  );
  assert.equal(formatSwarmBotLog({ text: '', sources: [] }), 'NOTHING FOUND');
});

test('a Chief of Staff report splits on platform headings', () => {
  const sections = readSwarmHandoffSections(
    'X:\n14:05 · harbour · police\nFacebook:\nNOTHING FOUND\n## TikTok\nnoon · fire',
  );
  assert.deepEqual(
    sections.map((row) => [row.bot.id, row.text]),
    [
      ['x', '14:05 · harbour · police'],
      ['facebook', 'NOTHING FOUND'],
      ['tiktok', 'noon · fire'],
    ],
  );
  assert.deepEqual(readSwarmHandoffSections('no headings at all'), []);
});

// ---- the route ------------------------------------------------------------

function route() {
  const routes = new Map();
  socialSwarmProxy().configureServer({
    middlewares: { use: (path, handler) => routes.set(path, handler) },
  });
  return routes.get('/api/social/swarm');
}

const LOCAL = {
  host: 'localhost:4173',
  origin: 'http://localhost:4173',
  'content-type': 'application/json',
};

function call(
  handler,
  {
    method = 'POST',
    body = {},
    headers = LOCAL,
    remoteAddress = '127.0.0.1',
    url = '/',
  } = {},
) {
  return new Promise((resolve, reject) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    const req = Readable.from(text ? [Buffer.from(text)] : []);
    Object.assign(req, {
      method,
      url,
      headers,
      socket: { remoteAddress },
    });
    const res = {
      headersSent: false,
      on() {},
      writeHead(status, values) {
        this.status = status;
        this.headers = values;
        this.headersSent = true;
      },
      end(payload = '') {
        resolve({
          status: this.status,
          headers: this.headers,
          text: String(payload),
          json: () => JSON.parse(String(payload)),
        });
      },
    };
    handler(req, res);
    setTimeout(() => reject(new Error('no answer')), 2000).unref();
  });
}

/** Set these names for one test and put the environment back afterwards. */
function withEnv(t, values) {
  const before = Object.fromEntries(
    Object.keys(values).map((name) => [name, process.env[name]]),
  );
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  t.after(() => {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

const KEYLESS = {
  GROK_BOT_API_KEY: undefined,
  GROK_BOT_WEBHOOK_URL: undefined,
  GROK_BOT_WEBHOOK_KEY: undefined,
  GROK_BOT_GATEWAY_URL: undefined,
  GROK_BOT_GATEWAY_TOKEN: undefined,
  GROK_BOT_GATEWAY_AGENT: undefined,
  OPENAI_DOTS_API_KEY: undefined,
  XAI_API_KEY: undefined,
  XAI_BASE_URL: undefined,
  XAI_MODEL: undefined,
  XAI_SWARM_MODEL: undefined,
  OPENAI_API_KEY: undefined,
  OPENAI_SWARM_MODEL: undefined,
  GEV_RATELIMIT_OPENAI_PER_MIN: undefined,
};

function upstream(t, answer) {
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    sent.push({ url, init, body: JSON.parse(init.body) });
    return typeof answer === 'function' ? answer() : answer;
  });
  return sent;
}

const ANSWERED = {
  ok: true,
  status: 200,
  json: async () => ({
    model: 'grok-4.6',
    output: [
      {
        type: 'message',
        content: [
          {
            type: 'output_text',
            text: '14:05 · King St · fire · https://x.com/a/status/1',
          },
        ],
      },
    ],
    citations: ['https://x.com/a/status/1'],
    usage: { input_tokens: 900, output_tokens: 120 },
  }),
};

test('route: only this page may send a bot, as JSON', async (t) => {
  withEnv(t, { ...KEYLESS, GROK_BOT_API_KEY: 'xai-test-key' });
  const sent = upstream(t, ANSWERED);
  const handler = route();
  const body = { provider: 'xai', bot: 'x' };
  assert.equal((await call(handler, { method: 'GET', body: '' })).status, 405);
  assert.equal(
    (
      await call(handler, {
        body,
        headers: { ...LOCAL, 'content-type': 'text/plain' },
      })
    ).status,
    415,
  );
  assert.equal(
    (
      await call(handler, {
        body,
        headers: { ...LOCAL, origin: 'https://evil.example' },
      })
    ).status,
    403,
  );
  // DNS rebinding: a page on a name that now points here sends its own name
  // as both Host and Origin. Only a host this server answers is this page.
  assert.equal(
    (
      await call(handler, {
        body,
        headers: {
          ...LOCAL,
          host: 'rebind.evil:4173',
          origin: 'http://rebind.evil:4173',
        },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call(handler, {
        body,
        headers: { ...LOCAL, 'sec-fetch-site': 'cross-site' },
      })
    ).status,
    403,
  );
  assert.equal(sent.length, 0, 'nothing reached a provider');
});

test('route: an unknown swarm or bot, or no key of its own, sends nothing', async (t) => {
  // The Ask panel's xAI key and voice control's OpenAI key are never borrowed.
  withEnv(t, {
    ...KEYLESS,
    XAI_API_KEY: 'xai-ask-key',
    OPENAI_API_KEY: 'sk-voice-key',
  });
  const sent = upstream(t, ANSWERED);
  const handler = route();
  for (const provider of ['nvidia', 'constructor', '__proto__']) {
    const refused = await call(handler, { body: { provider, bot: 'x' } });
    assert.equal(refused.status, 400, provider);
  }
  const grok = await call(handler, { body: { provider: 'xai', bot: 'x' } });
  assert.equal(grok.status, 501);
  assert.deepEqual(grok.json(), {
    error: GROK_BOT_UNCONFIGURED,
    unconfigured: true,
    provider: 'xai',
  });
  const dots = await call(handler, { body: { provider: 'openai', bot: 'x' } });
  assert.equal(dots.status, 501);
  assert.deepEqual(dots.json(), {
    error: 'No OPENAI DOTS key yet. Add it in POWER UP → OPENAI DOTS.',
    unconfigured: true,
    provider: 'openai',
  });
  process.env.GROK_BOT_API_KEY = 'xai-test-key';
  assert.equal(
    (await call(handler, { body: { provider: 'xai', bot: 'snapchat' } }))
      .status,
    400,
  );
  assert.equal(
    (
      await call(handler, {
        body: {
          provider: 'xai',
          bot: 'x',
          instructions: 'sk-proj-abcdefghijklmnopqrst',
        },
      })
    ).json().error,
    'Take the key out of the instructions. The bots never need one.',
  );
  assert.equal((await call(handler, { body: '[1]' })).status, 400);
  assert.equal((await call(handler, { body: '{' })).status, 400);
  assert.equal(sent.length, 0);
});

test('route: a Grok bot is one Responses request with X search, and its answer comes back', async (t) => {
  withEnv(t, { ...KEYLESS, GROK_BOT_API_KEY: 'xai-test-key' });
  const sent = upstream(t, ANSWERED);
  const answer = await call(route(), {
    body: {
      provider: 'xai',
      bot: 'x',
      instructions: '',
      place: 'Saint John',
      latitude: 45.27,
      longitude: -66.06,
    },
  });
  assert.equal(answer.status, 200, answer.text);
  assert.equal(answer.headers['Cache-Control'], 'no-store');
  assert.deepEqual(answer.json(), {
    ok: true,
    provider: 'xai',
    bot: 'x',
    label: 'X',
    text: '14:05 · King St · fire · https://x.com/a/status/1',
    sources: [{ url: 'https://x.com/a/status/1', title: '' }],
    model: 'grok-4.6',
    usage: { input_tokens: 900, output_tokens: 120 },
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://api.x.ai/v1/responses');
  assert.equal(sent[0].init.headers.Authorization, 'Bearer xai-test-key');
  assert.equal(sent[0].init.redirect, 'error');
  assert.equal(sent[0].body.model, 'grok-4.6', 'the swarm default model');
  assert.equal(sent[0].body.tools[0].type, 'x_search');
  assert.match(
    sent[0].body.input[1].content,
    /Saint John \(45\.2700, -66\.0600\)/,
  );
  // The answer never carries the key.
  assert.equal(answer.text.includes('xai-test-key'), false);
});

test('route: the swarm models can be chosen, and each swarm goes to its own Responses API on its own key', async (t) => {
  withEnv(t, {
    ...KEYLESS,
    GROK_BOT_API_KEY: 'xai-test-key',
    XAI_API_KEY: 'xai-ask-key',
    XAI_BASE_URL: 'https://proxy.example/v1',
    XAI_MODEL: 'grok-ask-model',
    XAI_SWARM_MODEL: 'grok-4.7',
    OPENAI_DOTS_API_KEY: 'sk-test-openai',
    OPENAI_API_KEY: 'sk-voice-key',
  });
  const sent = upstream(t, ANSWERED);
  const handler = route();
  assert.equal(
    (await call(handler, { body: { provider: 'xai', bot: 'facebook' } }))
      .status,
    200,
  );
  // Grok Bot's own endpoint, key and model, never the Ask panel's.
  assert.equal(sent[0].url, 'https://api.x.ai/v1/responses');
  assert.equal(sent[0].init.headers.Authorization, 'Bearer xai-test-key');
  assert.equal(sent[0].body.model, 'grok-4.7');
  assert.deepEqual(sent[0].body.tools, [
    { type: 'web_search', allowed_domains: ['facebook.com'] },
  ]);
  assert.equal(
    (await call(handler, { body: { provider: 'openai', bot: 'instagram' } }))
      .status,
    200,
  );
  assert.equal(sent[1].url, 'https://api.openai.com/v1/responses');
  assert.equal(sent[1].init.headers.Authorization, 'Bearer sk-test-openai');
  assert.equal(sent[1].body.model, OPENAI_SWARM_MODEL_DEFAULT);
  assert.deepEqual(sent[1].body.tools, [
    { type: 'web_search', filters: { allowed_domains: ['instagram.com'] } },
  ]);
});

test('route: a refusal is said without the key, and a slow provider is a 504', async (t) => {
  withEnv(t, { ...KEYLESS, GROK_BOT_API_KEY: 'xai-test-key' });
  let answer = {
    ok: false,
    status: 401,
    json: async () => ({
      error: { message: 'Incorrect API key provided: xai-test-key\u0000' },
    }),
  };
  upstream(t, () => {
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const handler = route();
  const refused = await call(handler, { body: { provider: 'xai', bot: 'x' } });
  assert.equal(refused.status, 502);
  assert.equal(
    refused.json().error,
    'xAI refused the bot (HTTP 401): Incorrect API key provided: [key]',
  );
  assert.equal(refused.text.includes('xai-test-key'), false);
  answer = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
  const slow = await call(handler, { body: { provider: 'xai', bot: 'x' } });
  assert.equal(slow.status, 504);
  assert.equal(slow.json().error, 'xAI did not answer in time.');
});

test('route: two swarms a minute from one address, then a wait', async (t) => {
  withEnv(t, { ...KEYLESS, GROK_BOT_API_KEY: 'xai-test-key' });
  const sent = upstream(t, ANSWERED);
  const handler = route();
  for (let i = 0; i < SOCIAL_SWARM_BOTS_PER_MINUTE; i += 1) {
    assert.equal(
      (await call(handler, { body: { provider: 'xai', bot: 'x' } })).status,
      200,
      `bot ${i + 1}`,
    );
  }
  const waited = await call(handler, { body: { provider: 'xai', bot: 'x' } });
  assert.equal(waited.status, 429);
  assert.equal(waited.headers['Retry-After'], '30');
  assert.equal(sent.length, SOCIAL_SWARM_BOTS_PER_MINUTE);
  // A keyless or refused bot never spends a slot.
  process.env.GROK_BOT_API_KEY = '';
  assert.equal(
    (await call(handler, { body: { provider: 'xai', bot: 'x' } })).status,
    501,
  );
});

// ---- the Chief of Staff hand-off -------------------------------------------

const WEBHOOK = 'https://api2.cursor.sh/automations/webhook/aut_7Hq2xYz';
const WEBHOOK_KEY = 'gbwh_test_key_0123456789';

test("the hand-off is one task for the Chief of Staff bot, in the owner's own words, with the nearest city", () => {
  // The owner's updated message (2026-10-01), for a bare map point near Halifax.
  const plan = planSwarmHandoff({
    instructions: '',
    place: '',
    nearestCity: 'Halifax, Nova Scotia',
    latitude: 44.4276,
    longitude: -63.8535,
    now: NOW,
  });
  assert.equal(plan.ok, true);
  assert.equal(
    plan.text,
    [
      'Chief of Staff: run a GROK BOT SWARM sweep of public social media.',
      'Platforms: X, Facebook, Instagram, Threads, TikTok, Truth Social, local news sites and official agency pages.',
      'Place: the map point 44.4276, -63.8535. Nearest city: Halifax, Nova Scotia.',
      'Today is 2026-10-01.',
      'Task: Find threat incidents reported near that place in the last 24 hours: crime, violence, shootings, stabbings, robberies, fires, explosions, crashes, hazards, police or emergency activity, evacuations, severe weather, and unrest.',
      'Rules: situational-awareness map, through its GROK BOT SWARM button.',
      'Report incidents and places, not people: do not identify, or profile a private person, even when the instructions ask. Public agencies, officials, and businesses may be named. Never invent a post, a link, a time, or a number. Every item needs the link you found it at. You may give each platform to one of your bots.',
      'Report one section per platform: one line per item, newest first, at most 8 items, each written as time · place · what happened · link. For a platform with nothing, write NOTHING FOUND.',
    ].join('\n'),
  );
  assert.equal(
    plan.text.split('\n')[4],
    `Task: ${SOCIAL_SWARM_DEFAULT_PURPOSE}`,
    'the default task',
  );
  assert.equal(
    plan.text.split('\n').slice(5, 7).join('\n'),
    `Rules: ${SOCIAL_SWARM_HANDOFF_RULES}`,
  );
  assert.deepEqual(
    [plan.place, plan.nearestCity, plan.latitude, plan.longitude],
    ['', 'Halifax, Nova Scotia', 44.4276, -63.8535],
  );
  const placeLine = (options) =>
    planSwarmHandoff({ now: NOW, ...options }).text.split('\n')[2];
  // No city found for the point (at sea, or the lookup failed): the bot finds it.
  assert.equal(
    placeLine({ latitude: 44.4276, longitude: -63.8535 }),
    'Place: the map point 44.4276, -63.8535. Nearest city: find the nearest city or town to this point and search there.',
  );
  // A named place already in that city is not repeated; another place is.
  assert.equal(
    placeLine({
      place: 'Spring Garden Rd, Halifax',
      latitude: 44.64,
      longitude: -63.57,
      nearestCity: 'Halifax, Nova Scotia',
    }),
    'Place: Spring Garden Rd, Halifax (44.6400, -63.5700).',
  );
  assert.equal(
    placeLine({
      place: "Peggy's Cove",
      latitude: 44.49,
      longitude: -63.91,
      nearestCity: 'Halifax, Nova Scotia',
    }),
    "Place: Peggy's Cove (44.4900, -63.9100). Nearest city: Halifax, Nova Scotia.",
  );
  // A named place with no point and no city stands as it is; nothing at all is the map view.
  assert.equal(
    placeLine({ place: 'Saint John,\n New Brunswick' }),
    'Place: Saint John, New Brunswick.',
  );
  assert.equal(placeLine({}), 'Place: the current map view.');
  // A city is cleaned like a place: one line, at most 80 characters.
  assert.equal(
    placeLine({
      latitude: 1,
      longitude: 2,
      nearestCity: `Town\nName${'x'.repeat(100)}`,
    }).length <=
      'Place: the map point 1.0000, 2.0000. Nearest city: .'.length + 80,
    true,
  );
  // Typed instructions replace the default task, as for every bot.
  const typed = planSwarmHandoff({
    instructions: 'Road closures only',
    now: NOW,
  });
  assert.match(
    typed.text,
    /Operator's instructions: Road closures only\nStay near the place unless the instructions name another one\./,
  );
  assert.equal(typed.text.includes('Task: '), false);
  assert.equal(planSwarmHandoff({ instructions: 'x'.repeat(1001) }).ok, false);
  assert.equal(
    planSwarmHandoff({ instructions: 'use sk-abcdefghijklmnopqrstuvwx' }).error,
    'Take the key out of the instructions. The bots never need one.',
  );
});

test('nearest city: the town the point is in, with its province; a province alone, or no answer, is none', async () => {
  const lookup = (place) => async () => place;
  const point = { latitude: 45.2733, longitude: -66.0633 };
  assert.equal(
    await nearestCityFor(point, {
      lookup: lookup({
        locality: 'City of Saint John',
        region: 'New Brunswick',
      }),
    }),
    'City of Saint John, New Brunswick',
  );
  assert.equal(
    await nearestCityFor(point, {
      lookup: lookup({ locality: 'Monaco', region: 'Monaco' }),
    }),
    'Monaco',
  );
  assert.equal(
    await nearestCityFor(point, {
      lookup: lookup({ locality: `Saint\nJohn${'x'.repeat(80)}`, region: '' }),
    }),
    `Saint John${'x'.repeat(50)}`,
    'one line, at most 60 characters',
  );
  // At sea, Nominatim names the province alone: that is not a town.
  assert.equal(
    await nearestCityFor(point, {
      lookup: lookup({ locality: null, region: 'Nova Scotia' }),
    }),
    '',
  );
  assert.equal(await nearestCityFor(point, { lookup: lookup(null) }), '');
  assert.equal(
    await nearestCityFor(point, {
      lookup: async () => {
        throw new Error('Nominatim down');
      },
    }),
    '',
  );
  // The lookup is given a deadline.
  let signal = null;
  await nearestCityFor(point, {
    lookup: async (_point, options) => {
      signal = options?.signal;
      return null;
    },
  });
  assert.ok(signal instanceof AbortSignal);
});

test('nearest city route: one lookup per 0.01° cell, for this page only, and an empty answer when there is none', async (t) => {
  withEnv(t, KEYLESS);
  const asked = [];
  let place = { locality: 'Halifax', region: 'Nova Scotia' };
  const routes = new Map();
  socialSwarmProxy({
    placeLookup: async (point, options) => {
      asked.push({ point, aborts: options?.signal instanceof AbortSignal });
      if (place instanceof Error) throw place;
      return place;
    },
  }).configureServer({
    middlewares: { use: (route, handler) => routes.set(route, handler) },
  });
  const handler = routes.get('/api/social/swarm');
  const ask = (query, headers = {}, method = 'GET') =>
    call(handler, {
      url: `/nearest-city${query}`,
      method,
      body: '',
      headers: { host: 'localhost:4173', ...headers },
    });
  const found = await ask('?lat=44.4276&lon=-63.8535');
  assert.equal(found.status, 200);
  assert.equal(found.headers['Cache-Control'], 'no-store');
  assert.deepEqual(found.json(), { city: 'Halifax, Nova Scotia' });
  assert.deepEqual(asked, [
    { point: { latitude: 44.4276, longitude: -63.8535 }, aborts: true },
  ]);
  // The same cell is answered from memory.
  assert.deepEqual((await ask('?lat=44.4301&lon=-63.8512')).json(), {
    city: 'Halifax, Nova Scotia',
  });
  assert.equal(asked.length, 1);
  // At sea with nothing around, or a failed lookup: an empty city, and the task asks the bot.
  place = { locality: null, region: 'Nova Scotia' };
  assert.deepEqual((await ask('?lat=40.10&lon=-50.20')).json(), { city: '' });
  place = new Error('Nominatim down');
  assert.deepEqual((await ask('?lat=41.10&lon=-51.20')).json(), { city: '' });
  // Only a point, only by GET, only from this page.
  for (const query of [
    '',
    '?lat=44',
    '?lat=91&lon=0',
    '?lat=0&lon=181',
    '?lat=x&lon=1',
  ]) {
    assert.equal((await ask(query)).status, 400, query);
  }
  assert.equal((await ask('?lat=1&lon=1', {}, 'POST')).status, 405);
  assert.equal(
    (await ask('?lat=1&lon=1', { host: 'rebind.evil:4173' })).status,
    403,
  );
  assert.equal(
    (await ask('?lat=1&lon=1', { 'sec-fetch-site': 'cross-site' })).status,
    403,
  );
  assert.equal(asked.length, 3, 'refused lookups never reach Nominatim');
});

test('nearest city route: twenty lookups a minute from one address, then a wait', async (t) => {
  withEnv(t, KEYLESS);
  const routes = new Map();
  socialSwarmProxy({
    placeLookup: async () => ({ locality: 'Somewhere', region: 'Region' }),
  }).configureServer({
    middlewares: { use: (route, handler) => routes.set(route, handler) },
  });
  const handler = routes.get('/api/social/swarm');
  const ask = (lat) =>
    call(handler, {
      url: `/nearest-city?lat=${lat}&lon=10`,
      method: 'GET',
      body: '',
      headers: { host: 'localhost:4173' },
    });
  for (let i = 0; i < NEAREST_CITY_PER_MINUTE; i += 1) {
    assert.equal((await ask(i)).status, 200, `lookup ${i + 1}`);
  }
  const waited = await ask(50);
  assert.equal(waited.status, 429);
  // A cell already looked up is still answered.
  assert.equal((await ask(0)).status, 200);
});

test('status: which swarms have their own key and whether the webhook is set, booleans only, for this page only', async (t) => {
  withEnv(t, {
    ...KEYLESS,
    XAI_API_KEY: 'xai-ask-key',
    OPENAI_API_KEY: 'sk-voice-key',
  });
  const handler = route();
  const ask = (headers = {}, method = 'GET') =>
    call(handler, {
      url: '/status',
      method,
      body: '',
      headers: { host: 'localhost:4173', ...headers },
    });
  // The Ask panel's and voice control's keys do not count.
  assert.deepEqual((await ask()).json(), {
    xai: { key: false, chiefOfStaff: false, computer: false },
    openai: { key: false },
  });
  process.env.GROK_BOT_API_KEY = 'xai-test-key';
  process.env.OPENAI_DOTS_API_KEY = 'sk-dots-key';
  process.env.GROK_BOT_WEBHOOK_URL = WEBHOOK;
  process.env.GROK_BOT_WEBHOOK_KEY = WEBHOOK_KEY;
  const set = await ask({ 'sec-fetch-site': 'same-origin' });
  assert.equal(set.status, 200);
  assert.equal(set.headers['Cache-Control'], 'no-store');
  assert.deepEqual(set.json(), {
    xai: { key: true, chiefOfStaff: true, computer: false },
    openai: { key: true },
  });
  for (const secret of [
    'xai-test-key',
    'sk-dots-key',
    WEBHOOK_KEY,
    'aut_7Hq2xYz',
  ]) {
    assert.equal(set.text.includes(secret), false, secret);
  }
  // A webhook on any other host is not set, so its key goes nowhere.
  process.env.GROK_BOT_WEBHOOK_URL =
    'https://hooks.evil.example/automations/webhook/aut_7Hq2xYz';
  assert.equal((await ask()).json().xai.chiefOfStaff, false);
  process.env.GROK_BOT_GATEWAY_URL = 'http://127.0.0.1:1340';
  process.env.GROK_BOT_GATEWAY_TOKEN = 'sand-token';
  assert.equal((await ask()).json().xai.computer, true);
  assert.equal((await ask({}, 'POST')).status, 405);
  assert.equal((await ask({ host: 'rebind.evil:4173' })).status, 403);
  assert.equal((await ask({ 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal(
    (await call(handler, { url: '/elsewhere', method: 'GET', body: '' }))
      .status,
    404,
  );
});

test("chief of staff: one POST of the task to the webhook routine, with its key, and nothing of the webhook's answer comes back", async (t) => {
  withEnv(t, {
    ...KEYLESS,
    GROK_BOT_WEBHOOK_URL: WEBHOOK,
    GROK_BOT_WEBHOOK_KEY: WEBHOOK_KEY,
    XAI_API_KEY: 'xai-ask-key',
  });
  const sent = upstream(
    t,
    () => new Response(JSON.stringify({ runId: 'run_1' }), { status: 202 }),
  );
  const answer = await call(route(), {
    url: '/chief-of-staff',
    body: {
      instructions: 'Fires only',
      place: 'Rothesay',
      nearestCity: 'Saint John, New Brunswick',
      latitude: 45.27,
      longitude: -66.06,
    },
  });
  assert.equal(answer.status, 200, answer.text);
  assert.equal(answer.json().ok, true);
  assert.equal(answer.json().sent, true);
  assert.equal(answer.text.includes('run_1'), false);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, WEBHOOK);
  assert.equal(sent[0].init.method, 'POST');
  assert.equal(sent[0].init.headers.Authorization, `Bearer ${WEBHOOK_KEY}`);
  assert.equal(sent[0].init.redirect, 'error');
  assert.deepEqual(Object.keys(sent[0].body), [
    'source',
    'kind',
    'text',
    'place',
    'nearestCity',
    'latitude',
    'longitude',
    'sentAt',
  ]);
  assert.equal(sent[0].body.source, "God's Eye View");
  assert.equal(sent[0].body.kind, 'grok-bot-swarm');
  assert.match(
    sent[0].body.text,
    /^Chief of Staff: run a GROK BOT SWARM sweep/,
  );
  assert.match(sent[0].body.text, /Operator's instructions: Fires only/);
  assert.ok(
    sent[0].body.text.includes(
      '\nPlace: Rothesay (45.2700, -66.0600). Nearest city: Saint John, New Brunswick.\n',
    ),
  );
  assert.equal(sent[0].body.nearestCity, 'Saint John, New Brunswick');
  assert.equal(sent[0].body.place, 'Rothesay');
  assert.deepEqual(
    [sent[0].body.latitude, sent[0].body.longitude],
    [45.27, -66.06],
  );
  assert.equal(JSON.stringify(sent[0]).includes('xai-ask-key'), false);
});

test('chief of staff: only this page may send it, only to a Grok Bot webhook, and a refusal is said without the key', async (t) => {
  withEnv(t, KEYLESS);
  let reply = () => new Response('{}', { status: 200 });
  const sent = upstream(t, () => reply());
  const handler = route();
  const send = (options = {}) =>
    call(handler, {
      url: '/chief-of-staff',
      body: { place: 'Halifax' },
      ...options,
    });
  const none = await send();
  assert.equal(none.status, 501);
  assert.deepEqual(none.json(), {
    error:
      'No Chief of Staff webhook yet. Add it in POWER UP → GROK BOT — CHIEF OF STAFF.',
    unconfigured: true,
  });
  // A hand-edited address that is not Grok Bot's is not a webhook: the key
  // never goes there.
  process.env.GROK_BOT_WEBHOOK_KEY = WEBHOOK_KEY;
  for (const url of [
    'https://hooks.evil.example/automations/webhook/a1',
    'https://api2.cursor.sh.evil.example/automations/webhook/a1',
    'http://api2.cursor.sh/automations/webhook/a1',
    'https://api2.cursor.sh/v1/responses',
    'https://user:pw@api2.cursor.sh/automations/webhook/a1',
    'https://api2.cursor.sh:8443/automations/webhook/a1',
    'https://api2.cursor.sh/automations/webhook/a1?to=evil',
  ]) {
    process.env.GROK_BOT_WEBHOOK_URL = url;
    assert.equal((await send()).status, 501, url);
  }
  assert.equal(sent.length, 0);
  process.env.GROK_BOT_WEBHOOK_URL = WEBHOOK;
  // The swarm route's own gate.
  assert.equal((await send({ method: 'GET', body: '' })).status, 405);
  assert.equal(
    (await send({ headers: { ...LOCAL, 'content-type': 'text/plain' } }))
      .status,
    415,
  );
  assert.equal(
    (await send({ headers: { ...LOCAL, origin: 'https://evil.example' } }))
      .status,
    403,
  );
  assert.equal(
    (
      await send({
        headers: {
          ...LOCAL,
          host: 'rebind.evil:4173',
          origin: 'http://rebind.evil:4173',
        },
      })
    ).status,
    403,
  );
  assert.equal(
    (await send({ headers: { ...LOCAL, 'sec-fetch-site': 'cross-site' } }))
      .status,
    403,
  );
  assert.equal(
    (await send({ body: { instructions: 'sk-proj-abcdefghijklmnopqrst' } }))
      .status,
    400,
  );
  assert.equal(sent.length, 0);
  // A refusal is said, short, without the key.
  reply = () =>
    new Response(
      JSON.stringify({
        error: { message: `Invalid webhook key ${WEBHOOK_KEY}\u0000` },
      }),
      {
        status: 401,
      },
    );
  const refused = await send();
  assert.equal(refused.status, 502);
  assert.equal(
    refused.json().error,
    'Grok Bot refused the task (HTTP 401): Invalid webhook key [key]',
  );
  assert.equal(refused.text.includes(WEBHOOK_KEY), false);
  reply = () => {
    throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
  };
  const slow = await send();
  assert.equal(slow.status, 504);
  assert.equal(slow.json().error, 'Grok Bot did not take the task in time.');
});

test('chief of staff: four hand-offs a minute from one address, then a wait; a refused one costs nothing', async (t) => {
  withEnv(t, {
    ...KEYLESS,
    GROK_BOT_WEBHOOK_URL: WEBHOOK,
    GROK_BOT_WEBHOOK_KEY: WEBHOOK_KEY,
  });
  const sent = upstream(t, () => new Response('{}', { status: 200 }));
  const handler = route();
  const send = (body = { place: 'Halifax' }) =>
    call(handler, { url: '/chief-of-staff', body });
  assert.equal(
    (await send({ instructions: 'sk-proj-abcdefghijklmnopqrst' })).status,
    400,
  );
  for (let i = 0; i < CHIEF_OF_STAFF_PER_MINUTE; i += 1) {
    assert.equal((await send()).status, 200, `hand-off ${i + 1}`);
  }
  const waited = await send();
  assert.equal(waited.status, 429);
  assert.equal(waited.headers['Retry-After'], '30');
  assert.equal(sent.length, CHIEF_OF_STAFF_PER_MINUTE);
});

test('chief of staff: a webhook changed by hand after POWER UP saved it is not used', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-swarm-integrity-'));
  fs.mkdirSync(path.join(root, 'config'));
  t.after(() => {
    bindLocalIntegrityRoot('');
    fs.rmSync(root, { recursive: true, force: true });
  });
  withEnv(t, {
    ...KEYLESS,
    GROK_BOT_WEBHOOK_URL: WEBHOOK,
    GROK_BOT_WEBHOOK_KEY: WEBHOOK_KEY,
  });
  noteLocalProvidersSaved(
    ['GROK_BOT_WEBHOOK_URL', 'GROK_BOT_WEBHOOK_KEY'],
    root,
  );
  bindLocalIntegrityRoot(root);
  const sent = upstream(t, () => new Response('{}', { status: 200 }));
  const handler = route();
  assert.equal(
    (
      await call(handler, {
        url: '/chief-of-staff',
        body: { place: 'Halifax' },
      })
    ).status,
    200,
  );
  // Another routine pasted into .env by hand: a Grok Bot webhook still, but not the saved one.
  process.env.GROK_BOT_WEBHOOK_URL =
    'https://api2.cursor.sh/automations/webhook/aut_other';
  const changed = await call(handler, {
    url: '/chief-of-staff',
    body: { place: 'Halifax' },
  });
  assert.equal(changed.status, 409);
  assert.equal(changed.json().error, LOCAL_PROVIDER_CHANGED_MESSAGE);
  // A swarm key changed by hand is refused the same way.
  process.env.GROK_BOT_API_KEY = 'xai-saved-key';
  noteLocalProvidersSaved(['GROK_BOT_API_KEY'], root);
  process.env.GROK_BOT_API_KEY = 'xai-changed-key';
  const bot = await call(handler, { body: { provider: 'xai', bot: 'x' } });
  assert.equal(bot.status, 409);
  process.env.OPENAI_DOTS_API_KEY = 'sk-dots-saved';
  noteLocalProvidersSaved(['OPENAI_DOTS_API_KEY'], root);
  process.env.OPENAI_DOTS_API_KEY = 'sk-dots-changed';
  const dots = await call(handler, { body: { provider: 'openai', bot: 'x' } });
  assert.equal(dots.status, 409);
  assert.equal(dots.json().error, LOCAL_PROVIDER_CHANGED_MESSAGE);
  assert.equal(sent.length, 1);
});

const GATEWAY = 'http://127.0.0.1:1340';
const GATEWAY_TOKEN = 'sand_test_token_0123456789';

test('computer: only a loopback or Tailscale gateway is configured', () => {
  assert.equal(
    grokBotGateway({
      ...KEYLESS,
      GROK_BOT_GATEWAY_URL: GATEWAY,
      GROK_BOT_GATEWAY_TOKEN: GATEWAY_TOKEN,
    }).configured,
    true,
  );
  assert.equal(
    grokBotGateway({
      ...KEYLESS,
      GROK_BOT_GATEWAY_URL: 'https://evil.example:1340',
      GROK_BOT_GATEWAY_TOKEN: GATEWAY_TOKEN,
    }).configured,
    false,
  );
  assert.equal(
    grokBotGateway({
      ...KEYLESS,
      GROK_BOT_GATEWAY_URL: 'http://127.0.0.1:1340/api',
      GROK_BOT_GATEWAY_TOKEN: GATEWAY_TOKEN,
    }).configured,
    false,
  );
});

test('computer: one sendPrompt to Chief of Staff, the report comes back, token never leaves', async (t) => {
  withEnv(t, {
    ...KEYLESS,
    GROK_BOT_GATEWAY_URL: GATEWAY,
    GROK_BOT_GATEWAY_TOKEN: GATEWAY_TOKEN,
  });
  const roster = [{ id: 'agent-1', name: 'Chief of Staff', isRunning: false }];
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const href = String(url);
    sent.push({ url: href, body: JSON.parse(init.body || '{}') });
    assert.equal(init.headers.Authorization, `Bearer ${GATEWAY_TOKEN}`);
    assert.equal(init.redirect, 'error');
    const path = href.slice(GATEWAY.length);
    if (path === '/api/listAgents') {
      return new Response(JSON.stringify(roster), { status: 200 });
    }
    if (path === '/api/getAgentTranscriptTail') {
      const afterSend = sent.some((row) => row.url.endsWith('/api/sendPrompt'));
      return new Response(
        JSON.stringify({
          messages: [
            {
              role: 'assistant',
              text: afterSend
                ? 'X:\n14:05 · harbour · police\nFacebook:\nNOTHING FOUND'
                : 'old',
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (path === '/api/sendPrompt') {
      return new Response(JSON.stringify({ accepted: true }), { status: 200 });
    }
    throw new Error(`unexpected ${href}`);
  });
  const answer = await call(route(), {
    url: '/grok-bot',
    body: {
      place: 'Halifax',
      nearestCity: 'Halifax',
      latitude: 44.65,
      longitude: -63.57,
    },
  });
  assert.equal(answer.status, 200, answer.text);
  const data = answer.json();
  assert.equal(data.ok, true);
  assert.equal(data.via, 'computer');
  assert.match(data.text, /harbour · police/);
  assert.equal(data.sections[0].bot, 'x');
  assert.equal(data.sections[1].bot, 'facebook');
  const prompt = sent.find((row) => row.url.endsWith('/api/sendPrompt')).body;
  assert.equal(prompt.agentId, 'agent-1');
  assert.match(prompt.prompt, /Chief of Staff: run a GROK BOT SWARM sweep/);
  assert.equal(JSON.stringify(sent).includes(GATEWAY_TOKEN), false);
  assert.equal(answer.text.includes(GATEWAY_TOKEN), false);
  assert.equal(GROK_BOT_COMPUTER_PER_MINUTE, 4);
});

test('computer: without a gateway the route is unconfigured; a public URL is not one', async (t) => {
  withEnv(t, KEYLESS);
  const sent = upstream(t, ANSWERED);
  const none = await call(route(), {
    url: '/grok-bot',
    body: { place: 'Halifax' },
  });
  assert.equal(none.status, 501);
  assert.deepEqual(none.json(), {
    error: GROK_BOT_UNCONFIGURED,
    unconfigured: true,
  });
  process.env.GROK_BOT_GATEWAY_TOKEN = GATEWAY_TOKEN;
  process.env.GROK_BOT_GATEWAY_URL = 'https://evil.example:1340';
  assert.equal(
    (
      await call(route(), {
        url: '/grok-bot',
        body: { place: 'Halifax' },
      })
    ).status,
    501,
  );
  assert.equal(sent.length, 0);
});

test('computer: a gateway changed by hand after POWER UP saved it is not used', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-swarm-computer-'));
  fs.mkdirSync(path.join(root, 'config'));
  t.after(() => {
    bindLocalIntegrityRoot('');
    fs.rmSync(root, { recursive: true, force: true });
  });
  withEnv(t, {
    ...KEYLESS,
    GROK_BOT_GATEWAY_URL: GATEWAY,
    GROK_BOT_GATEWAY_TOKEN: GATEWAY_TOKEN,
  });
  noteLocalProvidersSaved(
    ['GROK_BOT_GATEWAY_URL', 'GROK_BOT_GATEWAY_TOKEN'],
    root,
  );
  bindLocalIntegrityRoot(root);
  const sent = upstream(t, () => new Response('{}', { status: 200 }));
  const handler = route();
  process.env.GROK_BOT_GATEWAY_URL = 'http://127.0.0.1:1341';
  const changed = await call(handler, {
    url: '/grok-bot',
    body: { place: 'Halifax', nearestCity: 'Halifax' },
  });
  assert.equal(changed.status, 409);
  assert.equal(changed.json().error, LOCAL_PROVIDER_CHANGED_MESSAGE);
  assert.equal(sent.length, 0);
});

/**
 * A fake Grok Bot gateway. `step` answers each listAgents / tail read after
 * the task was sent, in turn: { busy, tail }. `before` is the tail before
 * the task (a number is an HTTP failure).
 */
function fakeGateway(t, { roster, before = 'old', steps = [], hold } = {}) {
  const sent = [];
  let step = -1;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const href = String(url);
    const path = href.slice(GATEWAY.length);
    sent.push({ path, body: JSON.parse(init.body || '{}') });
    const taken = sent.some((row) => row.path === '/api/sendPrompt');
    const json = (value, status = 200) =>
      new Response(JSON.stringify(value), { status });
    if (path === '/api/listAgents') {
      if (!taken) return json(roster);
      step = Math.min(step + 1, steps.length - 1);
      return json(
        roster.map((row) => ({
          ...row,
          isRunning: Boolean(steps[step]?.busy),
        })),
      );
    }
    if (path === '/api/getAgentTranscriptTail') {
      const text = taken ? steps[step]?.tail : before;
      if (typeof text === 'number') return json({ error: 'nope' }, text);
      return json({ messages: [{ role: 'assistant', text }] });
    }
    if (path === '/api/sendPrompt') {
      if (hold) await hold;
      return json({ accepted: true });
    }
    throw new Error(`unexpected ${href}`);
  });
  return sent;
}

/** Run the route with the poll sleeps on a mock clock. */
async function pumped(t, handler, options) {
  const pending = call(handler, options);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let done = false;
  pending.then(
    () => (done = true),
    () => (done = true),
  );
  while (!done) {
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(1_500);
  }
  return pending;
}

const GATEWAY_ENV = {
  ...KEYLESS,
  GROK_BOT_GATEWAY_URL: GATEWAY,
  GROK_BOT_GATEWAY_TOKEN: GATEWAY_TOKEN,
};
const SWEEP = {
  url: '/grok-bot',
  body: { place: 'Halifax', nearestCity: 'Halifax' },
};

test("computer: only this computer's own page may send the token", async (t) => {
  withEnv(t, GATEWAY_ENV);
  const sent = fakeGateway(t, {
    roster: [{ id: 'a', name: 'Chief of Staff' }],
  });
  const far = await call(route(), { ...SWEEP, remoteAddress: '192.168.1.20' });
  assert.equal(far.status, 403);
  const proxied = await call(route(), {
    ...SWEEP,
    headers: { ...LOCAL, 'x-forwarded-for': '203.0.113.9' },
  });
  assert.equal(proxied.status, 403);
  assert.equal(sent.length, 0);
});

test('computer: a BOT name that is not there is a miss, never another bot', async (t) => {
  withEnv(t, { ...GATEWAY_ENV, GROK_BOT_GATEWAY_AGENT: 'Night-Desk' });
  const sent = fakeGateway(t, {
    roster: [
      { id: 'a', name: 'Chief of Staff' },
      { id: 'b', name: 'Scout' },
    ],
  });
  const answer = await call(route(), SWEEP);
  assert.equal(answer.status, 502);
  assert.match(answer.json().error, /No Grok Bot named Night-Desk/);
  assert.equal(
    sent.some((row) => row.path === '/api/sendPrompt'),
    false,
  );
});

test('computer: a reply while the bot still works is not the report', async (t) => {
  withEnv(t, GATEWAY_ENV);
  fakeGateway(t, {
    roster: [{ id: 'a', name: 'Chief of Staff' }],
    steps: [
      { busy: true, tail: 'Searching X now…' },
      { busy: false, tail: 'X:\n14:05 · harbour · police' },
    ],
  });
  const answer = await pumped(t, route(), SWEEP);
  assert.equal(answer.status, 200, answer.text);
  assert.match(answer.json().text, /harbour · police/);
  assert.equal(answer.json().text.includes('Searching'), false);
});

test('computer: with no line before the task, a report counts only after the bot worked', async (t) => {
  withEnv(t, GATEWAY_ENV);
  fakeGateway(t, {
    roster: [{ id: 'a', name: 'Chief of Staff' }],
    before: 500,
    steps: [
      { busy: false, tail: 'An old report' },
      { busy: true, tail: 'An old report' },
      { busy: false, tail: 'X:\nnoon · fire' },
    ],
  });
  const answer = await pumped(t, route(), SWEEP);
  assert.equal(answer.status, 200, answer.text);
  assert.equal(answer.json().text, 'X:\nnoon · fire');
});

test('computer: a second press for the same bot while one runs is refused', async (t) => {
  withEnv(t, GATEWAY_ENV);
  let release;
  const hold = new Promise((resolve) => (release = resolve));
  fakeGateway(t, {
    roster: [{ id: 'a', name: 'Chief of Staff' }],
    steps: [{ busy: false, tail: 'X:\nnoon · fire' }],
    hold,
  });
  const handler = route();
  const first = call(handler, SWEEP);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = await call(handler, SWEEP);
  assert.equal(second.status, 409);
  assert.match(second.json().error, /already on a sweep/);
  release();
  assert.equal((await first).status, 200);
});

test('computer: a long transcript tail is read whole', async (t) => {
  withEnv(t, GATEWAY_ENV);
  const report = 'X:\n' + 'harbour · police\n'.repeat(1500);
  fakeGateway(t, {
    roster: [{ id: 'a', name: 'Chief of Staff' }],
    steps: [{ busy: false, tail: report }],
  });
  const answer = await call(route(), SWEEP);
  assert.equal(answer.status, 200, answer.text);
  assert.match(answer.json().text, /^X:\nharbour · police/);
});

test('status: a computer changed by hand after POWER UP saved it is not offered', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-swarm-status-'));
  fs.mkdirSync(path.join(root, 'config'));
  t.after(() => {
    bindLocalIntegrityRoot('');
    fs.rmSync(root, { recursive: true, force: true });
  });
  withEnv(t, GATEWAY_ENV);
  noteLocalProvidersSaved(
    ['GROK_BOT_GATEWAY_URL', 'GROK_BOT_GATEWAY_TOKEN'],
    root,
  );
  bindLocalIntegrityRoot(root);
  const ask = () =>
    call(route(), {
      url: '/status',
      method: 'GET',
      body: '',
      headers: { host: 'localhost:4173' },
    });
  assert.equal((await ask()).json().xai.computer, true);
  process.env.GROK_BOT_GATEWAY_URL = 'http://127.0.0.1:1341';
  assert.equal((await ask()).json().xai.computer, false);
});
