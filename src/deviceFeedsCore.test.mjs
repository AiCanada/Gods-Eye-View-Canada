import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEVICE_FEED_AUTH_MODES,
  DEVICE_FEED_KINDS,
  DEVICE_FEED_METHODS,
  applyDeviceFeedUpdate,
  cleanFeedUrl,
  deviceFeedRequest,
  deviceFeedStatus,
  devicePositionUrl,
  devicePublicRecord,
  emptyDeviceFeedConfig,
  extractDevicePosition,
  feedTransport,
  maskFeedUrl,
  normalizeDeviceFeedConfig,
  parseKmlPosition,
  parseNmeaPosition,
  readJsonPath,
} from './deviceFeedsCore.mjs';

const add = (body, previous = emptyDeviceFeedConfig()) => applyDeviceFeedUpdate(body, previous);

test('five kinds, each with every login type and only known methods', () => {
  assert.deepEqual(DEVICE_FEED_KINDS.map((kind) => kind.id), ['drone', 'robot', 'marine', 'tracker', 'security']);
  for (const kind of DEVICE_FEED_KINDS) {
    assert.deepEqual([...kind.authModes].sort(), Object.keys(DEVICE_FEED_AUTH_MODES).sort(), `${kind.id} offers every login type`);
    for (const method of kind.methods) assert.ok(DEVICE_FEED_METHODS[method], `${kind.id}: ${method}`);
    assert.ok(kind.methods.some((method) => DEVICE_FEED_METHODS[method].direct), `${kind.id} has a direct method`);
  }
  // A method the application cannot speak says which bridge turns it into one it can.
  for (const [id, method] of Object.entries(DEVICE_FEED_METHODS)) {
    if (!method.direct) assert.ok(method.bridge && method.bridge.length > 10, `${id} names its bridge`);
  }
  const offered = (kindId) => DEVICE_FEED_KINDS.find((kind) => kind.id === kindId).methods;
  assert.ok(offered('drone').includes('mavlink2rest') && offered('drone').includes('mavlink-udp') && offered('drone').includes('rtsp'));
  assert.ok(offered('robot').includes('ros') && offered('robot').includes('mqtt'));
  assert.ok(offered('marine').includes('signalk') && offered('marine').includes('nmea-http') && offered('marine').includes('ais'));
  assert.ok(offered('tracker').includes('traccar') && offered('tracker').includes('owntracks'));
});

test('any number of devices: ids stay unique per name', () => {
  let config = emptyDeviceFeedConfig();
  const ids = [];
  for (let i = 0; i < 40; i += 1) {
    const result = add({ kind: 'tracker', name: 'Van', method: 'http-json', url: 'https://gps.example.com/van' }, config);
    assert.equal(result.ok, true);
    config = result.config;
    ids.push(result.feedId);
  }
  assert.equal(new Set(ids).size, 40);
  assert.equal(ids[0], 'tracker-van');
  assert.equal(ids[1], 'tracker-van-2');
  assert.equal(normalizeDeviceFeedConfig(config).feeds.length, 40);
});

test('addresses: http(s) only, never with a login inside', () => {
  assert.equal(cleanFeedUrl('https://a.example/x'), 'https://a.example/x');
  assert.equal(cleanFeedUrl(''), '');
  assert.equal(cleanFeedUrl('rtsp://cam.local/stream'), null);
  assert.equal(cleanFeedUrl('https://user:pw@a.example/'), null);
  assert.equal(cleanFeedUrl('javascript:alert(1)'), null);
  assert.equal(add({ kind: 'drone', name: 'A', method: 'http-json', url: 'https://u:p@x.example/' }).ok, false);
  assert.equal(feedTransport('https://x.example/'), 'https');
  assert.equal(feedTransport('http://192.168.1.9/'), 'lan-http');
  assert.equal(feedTransport('http://blueos.local/'), 'lan-http');
  assert.equal(feedTransport('http://x.example/'), 'insecure');
});

test('a bridge-only method is refused with its bridge named', () => {
  const result = add({ kind: 'drone', name: 'Mavic', method: 'rtsp', url: 'https://x.example/' });
  assert.equal(result.ok, false);
  assert.match(result.error, /needs a bridge/);
  assert.equal(add({ kind: 'tracker', name: 'T', method: 'ros', url: 'https://x.example/' }).error, 'Unknown connection method');
});

