import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSwarmDesktopStatus, runSocialSwarm } from './socialSwarmRun.mjs';
import { GROK_BOT_UNCONFIGURED } from './socialSwarm.mjs';

test('runSocialSwarm POSTs every bot and counts found, empty, and failed', async () => {
  const bodies = [];
  const bots = [];
  const progress = [];
  const result = await runSocialSwarm({
    xaiStatus: { key: true },
    request: async (url, init) => {
      assert.equal(url, '/api/social/swarm');
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (body.bot === 'tiktok') {
        return {
          ok: false,
          status: 502,
          json: async () => ({ error: 'xAI refused the bot (HTTP 500)' }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          bot: body.bot,
          text: body.bot === 'x' ? '14:05 · harbour · police' : 'NOTHING FOUND',
          sources: [],
        }),
      };
    },
    provider: 'xai',
    instructions: '',
    place: 'Halifax',
    latitude: 44.65,
    longitude: -63.57,
    onBot: (row) => bots.push(row),
    onProgress: (row) => progress.push(row),
  });
  assert.deepEqual(
    bodies.map((body) => body.bot),
    ['x', 'facebook', 'instagram', 'threads', 'tiktok', 'truth', 'news'],
  );
  for (const body of bodies) {
    assert.equal(body.provider, 'xai');
    assert.equal(body.place, 'Halifax');
  }
  assert.equal(result.found, 1);
  assert.equal(result.empty, 5);
  assert.equal(result.failed, 1);
  assert.equal(result.unconfigured, '');
  assert.equal(bots.filter((row) => row.error).length, 1);
  assert.equal(progress.at(-1).back, 7);
});

test('runSocialSwarm treats 501 as unconfigured and does not log a bot', async () => {
  const bots = [];
  const result = await runSocialSwarm({
    xaiStatus: { key: true },
    request: async () => ({
      ok: false,
      status: 501,
      json: async () => ({
        error: GROK_BOT_UNCONFIGURED,
        unconfigured: true,
      }),
    }),
    provider: 'xai',
    onBot: (row) => bots.push(row),
  });
  assert.match(result.unconfigured, /POWER UP → GROK BOT — COMPUTER/);
  assert.equal(bots.length, 0);
  assert.equal(result.found, 0);
  assert.equal(result.failed, 0);
});

test('runSocialSwarm with no Grok Bot key copies the task, opens Grok Bot, and pastes it', async () => {
  const urls = [];
  const copied = [];
  const opens = [];
  const bots = [];
  const result = await runSocialSwarm({
    xaiStatus: { key: false, computer: false },
    copyText: async (text) => {
      copied.push(text);
    },
    request: async (url, init) => {
      urls.push(String(url).split('?')[0]);
      if (String(url).startsWith('/api/social/swarm/nearest-city')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ city: 'Halifax' }),
        };
      }
      if (url === '/api/social/grok-bot/open') {
        opens.push(JSON.parse(init.body));
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, opened: 'shortcut', pasted: true }),
        };
      }
      throw new Error(`unexpected ${url}`);
    },
    provider: 'xai',
    instructions: 'Fires only',
    place: 'Halifax',
    latitude: 44.65,
    longitude: -63.57,
    onBot: (row) => bots.push(row),
  });
  assert.equal(result.via, 'desktop');
  assert.equal(result.copied, true);
  assert.equal(result.opened, true);
  assert.equal(result.pasted, true);
  assert.equal(result.unconfigured, '');
  assert.equal(urls.includes('/api/social/swarm'), false);
  assert.equal(urls.includes('/api/social/swarm/grok-bot'), false);
  assert.equal(urls.includes('/api/social/grok-bot/open'), true);
  assert.equal(opens[0].paste, true);
  assert.match(opens[0].text, /Chief of Staff: run a GROK BOT SWARM sweep/);
  assert.match(opens[0].text, /Fires only/);
  assert.match(copied[0], /Chief of Staff: run a GROK BOT SWARM sweep/);
  assert.match(copied[0], /Fires only/);
  assert.equal(bots[0].bot.label, 'Chief of Staff');
  // The copied task is marked, so no box reads it as findings.
  assert.equal(bots[0].task, true);
  assert.match(
    formatSwarmDesktopStatus(result),
    /GROK BOT OPENED · task sent to your Chief of Staff/,
  );
});

test('formatSwarmDesktopStatus: pasted wins; otherwise the operator pastes', () => {
  assert.match(
    formatSwarmDesktopStatus({ opened: true, copied: true, pasted: true }),
    /task sent to your Chief of Staff/,
  );
  assert.match(
    formatSwarmDesktopStatus({ opened: true, copied: true, pasted: false }),
    /paste the task to your Chief of Staff/,
  );
  assert.match(
    formatSwarmDesktopStatus({
      opened: true,
      copied: true,
      pasted: true,
      desktopApp: 'chatgpt',
    }),
    /task sent to ChatGPT/,
  );
});

