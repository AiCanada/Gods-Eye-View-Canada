import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRIVATE_SITE_CHANGED_EVENT,
  PRIVATE_SITE_STATUS_ENDPOINT,
  initPrivateSiteLocations,
  privateSiteLocationEntries,
} from './privateSiteLocations.js';

const status = {
  kinds: [
    {
      id: 'home',
      sites: [
        { id: 'home', name: 'Home', lat: 45.27, lon: -66.06, cameras: [{ id: 'front' }] },
        { id: 'cottage', name: '', lat: null, lon: null },
      ],
    },
    { id: 'business', sites: [{ id: 'shop', name: ' Shop ', lat: '45.3', lon: '-66.1' }] },
    { id: 'unknown', sites: [{ id: 'x', name: 'X', lat: 1, lon: 1 }] },
  ],
};

test('only located home and business sites become location pills', () => {
  assert.deepEqual(privateSiteLocationEntries(status), [
    { id: 'private-site-home', kind: 'home', name: '🏠 Home', title: 'Home security: Home', label: 'Home, Home security site', lat: 45.27, lon: -66.06 },
    { id: 'private-site-shop', kind: 'business', name: '🏢 Shop', title: 'Business security: Shop', label: 'Shop, Business security site', lat: 45.3, lon: -66.1 },
  ]);
  assert.deepEqual(privateSiteLocationEntries(null), []);
  assert.deepEqual(privateSiteLocationEntries({ kinds: [{ id: 'home', sites: [{ id: 'bad id', lat: 1, lon: 1 }, { id: 'far', lat: 91, lon: 0 }] }] }), []);
});

test('pills load once, refresh when a site is saved, clear when the route is gone, and stop', async () => {
  const target = new EventTarget();
  const asked = [];
  let reply = { ok: true, json: async () => status };
  const published = [];
  const stop = initPrivateSiteLocations({
    target,
    fetchImpl: async (url, options) => {
      asked.push([url, options.credentials, options.cache]);
      return reply;
    },
    onChange: (entries) => published.push(entries.map((entry) => entry.id)),
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  await settle();
  assert.deepEqual(asked[0], [PRIVATE_SITE_STATUS_ENDPOINT, 'same-origin', 'no-store']);
  assert.deepEqual(published, [['private-site-home', 'private-site-shop']]);

  target.dispatchEvent(new Event(PRIVATE_SITE_CHANGED_EVENT));
  await settle();
  assert.equal(published.length, 1, 'an unchanged list is not republished');

  reply = { ok: false, status: 404, json: async () => ({}) };
  target.dispatchEvent(new Event(PRIVATE_SITE_CHANGED_EVENT));
  await settle();
  assert.deepEqual(published.at(-1), []);

  stop();
  reply = { ok: true, json: async () => status };
  target.dispatchEvent(new Event(PRIVATE_SITE_CHANGED_EVENT));
  await settle();
  assert.equal(asked.length, 3, 'no requests after stopping');
});
