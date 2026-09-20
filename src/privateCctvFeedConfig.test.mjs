import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PRIVATE_CCTV_FEED_DEFAULTS,
  hostMatchesSuffixes,
  sharedHostSuffix,
  parsePrivateCctvFeedConfig,
  renderRelayConfigScript,
  renderRelayManifest,
} from './privateCctvFeedConfig.mjs';
import { installPrivateCctvFeedRelay } from '../scripts/install-private-cctv-feed-relay.mjs';
import { configurePrivateCctvFeed, isPrivateCctvFeedCloudUrl, privateCctvFeedUrl } from './privateCamerasCore.mjs';

const LOCAL = { feedUrl: 'https://my.cameras.example.org/#/feed', imageHosts: ['Clips-1.cdn.example.org', 'clips-2.cdn.example.org'] };

test('with no local config the reserved example site applies and nothing is "configured"', () => {
  const config = parsePrivateCctvFeedConfig(null);
  assert.equal(config.configured, false);
  assert.equal(config.feedUrl, PRIVATE_CCTV_FEED_DEFAULTS.feedUrl);
  assert.deepEqual(config.imageHosts, [...PRIVATE_CCTV_FEED_DEFAULTS.imageHosts]);
  assert.match(config.feedOrigin, /\.example$/, 'the tracked defaults name no real site');
});

test('a local config supplies the feed site, picture hosts and the vendor host suffix', () => {
  const config = parsePrivateCctvFeedConfig(LOCAL);
  assert.equal(config.configured, true);
  assert.equal(config.feedOrigin, 'https://my.cameras.example.org');
  assert.deepEqual(config.imageHosts, ['clips-1.cdn.example.org', 'clips-2.cdn.example.org']);
  assert.deepEqual(config.cloudHostSuffixes, ['example.org'], 'derived from the feed host unless given');
  assert.deepEqual(parsePrivateCctvFeedConfig({ ...LOCAL, cloudHostSuffixes: ['cams.test'] }).cloudHostSuffixes, ['cams.test']);
});

test('a malformed local config never half-applies', () => {
  for (const bad of [{ feedUrl: 'http://plain.example.org/' }, { feedUrl: 'https://user:pw@x.example.org/' }, { feedUrl: 'nope' }, { ...LOCAL, imageHosts: ['has space.example'] }, { ...LOCAL, imageHosts: [] }, { feedUrl: LOCAL.feedUrl }]) {
    const config = parsePrivateCctvFeedConfig(bad);
    assert.equal(config.configured, false, JSON.stringify(bad));
    assert.ok(config.problems.length > 0);
  }
});

test('host suffixes match whole labels only', () => {
  assert.equal(hostMatchesSuffixes('my.cams.example.org', ['example.org']), true);
  assert.equal(hostMatchesSuffixes('example.org', ['example.org']), true);
  assert.equal(hostMatchesSuffixes('notexample.org', ['example.org']), false);
  assert.equal(hostMatchesSuffixes('example.org.evil.test', ['example.org']), false);
});

test('the core recognises the configured vendor site and reports the configured feed link', () => {
  configurePrivateCctvFeed(parsePrivateCctvFeedConfig(LOCAL));
  try {
    assert.equal(privateCctvFeedUrl(), LOCAL.feedUrl);
    assert.equal(isPrivateCctvFeedCloudUrl('https://api.example.org/x'), true);
    assert.equal(isPrivateCctvFeedCloudUrl('https://homeassistant.local:8123'), false);
  } finally {
    configurePrivateCctvFeed();
  }
  assert.equal(privateCctvFeedUrl(), PRIVATE_CCTV_FEED_DEFAULTS.feedUrl);
});

test('the installer writes the real site into the INSTALLED copy only', (t) => {
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-feed-relay-install-'));
  t.after(() => fs.rmSync(destination, { recursive: true, force: true }));
  const config = parsePrivateCctvFeedConfig(LOCAL);
  installPrivateCctvFeedRelay({ destination, feedConfig: config });
  const manifest = JSON.parse(fs.readFileSync(path.join(destination, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.content_scripts[0].matches, ['https://my.cameras.example.org/*']);
  assert.deepEqual(manifest.host_permissions, ['https://clips-1.cdn.example.org/*', 'https://clips-2.cdn.example.org/*', 'http://localhost:4173/*', 'http://127.0.0.1:4173/*']);
  assert.match(fs.readFileSync(path.join(destination, 'relay-config.js'), 'utf8'), /"feedOrigin": "https:\/\/my\.cameras\.example\.org"/);
  // Without a usable local config the tracked example copy is installed as-is.
  installPrivateCctvFeedRelay({ destination, feedConfig: parsePrivateCctvFeedConfig(null) });
  assert.match(fs.readFileSync(path.join(destination, 'relay-config.js'), 'utf8'), /feed\.private-cctv\.example/);
  assert.deepEqual(renderRelayManifest({ content_scripts: [{ js: ['a.js'] }], host_permissions: ['https://old/*', 'http://localhost:4173/*'] }, config).host_permissions.at(-1), 'http://localhost:4173/*');
  assert.match(renderRelayConfigScript(config), /GevPrivateCctvFeedConfig = Object\.freeze/);
});

test('the vendor site is recognised from the feed address alone, and never as a bare public suffix', () => {
  // imageHosts missing: the relay is not configured, but the guard still knows the vendor's site.
  const partial = parsePrivateCctvFeedConfig({ feedUrl: 'https://my.vendor.example.com/#/feed' });
  assert.equal(partial.configured, false);
  assert.deepEqual(partial.cloudHostSuffixes, ['example.com']);

  assert.equal(sharedHostSuffix('my.vendor.com'), 'vendor.com');
  assert.equal(sharedHostSuffix('vendor.com'), 'vendor.com');
  assert.equal(sharedHostSuffix('my.vendor.co.uk'), 'vendor.co.uk');
  assert.equal(sharedHostSuffix('vendor.co.uk'), 'vendor.co.uk', 'co.uk would block every British camera host');
  assert.equal(sharedHostSuffix('vendor.com.au'), 'vendor.com.au');

  const british = parsePrivateCctvFeedConfig({ feedUrl: 'https://my.vendor.co.uk/#/feed', imageHosts: ['clips.vendor.co.uk'] });
  assert.deepEqual(british.cloudHostSuffixes, ['vendor.co.uk']);
  assert.equal(hostMatchesSuffixes('nvr.myshop.co.uk', british.cloudHostSuffixes), false);
  assert.equal(hostMatchesSuffixes('eu.vendor.co.uk', british.cloudHostSuffixes), true);
});

test('host names are validated without a regex lookbehind (the module ships to browsers)', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('./privateCctvFeedConfig.mjs', import.meta.url), 'utf8');
  assert.equal(source.includes('(?<'), false);
  for (const bad of ['-lead.example.com', 'trail-.example.com', 'nodot', 'a..b.com', `${'x'.repeat(64)}.com`]) {
    assert.equal(parsePrivateCctvFeedConfig({ feedUrl: 'https://ok.example.com/', imageHosts: [bad] }).configured, false, bad);
  }
  assert.equal(parsePrivateCctvFeedConfig({ feedUrl: 'https://ok.example.com/', imageHosts: ['clips-1.example.com'] }).configured, true);
});
