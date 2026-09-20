// The Canadian webcam listing (tools/camera-pack/canada-listing-tsv.mjs): which
// rows are kept, what each offers to watch, and how a row with no coordinates
// is turned into addresses to place it by.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ID_PREFIX,
  TOWN_REACH_KM,
  addressQueries,
  canonicalHref,
  distanceKm,
  dropCrossHostCopies,
  excludedReason,
  inCanada,
  provinceOf,
  rowMedia,
  rowPoint,
  rowToEntries,
  rowTown,
  sourceTown,
  spreadPoint,
  vancouverJunction,
} from '../../tools/camera-pack/canada-listing-tsv.mjs';

const row = (fields) => ({
  state_id: 'CA-BC',
  state_name: 'British Columbia',
  camera_id: 'BC-TEST-1',
  camera_name: 'Main St and 1st Ave',
  location: '',
  road: '',
  latitude: '49.27',
  longitude: '-123.1',
  direction: '',
  camera_details: '',
  primary_url: 'https://cams.example.ca/main1.jpg',
  video_url: '',
  source: 'City of Vancouver',
  ...fields,
});

test('only Canadian rows; never a school camera, never an unpublished billboard monitor', () => {
  assert.equal(provinceOf(row({})), 'BC');
  assert.equal(provinceOf(row({ state_id: 'US-WA' })), '');
  assert.equal(provinceOf(row({ state_id: 'CA-ZZ' })), '');
  assert.equal(excludedReason(row({})), '');
  assert.match(excludedReason(row({ state_id: 'PM' })), /not a Canadian/);
  assert.match(excludedReason(row({ camera_id: '' })), /no camera id/);
  assert.match(
    excludedReason(row({ camera_name: 'SFU Burnaby - AQ North', location: 'Simon Fraser University, Burnaby', source: 'SFU Campus Webcams', primary_url: 'https://www.sfu.ca/cam/aqn.jpg' })),
    /school/,
  );
  assert.match(
    excludedReason(row({ camera_name: 'Prince George SPD004 Ahbau St Billboard Cam', source: 'Prince George SPD Billboard Webcam', primary_url: 'http://174.90.224.128:8089/axis-cgi/jpg/image.cgi' })),
    /unpublished device/,
  );
  assert.equal(
    excludedReason(row({ camera_name: 'Helijet Vancouver Harbour Helipad', source: 'Helijet Harbour Webcam', primary_url: 'http://207.194.15.97/axis-cgi/jpg/image.cgi' })),
    '',
    'a business that publishes its own camera stays',
  );
});

test('what a row offers: every distinct view, else its still, else its HLS stream, else nothing', () => {
  const views = rowMedia(
    row({
      N: 'https://cams.example.ca/n.jpg',
      S: 'https://cams.example.ca/s.jpg',
      E: 'https://cams.example.ca/n.jpg',
      primary_url: 'https://cams.example.ca/n.jpg',
    }),
  );
  assert.deepEqual(views, {
    kind: 'views',
    views: [
      { dir: 'N', href: 'https://cams.example.ca/n.jpg' },
      { dir: 'S', href: 'https://cams.example.ca/s.jpg' },
    ],
  });
  assert.deepEqual(rowMedia(row({})), { kind: 'still', href: 'https://cams.example.ca/main1.jpg', dir: null });
  assert.deepEqual(
    rowMedia(row({ primary_url: 'https://cdn.example.com/2/public/hls/CAM_ab.m3u8', video_url: 'https://cdn.example.com/2/public/hls/CAM_ab.m3u8' })),
    { kind: 'stream', href: 'https://cdn.example.com/2/public/hls/CAM_ab.m3u8' },
  );
  assert.deepEqual(rowMedia(row({ primary_url: 'https://www.quebec511.info/fr/Carte/camera.aspx?id=1' })), { kind: 'none' });
  assert.deepEqual(rowMedia(row({ primary_url: 'http://cdn.example.com/live.m3u8' })), { kind: 'none' }, 'a plain-http stream is not carried');
  assert.deepEqual(rowMedia(row({ primary_url: 'https://www.youtube.com/embed/abc' })), { kind: 'none' });
});

test('a row’s own point: missing, 0,0 and out-of-range values are not a point', () => {
  assert.deepEqual(rowPoint(row({})), { lat: 49.27, lon: -123.1 });
  assert.equal(rowPoint(row({ latitude: '', longitude: '' })), null);
  assert.equal(rowPoint(row({ latitude: '0', longitude: '0' })), null);
  assert.equal(rowPoint(row({ latitude: '95', longitude: '-123' })), null);
  assert.equal(inCanada({ lat: 49.27, lon: -123.1 }), true);
  assert.equal(inCanada({ lat: 30.26, lon: -97.74 }), false);
  assert.equal(inCanada(null), false);
  // Vancouver to Victoria: far past the reach of a camera's own town.
  assert.ok(distanceKm({ lat: 49.2827, lon: -123.1207 }, { lat: 48.4284, lon: -123.3656 }) > TOWN_REACH_KM);
  assert.ok(distanceKm({ lat: 49.2827, lon: -123.1207 }, { lat: 49.2488, lon: -122.9805 }) < TOWN_REACH_KM);
});

