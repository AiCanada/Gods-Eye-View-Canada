import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  epiParameters as _unused,
  gravityLinks,
  presetValues,
} from '../outbreakEpi.mjs';
import { trackedPlaces, worldCountries } from '../outbreakEpiTape.mjs';
import { writeWorldSnapshot } from '../../server/shared/outbreakWorldStore.mjs';
import { createEnvironment } from '../../scripts/outbreak-env.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const HOUR = 3_600_000;
const START = Date.UTC(2026, 0, 10);

function world(root) {
  const airport = (id, lat, lon, population, country) => ({
    id,
    code: id,
    name: id,
    lat,
    lon,
    population,
    kind: 'airport',
    size: 'M',
    country,
  });
  const nodes = [
    airport('AAA', 55, 37, 1_000_000, 'RU'),
    airport('BBB', 60, 30, 1_000_000, 'RU'),
    airport('CCC', 6, 3, 1_000_000, 'NG'),
  ];
  const routes = [
    {
      from: 0,
      to: 1,
      timeOfDayMs: 6 * HOUR,
      lengthMs: 2 * HOUR,
      passengers: 500,
    },
    {
      from: 0,
      to: 2,
      timeOfDayMs: 6 * HOUR,
      lengthMs: 2 * HOUR,
      passengers: 500,
    },
  ];
  const { countries, countryOfNode } = worldCountries(nodes);
  return writeWorldSnapshot(
    {
      nodes,
      routes,
      flights: [],
      flown: [],
      links: gravityLinks(nodes),
      tracked: trackedPlaces(nodes, 3),
      countries,
      countryOfNode,
      meta: { sources: [] },
    },
    root,
  ).dir;
}

const scenario = {
  profile: {
    ...presetValues('covid2020'),
    initialCases: 2000,
    triggerMode: 'reported',
    triggerPer100k: 100000,
    lockdownPct: 90,
    travelBanPct: 100,
    borderPolicy: 'reported',
    borderTrigger: 100000,
  },
  origins: [0],
  startMs: START,
  untilMs: START + 5 * 24 * HOUR,
};

test('the environment: reset gives day 0, each step a day, done after the last; actions steer', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-env-'));
  try {
    const worldDir = world(root);
    const run = async (action) => {
      const env = createEnvironment({ worldDir, days: 5 });
      const first = await env.reset({ scenario, seed: 3 });
      assert.equal(first.obs.day, 0);
      assert.equal(first.obs.country_state.length, 3, 'NG, RU and none');
      assert.equal(first.obs.global.length, 20, 'GLOBAL_CHANNELS on day 0');
      let last = first.obs;
      let steps = 0;
      for (;;) {
        const out = await env.step(action);
        if (out.done) break;
        steps += 1;
        last = out.obs;
        assert.equal(out.obs.day, steps);
        assert.equal(out.obs.global.length, 20, 'GLOBAL_CHANNELS every day');
      }
      env.close();
      assert.equal(steps, 5);
      return last;
    };
    const free = await run(null);
    // Lock the origin from day 0 and close Nigeria's legs (flagged): the
    // origin's flights stop (travel ban 100 % on legs touching a restricted
    // place, and the 'reported' policy now reaches Nigeria).
    const steered = await run({
      window: 0xffffff,
      switch: { 0: 1 },
      flag: [0],
    });
    const infected = (obs) => obs.global[0];
    assert.notDeepEqual(steered.country_state, free.country_state);
    assert.ok(infected(steered) <= infected(free));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the stdio server speaks JSON lines', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-env-cli-'));
  try {
    const worldDir = world(root);
    const child = spawn(
      process.execPath,
      [
        path.join(ROOT, 'scripts', 'outbreak-env.mjs'),
        '--world',
        worldDir,
        '--days',
        '5',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const lines = [];
    let buffer = '';
    const waiters = [];
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        lines.push(JSON.parse(buffer.slice(0, at)));
        buffer = buffer.slice(at + 1);
        waiters.shift()?.();
      }
    });
    const ask = (message) =>
      new Promise((resolve) => {
        const count = lines.length;
        waiters.push(() => resolve(lines[count]));
        child.stdin.write(`${JSON.stringify(message)}\n`);
      });
    const reset = await ask({ cmd: 'reset', scenario, seed: 1 });
    assert.equal(reset.ok, true);
    assert.equal(reset.obs.day, 0);
    const step = await ask({ cmd: 'step', action: { window: 0 } });
    assert.equal(step.ok, true);
    assert.equal(step.obs.day, 1);
    const bad = await ask({ cmd: 'fly' });
    assert.equal(bad.ok, false);
    const closed = await ask({ cmd: 'close' });
    assert.equal(closed.ok, true);
    await new Promise((resolve) => child.on('exit', resolve));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
