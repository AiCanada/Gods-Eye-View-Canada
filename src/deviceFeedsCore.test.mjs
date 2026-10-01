import test from 'node:test';
import assert from 'node:assert/strict';
import {
  thinTrackPoints,
  trackFromRecordingLines,
  DEVICE_RECORD_RADIUS_OPTIONS_KM,
  buildDeviceRecordingLine,
  recordRadiusKm,
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
  newReportKey,
  normalizeDeviceFeedConfig,
  parseDeviceReport,
  deviceReportReply,
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

test('a device that reports to this app: no address, no login, a minted key that survives edits', () => {
  const fixed = (bytes) => bytes.fill(7);
  const saved = applyDeviceFeedUpdate({ kind: 'security', name: 'Samsung', method: 'report-in', auth: 'bearer', token: 'ignored', url: 'https://x.example/' }, emptyDeviceFeedConfig(), { randomValues: fixed });
  assert.equal(saved.ok, true, saved.error);
  const feed = saved.config.feeds[0];
  assert.deepEqual([feed.url, feed.auth, feed.token, feed.reportKey.length], ['', 'none', '', 43]);
  assert.match(feed.reportKey, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(devicePositionUrl(feed), '', 'never asked for its position');

  // An edit keeps the key; asking for a new one replaces it; a real key is random.
  const edited = applyDeviceFeedUpdate({ kind: 'security', id: feed.id, name: 'Samsung S6', method: 'report-in' }, saved.config);
  assert.equal(edited.config.feeds[0].reportKey, feed.reportKey);
  const minted = applyDeviceFeedUpdate({ kind: 'security', id: feed.id, name: 'Samsung S6', method: 'report-in', newReportKey: true }, saved.config);
  assert.notEqual(minted.config.feeds[0].reportKey, feed.reportKey);
  assert.notEqual(newReportKey(), newReportKey());

  // Switching to a polled method drops the key; a key on disk without its method is ignored, and a reporting device without a key is dropped.
  const polled = applyDeviceFeedUpdate({ kind: 'security', id: feed.id, name: 'Samsung', method: 'traccar', url: 'https://gps.example/' }, saved.config);
  assert.equal(polled.config.feeds[0].reportKey, '');
  const disk = normalizeDeviceFeedConfig({ feeds: [{ ...feed, method: 'report-in', reportKey: '' }, { ...feed, id: 'security-other', method: 'traccar', url: 'https://gps.example/', reportKey: feed.reportKey }] });
  assert.deepEqual(disk.feeds.map((item) => [item.id, item.reportKey]), [['security-other', '']]);

  // The card is told the key (the owner types it into the phone) and where this machine listens.
  const status = deviceFeedStatus(saved.config, { reportAddresses: ['http://10.66.0.1:44173'] });
  const shown = status.kinds.find((kind) => kind.id === 'security').feeds[0];
  assert.deepEqual([shown.reportsIn, shown.reportKey, shown.transport, status.reportAddresses], [true, feed.reportKey, 'reports-in', ['http://10.66.0.1:44173']]);
  assert.equal(status.kinds.find((kind) => kind.id === 'tracker').methods[0].reportsIn, true);
});

test('positions out of what a phone app sends', () => {
  // Traccar Client (OsmAnd protocol): knots, unix seconds.
  const osmand = parseDeviceReport({ params: { id: 'k', lat: '45.27', lon: '-66.06', timestamp: '1700000000', speed: '10', bearing: '90', altitude: '12', batt: '80' } });
  assert.equal(osmand.protocol, 'osmand');
  assert.deepEqual([osmand.position.lat, osmand.position.lon, osmand.position.altM, osmand.position.headingDeg, osmand.position.at], [45.27, -66.06, 12, 90, 1700000000000]);
  assert.ok(Math.abs(osmand.position.speedMps - 5.14444) < 1e-4);
  // GPSLogger sends m/s; an ISO time reads too.
  const logger = parseDeviceReport({ params: { lat: '1', lon: '2', speedMps: '3', timestamp: '2026-09-22T10:00:00Z' } });
  assert.deepEqual([logger.position.speedMps, logger.position.at], [3, Date.parse('2026-09-22T10:00:00Z')]);
  // OwnTracks: km/h, unix seconds; the app expects an empty array back.
  const own = parseDeviceReport({ json: { _type: 'location', lat: 45.1, lon: -66.2, tst: 1700000000, vel: 36, cog: 180, alt: 5 } });
  assert.deepEqual([own.protocol, own.position.speedMps, own.position.headingDeg, own.position.altM, own.position.at], ['owntracks', 10, 180, 5, 1700000000000]);
  assert.deepEqual(deviceReportReply('owntracks'), { contentType: 'application/json', body: '[]' });
  // Overland: a batch of GeoJSON features, the last one counts.
  const overland = parseDeviceReport({ json: { locations: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [-66.3, 45.3] }, properties: { timestamp: '2026-09-22T10:00:00Z', speed: 2 } }, { type: 'Feature', geometry: { type: 'Point', coordinates: [-66.4, 45.4] }, properties: { timestamp: '2026-09-22T10:00:30Z', speed: 4, altitude: 9 } }] } });
  assert.deepEqual([overland.protocol, overland.position.lat, overland.position.lon, overland.position.speedMps, overland.position.altM], ['overland', 45.4, -66.4, 4, 9]);
  assert.deepEqual(deviceReportReply('overland'), { contentType: 'application/json', body: '{"result":"ok"}' });
  // Any other JSON with a point in it; nothing else.
  assert.equal(parseDeviceReport({ json: { device: { latitude: 45, longitude: -66 } } }).protocol, 'json');
  assert.equal(parseDeviceReport({ params: { lat: '0', lon: '0' } }), null);
  assert.equal(parseDeviceReport({ params: { lat: '91', lon: '1' } }), null);
  assert.equal(parseDeviceReport({ json: { _type: 'lwt' } }), null);
  assert.equal(parseDeviceReport({}), null);
});