test('logins: each type needs its fields, and is never sent in the clear', () => {
  const base = { kind: 'robot', name: 'Spot', method: 'http-json', url: 'https://robot.example.com/pose' };
  assert.match(add({ ...base, auth: 'basic', username: 'u' }).error, /username and a password/);
  assert.match(add({ ...base, auth: 'bearer' }).error, /token or key/);
  assert.match(add({ ...base, auth: 'header', token: 'k', keyName: 'Cookie' }).error, /cannot carry a key/);
  assert.match(add({ ...base, auth: 'query', token: 'k', keyName: 'a b' }).error, /parameter name/);
  assert.match(add({ ...base, url: 'http://robot.example.com/pose', auth: 'bearer', token: 't' }).error, /only sent over https/);
  assert.equal(add({ ...base, url: 'http://10.0.0.8/pose', auth: 'bearer', token: 't' }).ok, true, 'plain http on the local network is allowed');
  const header = add({ ...base, auth: 'header', token: 'k' });
  assert.equal(header.ok, true);
  assert.equal(header.config.feeds[0].keyName, DEVICE_FEED_AUTH_MODES.header.keyNameDefault);
});

test('saved secrets and addresses survive an edit that leaves them out', () => {
  const first = add({ kind: 'marine', name: 'USV 1', method: 'signalk', url: 'https://boat.example.com/', pictureUrl: 'https://boat.example.com/cam.jpg', auth: 'basic', username: 'cap', password: 'pw' });
  assert.equal(first.ok, true);
  const renamed = applyDeviceFeedUpdate({ id: first.feedId, kind: 'marine', name: 'USV One', method: 'signalk', auth: 'basic', password: '' }, first.config);
  assert.equal(renamed.ok, true);
  const feed = renamed.config.feeds[0];
  assert.deepEqual([feed.name, feed.url, feed.pictureUrl, feed.username, feed.password], ['USV One', 'https://boat.example.com/', 'https://boat.example.com/cam.jpg', 'cap', 'pw']);
  const cleared = applyDeviceFeedUpdate({ id: first.feedId, kind: 'marine', name: 'USV One', method: 'signalk', pictureUrl: null, auth: 'none' }, renamed.config);
  assert.equal(cleared.ok, true);
  assert.deepEqual([cleared.config.feeds[0].pictureUrl, cleared.config.feeds[0].password, cleared.config.feeds[0].username], ['', '', '']);
  assert.equal(applyDeviceFeedUpdate({ id: first.feedId, kind: 'drone', name: 'x', method: 'http-json' }, first.config).error, 'A device cannot change type');
  const removed = applyDeviceFeedUpdate({ removeFeedId: first.feedId }, first.config);
  assert.deepEqual(removed.config.feeds, []);
  assert.equal(applyDeviceFeedUpdate({ removeFeedId: 'nope' }, first.config).ok, false);
});

test('a picture-only device needs a picture and a place to stand', () => {
  assert.match(add({ kind: 'robot', name: 'Cam', method: 'snapshot' }).error, /picture address/);
  assert.match(add({ kind: 'robot', name: 'Cam', method: 'snapshot', pictureUrl: 'https://r.example/snap.jpg' }).error, /fixed position/);
  assert.equal(add({ kind: 'robot', name: 'Cam', method: 'snapshot', pictureUrl: 'https://r.example/snap.jpg', lat: 45.27, lon: -66.06 }).ok, true);
  assert.match(add({ kind: 'robot', name: 'Cam', method: 'http-json', url: 'https://r.example/', lat: 95, lon: 0 }).error, /fixed position/);
  assert.match(add({ kind: 'robot', name: 'Cam', method: 'http-json', url: 'https://r.example/', latPath: 'a.lat' }).error, /both JSON paths/);
  assert.match(add({ kind: 'robot', name: 'Cam', method: 'http-json', url: 'https://r.example/', latPath: 'a(b)', lonPath: 'c' }).error, /JSON path/);
});