test('runSocialSwarm with no OPENAI DOTS key copies the task, opens ChatGPT, and pastes it', async () => {
  const urls = [];
  const copied = [];
  const opens = [];
  const bots = [];
  const result = await runSocialSwarm({
    openaiStatus: { key: false },
    copyText: async (text) => {
      copied.push(text);
    },
    request: async (url, init) => {
      urls.push(String(url).split('?')[0]);
      if (String(url).startsWith('/api/social/swarm/nearest-city')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ city: 'Halifax' }),
        };
      }
      if (url === '/api/social/openai-dots/open') {
        opens.push(JSON.parse(init.body));
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, opened: 'app-link', pasted: true }),
        };
      }
      throw new Error(`unexpected ${url}`);
    },
    provider: 'openai',
    instructions: 'Fires only',
    place: 'Halifax',
    latitude: 44.65,
    longitude: -63.57,
    onBot: (row) => bots.push(row),
  });
  assert.equal(result.via, 'desktop');
  assert.equal(result.desktopApp, 'chatgpt');
  assert.equal(result.copied, true);
  assert.equal(result.opened, true);
  assert.equal(result.pasted, true);
  assert.equal(result.unconfigured, '');
  assert.equal(urls.includes('/api/social/swarm'), false);
  assert.equal(urls.includes('/api/social/openai-dots/open'), true);
  assert.equal(opens[0].paste, true);
  assert.match(opens[0].text, /ChatGPT: run a OPENAI DOT SWARM sweep/);
  assert.match(opens[0].text, /Fires only/);
  assert.equal(bots[0].bot.label, 'ChatGPT');
  assert.equal(bots[0].task, true);
  assert.match(
    formatSwarmDesktopStatus(result),
    /CHATGPT OPENED · task sent to ChatGPT/,
  );
});

/** A no-key, no-computer press: the server finds no town; Grok Bot opens. */
function desktopPress(extra) {
  const bots = [];
  const run = runSocialSwarm({
    xaiStatus: { key: false, computer: false },
    request: async (url) => {
      if (String(url).startsWith('/api/social/swarm/nearest-city')) {
        return { ok: true, status: 200, json: async () => ({ city: '' }) };
      }
      if (url === '/api/social/grok-bot/open') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, pasted: true }),
        };
      }
      throw new Error(`unexpected ${url}`);
    },
    provider: 'xai',
    instructions: '',
    place: 'Forest road',
    latitude: 46.1,
    longitude: -64.8,
    onBot: (row) => bots.push(row),
    ...extra,
  });
  return run.then((result) => ({ result, bots }));
}

test('runSocialSwarm never says copied when nothing took the task', async () => {
  const refused = await desktopPress({ copyText: () => false });
  assert.equal(refused.result.copied, false);
  const threw = await desktopPress({
    copyText: async () => {
      throw new Error('denied');
    },
  });
  assert.equal(threw.result.copied, false);
  const before = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: {},
    configurable: true,
  });
  try {
    // A plain http page has no navigator.clipboard at all.
    assert.equal((await desktopPress({})).result.copied, false);
  } finally {
    if (before) Object.defineProperty(globalThis, 'navigator', before);
    else delete globalThis.navigator;
  }
});

test('runSocialSwarm names the nearest town from the gazetteer when the server finds none', async () => {
  const asked = [];
  let copied = '';
  await desktopPress({
    copyText: (text) => {
      copied = text;
    },
    fallbackCity: (lat, lon) => {
      asked.push([lat, lon]);
      return { name: 'Moncton', distKm: 12.4 };
    },
  });
  assert.deepEqual(asked, [[46.1, -64.8]]);
  assert.match(copied, /Moncton \(about 12 km away\)/);
});

test('runSocialSwarm with a Grok Bot computer POSTs one task and logs each section', async () => {
  const urls = [];
  const bots = [];
  const result = await runSocialSwarm({
    xaiStatus: { key: false, computer: true },
    request: async (url, init) => {
      urls.push(String(url).split('?')[0]);
      if (String(url).startsWith('/api/social/swarm/nearest-city')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ city: 'Halifax' }),
        };
      }
      if (url === '/api/social/swarm/grok-bot') {
        const body = JSON.parse(init.body);
        assert.equal(body.place, 'Halifax');
        assert.equal(body.nearestCity, 'Halifax');
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            via: 'computer',
            text: 'X:\n14:05 · harbour · police\nFacebook:\nNOTHING FOUND',
            sections: [
              { bot: 'x', label: 'X', text: '14:05 · harbour · police' },
              { bot: 'facebook', label: 'Facebook', text: 'NOTHING FOUND' },
            ],
          }),
        };
      }
      throw new Error(`unexpected ${url}`);
    },
    provider: 'xai',
    place: 'Halifax',
    latitude: 44.65,
    longitude: -63.57,
    onBot: (row) => bots.push(row),
  });
  assert.equal(result.via, 'computer');
  assert.equal(result.found, 1);
  assert.equal(result.empty, 1);
  assert.equal(result.unconfigured, '');
  assert.equal(urls.includes('/api/social/swarm'), false);
  assert.deepEqual(
    bots.map((row) => row.bot.id),
    ['x', 'facebook'],
  );
});
