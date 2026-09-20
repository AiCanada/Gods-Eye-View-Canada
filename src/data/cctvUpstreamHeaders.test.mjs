import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CCTV_PROXY_USER_AGENT,
  browserDirectHosts,
  browserDirectImageUrl,
  roadMatchedThumbnail,
} from '../../server/providers/cctv/upstream-headers.js';

const env = { CCTV_BROWSER_DIRECT_HOSTS: ' Quebec511.info , www.example.org ' };
const still = (url) => ({ feedType: 'image', url });

test('stills on a listed host are handed to the browser', () => {
  assert.deepEqual(browserDirectHosts(env), ['quebec511.info', 'example.org']);
  assert.equal(
    browserDirectImageUrl(still('https://www.quebec511.info/Images/Cameras/Quebec/cam/19901.jpg'), env),
    'https://www.quebec511.info/Images/Cameras/Quebec/cam/19901.jpg',
  );
  assert.equal(browserDirectImageUrl(still('https://cams.example.org/a.jpg'), env), 'https://cams.example.org/a.jpg', 'subdomains of a listed host');
  assert.equal(
    browserDirectImageUrl({ url: 'https://www.quebec511.info/page', snapshotUrl: 'https://www.quebec511.info/Images/x.jpg' }, env),
    'https://www.quebec511.info/Images/x.jpg',
    'the snapshot address wins',
  );
});

test('everything else stays with the proxy', () => {
  assert.equal(browserDirectImageUrl(still('https://images.drivebc.ca/bchighwaycam/pub/cameras/1.jpg'), env), '');
  assert.equal(browserDirectImageUrl(still('https://notquebec511.info/x.jpg'), env), '', 'a look-alike host is not listed');
  assert.equal(browserDirectImageUrl(still('http://www.quebec511.info/x.jpg'), env), '', 'plain http is never handed to the browser');
  assert.equal(browserDirectImageUrl(still('not a url'), env), '');
  assert.equal(browserDirectImageUrl(still('https://www.quebec511.info/x.jpg'), { CCTV_BROWSER_DIRECT_HOSTS: '' }), '', 'set empty, nothing handed over');
  assert.equal(browserDirectImageUrl(still('https://www.drivebc.ca/images/1.jpg'), {}), '', 'the default lists Québec 511 only');
});

test('unset, no still goes to the browser: every camera is proxied and can show a map thumbnail', () => {
  assert.deepEqual(browserDirectHosts({}), []);
  assert.equal(
    browserDirectImageUrl(still('https://www.quebec511.info/Images/Cameras/Quebec/cam/19901.jpg'), {}),
    '',
  );
  assert.equal(CCTV_PROXY_USER_AGENT, 'gods-eye-view-cctv-proxy/1.0');
});

test('road-matched thumbnails are off by default and scoped by host when switched on', () => {
  const quebec = { url: 'https://www.quebec511.info/Images/Cameras/Montreal/cam/1360038.jpg' };
  const other = { url: 'https://g1.ipcamlive.com/player/snapshot.php?alias=x' };
  // Off unless asked for: thumbnails are upright and aligned by hand instead.
  assert.equal(roadMatchedThumbnail(quebec, {}), false);
  const on = { CCTV_ROAD_MATCH_HOSTS: 'quebec511.info' };
  assert.equal(roadMatchedThumbnail(quebec, on), true);
  assert.equal(roadMatchedThumbnail(other, on), false);
  assert.equal(roadMatchedThumbnail({ url: 'https://notquebec511.info/x.jpg' }, on), false, 'a look-alike host is not listed');
  assert.equal(roadMatchedThumbnail(other, { CCTV_ROAD_MATCH_HOSTS: '*' }), true);
  assert.equal(roadMatchedThumbnail(quebec, { CCTV_ROAD_MATCH_HOSTS: '' }), false);
  assert.equal(roadMatchedThumbnail(other, { CCTV_ROAD_MATCH_HOSTS: 'example.org, IPCamLive.com' }), true);
  assert.equal(roadMatchedThumbnail({ url: 'not a url' }, {}), false);
});
