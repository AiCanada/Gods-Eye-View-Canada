import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CCTV_MAX_SOURCES_HARD_CAP,
  enabledCctvCountries,
  frameFailureBackoffMs,
  frameHostAllowed,
  normalizeSourceItem,
  resolveFrameUrl,
} from '../../server/providers/local.js';

test('CCTV_COUNTRIES parses to a code set, every-country, or none', () => {
  assert.equal(enabledCctvCountries({}), null, 'unset serves every country');
  assert.equal(enabledCctvCountries({ CCTV_COUNTRIES: '*' }), null);
  assert.equal(enabledCctvCountries({ CCTV_COUNTRIES: 'ca, all' }), null);
  assert.deepEqual([...enabledCctvCountries({ CCTV_COUNTRIES: ' ca ,US' })], ['CA', 'US']);
  assert.equal(enabledCctvCountries({ CCTV_COUNTRIES: '' }).size, 0, 'explicitly empty serves no classified country');
});

test('normalised catalogue entries carry the resolver fields and an honest heading', () => {
  const entry = normalizeSourceItem({
    id: 'x', name: 'X', lat: 1, lon: 2, feedType: 'image', url: '',
    pageUrl: 'https://www.skaping.com/banffgondola', frameResolver: 'og-image', framePreferLarge: true,
    frameHosts: [' Skaping.S3.gra.io.cloud.ovh.net ', ''], country: 'ca', headingDeg: null,
  });
  assert.equal(entry.frameResolver, 'og-image');
  assert.deepEqual(entry.frameHosts, ['skaping.s3.gra.io.cloud.ovh.net']);
  assert.equal(entry.country, 'CA');
  assert.equal(Number.isNaN(entry.headingDeg), true, 'null heading stays unknown, not 0');
  assert.equal(normalizeSourceItem({ id: 'y', frameResolver: 'og_image', pageUrl: 'https://a.b/' }).frameResolver, '', 'unknown resolver names are dropped');
  assert.equal(normalizeSourceItem({ id: 'z', headingDeg: '270' }).headingDeg, 270);
});

test('the catalogue hard cap and the frame backoff schedule', () => {
  assert.equal(CCTV_MAX_SOURCES_HARD_CAP, 2000);
  assert.equal(frameFailureBackoffMs(1), 15000);
  assert.equal(frameFailureBackoffMs(3), 60000);
  assert.equal(frameFailureBackoffMs(12), 300000, 'capped at five minutes');
});

const SKAPING = {
  id: 'cam', pageUrl: 'https://www.skaping.com/banffgondola', frameResolver: 'og-image', framePreferLarge: true,
  frameHosts: ['skaping.s3.gra.io.cloud.ovh.net'],
};

test('a page may only send the proxy to its own host, a listed host, over https', () => {
  assert.equal(frameHostAllowed(SKAPING, new URL('https://www.skaping.com/frame.jpg')), true);
  assert.equal(frameHostAllowed(SKAPING, new URL('https://skaping.s3.gra.io.cloud.ovh.net/x/mini/1.jpg')), true);
  assert.equal(frameHostAllowed(SKAPING, new URL('http://www.skaping.com/frame.jpg')), false, 'https only');
  assert.equal(frameHostAllowed(SKAPING, new URL('https://cdn.other.example/frame.jpg')), false);
  assert.equal(frameHostAllowed(SKAPING, new URL('https://169.254.169.254/latest/meta-data')), false, 'address literals never');
  assert.equal(frameHostAllowed(SKAPING, new URL('https://[::1]/x')), false);
  assert.equal(frameHostAllowed(SKAPING, new URL('https://router.local/x')), false);
});

function pageFetch(html, { ok = true } = {}) {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return { ok, text: async () => html }; };
  return { fetchImpl, calls };
}

test('resolver reads og:image in either attribute order, decodes entities, prefers the large sibling', async () => {
  const cache = new Map();
  const html = '<meta content="https://skaping.s3.gra.io.cloud.ovh.net/pursuit/x/mini/12-30.jpg?a=1&amp;b=2" property="og:image">';
  const { fetchImpl, calls } = pageFetch(html);
  const url = await resolveFrameUrl(SKAPING, { fetchImpl, cache, now: () => 1000 });
  assert.equal(url, 'https://skaping.s3.gra.io.cloud.ovh.net/pursuit/x/large/12-30.jpg?a=1&b=2');
  assert.equal(await resolveFrameUrl(SKAPING, { fetchImpl, cache, now: () => 50000 }), url);
  assert.equal(calls.length, 1, 'served from cache inside the window');
});

test('resolver refuses a frame on a foreign host and does not cache it', async () => {
  const cache = new Map();
  const { fetchImpl } = pageFetch('<meta property="og:image" content="https://cdn.evil.example/f.jpg">');
  assert.equal(await resolveFrameUrl(SKAPING, { fetchImpl, cache, now: () => 1000 }), '');
  assert.equal(cache.get('cam').url, '');
});

test('a failing page is not re-read inside the cache window, serves the last good URL, then expires', async () => {
  const cache = new Map();
  const good = pageFetch('<meta property="og:image" content="/mini/a.jpg">');
  const first = await resolveFrameUrl({ ...SKAPING, framePreferLarge: false }, { fetchImpl: good.fetchImpl, cache, now: () => 0 });
  assert.equal(first, 'https://www.skaping.com/mini/a.jpg');
  const bad = pageFetch('', { ok: false });
  const t1 = 100000; // past the fresh window
  assert.equal(await resolveFrameUrl(SKAPING, { fetchImpl: bad.fetchImpl, cache, now: () => t1 }), first, 'last good URL through an outage');
  assert.equal(await resolveFrameUrl(SKAPING, { fetchImpl: bad.fetchImpl, cache, now: () => t1 + 1000 }), first);
  assert.equal(bad.calls.length, 1, 'the failed page is not hammered on every frame request');
  assert.equal(await resolveFrameUrl(SKAPING, { fetchImpl: bad.fetchImpl, cache, now: () => 40 * 60 * 1000 }), '', 'a stale URL is not served forever');
});

test('resolver ignores entries with no page or an unknown strategy without fetching', async () => {
  const { fetchImpl, calls } = pageFetch('<meta property="og:image" content="https://www.skaping.com/f.jpg">');
  assert.equal(await resolveFrameUrl({ id: 'a', pageUrl: '', frameResolver: 'og-image' }, { fetchImpl }), '');
  assert.equal(await resolveFrameUrl({ id: 'b', pageUrl: 'https://www.skaping.com/x', frameResolver: 'nope' }, { fetchImpl }), '');
  assert.equal(calls.length, 0);
});
