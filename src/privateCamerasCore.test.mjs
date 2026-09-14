import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRIVATE_CAMERA_KINDS,
  applyPrivateCameraUpdate,
  applyRelayPairing,
  clearRelayPairing,
  credentialDestinations,
  credentialTransport,
  emptyPrivateCameraConfig,
  isArloCloudUrl,
  isPrivateNetworkHost,
  maskPrivateCameraSource,
  normalizeFingerprint,
  normalizePrivateCameraConfig,
  normalizeRelayCameraName,
  privateCameraSources,
  privateCameraStatus,
  privateFrameTarget,
  privateSiteTransport,
  relayMatchName,
  siteUsesArloWebsite,
} from './privateCamerasCore.mjs';
import { collectPrivateSiteUpdate } from './privateCamerasSetup.js';

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.super-secret-token';
const PASSWORD = 'p@ss w0rd #$"\'`\\';
const PIN = 'ab'.repeat(32);

function withHome() {
  const result = applyPrivateCameraUpdate({
    kind: 'home',
    name: 'Home',
    bridgeUrl: 'https://homeassistant.local:8123/',
    auth: 'token',
    token: TOKEN,
    tlsFingerprint: PIN,
    cameras: [
      { name: 'Front', source: 'camera.aarlo_front', lat: 45.27, lon: -66.06, headingDeg: 90 },
      { name: 'Ff', source: 'camera.aarlo_ff' },
      { name: 'Back', source: 'camera.aarlo_back', lat: 45.2701, lon: -66.0601 },
    ],
  });
  assert.equal(result.ok, true, result.error);
  return result;
}

test('a home site saves a bridge, token, pin and any number of cameras', () => {
  const { config, siteId } = withHome();
  assert.equal(siteId, 'home');
  const [site] = config.sites;
  assert.equal(site.bridgeUrl, 'https://homeassistant.local:8123', 'trailing slash trimmed');
  assert.equal(site.tlsFingerprint, normalizeFingerprint(PIN));
  assert.deepEqual(site.cameras.map((camera) => camera.id), ['front', 'ff', 'back']);
  const many = applyPrivateCameraUpdate({
    kind: 'business',
    name: 'Warehouse',
    cameras: Array.from({ length: 250 }, (_, i) => ({ name: `Cam ${i}`, source: `http://10.0.0.${(i % 250) + 1}/snap.jpg`, lat: 45, lon: -66 })),
  }, config);
  assert.equal(many.ok, true, many.error);
  assert.equal(many.config.sites[1].cameras.length, 250, 'no camera limit');
});

test('several sites of the same kind get distinct ids and distinct public camera ids', () => {
  let { config } = withHome();
  const second = applyPrivateCameraUpdate({
    kind: 'home',
    name: 'Home',
    bridgeUrl: 'https://cottage-ha.local',
    token: 'another-token',
    cameras: [{ name: 'Front', source: 'camera.aarlo_front', lat: 46, lon: -65 }],
  }, config);
  assert.equal(second.ok, true, second.error);
  assert.equal(second.siteId, 'home-2');
  config = second.config;
  const ids = privateCameraSources(config).map((source) => source.id);
  assert.deepEqual(ids, ['private-home--front', 'private-home--back', 'private-home-2--front']);
  assert.equal(privateFrameTarget(config, 'private-home-2--front').auth.token, 'another-token');
  const removed = applyPrivateCameraUpdate({ removeSiteId: 'home-2' }, config);
  assert.equal(removed.config.sites.length, 1);
});

test('version 1 stores migrate to the site list', () => {
  const config = normalizePrivateCameraConfig({
    version: 1,
    sites: { home: { auth: 'token', token: 't', bridgeUrl: 'http://ha.local:8123', cameras: [{ id: 'front', name: 'Front', source: 'camera.aarlo_front' }] } },
  });
  assert.equal(config.version, 2);
  assert.deepEqual(config.sites.map((site) => [site.id, site.kind, site.name]), [['home', 'home', 'Home']]);
});

test('status reports presence and transport, never secrets, and masks sources', () => {
  const business = applyPrivateCameraUpdate({
    kind: 'business',
    name: 'Shop',
    username: 'admin',
    password: PASSWORD,
    cameras: [{ name: 'Loading dock', source: 'https://nvr.example.com/ISAPI/Streaming/channels/101/picture?auth=abcdef', lat: 45, lon: -66 }],
  }, withHome().config);
  assert.equal(business.ok, true, business.error);
  const status = privateCameraStatus(business.config);
  const text = JSON.stringify(status);
  for (const secret of [TOKEN, PASSWORD, 'abcdef', 'admin']) assert.equal(text.includes(secret), false, secret);
  const [home, shop] = status.kinds;
  assert.equal(home.sites[0].tokenSet, true);
  assert.equal(home.sites[0].transport, 'pinned');
  assert.equal(shop.sites[0].passwordSet, true);
  assert.equal(shop.sites[0].transport, 'https');
  assert.equal(shop.sites[0].cameras[0].source, 'https://nvr.example.com/ISAPI/Streaming/channels/101/picture?•••');
  assert.equal(home.sites[0].cameras[1].placed, false);
});

