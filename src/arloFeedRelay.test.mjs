import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { installArloRelay, relayInstallDestination, relayInstallFiles } from '../scripts/install-arlo-relay.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELAY_DIR = path.join(ROOT, 'tools', 'arlo-feed-relay');
const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
const GEV = 'http://localhost:4173/api/private-cams';
const S3_QUERY = '?AWSAccessKeyId=ASIAEXAMPLE&Expires=1757880000&Signature=c2lnbmF0dXJl%2B%3D&x-amz-security-token=IQoJb3JpZ2luX2Vj';
const NEWLINE = String.fromCharCode(10);
const TAB = String.fromCharCode(9);
const NUL = String.fromCharCode(0);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);

const readRelayFile = (name) => readFileSync(path.join(RELAY_DIR, name), 'utf8');
const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const s3 = (zone, id, ext = 'jpg') => `https://arlos3-prod-${zone}.s3.amazonaws.com/5K7-1234/ABCDEF/recordings/${id}.${ext}${S3_QUERY}`;
const settle = async () => {
  for (let round = 0; round < 20; round += 1) await new Promise((resolve) => setImmediate(resolve));
};

function createRelayContext(extra = {}) {
  const context = { URL, TextEncoder, TextDecoder, crypto: globalThis.crypto, ...extra };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(readRelayFile('relay-logic.js'), context, { filename: 'relay-logic.js' });
  return context;
}

const relay = createRelayContext().GevArloRelay;

// ---- a minimal fake DOM mirroring the observed my.arlo.com feed markup ----

function compileSelector(selector) {
  const match = /^([a-z][a-z0-9-]*)?((?:\.[a-z0-9_-]+)*)(?:\[([a-z-]+)=([a-z0-9_-]+)\])?$/i.exec(selector);
  if (!selector || !match) throw new Error(`The fake DOM does not support the selector ${JSON.stringify(selector)}`);
  const [, tag, classes, attribute, value] = match;
  const classNames = classes ? classes.split('.').filter(Boolean) : [];
  return (element) =>
    (!tag || element.localName === tag.toLowerCase()) &&
    classNames.every((name) => element.classNames.has(name)) &&
    (!attribute || element.getAttribute(attribute) === value);
}

class FakeElement {
  constructor(tag, { className = '', attrs = {}, text = '' } = {}, children = []) {
    this.localName = tag;
    this.classNames = new Set(className.split(' ').filter(Boolean));
    this.attributes = { ...attrs };
    this.ownText = text;
    this.children = children;
  }

  get textContent() {
    return this.ownText + this.children.map((child) => child.textContent).join('');
  }

  getAttribute(name) {
    return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null;
  }

  *descendants() {
    for (const child of this.children) {
      yield child;
      yield* child.descendants();
    }
  }

  querySelectorAll(selectorList) {
    const matchers = selectorList.split(',').map((selector) => compileSelector(selector.trim()));
    return [...this.descendants()].filter((element) => matchers.some((matches) => matches(element)));
  }

  querySelector(selectorList) {
    return this.querySelectorAll(selectorList)[0] ?? null;
  }
}

const h = (tag, options = {}, ...children) => new FakeElement(tag, options, children);

function feedCard({ name, src, type = 'Motion', date = '9/13', time = '2:14 PM', image = true }) {
  const media = h('app-feed-item-media', { className: 'feed-media large' }, ...(image ? [h('img', { className: 'ng-star-inserted', attrs: src === undefined ? {} : { src } })] : []));
  const nameRow = h('div', { className: 'feed-item-name' }, h('span', { className: 'device-name text-capitalize', text: name }), h('span', { className: 'border-divider', text: date }));
  const info = h('div', { className: 'feed-item-info' }, h('div', { className: 'feed-item-time', text: time }), h('div', { className: 'feed-record-type', text: type }));
  return h('div', { className: 'feed-item-container' }, h('app-feed-item', {}, h('div', { className: 'feed-item-host' }, media, h('div', { className: 'feed-item-details' }, nameRow, info))));
}

function feedDocument(cards, { password = false, container = true } = {}) {
  const list = h('div', {}, ...cards.map(feedCard));
  const feed = container ? [h('app-feed-scroll-container', {}, h('div', { className: 'feed-scroll-container' }, list))] : [];
  const html = h('html', {}, h('body', {}, h('app-root', {}, ...feed, ...(password ? [h('input', { attrs: { type: 'password' } })] : []))));
  const doc = h('#document', {}, html);
  doc.documentElement = html;
  return { doc, list };
}

const FRONT_NEWEST = s3('z2', '1757800000001');
const FRONT_OLDER = s3('z2', '1757700000000');
const FF_NEWEST = s3('z3', '1757790000000');
const FF_OLDER = s3('z3', '1757600000000');

const SAMPLE_FEED = [
  { name: `${NEWLINE}  front  `, src: FRONT_NEWEST, type: 'Person', date: '9/13', time: '2:14 PM' },
  { name: 'ff', src: 'https://arlos3-prod-z3.s3.amazonaws.com/5K7-1234/ABCDEF/recordings/placeholder.jpg?Expires=1' },
  { name: 'ff', src: '/assets/images/feed-placeholder.png' },
  { name: 'front', src: FRONT_OLDER },
  { name: 'ff', src: FF_NEWEST, type: 'Vehicle', date: '', time: '14:02' },
  { name: '', src: s3('z2', 'nameless') },
  { name: 'back yard', image: false },
  { name: 'FF', src: FF_OLDER },
];

// ---- relay-logic.js ----