test('the recording distance is one of twelve choices, 50 km unless the device says otherwise', () => {
  assert.deepEqual([...DEVICE_RECORD_RADIUS_OPTIONS_KM], [1, 2, 3, 4, 5, 10, 15, 20, 25, 30, 40, 50]);
  assert.deepEqual([recordRadiusKm(5), recordRadiusKm('25'), recordRadiusKm(7), recordRadiusKm(undefined), recordRadiusKm(null)], [5, 25, 50, 50, 50]);
  const base = { kind: 'security', name: 'Samsung', method: 'report-in', record: true };
  const saved = applyDeviceFeedUpdate(base, emptyDeviceFeedConfig());
  assert.equal(saved.config.feeds[0].recordKm, 50, 'the default is unchanged');
  const chosen = applyDeviceFeedUpdate({ ...base, id: saved.feedId, recordKm: 3 }, saved.config);
  assert.equal(chosen.config.feeds[0].recordKm, 3);
  const kept = applyDeviceFeedUpdate({ ...base, id: saved.feedId }, chosen.config);
  assert.equal(kept.config.feeds[0].recordKm, 3, 'left out keeps the choice');
  assert.match(applyDeviceFeedUpdate({ ...base, id: saved.feedId, recordKm: 7 }, chosen.config).error, /one of 1, 2, 3/);
  assert.equal(normalizeDeviceFeedConfig({ feeds: [{ ...chosen.config.feeds[0], recordKm: 99 }] }).feeds[0].recordKm, 50, 'a stray value on disk falls back');
  const status = deviceFeedStatus(chosen.config);
  assert.deepEqual([status.recordRadiusOptionsKm.length, status.kinds.find((kind) => kind.id === 'security').feeds[0].recordKm], [12, 3]);
  assert.equal(devicePublicRecord(chosen.config.feeds[0], { lat: 1, lon: 2 }).recordKm, 3, 'the recorder is told the distance');
  // The server keeps only what lies within the chosen distance.
  const line = buildDeviceRecordingLine({ layers: { cctv: [{ id: 'a', lat: 45.0, lon: -66.0 }, { id: 'b', lat: 45.02, lon: -66.0 }] } }, { lat: 45.0, lon: -66.0 }, { radiusKm: 1 });
  assert.deepEqual([line.kept, line.line.radiusKm, line.line.layers.cctv.length], [1, 1, 1]);
});