test('a login is never allowed over plain http beyond the local network', () => {
  const lan = applyPrivateCameraUpdate({ kind: 'business', name: 'Office', username: 'u', password: 'p', cameras: [{ name: 'A', source: 'http://192.168.1.64/snap.jpg' }] });
  assert.equal(lan.ok, true, lan.error);
  assert.equal(privateCameraStatus(lan.config).kinds[1].sites[0].transport, 'lan-http');
  const internet = applyPrivateCameraUpdate({ kind: 'business', name: 'Office', username: 'u', password: 'p', cameras: [{ name: 'A', source: 'http://cams.example.com/snap.jpg' }] });
  assert.equal(internet.ok, false);
  assert.match(internet.error, /plain http to cams\.example\.com.*use https/);
  const bridge = applyPrivateCameraUpdate({ kind: 'home', name: 'Home', bridgeUrl: 'http://my-ha.duckdns.org:8123', token: 't', cameras: [{ name: 'Front', source: 'camera.aarlo_front' }] });
  assert.equal(bridge.ok, false);
  assert.match(bridge.error, /Bridge URL/);
  const anonymous = applyPrivateCameraUpdate({ kind: 'business', name: 'Public', cameras: [{ name: 'A', source: 'http://cams.example.com/snap.jpg' }] });
  assert.equal(anonymous.ok, true, 'no login, nothing to protect in transit');
});

test('private network detection', () => {
  for (const host of ['localhost', '127.0.0.1', '10.1.2.3', '172.20.0.5', '192.168.0.10', '169.254.1.1', '100.101.102.103', 'nvr.local', 'ha.home.arpa', 'cam.lan', 'nvr', '::1', '[fd12::1]', 'fe80::1']) {
    assert.equal(isPrivateNetworkHost(host), true, host);
  }
  for (const host of ['8.8.8.8', '172.32.0.1', 'example.com', 'my-ha.duckdns.org', '2001:db8::1', '']) {
    assert.equal(isPrivateNetworkHost(host), false, host);
  }
  assert.equal(credentialTransport('https://example.com/x'), 'https');
  assert.equal(credentialTransport('ftp://10.0.0.1/x'), 'invalid');
});

test('omitted secrets and sources are kept, null clears a secret', () => {
  const { config } = withHome();
  const kept = applyPrivateCameraUpdate({ kind: 'home', siteId: 'home', cameras: [{ id: 'front', name: 'Front door', lat: 45.1, lon: -66.1 }] }, config);
  assert.equal(kept.ok, true, kept.error);
  assert.equal(kept.config.sites[0].token, TOKEN);
  assert.equal(kept.config.sites[0].cameras[0].source, 'camera.aarlo_front');
  assert.equal(kept.config.sites[0].cameras[0].id, 'front', 'a renamed camera keeps its id');
  const cleared = applyPrivateCameraUpdate({ kind: 'home', siteId: 'home', token: null }, config);
  assert.equal(cleared.config.sites[0].token, '');
});

test('bad input is refused with a reason', () => {
  const refuse = (body, pattern) => {
    const result = applyPrivateCameraUpdate(body, emptyPrivateCameraConfig());
    assert.equal(result.ok, false);
    assert.match(result.error, pattern);
  };
  refuse({ kind: 'office' }, /Unknown camera type/);
  refuse({ kind: 'home', siteId: 'nope' }, /Unknown site/);
  refuse({ kind: 'home', postalCode: 'not a code!' }, /Postal or ZIP code/);
  refuse({ kind: 'business', cameras: [{ name: 'A', source: 'http://admin:pw@10.0.0.2/snap.jpg' }] }, /must not contain a login/);
  refuse({ kind: 'business', cameras: [{ name: 'A', source: 'ftp://10.0.0.2/snap.jpg' }] }, /http/);
  refuse({ kind: 'business', cameras: [{ name: 'A', source: 'http://10.0.0.2/s.jpg', lat: 45 }] }, /both latitude and longitude/);
  refuse({ kind: 'business', cameras: [{ name: 'A', source: 'http://10.0.0.2/s.jpg', lat: 95, lon: 0 }] }, /outside the map/);
  refuse({ kind: 'business', cameras: [{ name: '', source: 'http://10.0.0.2/s.jpg' }] }, /needs a name/);
  refuse({ kind: 'business', tlsFingerprint: 'not-a-pin' }, /SHA-256/);
  refuse({ kind: 'home', auth: 'cookie' }, /token or login/);
  refuse({ removeSiteId: 'ghost' }, /Unknown site/);
});