test('relay logic is a classic script that exposes one frozen object', () => {
  const source = readRelayFile('relay-logic.js');
  assert.doesNotMatch(source, /^\s*(?:import|export)\b/m);
  assert.equal(Object.isFrozen(relay), true);
  assert.equal(relay.GEV_ORIGIN, 'http://localhost:4173');
  assert.equal(Object.isFrozen(relay.ALLOWED_IMAGE_HOSTS), true);
  assert.deepEqual([...relay.ALLOWED_IMAGE_HOSTS], ['arlos3-prod-z1.s3.amazonaws.com', 'arlos3-prod-z2.s3.amazonaws.com', 'arlos3-prod-z3.s3.amazonaws.com', 'arlos3-prod-z4.s3.amazonaws.com']);
  assert.deepEqual(plain(relay.SELECTORS), {
    item: 'div.feed-item-host',
    name: 'span.device-name',
    time: 'div.feed-item-time',
    type: 'div.feed-record-type',
    date: 'span.border-divider',
    image: 'img',
    feedContainer: 'div.feed-scroll-container, app-feed-scroll-container',
  });
  assert.equal(relay.PAIRING_CODE_ALPHABET, 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789');
  for (const name of ['isAllowedThumbnailUrl', 'normalizeCameraName', 'urlKey', 'readFeedItems', 'pickNewestPerCamera', 'detectFeedState', 'isReportablePage', 'isPairingCode', 'base64url', 'sha256Hex', 'sniffImageType']) {
    assert.equal(typeof relay[name], 'function', name);
  }
});

test('only https image paths on the four Arlo S3 recording hosts are allowed thumbnails', () => {
  for (const zone of ['z1', 'z2', 'z3', 'z4']) assert.equal(relay.isAllowedThumbnailUrl(s3(zone, '1757800000000')), true, zone);
  assert.equal(relay.isAllowedThumbnailUrl(s3('z2', 'clip', 'JPEG')), true);
  assert.equal(relay.isAllowedThumbnailUrl(s3('z2', 'clip', 'png')), true);
  assert.equal(relay.isAllowedThumbnailUrl(s3('z2', 'clip', 'webp')), true);
  assert.equal(relay.isAllowedThumbnailUrl('https://arlos3-prod-z2.s3.amazonaws.com/a/recordings/b.jpg'), true, 'no query');
  assert.equal(relay.isAllowedThumbnailUrl('HTTPS://ARLOS3-PROD-Z2.S3.AMAZONAWS.COM/a/recordings/b.jpg'), true, 'URL parsing lower-cases the scheme and host');

  const refused = [
    s3('z2', 'clip').replace('https:', 'http:'),
    s3('z5', 'clip'),
    'https://arlos3-prod-z2.s3.amazonaws.com.evil.test/a/recordings/b.jpg',
    'https://arlos3-prod-z2.s3.amazonaws.com./a/recordings/b.jpg',
    'https://evil-arlos3-prod-z2.s3.amazonaws.com/a/b.jpg',
    'https://evil.test/arlos3-prod-z2.s3.amazonaws.com/b.jpg',
    'https://s3.amazonaws.com/arlos3-prod-z2/a/b.jpg',
    'https://my.arlo.com/a/recordings/b.jpg',
    'https://user:pass@arlos3-prod-z2.s3.amazonaws.com/a/recordings/b.jpg',
    'https://user@arlos3-prod-z2.s3.amazonaws.com/a/recordings/b.jpg',
    'https://arlos3-prod-z2.s3.amazonaws.com:8443/a/recordings/b.jpg',
    'https://arlos3-prod-z2.s3.amazonaws.com/assets/placeholder.jpg',
    'https://arlos3-prod-z2.s3.amazonaws.com/assets/Feed-PlaceHolder-Image.PNG',
    'https://arlos3-prod-z2.s3.amazonaws.com/a/recordings/b.mp4',
    'https://arlos3-prod-z2.s3.amazonaws.com/a/recordings/b.jpg.html',
    'https://arlos3-prod-z2.s3.amazonaws.com/a/recordings/',
    'https://arlos3-prod-z2.s3.amazonaws.com/a/recordings/b?name=.jpg',
    'data:image/jpeg;base64,/9j/4AAQ',
    'not a url',
    '',
    null,
    42,
  ];
  for (const url of refused) assert.equal(relay.isAllowedThumbnailUrl(url), false, String(url));
});

const NAME_SAMPLES = ['Front', '  Back   Yard ', 'FF', 'ff', `Back${TAB}${NEWLINE}Yard`, 'Ｆｒｏｎｔ Ｄｏｏｒ', 'ﬁsh pond', `Cafe${String.fromCodePoint(0x301)}`, 'Garage²', `Side${String.fromCharCode(0xa0)}Gate`, 'İstanbul', '', '   '];

test('camera names normalize with NFKC, trimming, collapsed whitespace and lower case', () => {
  assert.equal(relay.normalizeCameraName('  Back   Yard '), 'back yard');
  assert.equal(relay.normalizeCameraName(`Back${TAB}${NEWLINE}Yard`), 'back yard');
  assert.equal(relay.normalizeCameraName('Ｆｒｏｎｔ Ｄｏｏｒ'), 'front door');
  assert.equal(relay.normalizeCameraName('ﬁsh pond'), 'fish pond');
  assert.equal(relay.normalizeCameraName(`Cafe${String.fromCodePoint(0x301)}`), 'café');
  assert.equal(relay.normalizeCameraName('Garage²'), 'garage2');
  assert.equal(relay.normalizeCameraName(`Side${String.fromCharCode(0xa0)}Gate`), 'side gate');
  assert.equal(relay.normalizeCameraName('FF'), 'ff');
  assert.equal(relay.normalizeCameraName('   '), '');
  assert.equal(relay.normalizeCameraName(null), '');
  assert.equal(relay.normalizeCameraName(42), '');
  assert.equal(relay.normalizeCameraName({ toString: () => 'Front' }), '');
});

test('camera names normalize exactly like the server core', async (t) => {
  let core;
  try {
    core = await import('./privateCamerasCore.mjs');
  } catch (error) {
    t.skip(`privateCamerasCore.mjs could not be loaded: ${error.message}`);
    return;
  }
  if (typeof core.normalizeRelayCameraName !== 'function') {
    t.skip('normalizeRelayCameraName is not exported by privateCamerasCore.mjs yet');
    return;
  }
  for (const sample of [...NAME_SAMPLES, null, undefined, 7]) {
    assert.equal(relay.normalizeCameraName(sample), core.normalizeRelayCameraName(sample), JSON.stringify(sample));
  }
});

test('urlKey keeps the origin and path and drops the signed query', () => {
  assert.equal(relay.urlKey(FRONT_NEWEST), 'https://arlos3-prod-z2.s3.amazonaws.com/5K7-1234/ABCDEF/recordings/1757800000001.jpg');
  assert.equal(relay.urlKey(`${FRONT_NEWEST}#frag`), relay.urlKey(FRONT_NEWEST.replace('Signature=', 'Signature=other')));
  assert.doesNotMatch(relay.urlKey(FRONT_NEWEST), /[?#]|Signature|Expires|token/);
  assert.equal(relay.urlKey('nope'), '');
  assert.equal(relay.urlKey(null), '');
});

test('readFeedItems reads name, absolute picture address and clip label per card in document order', () => {
  const { doc } = feedDocument(SAMPLE_FEED);
  const items = plain(relay.readFeedItems(doc));
  assert.deepEqual(items, [
    { name: 'front', src: new URL(FRONT_NEWEST).href, clip: 'Person · 9/13 · 2:14 PM' },
    { name: 'ff', src: 'https://arlos3-prod-z3.s3.amazonaws.com/5K7-1234/ABCDEF/recordings/placeholder.jpg?Expires=1', clip: 'Motion · 9/13 · 2:14 PM' },
    { name: 'ff', src: 'https://my.arlo.com/assets/images/feed-placeholder.png', clip: 'Motion · 9/13 · 2:14 PM' },
    { name: 'front', src: new URL(FRONT_OLDER).href, clip: 'Motion · 9/13 · 2:14 PM' },
    { name: 'ff', src: new URL(FF_NEWEST).href, clip: 'Vehicle · 14:02' },
    { name: 'FF', src: new URL(FF_OLDER).href, clip: 'Motion · 9/13 · 2:14 PM' },
  ]);
  assert.deepEqual(plain(relay.readFeedItems(null)), []);
  assert.deepEqual(plain(relay.readFeedItems(feedDocument([]).doc)), []);
});

test('clip labels are single-line, control-free and at most 80 characters', () => {
  const longType = `Motion${NUL}${NEWLINE}${'x'.repeat(120)}`;
  const { doc } = feedDocument([{ name: `fr${NUL}ont`, src: FRONT_NEWEST, type: longType, date: '9/13', time: '2:14 PM' }]);
  const [item] = relay.readFeedItems(doc);
  assert.ok(item.clip.length <= 80, item.clip);
  assert.ok(item.clip.startsWith('Motion x'), item.clip);
  assert.equal([...item.clip, ...item.name].some((character) => character.charCodeAt(0) < 32), false);
  assert.equal(item.name, 'fr ont');
  const emoji = relay.cleanLabel('😀'.repeat(50), 80);
  assert.equal(emoji.length, 80);
  assert.doesNotThrow(() => encodeURIComponent(relay.cleanLabel(`a${String.fromCharCode(0xd800)}b`, 80)));
});

test('pickNewestPerCamera keeps the first allowed picture per normalized camera name', () => {
  const { doc } = feedDocument(SAMPLE_FEED);
  const newest = relay.pickNewestPerCamera(relay.readFeedItems(doc));
  assert.deepEqual(plain([...newest.keys()]), ['front', 'ff']);
  assert.equal(newest.get('front').src, new URL(FRONT_NEWEST).href);
  assert.equal(newest.get('ff').src, new URL(FF_NEWEST).href, 'placeholder pictures are skipped');
  assert.equal(newest.get('ff').clip, 'Vehicle · 14:02');
  assert.equal(newest.has('back yard'), false, 'a camera without a recent clip is simply absent');
  assert.equal(relay.pickNewestPerCamera(null).size, 0);
  assert.equal(relay.pickNewestPerCamera([{ name: 'front', src: 'http://arlos3-prod-z2.s3.amazonaws.com/a.jpg' }, null, { name: '  ', src: FRONT_NEWEST }]).size, 0);
});

test('detectFeedState distinguishes signed out, feed, no clips and an unknown layout', () => {
  const feed = feedDocument(SAMPLE_FEED).doc;
  assert.equal(relay.detectFeedState(feed, { hash: '#/feed' }), 'feed');
  for (const hash of ['#/login', '#/Login?next=feed', '#/signin', '#/signup', '#/forgot-password']) {
    assert.equal(relay.detectFeedState(feed, { hash }), 'signed-out', hash);
  }
  assert.equal(relay.detectFeedState(feedDocument([], { password: true, container: false }).doc, { hash: '#/feed' }), 'signed-out');
  assert.equal(relay.detectFeedState(feedDocument(SAMPLE_FEED, { password: true }).doc, { hash: '#/feed' }), 'signed-out');
  assert.equal(relay.detectFeedState(feedDocument([]).doc, { hash: '#/feed' }), 'no-cards');
  const bareContainer = h('#document', {}, h('html', {}, h('body', {}, h('app-feed-scroll-container'))));
  assert.equal(relay.detectFeedState(bareContainer, { hash: '#/feed' }), 'no-cards');
  const spinner = h('#document', {}, h('html', {}, h('body', {}, h('div', { className: 'loading-spinner' }))));
  assert.equal(relay.detectFeedState(spinner, { hash: '#/feed' }), 'layout-unknown');
  assert.equal(relay.detectFeedState(null, null), 'layout-unknown');
  assert.equal(relay.detectFeedState(feed, null), 'feed');
});

test('only a tab showing the feed, or on the feed or a sign-in route, reports', () => {
  assert.equal(relay.isReportablePage('feed', { hash: '#/devices' }), true, 'feed cards are the feed wherever they are');
  assert.equal(relay.isReportablePage('no-cards', { hash: '#/feed' }), true);
  assert.equal(relay.isReportablePage('layout-unknown', { hash: '#/feed?filter=motion' }), true);
  assert.equal(relay.isReportablePage('layout-unknown', { hash: '#/feed/' }), true);
  assert.equal(relay.isReportablePage('signed-out', { hash: '#/login' }), true);
  assert.equal(relay.isReportablePage('signed-out', { hash: '#/settings/password' }), false, 'a change-password form elsewhere is not a sign-out');
  assert.equal(relay.isReportablePage('layout-unknown', { hash: '#/devices' }), false, 'another Arlo page is not an unknown feed layout');
  assert.equal(relay.isReportablePage('no-cards', { hash: '#/feedback' }), false);
  assert.equal(relay.isReportablePage('layout-unknown', null), false);
});

test('pairing codes are six characters from the unambiguous 32-letter alphabet, and only GEV makes them', () => {
  const alphabet = relay.PAIRING_CODE_ALPHABET;
  assert.equal(alphabet.length, 32);
  assert.equal(new Set(alphabet).size, 32);
  assert.doesNotMatch(alphabet, /[IO01]/);
  for (const code of ['K7PM3Q', 'ABCD89', '222222']) assert.equal(relay.isPairingCode(code), true, code);
  for (const code of ['k7pm3q', 'K7PM3', 'K7PM3QQ', 'K7PM3O', 'K7PM31', 'K7 M3Q', 'K7PM3Q\u200b', '', null, 42, ['K7PM3Q']]) {
    assert.equal(relay.isPairingCode(code), false, JSON.stringify(code));
  }
  assert.equal(relay.generatePairingCode, undefined, 'the extension never picks a code');
  assert.doesNotMatch(readRelayFile('service-worker.js'), /generatePairingCode|new Uint8Array\(6\)/);
});

test('base64url encodes without padding and matches Node for a 32-byte secret', () => {
  const encoder = new TextEncoder();
  const vectors = { '': '', f: 'Zg', fo: 'Zm8', foo: 'Zm9v', foob: 'Zm9vYg', fooba: 'Zm9vYmE', foobar: 'Zm9vYmFy' };
  for (const [input, expected] of Object.entries(vectors)) assert.equal(relay.base64url(encoder.encode(input)), expected, input);
  assert.equal(relay.base64url(Uint8Array.from([0xfb, 0xff])), '-_8');
  assert.equal(relay.base64url(Uint8Array.from([0xfb, 0xff]).buffer), '-_8');
  for (let round = 0; round < 20; round += 1) {
    const bytes = randomBytes(32);
    const secret = relay.base64url(new Uint8Array(bytes));
    assert.equal(secret, bytes.toString('base64url'));
    assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
  }
});

test('sha256Hex hashes bytes, and the pairing hash is sha256 of the secret string', async () => {
  const encoder = new TextEncoder();
  assert.equal(await relay.sha256Hex(encoder.encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(await relay.sha256Hex(new Uint8Array(0)), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  const secret = relay.base64url(new Uint8Array(randomBytes(32)));
  assert.equal(await relay.sha256Hex(encoder.encode(secret)), sha256(secret));
});

test('sniffImageType recognises JPEG, PNG and WebP magic bytes only', () => {
  assert.equal(relay.sniffImageType(JPEG), 'image/jpeg');
  assert.equal(relay.sniffImageType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])), 'image/png');
  const webp = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50]);
  assert.equal(relay.sniffImageType(webp), 'image/webp');
  assert.equal(relay.sniffImageType(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45])), '');
  assert.equal(relay.sniffImageType(new TextEncoder().encode('GIF89a')), '');
  assert.equal(relay.sniffImageType(new TextEncoder().encode('<html>')), '');
  assert.equal(relay.sniffImageType(Uint8Array.from([0xff, 0xd8])), '');
  assert.equal(relay.sniffImageType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47])), '');
  assert.equal(relay.sniffImageType(null), '');
});

