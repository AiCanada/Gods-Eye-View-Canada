import test from 'node:test';
import assert from 'node:assert/strict';
import { curateLinkCameras, stableStillUrl } from '../../tools/camera-pack/curate-link-cameras.mjs';

const cam = (name, url, lat, lon) => ({ name, url, lat, lon });

test('cache-busting query strings are dropped from still addresses', () => {
  assert.equal(stableStillUrl('https://a.example/cam.jpg?t=1777574377611'), 'https://a.example/cam.jpg');
  assert.equal(stableStillUrl('https://a.example/now.jpg?20260913'), 'https://a.example/now.jpg');
  assert.equal(stableStillUrl('https://a.example/cam.jpg?id=4&ts=9'), 'https://a.example/cam.jpg?id=4');
});

test('share images, posters, banners and thumbnails are not live stills', () => {
  const { kept, dropped } = curateLinkCameras([
    cam('Waterfront', 'https://images.example/waterfront/og_image.jpg', 44.6, -63.5),
    cam('Harbour', 'https://cdn.example/v2/media/x/poster.jpg?width=320', 44.3, -64.3),
    cam('Red River', 'https://news.example/wp-content/uploads/2013/04/web-cam.jpg', 49.9, -97.0),
    cam('Corner Brook', 'https://tv.example/cams/thumb_green-cam.jpg?ts=1', 48.9, -57.9),
    cam('Regina', 'http://users.example/webcam/webcam32.jpg', 50.4, -104.6),
  ]);
  assert.deepEqual(kept.map((c) => c.name), ['Regina']);
  assert.equal(dropped.length, 4);
});

test('one image claimed by far-apart cameras is dropped; same-place claimants keep one', () => {
  const { kept, dropped } = curateLinkCameras([
    cam('Downtown Kelowna', 'https://cams.example/scenic5/now.jpg?20260913', 49.887, -119.5),
    cam('Lake Okanagan View', 'https://cams.example/scenic5/now.jpg?20260912', 50.693, -119.161),
    cam('North Sydney Webcam', 'https://ns.example/rwis_cam/North%20Sydney_1.jpg', 46.211, -60.247),
    cam('Hwy 125, North Sydney', 'https://ns.example/rwis_cam/North%20Sydney_1.jpg', 46.212, -60.248),
  ]);
  assert.deepEqual(kept.map((c) => c.name), ['North Sydney Webcam']);
  assert.ok(dropped.some((d) => d.name === 'Downtown Kelowna' && /km apart/.test(d.reason)));
});

test('a known misplaced still is moved to its real location', () => {
  const { kept } = curateLinkCameras([
    cam('BC Ferries', 'https://ccimg.bcferries.com/cc/support/terminals/cam1_DUK.jpg', 48.426, -123.361),
  ]);
  assert.equal(kept[0].name, 'BC Ferries Duke Point Terminal');
  assert.ok(kept[0].lat > 49.1 && kept[0].lon < -123.8, 'Duke Point is near Nanaimo, not Victoria');
});