test('frame targets carry the right login and pin; malformed ids resolve to nothing', () => {
  const shop = applyPrivateCameraUpdate({
    kind: 'business',
    name: 'Shop',
    username: 'admin',
    password: 'pw',
    cameras: [{ name: 'Dock', source: 'http://10.0.0.2/snap.jpg', lat: 1, lon: 2 }],
  }, withHome().config).config;
  assert.deepEqual(privateFrameTarget(shop, 'private-home--front'), {
    url: 'https://homeassistant.local:8123/api/camera_proxy/camera.aarlo_front',
    auth: { type: 'bearer', token: TOKEN },
    name: 'Front',
    tlsFingerprint: normalizeFingerprint(PIN),
  });
  assert.deepEqual(privateFrameTarget(shop, 'private-shop--dock').auth, { type: 'basic', username: 'admin', password: 'pw' });
  for (const bad of ['private-shop--nope', 'private-shop-dock', '../etc/passwd', 'private---dock', '']) {
    assert.equal(privateFrameTarget(shop, bad), null, bad);
  }
});

test('a facing is a compass direction: any number wraps onto 0–359 instead of blocking the save', () => {
  const result = applyPrivateCameraUpdate({
    kind: 'business',
    name: 'Yard',
    cameras: [
      { name: 'West', source: 'http://10.0.0.2/a.jpg', lat: 45, lon: -66, headingDeg: -90 },
      { name: 'Over', source: 'http://10.0.0.2/b.jpg', lat: 45, lon: -66, headingDeg: 400 },
      { name: 'North', source: 'http://10.0.0.2/c.jpg', lat: 45, lon: -66, headingDeg: 360 },
      { name: 'Longitude typed as facing', source: 'http://10.0.0.2/d.jpg', lat: 45, lon: -66, headingDeg: '-66.0633' },
      { name: 'Blank', source: 'http://10.0.0.2/e.jpg', lat: 45, lon: -66, headingDeg: '' },
    ],
  });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.config.sites[0].cameras.map((camera) => camera.headingDeg), [270, 40, 0, 293.9, null]);
});

test('facing accepts compass points and numbers, reports the nearest point, and draws like a security camera', async () => {
  const { headingFromFacing, compassPointFor } = await import('./privateCamerasCore.mjs');
  assert.equal(headingFromFacing('N'), 0);
  assert.equal(headingFromFacing('nne'), 22.5);
  assert.equal(headingFromFacing('SW'), 225);
  assert.equal(headingFromFacing(' NW '), 315);
  assert.equal(headingFromFacing(-90), 270);
  assert.equal(headingFromFacing(''), null);
  assert.equal(headingFromFacing(null), null);
  assert.equal(headingFromFacing('up'), undefined);
  assert.equal(compassPointFor(0), 'N');
  assert.equal(compassPointFor(300), 'WNW');
  assert.equal(compassPointFor(350), 'N');
  assert.equal(compassPointFor(null), '');
  const saved = applyPrivateCameraUpdate({ kind: 'business', name: 'Lot', cameras: [{ name: 'Gate', source: 'http://10.0.0.9/s.jpg', lat: 45, lon: -66, headingDeg: 'SE' }] });
  assert.equal(saved.ok, true, saved.error);
  assert.equal(saved.config.sites[0].cameras[0].headingDeg, 135);
  assert.equal(privateCameraStatus(saved.config).kinds[1].sites[0].cameras[0].facing, 'SE');
  const [source] = privateCameraSources(saved.config);
  assert.deepEqual([source.headingDeg, source.fovDeg, source.pitchDeg, source.rangeM, source.mountHeightM], [135, 110, -20, 25, 3]);
  const refused = applyPrivateCameraUpdate({ kind: 'business', name: 'Lot', cameras: [{ name: 'Gate', source: 'http://10.0.0.9/s.jpg', headingDeg: 'up' }] });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /compass point/);
});