test('a route out of recording lines: positions only, oldest first, thinned', () => {
  const line = (at, lat, lon) => JSON.stringify({ at, target: { lat, lon, altM: 3, headingDeg: 90, speedMps: 1 }, layers: {} });
  const text = [line('2026-09-26T10:00:10Z', 45.001, -66), 'garbage', line('2026-09-26T10:00:00Z', 45, -66), JSON.stringify({ at: 'x', target: { lat: 1, lon: 1 } }), line('2026-09-26T10:00:20Z', 45.001, -66)].join('\n');
  const points = trackFromRecordingLines(text);
  assert.deepEqual(points.map((point) => point.lat), [45, 45.001, 45.001], 'sorted by time, bad lines skipped');
  assert.deepEqual([points[0].altM, points[0].headingDeg, points[0].speedMps], [3, 90, 1]);
  assert.equal(thinTrackPoints(points).length, 2, 'an unmoved fix is one point');
  const long = Array.from({ length: 10_001 }, (_, i) => ({ at: i, lat: 45 + i * 0.001, lon: -66 }));
  const thinned = thinTrackPoints(long, { maxPoints: 1000 });
  assert.ok(thinned.length <= 1001 && thinned.length >= 900, `kept ${thinned.length}`);
  assert.equal(thinned[thinned.length - 1], long[long.length - 1], 'the last point is always kept');
  assert.deepEqual(thinTrackPoints([]), []);
});

test('NEW KEY keeps a hand-placed position and JSON paths; the card’s own save still clears them', () => {
  const saved = applyDeviceFeedUpdate({ kind: 'security', name: 'Samsung', method: 'report-in', lat: 45.27, lon: -66.06 }, emptyDeviceFeedConfig());
  assert.equal(saved.ok, true, saved.error);
  const feed = saved.config.feeds[0];
  // What the NEW KEY button sends: the name, the method and the request, nothing else.
  const minted = applyDeviceFeedUpdate({ kind: 'security', id: feed.id, name: feed.name, method: feed.method, newReportKey: true }, saved.config);
  assert.equal(minted.ok, true, minted.error);
  assert.notEqual(minted.config.feeds[0].reportKey, feed.reportKey);
  assert.deepEqual([minted.config.feeds[0].lat, minted.config.feeds[0].lon], [45.27, -66.06]);
  // The card's save sends null for an empty box, and that removes the position.
  const cleared = applyDeviceFeedUpdate({ kind: 'security', id: feed.id, name: feed.name, method: feed.method, lat: null, lon: null }, minted.config);
  assert.deepEqual([cleared.config.feeds[0].lat, cleared.config.feeds[0].lon], [null, null]);
  // Half a position is still refused.
  assert.equal(applyDeviceFeedUpdate({ kind: 'security', id: feed.id, name: feed.name, method: feed.method, lat: 45 }, minted.config).ok, false);

  // A polled tracker's JSON paths survive an update that leaves them out...
  const polled = applyDeviceFeedUpdate({ kind: 'tracker', name: 'Van GPS', method: 'http-json', url: 'https://gps.example/where', latPath: 'data.lat', lonPath: 'data.lon' }, emptyDeviceFeedConfig());
  assert.equal(polled.ok, true, polled.error);
  const tracker = polled.config.feeds[0];
  const renamed = applyDeviceFeedUpdate({ kind: 'tracker', id: tracker.id, name: 'Van GPS 2', method: 'http-json' }, polled.config);
  assert.equal(renamed.ok, true, renamed.error);
  assert.deepEqual([renamed.config.feeds[0].latPath, renamed.config.feeds[0].lonPath], ['data.lat', 'data.lon']);
  // ...and the card's two empty path boxes clear them.
  const emptied = applyDeviceFeedUpdate({ kind: 'tracker', id: tracker.id, name: 'Van GPS 2', method: 'http-json', latPath: '', lonPath: '' }, renamed.config);
  assert.deepEqual([emptied.config.feeds[0].latPath, emptied.config.feeds[0].lonPath], ['', '']);
});

test('each phone package’s map card shows its own phone’s picture, never the newest reporter’s', () => {
  const van = { id: 'security-van', kind: 'security', name: 'Van', method: 'report-in', lat: 45.1, lon: -66.1, pictureUrl: '' };
  const home = { ...van, id: 'security-home', name: 'Home' };
  assert.equal(devicePublicRecord(van, null).pictureUrl, '/api/ultra-help/picture/device-security-van');
  assert.equal(devicePublicRecord(home, null).pictureUrl, '/api/ultra-help/picture/device-security-home');
  // A package with its own picture address still uses its own frame route.
  assert.equal(
    devicePublicRecord({ ...van, pictureUrl: 'https://cam.example/shot.jpg' }, null).pictureUrl,
    '/api/device-feeds/frame/device-security-van',
  );
});