test('the setup card is never told a secret or a full address', () => {
  const saved = add({ kind: 'tracker', name: 'Van', method: 'traccar', url: 'https://gps.example.com/api/positions?deviceId=7', auth: 'query', token: 'SECRET-TOKEN', keyName: 'token' });
  const status = deviceFeedStatus(saved.config);
  const flat = JSON.stringify(status);
  assert.ok(!flat.includes('SECRET-TOKEN'));
  assert.ok(!flat.includes('deviceId=7'));
  const feed = status.kinds.find((kind) => kind.id === 'tracker').feeds[0];
  assert.deepEqual([feed.tokenSet, feed.urlSet, feed.url, feed.transport], [true, true, 'https://gps.example.com/api/positions?•••', 'https']);
  assert.equal(maskFeedUrl('https://x.example/share/abcdefghijklmnopqrstuvwxyz/pos'), 'https://x.example/share/•••/pos');
});

test('the request a login becomes', () => {
  const at = 'https://d.example/pos?x=1';
  assert.deepEqual(deviceFeedRequest({ auth: 'none' }, at), { url: at, headers: { Accept: '*/*' }, basic: null });
  assert.equal(deviceFeedRequest({ auth: 'bearer', token: 't' }, at).headers.Authorization, 'Bearer t');
  assert.equal(deviceFeedRequest({ auth: 'header', token: 'k', keyName: 'X-API-Key' }, at).headers['X-API-Key'], 'k');
  assert.equal(deviceFeedRequest({ auth: 'query', token: 'k y', keyName: 'key' }, at).url, 'https://d.example/pos?x=1&key=k+y');
  const basic = deviceFeedRequest({ auth: 'basic', username: 'u', password: 'p' }, at);
  assert.equal(basic.headers.Authorization, undefined, 'a password waits for the challenge');
  assert.deepEqual(basic.basic, { username: 'u', password: 'p' });
});

test('a bare base address reads the method’s standard endpoint', () => {
  assert.equal(devicePositionUrl({ method: 'mavlink2rest', url: 'http://blueos.local:6040/' }), 'http://blueos.local:6040/mavlink/vehicles/1/components/1/messages/GLOBAL_POSITION_INT');
  assert.equal(devicePositionUrl({ method: 'signalk', url: 'https://boat.example/' }), 'https://boat.example/signalk/v1/api/vessels/self/navigation');
  assert.equal(devicePositionUrl({ method: 'traccar', url: 'https://gps.example/' }), 'https://gps.example/api/positions');
  assert.equal(devicePositionUrl({ method: 'traccar', url: 'https://gps.example/api/positions?deviceId=3' }), 'https://gps.example/api/positions?deviceId=3');
  assert.equal(devicePositionUrl({ method: 'http-json', url: '' }), '');
});

test('positions out of every direct method', () => {
  assert.deepEqual(
    extractDevicePosition({ method: 'mavlink2rest' }, { json: { message: { type: 'GLOBAL_POSITION_INT', lat: 452700000, lon: -660600000, relative_alt: 52000, hdg: 9000, vx: 300, vy: 400 } } }),
    { lat: 45.27, lon: -66.06, altM: 52, headingDeg: 90, speedMps: 5 },
  );
  const signalk = extractDevicePosition({ method: 'signalk' }, { json: { position: { value: { latitude: 44.6, longitude: -63.5 } }, courseOverGroundTrue: { value: Math.PI / 2 }, speedOverGround: { value: 2.5 } } });
  assert.deepEqual([signalk.lat, signalk.lon, Math.round(signalk.headingDeg), signalk.speedMps], [44.6, -63.5, 90, 2.5]);
  const traccar = extractDevicePosition({ method: 'traccar' }, { json: [{ latitude: 1, longitude: 2 }, { latitude: 43.6, longitude: -79.4, speed: 10, course: 270, altitude: 80, fixTime: '2026-09-20T12:00:00Z' }] });
  assert.deepEqual([traccar.lat, traccar.lon, traccar.headingDeg, traccar.altM, traccar.at], [43.6, -79.4, 270, 80, '2026-09-20T12:00:00Z']);
  assert.ok(Math.abs(traccar.speedMps - 5.14444) < 1e-4, 'knots become metres per second');
  assert.deepEqual(extractDevicePosition({ method: 'geojson' }, { json: { type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, 1], [-66.05, 45.28, 12]] } } }), { lat: 45.28, lon: -66.05, altM: 12 });
  assert.deepEqual(extractDevicePosition({ method: 'http-json', latPath: 'data.pos[1]', lonPath: 'data.pos[0]' }, { json: { data: { pos: [-66, 45] } } }), { lat: 45, lon: -66 });
  const found = extractDevicePosition({ method: 'http-json' }, { json: { status: 'ok', vehicle: { gps: { latitude: '45.5', longitude: '-73.6' } } } });
  assert.deepEqual([found.lat, found.lon], [45.5, -73.6]);
  assert.equal(extractDevicePosition({ method: 'http-json' }, { json: { lat: 0, lon: 0 } }), null, 'null island is no fix');
  assert.equal(extractDevicePosition({ method: 'http-json' }, { json: { lat: 200, lon: 0 } }), null);
  assert.equal(extractDevicePosition({ method: 'http-json' }, {}), null);
  assert.equal(readJsonPath({ a: [{ b: 3 }] }, 'a[0].b'), 3);
  assert.equal(readJsonPath({ a: 1 }, '__proto__.x'), undefined);
});