test('masking keeps entities, hides long path segments and queries', () => {
  assert.equal(maskPrivateCameraSource('camera.aarlo_front'), 'camera.aarlo_front');
  assert.equal(
    maskPrivateCameraSource('https://scrypted.local/endpoint/@scrypted/webhook/public/12/abcdefabcdefabcdefabcdef1234/takePicture'),
    'https://scrypted.local/endpoint/@scrypted/webhook/public/12/•••/takePicture',
  );
  assert.equal(maskPrivateCameraSource('not a url'), '');
});

test('the panel omits empty secrets, sends the located postal code and gives cameras only a facing', () => {
  const body = collectPrivateSiteUpdate('home', 'home', { name: 'Home', postalCode: 'E2L 4S6', lat: '45.2733', lon: '-66.0633', locationLabel: 'Saint John', bridgeUrl: 'https://ha:8123', auth: 'token', token: '', username: '', password: '', tlsFingerprint: '' }, [
    { id: 'front', name: 'Front', source: '', headingDeg: 'N' },
  ]);
  assert.deepEqual(body, {
    kind: 'home',
    name: 'Home',
    siteId: 'home',
    tlsFingerprint: '',
    bridgeUrl: 'https://ha:8123',
    auth: 'token',
    postalCode: 'E2L 4S6',
    address: '',
    lat: 45.2733,
    lon: -66.0633,
    locationLabel: 'Saint John',
    cameras: [{ id: 'front', name: 'Front', headingDeg: 'N' }],
  });
});

test('a site is placed by postal code and its cameras are spread apart by facing', async () => {
  const { normalizePostalCode, postalCountry, privateCameraPositions } = await import('./privateCamerasCore.mjs');
  assert.equal(normalizePostalCode('e2l4s6'), 'E2L 4S6');
  assert.equal(normalizePostalCode(' 90210-1234 '), '90210-1234');
  assert.equal(normalizePostalCode(''), '');
  assert.equal(normalizePostalCode('hello world!'), null);
  assert.deepEqual([postalCountry('E2L 4S6'), postalCountry('90210'), postalCountry('SW1A 1AA')], ['ca', 'us', '']);

  const saved = applyPrivateCameraUpdate({
    kind: 'home',
    name: 'Home',
    postalCode: 'e2l 4s6',
    lat: 45.2733,
    lon: -66.0633,
    locationLabel: 'Saint John, NB',
    cameras: [
      { name: 'Front', source: 'camera.aarlo_front', headingDeg: 'S' },
      { name: 'Ff', source: 'camera.aarlo_ff', headingDeg: 'S' },
      { name: 'Back Yard', source: 'camera.aarlo_back_yard', headingDeg: 'N' },
    ],
  });
  assert.equal(saved.ok, true, saved.error);
  assert.equal(saved.config.sites[0].postalCode, 'E2L 4S6');
  const sources = privateCameraSources(saved.config);
  assert.equal(sources.length, 3, 'saved and on the map before any bridge is connected');
  const metres = (a, b) => Math.hypot((b.lat - a.lat) * 111320, (b.lon - a.lon) * 111320 * Math.cos((a.lat * Math.PI) / 180));
  for (let i = 0; i < sources.length; i += 1) {
    for (let j = i + 1; j < sources.length; j += 1) assert.ok(metres(sources[i], sources[j]) >= 8, `${sources[i].name} and ${sources[j].name} do not overlap`);
    assert.ok(metres(sources[i], { lat: 45.2733, lon: -66.0633 }) < 60, 'every camera stays at the site');
  }
  const back = sources.find((source) => source.name === 'Back Yard');
  const front = sources.find((source) => source.name === 'Front');
  assert.ok(back.lat > 45.2733 && front.lat < 45.2733, 'each camera sits on the side it faces');
  assert.equal(privateCameraPositions(saved.config.sites[0]).size, 3);
  assert.equal(privateFrameTarget(saved.config, 'private-home--front'), null, 'no bridge yet: the frame route shows a placeholder');

  const moved = applyPrivateCameraUpdate({ kind: 'home', siteId: 'home', postalCode: 'E2K 1A1' }, saved.config);
  assert.equal(moved.config.sites[0].lat, null, 'a new code clears the old position until it is located');
  assert.equal(privateCameraStatus(moved.config).kinds[0].sites[0].cameras[0].placed, false);
});