test('the town a source names', () => {
  assert.equal(sourceTown('City of Vancouver'), 'Vancouver');
  assert.equal(sourceTown('City of Ottawa Traffic'), 'Ottawa');
  assert.equal(sourceTown('City of Toronto TMC'), 'Toronto');
  assert.equal(sourceTown('City of Surrey Traffic Cameras'), 'Surrey');
  assert.equal(sourceTown('Township of Langley Traffic Cameras'), 'Langley');
  assert.equal(sourceTown('Ontario 511 / City of Toronto'), 'Toronto');
  assert.equal(sourceTown('Ontario 511 / Windsor'), 'Windsor');
  assert.equal(sourceTown('York Region Traffic Cameras'), 'York Region');
  assert.equal(sourceTown('Alberta 511'), '');
  assert.equal(sourceTown('SkylineWebcams'), '');
  // The town a row is known to be in, for a camera listed with no address at all.
  assert.equal(rowTown(row({ source: 'City of Ottawa Traffic', camera_name: 'Ottawa Traffic Camera 379' })), 'Ottawa');
  assert.equal(rowTown(row({ source: 'Castanet Scenic Webcams', camera_details: 'Castanet Kelowna-area scenic webcam' })), 'Kelowna');
  assert.equal(rowTown(row({ source: 'Alberta 511', camera_details: 'TravelerIQ ID-gap image probe' })), '');
});

test('Vancouver’s camera file names are junctions', () => {
  assert.equal(vancouverJunction('Beatty Robson - East'), 'Beatty & Robson');
  assert.equal(vancouverJunction('Cambie02East - East'), 'Cambie Street & 2nd Avenue');
  assert.equal(vancouverJunction('Oak70 - West'), 'Oak Street & 70th Avenue');
  assert.equal(vancouverJunction('Granville12South - South'), 'Granville Street & 12th Avenue');
  assert.equal(vancouverJunction('Boundary1st S - East'), 'Boundary Street & 1st Avenue');
  assert.equal(vancouverJunction('Macdonald13'), 'Macdonald Street & 13th Avenue');
  assert.equal(vancouverJunction('Granville Robson South - West'), 'Granville & Robson', 'a trailing compass word is the side the pole stands on');
  assert.equal(vancouverJunction('Yukon SWMarine - North'), 'Yukon & SW Marine Drive');
  assert.equal(vancouverJunction('Cambie Bridge - East'), '', 'a bridge is a place, not two streets');
});

test('addresses to place a row by, most specific first; a serial number gives none', () => {
  assert.deepEqual(
    addressQueries(row({ camera_name: 'Cambie02East - East', location: 'Cambie02East' })),
    [
      'Cambie Street & 2nd Avenue, Vancouver, British Columbia, Canada',
      'Cambie02East, Vancouver, British Columbia, Canada',
    ],
  );
  assert.deepEqual(
    addressQueries(row({ state_id: 'CA-AB', source: 'Alberta 511', camera_name: 'Stoney Trail & 52 St SE facing S', location: '' })),
    ['Stoney Trail & 52 St SE, Alberta, Canada'],
  );
  assert.deepEqual(
    addressQueries(row({ source: 'DriveBC (rescued URL variant)', camera_name: 'Abbotsford (Bradner Rd.) BC', location: '' })),
    ['Bradner Rd, Abbotsford, British Columbia, Canada'],
  );
  assert.deepEqual(
    addressQueries(row({ state_id: 'CA-NL', source: 'NL Transportation Highway Cams', camera_name: 'NL Highway Camera – Portauxbasques', location: 'Portauxbasques' })),
    [
      'Port aux Basques, Newfoundland and Labrador, Canada',
      'NL Highway Camera – Portauxbasques, Newfoundland and Labrador, Canada',
    ],
  );
  assert.deepEqual(
    addressQueries(row({ state_id: 'CA-NB', source: 'SkylineWebcams', camera_name: 'Fredericton - Canada', location: 'View over the Saint John River in Fredericton' })).at(-1),
    'Fredericton, New Brunswick, Canada',
  );
  for (const placeless of [
    { state_id: 'CA-AB', source: 'Alberta 511', camera_name: 'Alberta 511 camera 48', location: 'Alberta 511 camera 48' },
    { state_id: 'CA-ON', source: 'City of Toronto TMC', camera_name: 'Toronto TMC loc8279', location: 'Toronto TMC loc8279' },
    { state_id: 'CA-ON', source: 'City of Ottawa Traffic', camera_name: 'Ottawa Traffic Camera 379', location: 'Ottawa camera 379' },
    { source: 'BC Ferries', camera_name: 'BC Ferries terminal cam BEC-1', location: '' },
    { state_id: 'CA-ON', source: 'City of Toronto TMC', camera_name: 'Toronto loc8294', location: '' },
    { state_id: 'CA-ON', source: 'York Region Traffic Cameras', camera_name: 'York Region loc394', location: '' },
    { state_id: 'CA-ON', source: 'Ontario 511', camera_name: 'Ontario 511 loc84--2', location: '' },
    { state_id: 'CA-SK', source: 'Saskatchewan 511', camera_name: 'Saskatchewan 511 Cctv/59', location: '' },
  ]) {
    assert.deepEqual(addressQueries(row(placeless)), [], placeless.camera_name);
  }
});

