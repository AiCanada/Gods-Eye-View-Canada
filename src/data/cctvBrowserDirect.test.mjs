import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BROWSER_DIRECT_MIN_REFRESH_MS,
  browserDirectFrameUrl,
  isBrowserDirect,
} from './cctvBrowserDirect.js';

const quebec = { browserImageUrl: 'https://www.quebec511.info/Images/Cameras/Quebec/cam/19901.jpg' };

test('only https stills handed over by the server are browser-direct', () => {
  assert.equal(isBrowserDirect(quebec), true);
  assert.equal(isBrowserDirect({}), false);
  assert.equal(isBrowserDirect({ browserImageUrl: '' }), false);
  assert.equal(isBrowserDirect({ browserImageUrl: 'http://example.org/a.jpg' }), false);
});

test('the browser still refreshes at most once a minute, whatever the app asks for', () => {
  const now = 1789300000000;
  const fast = browserDirectFrameUrl(quebec, 10000, now);
  assert.equal(new URL(fast).origin + new URL(fast).pathname, quebec.browserImageUrl);
  assert.equal(new URL(fast).searchParams.get('gev'), String(Math.floor(now / BROWSER_DIRECT_MIN_REFRESH_MS)));
  const minuteStart = Math.floor(now / 60000) * 60000;
  assert.equal(
    browserDirectFrameUrl(quebec, 10000, minuteStart + 1000),
    browserDirectFrameUrl(quebec, 10000, minuteStart + 59000),
    'a 10-second refresh reuses the same address within one minute',
  );
  assert.notEqual(
    browserDirectFrameUrl(quebec, 10000, minuteStart + 59000),
    browserDirectFrameUrl(quebec, 10000, minuteStart + 61000),
    'the next minute asks for a new still',
  );
  const slow = browserDirectFrameUrl(quebec, 5 * 60000, now);
  assert.equal(new URL(slow).searchParams.get('gev'), String(Math.floor(now / (5 * 60000))), 'a slower cadence is kept');
  const withQuery = browserDirectFrameUrl({ browserImageUrl: 'https://a.example/cam.jpg?size=large' }, 0, now);
  assert.equal(new URL(withQuery).searchParams.get('size'), 'large', 'existing query parameters survive');
});