test("a site pointed at the Arlo website is flagged, since that page is never a camera picture", () => {
  assert.equal(isArloCloudUrl('https://my.arlo.com/#/feed'), true);
  assert.equal(isArloCloudUrl('https://ARLO.com/'), true);
  assert.equal(isArloCloudUrl('https://myapi.arlo.netgear.com/x'), true);
  assert.equal(isArloCloudUrl('https://homeassistant.local:8123'), false);
  assert.equal(isArloCloudUrl('https://notarlo.com.example.net/'), false);
  assert.equal(isArloCloudUrl('camera.aarlo_front'), false);
  const config = normalizePrivateCameraConfig({
    version: 2,
    sites: [
      { kind: 'home', id: 'home', name: 'Home', auth: 'login', bridgeUrl: 'https://my.arlo.com', cameras: [{ id: 'front', name: 'Front', source: 'https://my.arlo.com/#/feed' }] },
      { kind: 'business', id: 'shop', name: 'Shop', cameras: [{ id: 'door', name: 'Door', source: 'https://192.168.1.64/ISAPI/Streaming/channels/101/picture' }] },
    ],
  });
  const status = privateCameraStatus(config);
  const home = status.kinds.find((kind) => kind.id === 'home').sites[0];
  const shop = status.kinds.find((kind) => kind.id === 'business').sites[0];
  assert.equal(home.arloWebsite, true);
  assert.equal(home.cameras[0].arloWebsite, true);
  assert.equal(shop.arloWebsite, false);
  assert.equal(shop.cameras[0].arloWebsite, false);
});

const RELAY_EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
const RELAY_SECRET_HASH = `${'c0ffee'.repeat(10)}c0ff`;
const ARLO_FEED = 'https://my.arlo.com/#/feed';

function withLoginHome() {
  const result = applyPrivateCameraUpdate({
    kind: 'home',
    name: 'Home',
    auth: 'login',
    bridgeUrl: 'https://homeassistant.local:8123',
    token: TOKEN,
    username: 'owner@example.com',
    password: PASSWORD,
    tlsFingerprint: PIN,
    cameras: [
      { name: 'Front', source: ARLO_FEED, lat: 45.27, lon: -66.06 },
      { name: 'Ff', source: ARLO_FEED },
      { name: 'Back Yard', source: ARLO_FEED },
    ],
  });
  assert.equal(result.ok, true, result.error);
  return result.config;
}

test('the browser feed relay is a third home sign-in mode that keeps saved logins and sends them nowhere', () => {
  assert.deepEqual([...PRIVATE_CAMERA_KINDS[0].authModes], ['token', 'login', 'relay']);
  assert.match(PRIVATE_CAMERA_KINDS[0].unlocks, /relay/i);
  assert.deepEqual([...PRIVATE_CAMERA_KINDS[1].authModes], ['login']);

  const before = withLoginHome();
  // What the POWER UP panel sends in relay mode: no login keys at all, blank sources.
  const relay = applyPrivateCameraUpdate({
    kind: 'home',
    siteId: 'home',
    name: 'Home',
    auth: 'relay',
    relayExtensionId: RELAY_EXTENSION_ID,
    relaySecretHash: RELAY_SECRET_HASH,
    cameras: [{ id: 'front', name: 'Front' }, { id: 'ff', name: 'Ff', source: '' }, { id: 'back-yard', name: 'Back Yard' }],
  }, before);
  assert.equal(relay.ok, true, relay.error);
  const [site] = relay.config.sites;
  assert.equal(site.auth, 'relay');
  assert.deepEqual(
    [site.token, site.username, site.password, site.bridgeUrl, site.tlsFingerprint],
    [TOKEN, 'owner@example.com', PASSWORD, 'https://homeassistant.local:8123', normalizeFingerprint(PIN)],
    'saved logins are kept, never blanked',
  );
  assert.deepEqual([site.relayExtensionId, site.relaySecretHash], ['', ''], 'a pairing never comes from a request body');
  assert.deepEqual(site.cameras.map((camera) => camera.source), [ARLO_FEED, ARLO_FEED, ARLO_FEED], 'older my.arlo.com sources are left alone');
  assert.deepEqual(credentialDestinations(site), []);
  assert.equal(privateSiteTransport(site), 'relay');
  assert.equal(siteUsesArloWebsite(site), false);

  const status = privateCameraStatus(relay.config);
  const [home] = status.kinds[0].sites;
  assert.equal(home.transport, 'relay');
  assert.equal(home.arloWebsite, false);
  assert.deepEqual(home.relay, { paired: false, extensionId: '' });
  assert.deepEqual(home.cameras.map((camera) => [camera.matchName, camera.arloWebsite]), [['front', false], ['ff', false], ['back yard', false]]);

  const target = privateFrameTarget(relay.config, 'private-home--back-yard');
  assert.deepEqual(target, { relay: true, siteId: 'home', cameraId: 'back-yard', matchName: 'back yard', name: 'Back Yard' });
  assert.equal('url' in target, false, 'nothing is ever fetched for a relay camera');
  assert.equal(normalizePrivateCameraConfig(relay.config).sites[0].auth, 'relay', 'the relay mode survives a reload');
});

