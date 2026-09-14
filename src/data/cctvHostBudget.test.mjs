import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHostBudget, isBudgetedFrameUrl } from '../../server/providers/cctv/host-budget.js';
import {
  CCTV_IBI_ACTIVE_REFRESH_MS,
  CCTV_IBI_CARD_REFRESH_MS,
  CCTV_IBI_LAST_GOOD_MAX_MS,
  CCTV_IBI_PER_DAY,
  CCTV_IBI_PER_MINUTE,
} from '../../server/providers/cctv/constants.js';

const HOST = '511on.ca';

function tempDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'gev-cctv-budget-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('511 stills are the ones under /map/Cctv/', () => {
  assert.equal(isBudgetedFrameUrl('https://511on.ca/map/Cctv/1234'), true);
  assert.equal(isBudgetedFrameUrl('https://511.alaska.gov/map/Cctv/448'), true);
  assert.equal(isBudgetedFrameUrl('https://images.drivebc.ca/bchighwaycam/pub/cameras/1.jpg'), false);
  assert.equal(isBudgetedFrameUrl(''), false);
  assert.equal(isBudgetedFrameUrl('not a url /map/Cctv/'), false);
});

test('the limits are 20 a minute and 1,000 a day, refreshed every 15 min on cards and every minute when active', () => {
  assert.equal(CCTV_IBI_PER_MINUTE, 20);
  assert.equal(CCTV_IBI_PER_DAY, 1000);
  assert.equal(CCTV_IBI_CARD_REFRESH_MS, 900000);
  assert.equal(CCTV_IBI_ACTIVE_REFRESH_MS, 60000);
  assert.equal(CCTV_IBI_LAST_GOOD_MAX_MS, 3600000);
});

test('cards stop at the reserve; the active camera can use the whole minute', () => {
  let clock = Date.UTC(2026, 8, 14, 12, 0, 0);
  const budget = createHostBudget({ now: () => clock });
  for (let i = 0; i < 15; i += 1) assert.equal(budget.take(HOST).ok, true, `card ${i}`);
  const refused = budget.take(HOST);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'minute');
  assert.ok(refused.retryAfterMs > 0 && refused.retryAfterMs <= 60000);
  for (let i = 0; i < 5; i += 1) assert.equal(budget.take(HOST, { active: true }).ok, true, `active ${i}`);
  assert.equal(budget.take(HOST, { active: true }).ok, false, 'twenty in a minute, even for the active camera');
  assert.equal(budget.take('511.alberta.ca').ok, true, 'each host has its own budget');
  clock += 60001;
  assert.equal(budget.take(HOST).ok, true, 'the minute rolls over');
});

test('the day limit holds, keeps a reserve for the active camera, and resets at UTC midnight', () => {
  let clock = Date.UTC(2026, 8, 14, 0, 0, 0);
  const budget = createHostBudget({ now: () => clock });
  let taken = 0;
  for (let i = 0; i < 2000; i += 1) {
    clock += 3100; // 19 a minute: never the minute limit
    if (budget.take(HOST).ok) taken += 1;
  }
  assert.equal(taken, 900, 'cards get 900 of the 1,000');
  const card = budget.take(HOST);
  assert.equal(card.reason, 'day');
  let active = 0;
  for (let i = 0; i < 200; i += 1) {
    clock += 3100;
    if (budget.take(HOST, { active: true }).ok) active += 1;
  }
  assert.equal(active, 100);
  assert.equal(budget.usage(HOST).day, 1000);
  clock = Date.UTC(2026, 8, 15, 0, 0, 1);
  assert.equal(budget.take(HOST).ok, true, 'a new UTC day');
  assert.equal(budget.usage(HOST).day, 1);
});

test('daily counts persist atomically and a restart keeps them', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'cctv-host-budget.json');
  const clock = Date.UTC(2026, 8, 14, 9, 0, 0);
  const first = createHostBudget({ file, now: () => clock });
  await first.ready();
  for (let i = 0; i < 7; i += 1) first.take(HOST, { active: true });
  await first.flush();
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(saved, { format: 'gev-cctv-host-budget/1', hosts: { [HOST]: { day: '2026-09-14', count: 7 } } });

  const second = createHostBudget({ file, now: () => clock + 120000 });
  await second.ready();
  assert.equal(second.usage(HOST).day, 7);
  const tomorrow = createHostBudget({ file, now: () => Date.UTC(2026, 8, 15, 1) });
  await tomorrow.ready();
  assert.equal(tomorrow.usage(HOST).day, 0, 'yesterday\'s count is not carried over');
});

test('a malformed budget file starts from zero', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'cctv-host-budget.json');
  writeFileSync(file, '{not json');
  const budget = createHostBudget({ file });
  await budget.ready();
  assert.equal(budget.take(HOST).ok, true);
});