// ---- static checks ----

test('the manifest is MV3 with only the Arlo thumbnail hosts and local GEV as host permissions', () => {
  const manifest = JSON.parse(readRelayFile('manifest.json'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, 'GEV Arlo Feed Relay');
  assert.equal(manifest.version, '1.0.0');
  assert.equal(manifest.minimum_chrome_version, '116');
  assert.deepEqual(manifest.background, { service_worker: 'service-worker.js', type: 'module' });
  assert.deepEqual(manifest.host_permissions, [
    'https://arlos3-prod-z1.s3.amazonaws.com/*',
    'https://arlos3-prod-z2.s3.amazonaws.com/*',
    'https://arlos3-prod-z3.s3.amazonaws.com/*',
    'https://arlos3-prod-z4.s3.amazonaws.com/*',
    'http://localhost:4173/*',
    'http://127.0.0.1:4173/*',
  ]);
  assert.ok(manifest.permissions === undefined || (Array.isArray(manifest.permissions) && manifest.permissions.length === 0));
  assert.deepEqual(manifest.content_scripts, [{ matches: ['https://my.arlo.com/*'], js: ['relay-logic.js', 'content.js'], run_at: 'document_idle', all_frames: false }]);
  assert.equal(manifest.options_page, 'options.html');
  for (const key of ['externally_connectable', 'key', 'web_accessible_resources', 'optional_permissions', 'optional_host_permissions', 'content_security_policy', 'action', 'sandbox', 'update_url']) {
    assert.equal(Object.hasOwn(manifest, key), false, key);
  }
  assert.doesNotMatch(JSON.stringify(manifest), /MAIN|"world"/);
  assert.ok(manifest.description.length <= 132);
});

function extensionFiles() {
  return readdirSync(RELAY_DIR, { withFileTypes: true }).map((entry) => {
    assert.ok(entry.isFile(), `unexpected entry ${entry.name}`);
    return entry.name;
  });
}

test('no extension file uses cookies, webRequest, debugger, storage, eval or HTML injection', () => {
  const forbidden = [
    /chrome\.cookies/,
    /chrome\.webRequest/,
    /chrome\.debugger/,
    /chrome\.storage/,
    /chrome\.scripting/,
    /chrome\.tabs/,
    /\beval\s*\(/,
    /\bnew\s+Function\b/,
    /\bFunction\s*\(/,
    /\.innerHTML\s*\+?=/,
    /\.outerHTML\s*\+?=/,
    /insertAdjacentHTML/,
    /document\.write/,
    /\bimportScripts\s*\(/,
    /document\.cookie/,
    /\blocalStorage\b/,
    /\bsessionStorage\b/,
    /setTimeout\s*\(\s*['"`]/,
    /\bconsole\./,
    /\.pem\b/,
  ];
  const code = extensionFiles().filter((name) => /\.(?:js|html|json|css)$/.test(name));
  assert.deepEqual(code.sort(), ['content.js', 'manifest.json', 'options.css', 'options.html', 'options.js', 'relay-logic.js', 'service-worker.js']);
  for (const name of code) {
    const source = readRelayFile(name);
    for (const pattern of forbidden) assert.doesNotMatch(source, pattern, `${name} must not match ${pattern}`);
    assert.equal([...source].some((character) => { const value = character.charCodeAt(0); return (value < 32 && value !== 10 && value !== 13) || value === 127; }), false, `${name} has raw control characters`);
  }
  assert.equal(extensionFiles().some((name) => name.endsWith('.pem') || name.endsWith('.crx')), false);
});

test('the content script and shared logic never act on the page or reach the network', () => {
  const pageActions = [/\.click\s*\(/, /scrollIntoView|scrollTo\s*\(|scrollBy\s*\(/, /location\.(?:reload|assign|replace)\s*\(/, /location\.href\s*=/, /\.dispatchEvent\s*\(/, /\.focus\s*\(/, /history\.(?:push|replace)State/, /\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /indexedDB/, /createElement\s*\(\s*['"]script/];
  for (const name of ['content.js', 'relay-logic.js']) {
    const source = readRelayFile(name);
    for (const pattern of pageActions) assert.doesNotMatch(source, pattern, `${name} must not match ${pattern}`);
  }
});

test('options.html has no inline script, inline handlers or inline styles', () => {
  const html = readRelayFile('options.html');
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length >= 1);
  for (const [, attributes, body] of scripts) {
    assert.equal(body.trim(), '', 'inline script content');
    assert.match(attributes, /\bsrc="options\.js"/);
  }
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(html, /\sstyle\s*=/i);
  assert.doesNotMatch(html, /<style\b/i);
  assert.doesNotMatch(html, /(?:src|href)="(?:https?:)?\/\//i);
  for (const label of ['PAIR WITH GODS EYE VIEW', 'FORGET PAIRING', 'https://my.arlo.com/#/feed', 'use this relay at your own risk', 'Code from Gods Eye View', 'extension ID both match']) assert.ok(html.includes(label), label);
});

test('the service worker fetches thumbnails with credentials omitted and redirects refused', () => {
  const source = readRelayFile('service-worker.js');
  const options = /const THUMBNAIL_FETCH_OPTIONS = Object\.freeze\(\{([^}]*)\}\);/.exec(source);
  assert.ok(options, 'THUMBNAIL_FETCH_OPTIONS is declared');
  assert.match(options[1], /credentials: 'omit'/);
  assert.match(options[1], /redirect: 'error'/);
  assert.match(options[1], /cache: 'no-store'/);
  assert.match(options[1], /referrerPolicy: 'no-referrer'/);
  assert.match(source, /await fetch\(url, THUMBNAIL_FETCH_OPTIONS\)/);
  assert.doesNotMatch(source, /credentials: 'include'|credentials: 'same-origin'/);
  assert.deepEqual([...source.matchAll(/^\s*import\s.*$/gm)].map((match) => match[0].trim()), ["import './relay-logic.js';"]);
});

// ---- service worker behaviour with fake Chrome, IndexedDB and network ----

function fakeIndexedDB() {
  const stores = new Map();
  let version = 0;
  const later = (callback) => setTimeout(callback, 0);
  return {
    stores,
    open(name, requested) {
      assert.equal(name, 'gev-arlo-relay');
      const openRequest = {};
      later(() => {
        const database = {
          objectStoreNames: { contains: (store) => stores.has(store) },
          createObjectStore: (store) => stores.set(store, new Map()),
          close() {},
          transaction(store, mode) {
            const data = stores.get(store);
            if (!data) throw new Error('NotFoundError');
            const operations = [];
            const queue = (operation) => {
              const request = {};
              operations.push(() => operation(request));
              return request;
            };
            const writable = () => {
              if (mode !== 'readwrite') throw new Error('ReadOnlyError');
            };
            const transaction = {
              objectStore: () => ({
                get: (key) => queue((request) => { request.result = data.get(key); }),
                put: (value, key) => { writable(); return queue(() => data.set(key, value)); },
                delete: (key) => { writable(); return queue(() => data.delete(key)); },
              }),
            };
            later(() => {
              for (const operation of operations) operation();
              transaction.oncomplete?.();
            });
            return transaction;
          },
        };
        openRequest.result = database;
        if (version < requested) {
          version = requested;
          openRequest.onupgradeneeded?.();
        }
        openRequest.onsuccess?.();
      });
      return openRequest;
    },
  };
}

function fakeNetwork() {
  const calls = [];
  const routes = [];
  return {
    calls,
    on(url, reply) {
      routes.unshift({ url, reply });
    },
    async fetchImpl(url, options = {}) {
      const call = { url: String(url), options: { ...options, headers: { ...(options.headers || {}) } } };
      calls.push(call);
      const route = routes.find((candidate) => candidate.url === call.url);
      if (!route) throw new TypeError('Failed to fetch');
      return route.reply(call);
    },
  };
}

const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const emptyResponse = (status) => new Response(null, { status });
const imageResponse = (bytes, type = 'image/jpeg', status = 200) => new Response(bytes, { status, headers: { 'content-type': type } });

const FEED_SENDER = Object.freeze({ id: EXTENSION_ID, origin: 'https://my.arlo.com', frameId: 0, tab: { id: 3 }, url: 'https://my.arlo.com/#/feed' });
const OPTIONS_SENDER = Object.freeze({ id: EXTENSION_ID, origin: `chrome-extension://${EXTENSION_ID}`, tab: { id: 4 }, url: `chrome-extension://${EXTENSION_ID}/options.html` });

function loadServiceWorker({ clock } = {}) {
  const network = fakeNetwork();
  const indexedDB = fakeIndexedDB();
  const listeners = {};
  const chrome = {
    runtime: {
      id: EXTENSION_ID,
      getURL: (file) => `chrome-extension://${EXTENSION_ID}/${file}`,
      onMessage: { addListener: (listener) => { listeners.message = listener; } },
      onInstalled: { addListener: (listener) => { listeners.installed = listener; } },
      openOptionsPage: async () => {},
    },
  };
  const context = createRelayContext({ chrome, indexedDB, fetch: (url, options) => network.fetchImpl(url, options), Response, Headers, ...(clock ? { Date: { now: () => clock.now } } : {}) });
  const importLine = "import './relay-logic.js';";
  const source = readRelayFile('service-worker.js');
  assert.ok(source.includes(importLine));
  vm.runInContext(`'use strict';${source.replace(importLine, '')}`, context, { filename: 'service-worker.js' });
  assert.equal(typeof listeners.message, 'function');
  assert.equal(typeof listeners.installed, 'function');
  const dispatch = (message, sender) =>
    new Promise((resolve) => {
      let answered = false;
      const keepOpen = listeners.message(message, sender, (reply) => {
        answered = true;
        resolve(plain(reply));
      });
      if (keepOpen !== true && !answered) resolve(undefined);
    });
  const pairingStore = () => indexedDB.stores.get('pairing') ?? new Map();
  return { dispatch, network, pairingStore };
}

async function pairedServiceWorker({ clock } = {}) {
  const sw = loadServiceWorker({ clock });
  let pairRequest;
  sw.network.on(`${GEV}/relay/pair-request`, (call) => {
    pairRequest = call;
    return jsonResponse(202, { pending: true, code: 'K7PM3Q', expiresInSeconds: 120 });
  });
  const pairReply = await sw.dispatch({ type: 'pair' }, OPTIONS_SENDER);
  sw.network.on(`${GEV}/relay/pair-status`, () => jsonResponse(200, { paired: true, siteName: 'Home', cameras: ['Front', 'Ff', 'Back Yard'] }));
  const statusReply = await sw.dispatch({ type: 'pair-status' }, OPTIONS_SENDER);
  const secret = sw.pairingStore().get('secret');
  sw.network.calls.length = 0;
  return { ...sw, pairRequest, pairReply, statusReply, secret };
}

test('the service worker ignores messages from the wrong senders', async () => {
  const sw = loadServiceWorker();
  const frame = { type: 'frame', camera: 'front', url: FRONT_NEWEST, clip: 'Motion' };
  const refused = [
    [frame, OPTIONS_SENDER],
    [frame, { ...FEED_SENDER, frameId: 2 }],
    [frame, { ...FEED_SENDER, origin: 'https://evil.test' }],
    [frame, { ...FEED_SENDER, origin: 'http://my.arlo.com' }],
    [frame, { ...FEED_SENDER, tab: undefined }],
    [frame, { ...FEED_SENDER, id: 'ponmlkjihgfedcbaponmlkjihgfedcba' }],
    [{ type: 'heartbeat', state: 'feed', seen: [] }, OPTIONS_SENDER],
    [{ type: 'pair' }, FEED_SENDER],
    [{ type: 'pair' }, { ...OPTIONS_SENDER, url: 'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/options.html' }],
    [{ type: 'pair' }, { ...OPTIONS_SENDER, url: `chrome-extension://${EXTENSION_ID}/options.html.evil` }],
    [{ type: 'forget' }, { ...OPTIONS_SENDER, id: undefined }],
    [{ type: 'status' }, { ...OPTIONS_SENDER, url: 'https://my.arlo.com/options.html' }],
    [{ type: 'unknown' }, OPTIONS_SENDER],
    [null, OPTIONS_SENDER],
    [{ type: 'status' }, null],
  ];
  for (const [message, sender] of refused) {
    assert.equal(await sw.dispatch(message, sender), undefined, JSON.stringify([message, sender]));
  }
  await settle();
  assert.equal(sw.network.calls.length, 0);
  assert.equal(sw.pairingStore().size, 0);
});

test('pairing sends only sha256 of the secret string, shows the code GEV issued, then promotes the pending secret once approved', async () => {
  const sw = loadServiceWorker();
  let pairRequest;
  sw.network.on(`${GEV}/relay/pair-request`, (call) => {
    pairRequest = call;
    return jsonResponse(202, { pending: true, code: 'K7PM3Q', expiresInSeconds: 120 });
  });
  const reply = await sw.dispatch({ type: 'pair' }, OPTIONS_SENDER);
  assert.equal(reply.ok, true);
  assert.equal(reply.extensionId, EXTENSION_ID);
  assert.equal(reply.code, 'K7PM3Q', 'the options page shows the code GEV issued');
  const body = JSON.parse(pairRequest.options.body);
  assert.deepEqual(Object.keys(body), ['secretHash'], 'the extension never picks a code');
  assert.match(body.secretHash, /^[0-9a-f]{64}$/);
  assert.equal(pairRequest.options.method, 'POST');
  assert.equal(pairRequest.options.credentials, 'omit');
  assert.deepEqual(pairRequest.options.headers, { 'Content-Type': 'application/json' });
  const pending = sw.pairingStore().get('pendingSecret');
  assert.match(pending, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(sha256(pending), body.secretHash, 'secretHash is sha256 of the UTF-8 base64url secret string');
  assert.equal(sw.pairingStore().has('secret'), false);
  assert.ok(!JSON.stringify(reply).includes(pending));

  sw.network.on(`${GEV}/relay/pair-status`, () => jsonResponse(200, { paired: false, pending: true }));
  assert.deepEqual(await sw.dispatch({ type: 'pair-status' }, OPTIONS_SENDER), { paired: false, pending: true, local: 'pending' });
  const statusCall = sw.network.calls.at(-1);
  assert.equal(statusCall.options.method, 'GET');
  assert.deepEqual(statusCall.options.headers, { Authorization: `Bearer ${pending}` });
  assert.equal(statusCall.options.body, undefined);

  sw.network.on(`${GEV}/relay/pair-status`, () => jsonResponse(200, { paired: true, siteName: 'Home', cameras: ['Front', 'Ff', 'Back Yard'] }));
  assert.deepEqual(await sw.dispatch({ type: 'pair-status' }, OPTIONS_SENDER), { paired: true, siteName: 'Home', cameras: ['Front', 'Ff', 'Back Yard'], approved: true, local: 'paired' });
  assert.equal(sw.pairingStore().get('secret'), pending);
  assert.equal(sw.pairingStore().has('pendingSecret'), false);

  const status = await sw.dispatch({ type: 'status' }, OPTIONS_SENDER);
  assert.equal(status.paired, true);
  assert.ok(!JSON.stringify(status).includes(pending));
});

test('an expired pairing request is forgotten and pairing errors are reported', async () => {
  const sw = loadServiceWorker();
  assert.match((await sw.dispatch({ type: 'pair' }, OPTIONS_SENDER)).error, /not reachable/);
  assert.equal(sw.pairingStore().size, 0);
  sw.network.on(`${GEV}/relay/pair-request`, () => jsonResponse(429, { error: 'Too many' }));
  assert.match((await sw.dispatch({ type: 'pair' }, OPTIONS_SENDER)).error, /Too many pairing requests/);
  sw.network.on(`${GEV}/relay/pair-request`, () => jsonResponse(403, { error: 'Relay pairing is refused here' }));
  assert.deepEqual(await sw.dispatch({ type: 'pair' }, OPTIONS_SENDER), { ok: false, error: 'Relay pairing is refused here' });
  assert.equal(sw.pairingStore().size, 0);
  for (const answer of [{ pending: true, expiresInSeconds: 120 }, { pending: true, code: 'k7pm3q', expiresInSeconds: 120 }, { pending: true, code: 'K7PM3Q<b>', expiresInSeconds: 120 }]) {
    sw.network.on(`${GEV}/relay/pair-request`, () => jsonResponse(202, answer));
    assert.deepEqual(await sw.dispatch({ type: 'pair' }, OPTIONS_SENDER), { ok: false, error: 'Gods Eye View sent no pairing code. Update Gods Eye View and try again.' }, JSON.stringify(answer));
  }
  assert.equal(sw.pairingStore().size, 0, 'nothing is kept for a request without a code to compare');

  sw.network.on(`${GEV}/relay/pair-request`, () => jsonResponse(202, { pending: true, code: 'K7PM3Q', expiresInSeconds: 120 }));
  assert.equal((await sw.dispatch({ type: 'pair' }, OPTIONS_SENDER)).ok, true);
  sw.network.on(`${GEV}/relay/pair-status`, () => jsonResponse(401, { paired: false }));
  assert.deepEqual(await sw.dispatch({ type: 'pair-status' }, OPTIONS_SENDER), { paired: false, pendingExpired: true, local: 'none' });
  assert.equal(sw.pairingStore().size, 0);
});

test('a paired service worker relays thumbnail bytes, camera name and clip label and never the address', async () => {
  const sw = await pairedServiceWorker();
  assert.match(sw.secret, /^[A-Za-z0-9_-]{43}$/);
  sw.network.on(FRONT_NEWEST, () => imageResponse(JPEG));
  sw.network.on(`${GEV}/relay/frame`, () => emptyResponse(204));
  const clip = 'Motion · 9/13 · 2:14 PM';
  const reply = await sw.dispatch({ type: 'frame', camera: 'front', url: FRONT_NEWEST, clip }, FEED_SENDER);
  assert.equal(reply.ok, true);
  assert.equal(reply.done, true);
  assert.equal(reply.paired, true);
  assert.match(reply.epoch, /^[0-9a-f]{16}$/);
  assert.notEqual(reply.epoch, sha256(sw.secret).slice(0, 16), 'the epoch is not a prefix of the stored hash');

  const [thumbnail, frame, ...rest] = sw.network.calls;
  assert.equal(rest.length, 0);
  assert.equal(thumbnail.url, FRONT_NEWEST);
  assert.deepEqual(plain({ ...thumbnail.options, headers: undefined }), { method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });
  assert.deepEqual(thumbnail.options.headers, {});
  assert.equal(frame.url, `${GEV}/relay/frame`);
  assert.equal(frame.options.method, 'POST');
  assert.equal(frame.options.credentials, 'omit');
  assert.equal(frame.options.redirect, 'error');
  assert.deepEqual(frame.options.headers, { Authorization: `Bearer ${sw.secret}`, 'Content-Type': 'image/jpeg', 'X-Arlo-Camera': 'front', 'X-Arlo-Clip': encodeURIComponent(clip) });
  assert.deepEqual([...frame.options.body], [...JPEG]);
  for (const value of [frame.url, ...Object.values(frame.options.headers)]) assert.doesNotMatch(value, /amazonaws|Signature|recordings|Expires/);

  assert.equal((await sw.dispatch({ type: 'frame', camera: 'Front', url: FRONT_NEWEST.replace('Signature=', 'Signature=renewed'), clip }, FEED_SENDER)).done, true);
  assert.equal(sw.network.calls.length, 2, 'the same clip picture is not relayed twice');

  const status = await sw.dispatch({ type: 'status' }, OPTIONS_SENDER);
  assert.equal(status.recent[0].camera, 'front');
  assert.equal(status.recent[0].outcome, 'sent');
  assert.deepEqual(Object.keys(status.recent[0]).sort(), ['at', 'camera', 'outcome']);
  assert.doesNotMatch(JSON.stringify(status), /amazonaws|Signature|recordings/);
  assert.ok(!JSON.stringify(status).includes(sw.secret));
});

test('refused, oversized, unknown, rate-limited and unreachable frames report outcomes without retrying credentials', async () => {
  const sw = await pairedServiceWorker();
  const outcomes = async () => (await sw.dispatch({ type: 'status' }, OPTIONS_SENDER)).recent.map((entry) => `${entry.camera}: ${entry.outcome}`);
  const send = (camera, url) => sw.dispatch({ type: 'frame', camera, url, clip: 'Motion' }, FEED_SENDER);

  const evil = 'https://arlos3-prod-z2.s3.amazonaws.com.evil.test/a/recordings/b.jpg?Signature=x';
  assert.deepEqual((({ ok, done }) => ({ ok, done }))(await send('front', evil)), { ok: false, done: true });
  assert.equal(sw.network.calls.length, 0);
  assert.equal((await outcomes())[0], 'front: unsupported host: arlos3-prod-z2.s3.amazonaws.com.evil.test');

  const expired = s3('z2', 'expired');
  sw.network.on(expired, () => new Response('<Error/>', { status: 403, headers: { 'content-type': 'application/xml' } }));
  const refusedReply = await send('front', expired);
  assert.deepEqual([refusedReply.done, refusedReply.refused], [true, true], 'a refused thumbnail is final for its address');
  assert.equal(sw.network.calls.length, 1, 'no GEV request and no second thumbnail attempt');
  assert.equal((await outcomes())[0], 'front: thumbnail refused (HTTP 403)');

  const html = s3('z2', 'html');
  sw.network.on(html, () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }));
  await send('front', html);
  assert.equal((await outcomes())[0], 'front: thumbnail refused (HTTP 200)');

  const notPicture = s3('z2', 'not-picture');
  sw.network.on(notPicture, () => imageResponse(new TextEncoder().encode('hello')));
  await send('front', notPicture);
  assert.equal((await outcomes())[0], 'front: thumbnail is not a picture');

  const huge = s3('z2', 'huge');
  sw.network.on(huge, () => imageResponse(new Uint8Array(8 * 1024 * 1024 + 1)));
  assert.equal((await send('front', huge)).done, true);
  assert.equal((await outcomes())[0], 'front: thumbnail too large');
  assert.equal(sw.network.calls.some((call) => call.url.endsWith('/relay/frame')), false);

  const garage = s3('z1', 'garage');
  sw.network.on(garage, () => imageResponse(JPEG));
  sw.network.on(`${GEV}/relay/frame`, () => jsonResponse(404, { error: 'Unknown camera name' }));
  const unknownReply = await send('Garage', garage);
  assert.deepEqual([unknownReply.done, unknownReply.retryAfterMs], [false, 10 * 60 * 1000], 'an unknown name is tried again only after ten minutes');
  assert.equal((await outcomes())[0], 'Garage: unknown camera name');

  sw.network.on(`${GEV}/relay/frame`, () => emptyResponse(429));
  const limited = await send('Garage', garage);
  assert.equal(limited.done, false);
  assert.equal(limited.retryAfterMs, 2500);
  assert.equal((await outcomes())[0], 'Garage: rate limited');

  sw.network.on(`${GEV}/relay/frame`, () => emptyResponse(401));
  const notPaired = await send('Garage', garage);
  assert.deepEqual([notPaired.done, notPaired.gevReady], [false, false], 'GEV no longer takes the relay');
  assert.equal((await outcomes())[0], 'Garage: not paired');

  sw.network.on(`${GEV}/relay/frame`, () => emptyResponse(415));
  assert.deepEqual((({ done, refused }) => ({ done, refused }))(await send('Garage', garage)), { done: true, refused: true }, 'another refusal is final for that picture');
  assert.equal((await outcomes())[0], 'Garage: GEV answered 415');

  // GEV drops the connection of an upload it refuses unread, which fetch reports as a network error.
  sw.network.on(`${GEV}/relay/frame`, () => {
    throw new TypeError('Failed to fetch');
  });
  const dropped = await send('Garage', garage);
  assert.deepEqual([dropped.done, dropped.gevReady], [false, true]);
  assert.equal((await outcomes())[0], 'Garage: GEV dropped the upload', 'GEV still answers, so the upload itself was dropped');
  sw.network.on(`${GEV}/relay/pair-status`, () => jsonResponse(401, { paired: false }));
  const droppedUnpaired = await send('Garage', garage);
  assert.deepEqual([droppedUnpaired.done, droppedUnpaired.gevReady], [false, false]);
  assert.equal((await outcomes())[0], 'Garage: not paired', 'a dropped upload from a relay GEV no longer knows reads as not paired');
  sw.network.on(`${GEV}/relay/pair-status`, () => {
    throw new TypeError('Failed to fetch');
  });
  const unreachable = await send('Garage', garage);
  assert.deepEqual([unreachable.done, unreachable.gevReady], [false, false]);
  assert.equal((await outcomes())[0], 'Garage: GEV not reachable');

  for (const call of sw.network.calls) {
    assert.notEqual(call.options.credentials, 'include');
    if (!call.url.startsWith('http://localhost:4173/')) assert.equal(call.options.headers.Authorization, undefined);
  }
  const recent = (await sw.dispatch({ type: 'status' }, OPTIONS_SENDER)).recent;
  assert.ok(recent.length <= 20);
  assert.doesNotMatch(JSON.stringify(recent), /Signature|recordings|\?/);
});

test('an unpaired service worker sends nothing, heartbeats are bounded JSON and forget removes both secrets', async () => {
  const unpaired = loadServiceWorker();
  assert.deepEqual(await unpaired.dispatch({ type: 'frame', camera: 'front', url: FRONT_NEWEST, clip: 'Motion' }, FEED_SENDER), { paired: false, epoch: '', ok: false, done: false, gevReady: false });
  assert.deepEqual(await unpaired.dispatch({ type: 'heartbeat', state: 'feed', seen: ['front'] }, FEED_SENDER), { paired: false, epoch: '', ok: false, sent: false });
  await settle();
  assert.equal(unpaired.network.calls.length, 0);

  const sw = await pairedServiceWorker();
  sw.network.on(`${GEV}/relay/heartbeat`, () => emptyResponse(204));
  const beat = await sw.dispatch({ type: 'heartbeat', state: 'feed', seen: ['front', 'ff'] }, FEED_SENDER);
  assert.equal(beat.sent, true);
  const [call] = sw.network.calls;
  assert.equal(call.options.method, 'POST');
  assert.deepEqual(call.options.headers, { Authorization: `Bearer ${sw.secret}`, 'Content-Type': 'application/json' });
  const sentBeat = JSON.parse(call.options.body);
  assert.deepEqual(Object.keys(sentBeat), ['state', 'seen', 'reporter']);
  assert.deepEqual([sentBeat.state, sentBeat.seen], ['feed', ['front', 'ff']]);
  assert.match(sentBeat.reporter, /^[0-9a-f]{16}$/, 'an opaque tag for the tab, not the tab id');
  assert.notEqual(sentBeat.reporter, beat.epoch);

  // One tab keeps its tag (so GEV believes its own sign-out at once); another tab gets its own.
  await sw.dispatch({ type: 'heartbeat', state: 'signed-out', seen: [] }, { ...FEED_SENDER, url: 'https://my.arlo.com/#/login' });
  const sameTab = JSON.parse(sw.network.calls.at(-1).options.body);
  assert.deepEqual([sameTab.state, sameTab.reporter], ['signed-out', sentBeat.reporter]);
  await sw.dispatch({ type: 'heartbeat', state: 'feed', seen: [] }, { ...FEED_SENDER, tab: { id: 7 } });
  const otherTab = JSON.parse(sw.network.calls.at(-1).options.body);
  assert.match(otherTab.reporter, /^[0-9a-f]{16}$/);
  assert.notEqual(otherTab.reporter, sentBeat.reporter);

  // GEV answers which seen cameras still need a picture and which names match no camera.
  sw.network.on(`${GEV}/relay/heartbeat`, () => jsonResponse(200, { missing: ['Front', 'ff', 'ff', 42], unknown: ['Garage', null], extra: 'ignored' }));
  const answered = await sw.dispatch({ type: 'heartbeat', state: 'feed', seen: ['front', 'ff', 'garage'] }, FEED_SENDER);
  assert.deepEqual([answered.sent, answered.missing, answered.unknown], [true, ['front', 'ff'], ['garage']]);
  sw.network.on(`${GEV}/relay/heartbeat`, () => emptyResponse(401));
  const refusedBeat = await sw.dispatch({ type: 'heartbeat', state: 'feed', seen: [] }, FEED_SENDER);
  assert.deepEqual([refusedBeat.sent, Object.hasOwn(refusedBeat, 'missing')], [false, false]);
  sw.network.on(`${GEV}/relay/heartbeat`, () => emptyResponse(204));

  await sw.dispatch({ type: 'heartbeat', state: 'bogus', seen: Array.from({ length: 30 }, (_, index) => `camera ${index} ${'x'.repeat(300)}`) }, FEED_SENDER);
  const bounded = JSON.parse(sw.network.calls.at(-1).options.body);
  assert.equal(bounded.state, 'layout-unknown');
  assert.ok(bounded.seen.length <= 20);
  assert.ok(bounded.seen.every((name) => name.length <= 200));
  assert.ok(new TextEncoder().encode(sw.network.calls.at(-1).options.body).byteLength <= 4096);

  assert.deepEqual(await sw.dispatch({ type: 'forget' }, OPTIONS_SENDER), { ok: true });
  assert.equal(sw.pairingStore().size, 0);
  assert.equal((await sw.dispatch({ type: 'status' }, OPTIONS_SENDER)).paired, false);
});

test('a feed tab picks up an approval by itself when the options page is closed, asking GEV at most every 10 seconds', async () => {
  const clock = { now: 1_000_000 };
  const sw = loadServiceWorker({ clock });
  sw.network.on(`${GEV}/relay/pair-request`, () => jsonResponse(202, { pending: true, code: 'K7PM3Q', expiresInSeconds: 120 }));
  assert.equal((await sw.dispatch({ type: 'pair' }, OPTIONS_SENDER)).ok, true);
  const pending = sw.pairingStore().get('pendingSecret');
  const heartbeat = () => sw.dispatch({ type: 'heartbeat', state: 'feed', seen: ['front'] }, FEED_SENDER);
  const asked = () => sw.network.calls.filter((call) => call.url === `${GEV}/relay/pair-status`).length;

  sw.network.on(`${GEV}/relay/pair-status`, () => jsonResponse(200, { paired: false, pending: true }));
  assert.deepEqual(await heartbeat(), { paired: false, epoch: '', ok: false, sent: false });
  assert.equal(asked(), 1);
  assert.equal(sw.network.calls.some((call) => call.url === `${GEV}/relay/heartbeat`), false, 'nothing is reported before approval');

  // Approved in POWER UP; nobody looks at the options page.
  sw.network.on(`${GEV}/relay/pair-status`, () => jsonResponse(200, { paired: true, siteName: 'Home', cameras: ['Front'] }));
  sw.network.on(`${GEV}/relay/heartbeat`, () => jsonResponse(200, { missing: ['front'], unknown: [] }));
  assert.equal((await heartbeat()).sent, false);
  assert.equal(asked(), 1, 'not asked again within 10 seconds');
  clock.now += 10_000;
  const promoted = await heartbeat();
  assert.deepEqual([promoted.paired, promoted.sent, promoted.missing], [true, true, ['front']]);
  assert.match(promoted.epoch, /^[0-9a-f]{16}$/);
  assert.equal(sw.pairingStore().get('secret'), pending);
  assert.equal(sw.pairingStore().has('pendingSecret'), false);
  const beat = sw.network.calls.at(-1);
  assert.deepEqual([beat.url, beat.options.headers.Authorization], [`${GEV}/relay/heartbeat`, `Bearer ${pending}`], 'the first heartbeat goes out straight away');

  // An expired request found this way is forgotten.
  const other = loadServiceWorker({ clock });
  other.network.on(`${GEV}/relay/pair-request`, () => jsonResponse(202, { pending: true, code: 'K7PM3Q', expiresInSeconds: 120 }));
  await other.dispatch({ type: 'pair' }, OPTIONS_SENDER);
  other.network.on(`${GEV}/relay/pair-status`, () => jsonResponse(401, { paired: false }));
  assert.equal((await other.dispatch({ type: 'heartbeat', state: 'feed', seen: [] }, FEED_SENDER)).sent, false);
  assert.equal(other.pairingStore().size, 0);
});

test('after UNPAIR in POWER UP the relay says not paired, and a feed tab picks up a new approval while the old secret is still stored', async () => {
  const clock = { now: 5_000_000 };
  const sw = await pairedServiceWorker({ clock });
  const oldSecret = sw.secret;
  let accepted = oldSecret; // the secret GEV takes heartbeats from
  const pairStatus = new Map(); // secret -> [status, body]; any other secret gets 401
  sw.network.on(`${GEV}/relay/pair-status`, (call) => jsonResponse(...(pairStatus.get(call.options.headers.Authorization.slice('Bearer '.length)) || [401, { paired: false }])));
  sw.network.on(`${GEV}/relay/heartbeat`, (call) => (call.options.headers.Authorization === `Bearer ${accepted}` ? jsonResponse(200, { missing: ['front'], unknown: [] }) : jsonResponse(401, { error: 'The relay is not paired' })));
  const heartbeat = () => sw.dispatch({ type: 'heartbeat', state: 'feed', seen: ['front'] }, FEED_SENDER);
  const status = () => sw.dispatch({ type: 'status' }, OPTIONS_SENDER);
  const asked = () => sw.network.calls.filter((call) => call.url === `${GEV}/relay/pair-status`).map((call) => call.options.headers.Authorization);

  const first = await heartbeat();
  assert.deepEqual([first.sent, first.paired, (await status()).notPaired], [true, true, false]);
  assert.deepEqual(asked(), [], 'no pairing check while no request waits');

  // UNPAIR in POWER UP: GEV no longer takes the stored secret.
  accepted = '';
  const refused = await heartbeat();
  assert.deepEqual([refused.sent, refused.paired, refused.epoch], [false, true, first.epoch]);
  let shown = await status();
  assert.deepEqual([shown.notPaired, shown.heartbeat.outcome], [true, 'not paired'], 'the options page can say not paired');
  assert.deepEqual(await sw.dispatch({ type: 'pair-status' }, OPTIONS_SENDER), { paired: false, pendingExpired: false, local: 'paired' });
  assert.equal((await status()).notPaired, true);

  // PAIR again while the old secret is still stored.
  sw.network.on(`${GEV}/relay/pair-request`, () => jsonResponse(202, { pending: true, code: 'XYZ789', expiresInSeconds: 120 }));
  assert.equal((await sw.dispatch({ type: 'pair' }, OPTIONS_SENDER)).code, 'XYZ789');
  const newSecret = sw.pairingStore().get('pendingSecret');
  assert.equal(sw.pairingStore().get('secret'), oldSecret);
  pairStatus.set(newSecret, [200, { paired: false, pending: true }]);
  assert.equal((await heartbeat()).sent, false);
  assert.deepEqual(asked(), [`Bearer ${oldSecret}`, `Bearer ${newSecret}`], 'a feed tab asks about the waiting request although an older secret is stored');
  shown = await status();
  assert.deepEqual([shown.notPaired, shown.pending, shown.heartbeat.outcome], [false, true, 'waiting for approval']);

  // Approved in POWER UP; the options page is closed.
  pairStatus.set(newSecret, [200, { paired: true, siteName: 'Home', cameras: ['Front'] }]);
  accepted = newSecret;
  assert.equal((await heartbeat()).sent, false);
  assert.equal(asked().length, 2, 'not asked again within 10 seconds');
  clock.now += 10_000;
  const promoted = await heartbeat();
  assert.deepEqual([promoted.sent, promoted.paired, promoted.missing], [true, true, ['front']]);
  assert.notEqual(promoted.epoch, first.epoch, 'a new epoch makes the feed tab send every picture again');
  assert.deepEqual([sw.pairingStore().get('secret'), sw.pairingStore().has('pendingSecret')], [newSecret, false]);
  assert.deepEqual([sw.network.calls.at(-1).url, sw.network.calls.at(-1).options.headers.Authorization], [`${GEV}/relay/heartbeat`, `Bearer ${newSecret}`]);
  shown = await status();
  assert.deepEqual([shown.paired, shown.pending, shown.notPaired, shown.heartbeat.outcome], [true, false, false, 'sent']);

  // A request that expires while a pairing is stored is forgotten, and only it.
  sw.network.on(`${GEV}/relay/pair-request`, () => jsonResponse(202, { pending: true, code: 'QRS234', expiresInSeconds: 120 }));
  assert.equal((await sw.dispatch({ type: 'pair' }, OPTIONS_SENDER)).ok, true);
  clock.now += 10_000;
  assert.equal((await heartbeat()).sent, true);
  assert.deepEqual([sw.pairingStore().get('secret'), sw.pairingStore().has('pendingSecret')], [newSecret, false]);

  // A picture GEV refuses with no request waiting reads as not paired too, until GEV takes the pairing again.
  sw.network.on(FRONT_NEWEST, () => imageResponse(JPEG));
  sw.network.on(`${GEV}/relay/frame`, () => emptyResponse(401));
  assert.equal((await sw.dispatch({ type: 'frame', camera: 'front', url: FRONT_NEWEST, clip: 'Motion' }, FEED_SENDER)).gevReady, false);
  shown = await status();
  assert.deepEqual([shown.notPaired, shown.recent[0].outcome], [true, 'not paired']);
  assert.equal((await sw.dispatch({ type: 'pair-status' }, OPTIONS_SENDER)).paired, true);
  assert.equal((await status()).notPaired, false, 'recognised again');
});

// ---- content script behaviour with a fake page ----

function loadContentScript({ doc, hash = '#/feed', reply }) {
  const messages = [];
  const timers = new Map();
  const clock = { now: 1_757_800_000_000 };
  const page = { observerCallback: null, disconnected: false };
  let nextTimer = 1;
  const chrome = {
    runtime: {
      id: EXTENSION_ID,
      sendMessage: (message) => {
        const copy = plain(message);
        messages.push(copy);
        return Promise.resolve(reply(copy));
      },
    },
  };
  class MutationObserver {
    constructor(callback) {
      page.observerCallback = callback;
    }

    observe(target, options) {
      assert.equal(target, doc.documentElement);
      assert.deepEqual(plain(options), { childList: true, subtree: true });
    }

    disconnect() {
      page.disconnected = true;
    }
  }
  const location = { hash };
  const context = createRelayContext({
    chrome,
    document: doc,
    location,
    MutationObserver,
    window: { addEventListener() {}, removeEventListener() {} },
    Date: { now: () => clock.now },
    setTimeout: (callback, delay) => {
      const id = nextTimer;
      nextTimer += 1;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  vm.runInContext(readRelayFile('content.js'), context, { filename: 'content.js' });
  return Object.assign(page, {
    messages,
    timers,
    clock,
    location,
    chrome,
    mutate() {
      page.observerCallback([], null);
    },
    fire(delay) {
      const due = [...timers].filter(([, timer]) => timer.delay === delay);
      for (const [id, timer] of due) {
        timers.delete(id);
        timer.callback();
      }
      return due.length;
    },
    take() {
      return messages.splice(0, messages.length);
    },
  });
}

test('the content script heartbeats first, relays each newest picture once and downloads only what GEV will take', async () => {
  const { doc, list } = feedDocument(SAMPLE_FEED);
  const gev = { epoch: 'epoch-1', sent: true, missing: [], unknown: [], frame: { ok: true, done: true } };
  const page = loadContentScript({
    doc,
    reply: (message) => (message.type === 'frame' ? { ...gev.frame, paired: true, epoch: gev.epoch } : { ok: gev.sent, sent: gev.sent, paired: gev.sent, epoch: gev.epoch, missing: gev.missing, unknown: gev.unknown }),
  });
  const beat = (seen = ['front', 'ff'], state = 'feed') => ({ type: 'heartbeat', state, seen });
  const frame = (camera, src, clip) => ({ type: 'frame', camera, url: new URL(src).href, clip });
  const step = async (delay = 1500, mutate = true) => {
    if (mutate) page.mutate();
    const fired = page.fire(delay);
    await settle();
    return fired;
  };
  const tick = (delay = 120000) => step(delay, false);

  await settle();
  assert.deepEqual(page.take(), [], 'nothing is sent before the page settles');
  assert.equal(await step(1500, false), 1);
  assert.deepEqual(page.take(), [beat(), frame('front', FRONT_NEWEST, 'Person · 9/13 · 2:14 PM'), frame('ff', FF_NEWEST, 'Vehicle · 14:02')], 'the heartbeat goes first and pictures follow once GEV takes the relay');
  assert.ok([...page.timers.values()].some((timer) => timer.delay === 120000), 'an accepted relay heartbeats every 2 minutes');

  await step();
  assert.deepEqual(page.take(), [], 'nothing changed, nothing is sent');

  const FRONT_NEWER = s3('z2', '1757800099999');
  list.children.unshift(feedCard({ name: 'front', src: FRONT_NEWER, type: 'Motion', date: '9/13', time: '2:20 PM' }));
  await step();
  assert.deepEqual(page.take(), [frame('front', FRONT_NEWER, 'Motion · 9/13 · 2:20 PM')]);

  page.clock.now += 11 * 60 * 1000;
  assert.equal(await tick(), 1);
  assert.deepEqual(page.take(), [beat()], 'an unchanged picture is never downloaded again on a timer');
  gev.missing = ['front'];
  await tick();
  assert.deepEqual(page.take(), [beat(), frame('front', FRONT_NEWER, 'Motion · 9/13 · 2:20 PM')], 'a picture GEV lost (a restart, say) is sent again');
  gev.missing = [];

  // A camera GEV does not know is not downloaded until GEV knows it.
  gev.unknown = ['ff'];
  const FF_NEWER = s3('z3', '1757800188888');
  list.children.unshift(feedCard({ name: 'ff', src: FF_NEWER, type: 'Motion', date: '9/13', time: '2:30 PM' }));
  await step();
  assert.deepEqual(page.take(), [beat(['ff', 'front'])]);
  gev.unknown = [];
  await tick();
  assert.deepEqual(page.take(), [beat(['ff', 'front']), frame('ff', FF_NEWER, 'Motion · 9/13 · 2:30 PM')]);

  // A refused thumbnail is never requested again, even when GEV asks for that camera.
  gev.frame = { ok: false, done: true, refused: true };
  const FRONT_EXPIRED = s3('z2', '1757800277777');
  list.children.unshift(feedCard({ name: 'front', src: FRONT_EXPIRED, type: 'Motion', date: '9/13', time: '2:40 PM' }));
  await step();
  assert.deepEqual(page.take(), [beat(), frame('front', FRONT_EXPIRED, 'Motion · 9/13 · 2:40 PM')]);
  gev.missing = ['front'];
  await tick();
  assert.deepEqual(page.take(), [beat()]);
  gev.missing = [];

  // Other failures back off: 30 s, then 60 s.
  gev.frame = { ok: false, done: false };
  const FF_FAILING = s3('z3', '1757800366666');
  list.children.unshift(feedCard({ name: 'ff', src: FF_FAILING, type: 'Motion', date: '9/13', time: '2:50 PM' }));
  await step();
  assert.deepEqual(page.take(), [beat(['ff', 'front']), frame('ff', FF_FAILING, 'Motion · 9/13 · 2:50 PM')]);
  await step();
  assert.deepEqual(page.take(), [], 'a failed picture is not retried at once');
  page.clock.now += 30 * 1000;
  assert.equal(await step(30000, false), 1);
  assert.deepEqual(page.take(), [frame('ff', FF_FAILING, 'Motion · 9/13 · 2:50 PM')]);
  page.clock.now += 30 * 1000;
  await step();
  assert.deepEqual(page.take(), [], 'the second retry waits twice as long');
  page.clock.now += 30 * 1000;
  assert.equal(await step(60000, false), 1);
  assert.deepEqual(page.take(), [frame('ff', FF_FAILING, 'Motion · 9/13 · 2:50 PM')]);

  // While GEV does not take the relay, only heartbeats go out, every 15 seconds.
  gev.frame = { ok: true, done: true };
  gev.sent = false;
  page.clock.now += 3 * 60 * 1000;
  await tick();
  assert.deepEqual(page.take(), [beat(['ff', 'front'])], 'no thumbnail while GEV does not take the relay');
  assert.ok([...page.timers.values()].some((timer) => timer.delay === 15000));
  gev.sent = true;
  assert.equal(await tick(15000), 1);
  assert.deepEqual(page.take(), [beat(['ff', 'front']), frame('ff', FF_FAILING, 'Motion · 9/13 · 2:50 PM')], 'the failed picture goes as soon as GEV is back; the refused one does not');

  // A new pairing gets every current picture again.
  gev.epoch = 'epoch-2';
  await tick();
  assert.deepEqual(page.take(), [beat(['ff', 'front']), frame('ff', FF_FAILING, 'Motion · 9/13 · 2:50 PM'), frame('front', FRONT_EXPIRED, 'Motion · 9/13 · 2:40 PM')]);
  await step(1500, false);
  assert.deepEqual(page.take(), [beat(['ff', 'front'])]);

  // Another Arlo page in the tab says nothing; the sign-in page says signed out.
  list.children.length = 0;
  page.location.hash = '#/devices';
  page.clock.now += 3 * 60 * 1000;
  await tick();
  assert.deepEqual(page.take(), []);
  page.location.hash = '#/login';
  await step();
  assert.deepEqual(page.take(), [beat([], 'signed-out')]);

  page.location.hash = '#/feed';
  page.chrome.runtime.id = undefined;
  await step();
  assert.deepEqual(page.take(), []);
  assert.equal(page.disconnected, true);
  assert.equal(page.timers.size, 0, 'an invalidated extension stops observing and clears its timers');
});

test('a feed page still drawing is not reported as an unknown layout', async () => {
  const spinner = h('#document', {}, h('html', {}, h('body', {}, h('div', { className: 'loading-spinner' }))));
  spinner.documentElement = spinner.children[0];
  const page = loadContentScript({ doc: spinner, reply: () => ({ ok: true, sent: true, paired: true, epoch: 'e', missing: [], unknown: [] }) });
  page.fire(1500);
  await settle();
  assert.deepEqual(page.take(), []);
  page.clock.now += 20000;
  assert.equal(page.fire(20000), 1);
  await settle();
  assert.deepEqual(page.take(), [{ type: 'heartbeat', state: 'layout-unknown', seen: [] }]);
});

// ---- install script and package.json ----

test('the installer copies only the files the manifest names plus the options page and readme', () => {
  const manifest = JSON.parse(readRelayFile('manifest.json'));
  const files = relayInstallFiles(manifest);
  assert.deepEqual(files, ['README.md', 'content.js', 'manifest.json', 'options.css', 'options.html', 'options.js', 'relay-logic.js', 'service-worker.js']);
  assert.deepEqual(extensionFiles().sort(), [...files].sort(), 'the extension folder holds exactly the installed files');
  for (const name of ['../evil.js', 'sub/dir.js', '.hidden.js', 'C:\\evil.js', 'evil..js', '']) {
    assert.throws(() => relayInstallFiles({ ...manifest, background: { service_worker: name, type: 'module' } }), /Refusing/, name);
  }
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['arlo-relay:install'], 'node scripts/install-arlo-relay.mjs');
});

test('the install folder is fixed per user and platform', () => {
  assert.equal(relayInstallDestination({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, homedir: 'C:\\Users\\me' }), 'C:\\Users\\me\\AppData\\Local\\GEV\\arlo-feed-relay');
  assert.equal(relayInstallDestination({ platform: 'win32', env: {}, homedir: 'C:\\Users\\me' }), 'C:\\Users\\me\\AppData\\Local\\GEV\\arlo-feed-relay');
  assert.equal(relayInstallDestination({ platform: 'linux', env: { XDG_DATA_HOME: '/xdg/data' }, homedir: '/home/me' }), '/xdg/data/gev/arlo-feed-relay');
  assert.equal(relayInstallDestination({ platform: 'linux', env: { XDG_DATA_HOME: 'relative' }, homedir: '/home/me' }), '/home/me/.local/share/gev/arlo-feed-relay');
  assert.equal(relayInstallDestination({ platform: 'darwin', env: {}, homedir: '/Users/me' }), '/Users/me/.local/share/gev/arlo-feed-relay');
});

test('installArloRelay copies the extension, updates in place and refuses symbolic links', (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'gev-arlo-relay-test-'));
  try {
    const source = path.join(temp, 'source');
    mkdirSync(source);
    for (const name of extensionFiles()) writeFileSync(path.join(source, name), readRelayFile(name));
    writeFileSync(path.join(source, 'extra-notes.txt'), 'not part of the extension');
    const destination = path.join(temp, 'LocalAppData', 'GEV', 'arlo-feed-relay');
    const result = installArloRelay({ sourceDir: source, destination });
    assert.equal(result.destination, destination);
    assert.deepEqual(readdirSync(destination).sort(), [...result.files].sort());
    for (const name of result.files) assert.equal(readFileSync(path.join(destination, name), 'utf8'), readRelayFile(name), name);
    writeFileSync(path.join(source, 'options.css'), 'body { color: red; }');
    installArloRelay({ sourceDir: source, destination });
    assert.equal(readFileSync(path.join(destination, 'options.css'), 'utf8'), 'body { color: red; }');

    rmSync(path.join(source, 'content.js'));
    assert.throws(() => installArloRelay({ sourceDir: source, destination: path.join(temp, 'other') }), /missing: content\.js/);
    writeFileSync(path.join(source, 'content.js'), readRelayFile('content.js'));

    const target = path.join(temp, 'elsewhere');
    mkdirSync(target);
    const link = path.join(temp, 'linked');
    try {
      symlinkSync(target, link, 'junction');
    } catch (error) {
      t.diagnostic(`symbolic link checks skipped: ${error.code}`);
      return;
    }
    assert.throws(() => installArloRelay({ sourceDir: source, destination: link }), /symbolic link/);
    assert.throws(() => installArloRelay({ sourceDir: source, destination: path.join(link, 'arlo-feed-relay') }), /symbolic link/);
    assert.throws(() => installArloRelay({ sourceDir: link, destination: path.join(temp, 'third') }), /symbolic link/);
    assert.deepEqual(readdirSync(target), [], 'nothing was written through the link');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('installArloRelay clears the Windows folder settings that stop Chrome loading the extension', async () => {
  const { chmodSync } = await import('node:fs');
  const temp = mkdtempSync(path.join(os.tmpdir(), 'gev-arlo-relay-test-'));
  try {
    const source = path.join(temp, 'source');
    mkdirSync(source);
    for (const name of extensionFiles()) writeFileSync(path.join(source, name), readRelayFile(name));
    const destination = path.join(temp, 'GEV', 'arlo-feed-relay');
    installArloRelay({ sourceDir: source, destination, platform: 'linux' });

    // What Explorer and a folder's Properties leave behind: settings files, and read-only copies.
    writeFileSync(path.join(destination, 'desktop.ini'), '[ViewState]\r\nFolderType=Generic\r\n');
    writeFileSync(path.join(destination, 'Thumbs.db'), 'thumbnail cache');
    writeFileSync(path.join(destination, 'notes.txt'), 'left by hand');
    chmodSync(path.join(destination, 'content.js'), 0o444);

    const attribCalls = [];
    const result = installArloRelay({ sourceDir: source, destination, platform: 'win32', run: (command, args) => attribCalls.push([command, ...args]) });
    assert.deepEqual(result.removedMetadata.map((name) => name.toLowerCase()).sort(), ['desktop.ini', 'thumbs.db']);
    assert.equal(readdirSync(destination).some((name) => /^(desktop\.ini|thumbs\.db)$/i.test(name)), false, 'Chrome refuses a folder holding either file');
    assert.deepEqual(result.extras, ['notes.txt'], 'other stray files are reported, not deleted');
    assert.equal(readFileSync(path.join(destination, 'content.js'), 'utf8'), readRelayFile('content.js'), 'a read-only copy is replaced');
    assert.deepEqual(attribCalls, [
      ['attrib', '-R', '-S', '-H', destination],
      ['attrib', '-R', '-S', '-H', path.join(destination, '*')],
    ]);

    const elsewhere = installArloRelay({ sourceDir: source, destination: path.join(temp, 'posix'), platform: 'linux', run: () => assert.fail('attrib runs on Windows only') });
    assert.deepEqual([elsewhere.removedMetadata, elsewhere.extras], [[], []]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