test('relay camera names compare the way the Arlo feed writes them', () => {
  assert.equal(normalizeRelayCameraName('  Back \t  Yard '), 'back yard');
  assert.equal(normalizeRelayCameraName('ＦＲＯＮＴ'), 'front', 'full-width letters fold to plain ones');
  assert.equal(normalizeRelayCameraName(42), '');
  assert.equal(normalizeRelayCameraName(null), '');
  assert.equal(relayMatchName({ name: 'Front', source: '' }), 'front');
  assert.equal(relayMatchName({ name: 'Porch', source: ' Front  Door ' }), 'front door');
  assert.equal(relayMatchName({ name: 'Ff', source: ARLO_FEED }), 'ff', 'an address is never a name');
  assert.equal(relayMatchName({ name: 'Ff', source: '   ' }), 'ff');
  assert.equal(relayMatchName({ name: 'Ff' }), 'ff');
});

test('a relay camera needs no source; an Arlo name override is plain text and each name reaches one camera', () => {
  const saved = applyPrivateCameraUpdate({ kind: 'home', name: 'Cottage', auth: 'relay', cameras: [{ name: 'Front door', source: '  Front  ' }, { name: 'Garage' }] });
  assert.equal(saved.ok, true, saved.error);
  assert.deepEqual(saved.config.sites[0].cameras.map((camera) => [camera.source, relayMatchName(camera)]), [['Front', 'front'], ['', 'garage']]);

  const refuse = (body, previous, expected) => {
    const result = applyPrivateCameraUpdate(body, previous);
    assert.equal(result.ok, false, JSON.stringify(body));
    if (expected instanceof RegExp) assert.match(result.error, expected);
    else assert.equal(result.error, expected);
  };
  refuse({ kind: 'home', name: 'Cottage', auth: 'relay', cameras: [{ name: 'Front door', source: ARLO_FEED }] }, undefined, 'Camera 1 (Front door) Arlo name must be the camera name shown in the Arlo feed, not an address');
  refuse({ kind: 'home', name: 'Cottage', auth: 'relay', cameras: [{ name: 'Garage' }, { name: 'Dock', source: 'http://10.0.0.2/snap.jpg' }] }, undefined, /Camera 2 \(Dock\) Arlo name must be the camera name shown in the Arlo feed, not an address/);
  refuse({ kind: 'home', name: 'Cottage', auth: 'relay', cameras: [{ name: 'Front', source: 'x'.repeat(61) }] }, undefined, /Arlo name is not valid/);
  refuse({ kind: 'home', name: 'Cottage', auth: 'relay', cameras: [{ name: 'Front', source: 'front\u0007' }] }, undefined, /Arlo name is not valid/);
  refuse({ kind: 'home', name: 'Cottage', auth: 'relay', cameras: [{ name: 'Front' }, { name: 'Porch', source: 'FRONT' }] }, undefined, 'Two cameras would both match the Arlo camera “front”');
  refuse({ kind: 'home', name: 'Cottage', auth: 'relay', cameras: [{ name: 'Back  Yard' }, { name: 'back yard' }] }, undefined, 'Two cameras would both match the Arlo camera “back yard”');
  refuse({ kind: 'home', name: 'Home', auth: 'token', cameras: [{ name: 'Front' }] }, undefined, /needs a camera entity or snapshot URL/);
  refuse({ kind: 'home', name: 'Cottage', auth: 'relay', cameras: [{ name: 'Front', source: 'camera.aarlo_front' }] }, undefined, 'Camera 1 (Front) Arlo name must be the camera name shown in the Arlo feed, not a Home Assistant entity');
  // Switching a bridge site to the relay with its sources left blank keeps every saved
  // snapshot address and entity for switching back, and matches each camera by its name.
  const bridge = applyPrivateCameraUpdate({ kind: 'home', name: 'Home', bridgeUrl: 'https://homeassistant.local:8123', cameras: [{ name: 'Front', source: 'https://homeassistant.local:8123/snap.jpg' }, { name: 'Ff', source: 'camera.aarlo_ff' }] });
  assert.equal(bridge.ok, true, bridge.error);
  const switched = applyPrivateCameraUpdate({ kind: 'home', siteId: 'home', auth: 'relay', cameras: [{ id: 'front', name: 'Front' }, { id: 'ff', name: 'Ff', source: '' }] }, bridge.config);
  assert.equal(switched.ok, true, switched.error);
  assert.deepEqual(switched.config.sites[0].cameras.map((camera) => [camera.source, relayMatchName(camera)]), [['https://homeassistant.local:8123/snap.jpg', 'front'], ['camera.aarlo_ff', 'ff']]);
  assert.deepEqual(privateCameraStatus(switched.config).kinds[0].sites[0].cameras.map((camera) => camera.matchName), ['front', 'ff']);
  assert.equal(applyPrivateCameraUpdate({ kind: 'home', siteId: 'home', auth: 'relay', cameras: [{ name: 'Porch', source: 'https://homeassistant.local:8123/snap.jpg' }] }, bridge.config).ok, false, 'a new row cannot bring an address along');
  const renamed = applyPrivateCameraUpdate({ kind: 'home', siteId: 'home', auth: 'relay', cameras: [{ id: 'front', name: 'Front', source: 'Front porch' }] }, bridge.config);
  assert.equal(renamed.ok, true, renamed.error);
  assert.equal(relayMatchName(renamed.config.sites[0].cameras[0]), 'front porch');
  // Typing the camera's own name as its Arlo name clears the override.
  const sameName = applyPrivateCameraUpdate({ kind: 'home', siteId: 'home', cameras: [{ id: 'front', name: 'Front', source: ' FRONT ' }] }, renamed.config);
  assert.equal(sameName.ok, true, sameName.error);
  assert.equal(sameName.config.sites[0].cameras[0].source, '');
  // The CCTV panel names where a relay camera's pictures come from.
  assert.deepEqual(privateCameraSources(sameName.config).map((source) => source.provider), []);
  const placed = applyPrivateCameraUpdate({ kind: 'home', siteId: 'home', lat: 45.27, lon: -66.06 }, sameName.config);
  assert.deepEqual(privateCameraSources(placed.config).map((source) => source.provider), ['Arlo browser feed relay (clip pictures)']);
  const placedBridge = applyPrivateCameraUpdate({ kind: 'home', siteId: 'home', lat: 45.27, lon: -66.06 }, bridge.config);
  assert.deepEqual(privateCameraSources(placedBridge.config).map((source) => source.provider), ['Arlo via local bridge', 'Arlo via local bridge']);

  // Omitted or '' keeps an override; null clears it back to the camera's own name.
  const kept = applyPrivateCameraUpdate({ kind: 'home', siteId: 'cottage', cameras: [{ id: 'front-door', name: 'Front door', source: '' }, { id: 'garage', name: 'Garage' }] }, saved.config);
  assert.equal(kept.config.sites[0].cameras[0].source, 'Front');
  const cleared = applyPrivateCameraUpdate({ kind: 'home', siteId: 'cottage', cameras: [{ id: 'front-door', name: 'Front door', source: null }, { id: 'garage', name: 'Garage' }] }, saved.config);
  assert.equal(cleared.ok, true, cleared.error);
  assert.equal(relayMatchName(cleared.config.sites[0].cameras[0]), 'front door');
});