test('NMEA and KML positions', () => {
  const gga = parseNmeaPosition('$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47');
  assert.ok(Math.abs(gga.lat - 48.1173) < 1e-4 && Math.abs(gga.lon - 11.516667) < 1e-4);
  const rmc = parseNmeaPosition('noise\r\n$GPRMC,123519,A,4916.45,N,12311.12,W,000.5,054.7,191194,020.3,E*68\r\n');
  assert.ok(Math.abs(rmc.lat - 49.274167) < 1e-4 && Math.abs(rmc.lon + 123.185333) < 1e-4);
  assert.equal(parseNmeaPosition('$GPRMC,123519,V,,,,,,,191194,,*00'), null, 'a void fix is no fix');
  assert.equal(parseNmeaPosition(''), null);
  assert.deepEqual(parseKmlPosition('<kml><Placemark><Point><coordinates>-66.06,45.27,15</coordinates></Point></Placemark></kml>'), { lat: 45.27, lon: -66.06, altM: 15 });
  assert.equal(parseKmlPosition('<kml></kml>'), null);
});

test('the map is told a name and a place, never an address or a login', () => {
  const saved = add({ kind: 'drone', name: 'Scout', method: 'http-json', url: 'https://d.example/pos', pictureUrl: 'https://d.example/cam.jpg', auth: 'bearer', token: 'TOPSECRET', lat: 45, lon: -66 });
  const feed = saved.config.feeds[0];
  const live = devicePublicRecord(feed, { lat: 45.1, lon: -66.1, altM: 30 }, { at: 5 });
  assert.deepEqual([live.id, live.lat, live.lon, live.live, live.fixed, live.pictureUrl], ['device-drone-scout', 45.1, -66.1, true, false, '/api/device-feeds/frame/device-drone-scout']);
  const parked = devicePublicRecord(feed, null);
  assert.deepEqual([parked.lat, parked.lon, parked.live, parked.fixed], [45, -66, false, true]);
  assert.ok(!JSON.stringify([live, parked]).match(/TOPSECRET|d\.example/));
  assert.equal(devicePublicRecord({ ...feed, lat: null, lon: null }, null), null, 'no position, no fixed place: not on the map');
});

test('whatever is on disk is coerced, and the malformed dropped', () => {
  const config = normalizeDeviceFeedConfig({
    feeds: [
      { id: 'drone-a', kind: 'drone', name: 'A', method: 'http-json', url: 'https://a.example/' },
      { id: 'drone-a', kind: 'drone', name: 'Twin', method: 'http-json', url: 'https://a.example/' },
      { id: '../x', kind: 'drone', name: 'Bad id', method: 'http-json', url: 'https://a.example/' },
      { id: 'sub-1', kind: 'submarine', name: 'Bad kind', method: 'http-json', url: 'https://a.example/' },
      { id: 'drone-b', kind: 'drone', name: 'Bridge', method: 'rtsp', url: 'https://a.example/' },
      { id: 'drone-c', kind: 'drone', name: 'Bad url', method: 'http-json', url: 'file:///etc/passwd' },
      null,
      'text',
    ],
  });
  assert.deepEqual(config.feeds.map((feed) => feed.id), ['drone-a']);
  assert.deepEqual(normalizeDeviceFeedConfig(null), emptyDeviceFeedConfig());
});
