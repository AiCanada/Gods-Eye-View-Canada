import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RISK_NEWS_LOOKBACK_DAYS,
  RISK_NEWS_RADIUS_KM,
  buildGovCrimeQuery,
  filterRiskNewsArticles,
  sanitizeRiskNewsQuery,
} from '../../server/providers/regional/news.js';

test('risk-news query sanitizing drops controls and caps length', () => {
  assert.equal(sanitizeRiskNewsQuery('  Saint John  '), 'Saint John');
  assert.equal(sanitizeRiskNewsQuery('a\nb\\c'), 'a b c');
  assert.equal(sanitizeRiskNewsQuery('x'.repeat(300)).length, 240);
  assert.equal(sanitizeRiskNewsQuery('   '), '');
});

test('risk-news lookback keeps recent and undated headlines and drops old ones', () => {
  const now = Date.parse('2026-09-16T12:00:00Z');
  const articles = filterRiskNewsArticles(
    [
      { title: 'today', publishedAt: '2026-09-10T00:00:00Z' },
      { title: 'old', publishedAt: '2026-07-01T00:00:00Z' },
      { title: 'undated', publishedAt: null },
    ],
    RISK_NEWS_LOOKBACK_DAYS,
    now,
  );
  assert.deepEqual(
    articles.map((article) => article.title),
    ['today', 'undated'],
  );
  assert.equal(RISK_NEWS_RADIUS_KM, 100);
  assert.equal(RISK_NEWS_LOOKBACK_DAYS, 30);
});

test('government crime-stat search is scoped to official sites for the selected area', () => {
  const canada = buildGovCrimeQuery('Saint John', 'canada');
  assert.match(canada, /Saint John/);
  assert.match(canada, /statcan\.gc\.ca/);
  assert.match(canada, /crime statistics/);
  assert.doesNotMatch(canada, /fbi\.gov/);
  const usa = buildGovCrimeQuery('Austin', 'usa');
  assert.match(usa, /Austin/);
  assert.match(usa, /fbi\.gov/);
  assert.match(usa, /bjs\.gov/);
  assert.doesNotMatch(usa, /statcan/);
});