test('cameras that share an address step off it, so the 25 m duplicate rule keeps them all', () => {
  const point = { lat: 49.2827, lon: -123.1207 };
  assert.deepEqual(spreadPoint(point, 0), point);
  const metres = (a, b) => {
    const dLat = (a.lat - b.lat) * 111_320;
    const dLon = (a.lon - b.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180);
    return Math.hypot(dLat, dLon);
  };
  const spots = Array.from({ length: 30 }, (_, index) => spreadPoint(point, index));
  for (let a = 0; a < spots.length; a++) {
    for (let b = a + 1; b < spots.length; b++) {
      assert.ok(metres(spots[a], spots[b]) > 25, `cameras ${a} and ${b} are ${metres(spots[a], spots[b]).toFixed(1)} m apart`);
    }
  }
  assert.ok(metres(spots[29], point) <= 40 * 4 + 1, 'and none strays far from its address');
});

test('pack entries: one per view, a still, or a stream-only camera; placed by address says so', () => {
  const point = { lat: 49.27, lon: -123.1 };
  const [north, south] = rowToEntries(row({ N: 'https://cams.example.ca/n.jpg', S: 'https://cams.example.ca/s.jpg' }), point);
  assert.equal(north.id, `${ID_PREFIX}BC-TEST-1-N`);
  assert.equal(north.name, 'Main St and 1st Ave (North view)');
  assert.deepEqual([north.headingDeg, north.headingConfidence, south.headingDeg], [0, 'estimated', 180]);
  assert.deepEqual(
    [north.feedType, north.url, north.city, north.cityId, north.provider, north.country, north.coordConfidence, north.sourceKind],
    ['image', 'https://cams.example.ca/n.jpg', 'Vancouver', 'bc', 'City of Vancouver', 'CA', 'exact', 'configured'],
  );
  assert.equal('placedBy' in north, false);

  const [still] = rowToEntries(row({ direction: 'Eastbound' }), point, { placedBy: 'address', address: 'Main & 1st, Vancouver' });
  assert.deepEqual(
    [still.id, still.headingDeg, still.coordConfidence, still.placedBy, still.placedAddress],
    [`${ID_PREFIX}BC-TEST-1`, 90, 'estimated', 'address', 'Main & 1st, Vancouver'],
  );

  const [stream] = rowToEntries(
    row({ state_id: 'CA-AB', source: 'City of Edmonton Traffic Cameras', primary_url: 'https://cdn.example.com/hls/CAM_ab.m3u8', video_url: '' }),
    { lat: 53.54, lon: -113.49 },
  );
  assert.deepEqual(
    [stream.feedType, stream.url, stream.videoUrl, stream.city, stream.cityId, stream.headingDeg],
    ['none', '', 'https://cdn.example.com/hls/CAM_ab.m3u8', 'Edmonton', 'ab', null],
  );
  assert.deepEqual(rowToEntries(row({ primary_url: 'https://example.ca/page.html' }), point), []);
});

test('one address per still, and one entry per camera the listing reaches through two hosts', () => {
  assert.equal(
    canonicalHref('http://images.drivebc.ca/bchighwaycam/pub/cameras/786.jpg'),
    'https://www.drivebc.ca/images/786.jpg',
    'DriveBC serves one camera at two addresses',
  );
  assert.equal(canonicalHref('HTTPS://Cams.Example.ca/Main.JPG/'), 'https://cams.example.ca/main.jpg');

  const at = (id, url, lat, lon) => ({ id, url, lat, lon });
  const { kept, dropped } = dropCrossHostCopies([
    at('relisted', 'https://511on.ca/map/Cctv/loc8001', 43.64312, -79.381386),
    at('north', 'https://opendata.toronto.ca/tmc/loc8001n.jpg', 43.64312, -79.381386),
    at('south', 'https://opendata.toronto.ca/tmc/loc8001s.jpg', 43.64312, -79.381386),
    at('own-511', 'https://511on.ca/map/Cctv/2880', 44.232447, -76.477545),
    at('own-511-second-view', 'https://511on.ca/map/Cctv/2881', 44.232447, -76.477545),
    at('across-the-road', 'https://cams.example.ca/x.jpg', 43.6436, -79.381386),
  ]);
  assert.deepEqual(kept.map((entry) => entry.id), ['north', 'south', 'own-511', 'own-511-second-view', 'across-the-road']);
  assert.deepEqual(dropped.map((entry) => entry.id), ['relisted'], 'the city’s own host wins over the 511 re-listing');
});