test('a relay pairing is set only by approval, has an exact shape and ends when the site stops being a relay', () => {
  const relay = applyPrivateCameraUpdate({ kind: 'home', name: 'Home', auth: 'relay', token: TOKEN, cameras: [{ name: 'Front' }] });
  assert.equal(relay.ok, true, relay.error);
  const config = applyPrivateCameraUpdate({ kind: 'business', name: 'Shop', cameras: [{ name: 'Dock', source: 'http://10.0.0.2/snap.jpg' }] }, relay.config).config;

  const paired = applyRelayPairing(config, 'home', { extensionId: RELAY_EXTENSION_ID, secretHash: RELAY_SECRET_HASH });
  assert.equal(paired.ok, true, paired.error);
  assert.deepEqual([paired.config.sites[0].relayExtensionId, paired.config.sites[0].relaySecretHash], [RELAY_EXTENSION_ID, RELAY_SECRET_HASH]);
  assert.equal(config.sites[0].relayExtensionId, '', 'the previous config is not changed');

  const refusePairing = (siteId, pairing, pattern) => {
    const result = applyRelayPairing(config, siteId, pairing);
    assert.equal(result.ok, false, JSON.stringify([siteId, pairing]));
    assert.match(result.error, pattern);
  };
  refusePairing('ghost', { extensionId: RELAY_EXTENSION_ID, secretHash: RELAY_SECRET_HASH }, /Unknown site/);
  refusePairing('shop', { extensionId: RELAY_EXTENSION_ID, secretHash: RELAY_SECRET_HASH }, /Browser feed relay/);
  for (const extensionId of ['q'.repeat(32), RELAY_EXTENSION_ID.toUpperCase(), RELAY_EXTENSION_ID.slice(1), `${RELAY_EXTENSION_ID}a`, '', undefined]) {
    refusePairing('home', { extensionId, secretHash: RELAY_SECRET_HASH }, /Extension id/);
  }
  for (const secretHash of [RELAY_SECRET_HASH.toUpperCase(), RELAY_SECRET_HASH.slice(1), `${RELAY_SECRET_HASH}0`, 'g'.repeat(64), null]) {
    refusePairing('home', { extensionId: RELAY_EXTENSION_ID, secretHash }, /secret/);
  }
  const tokenHome = applyPrivateCameraUpdate({ kind: 'home', name: 'Home', token: TOKEN, cameras: [{ name: 'Front', source: 'camera.aarlo_front' }] });
  assert.match(applyRelayPairing(tokenHome.config, 'home', { extensionId: RELAY_EXTENSION_ID, secretHash: RELAY_SECRET_HASH }).error, /Browser feed relay/);

  // Status says whether and with which extension; the hash never leaves the store.
  const status = privateCameraStatus(paired.config);
  assert.deepEqual(status.kinds[0].sites[0].relay, { paired: true, extensionId: RELAY_EXTENSION_ID });
  assert.equal(status.kinds[1].sites[0].relay, null);
  assert.equal(status.kinds[1].sites[0].cameras[0].matchName, 'dock');
  const text = JSON.stringify(status);
  for (const secret of [RELAY_SECRET_HASH, TOKEN]) assert.equal(text.includes(secret), false, secret);

  // A request body can neither set nor change a pairing; a relay save keeps it.
  const forged = applyPrivateCameraUpdate({ kind: 'home', siteId: 'home', auth: 'relay', relayExtensionId: 'p'.repeat(32), relaySecretHash: '0'.repeat(64) }, paired.config);
  assert.equal(forged.ok, true, forged.error);
  assert.deepEqual([forged.config.sites[0].relayExtensionId, forged.config.sites[0].relaySecretHash], [RELAY_EXTENSION_ID, RELAY_SECRET_HASH]);
  assert.equal(forged.config.sites[0].token, TOKEN);
  const cleared = applyPrivateCameraUpdate({ kind: 'business', siteId: 'shop', relayExtensionId: RELAY_EXTENSION_ID, relaySecretHash: RELAY_SECRET_HASH }, paired.config);
  assert.deepEqual([cleared.config.sites[1].relayExtensionId, cleared.config.sites[1].relaySecretHash], ['', '']);

  // Leaving the relay mode ends the pairing, and coming back does not restore it.
  const token = applyPrivateCameraUpdate({ kind: 'home', siteId: 'home', auth: 'token', cameras: [{ id: 'front', name: 'Front', source: 'camera.aarlo_front' }] }, paired.config);
  assert.equal(token.ok, true, token.error);
  assert.deepEqual([token.config.sites[0].relayExtensionId, token.config.sites[0].relaySecretHash], ['', '']);
  const back = applyPrivateCameraUpdate({ kind: 'home', siteId: 'home', auth: 'relay' }, token.config);
  assert.equal(privateCameraStatus(back.config).kinds[0].sites[0].relay.paired, false);

  const unpaired = clearRelayPairing(paired.config, 'home');
  assert.equal(unpaired.ok, true);
  assert.deepEqual([unpaired.config.sites[0].relayExtensionId, unpaired.config.sites[0].relaySecretHash], ['', '']);
  assert.deepEqual(clearRelayPairing(paired.config, 'ghost'), { ok: false, error: 'Unknown site' });

  // From disk: only a relay site keeps a pairing, and only in its exact shape.
  const loaded = normalizePrivateCameraConfig({
    version: 2,
    sites: [
      { id: 'home', kind: 'home', auth: 'relay', relayExtensionId: RELAY_EXTENSION_ID, relaySecretHash: RELAY_SECRET_HASH, cameras: [] },
      { id: 'cabin', kind: 'home', auth: 'relay', relayExtensionId: 'Z'.repeat(32), relaySecretHash: 'nope', cameras: [] },
      { id: 'barn', kind: 'home', auth: 'token', relayExtensionId: RELAY_EXTENSION_ID, relaySecretHash: RELAY_SECRET_HASH, cameras: [] },
      { id: 'shed', kind: 'home', auth: 'cookie', cameras: [] },
    ],
  });
  assert.deepEqual(loaded.sites.map((site) => [site.id, site.auth, site.relayExtensionId, site.relaySecretHash]), [
    ['home', 'relay', RELAY_EXTENSION_ID, RELAY_SECRET_HASH],
    ['cabin', 'relay', '', ''],
    ['barn', 'token', '', ''],
    ['shed', 'token', '', ''],
  ]);
});
