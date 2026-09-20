import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  decodeHlsTarget,
  encodeHlsTarget,
  hlsTargetAllowed,
  isHlsPlaylist,
  rewriteHlsPlaylist,
  safeHlsPlaylistUrl,
} from '../../server/providers/cctv/hls-proxy.js';

const STREAM = 'https://video.example.org/live/CAM1.stream/playlist.m3u8';

test('only a plain playlist on a public host may be proxied', () => {
  assert.equal(safeHlsPlaylistUrl(STREAM), STREAM);
  assert.equal(safeHlsPlaylistUrl('http://8.8.8.8/rtplive/1.stream/playlist.m3u8'), 'http://8.8.8.8/rtplive/1.stream/playlist.m3u8', 'plain http and a bare public address are common for these');
  assert.equal(safeHlsPlaylistUrl('https://video.example.org:3443/cam/a.m3u8?token=1'), 'https://video.example.org:3443/cam/a.m3u8?token=1');
  for (const bad of ['', null, 'rtsp://video.example.org/a.m3u8', 'https://user:pw@video.example.org/a.m3u8', 'https://localhost/a.m3u8', 'http://127.0.0.1/a.m3u8', 'http://10.1.2.3/a.m3u8', 'http://192.168.1.4/a.m3u8', 'https://video.example.org/page.php', 'https://video.example.org/clip.mp4']) {
    assert.equal(safeHlsPlaylistUrl(bad), '', String(bad));
  }
});

test('a playlist can only name resources on the stream\'s own public host', () => {
  assert.equal(hlsTargetAllowed('https://video.example.org/live/CAM1.stream/media_1.ts', STREAM), true);
  assert.equal(hlsTargetAllowed('https://video.example.org/other/key.bin', STREAM), true);
  assert.equal(hlsTargetAllowed('https://cdn.example.org/live/media_1.ts', STREAM), false, 'another host');
  assert.equal(hlsTargetAllowed('https://video.example.org:8443/x.ts', STREAM), false, 'another port');
  assert.equal(hlsTargetAllowed('http://127.0.0.1:4173/api/keys', STREAM), false);
  assert.equal(hlsTargetAllowed('http://127.0.0.1/x.ts', 'http://127.0.0.1/playlist.m3u8'), false, 'never a private address, even its own');
  assert.equal(hlsTargetAllowed('file:///etc/passwd', STREAM), false);
  assert.equal(hlsTargetAllowed('https://u:p@video.example.org/x.ts', STREAM), false);
  assert.equal(hlsTargetAllowed('not a url', STREAM), false);
});

test('addresses survive the trip through the proxy\'s query string, and junk does not', () => {
  const href = 'https://video.example.org/live/CAM1.stream/media_w1_2.ts?a=1&b=/x';
  assert.equal(decodeHlsTarget(encodeHlsTarget(href)), href);
  assert.match(encodeHlsTarget(href), /^[A-Za-z0-9_-]+$/);
  assert.equal(decodeHlsTarget(''), '');
  assert.equal(decodeHlsTarget('not base64!'), '');
  assert.equal(decodeHlsTarget(Buffer.from('nonsense').toString('base64url')), '');
  assert.equal(decodeHlsTarget('A'.repeat(5000)), '');
});

test('every address in a playlist is rewritten: segments, variants, and the URI of a tag', () => {
  const toProxy = (href) => (href.startsWith('https://video.example.org/') ? `/p?u=${href.slice(26)}` : '');
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=120320\nchunklist_w1.m3u8\n';
  assert.equal(rewriteHlsPlaylist(master, STREAM, toProxy), '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=120320\n/p?u=live/CAM1.stream/chunklist_w1.m3u8\n');

  const media = [
    '#EXTM3U',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXT-X-KEY:METHOD=AES-128,URI="https://video.example.org/keys/1.bin",IV=0x1',
    '#EXTINF:6.0,',
    'media_1.ts',
    '#EXTINF:6.0,',
    'https://evil.example.net/steal.ts',
    '#EXTINF:6.0,',
    '/abs/media_3.ts',
  ].join('\r\n');
  const out = rewriteHlsPlaylist(media, STREAM, toProxy).split('\n');
  assert.ok(out.includes('#EXT-X-MAP:URI="/p?u=live/CAM1.stream/init.mp4"'));
  assert.ok(out.includes('#EXT-X-KEY:METHOD=AES-128,URI="/p?u=keys/1.bin",IV=0x1'));
  assert.ok(out.includes('/p?u=live/CAM1.stream/media_1.ts'));
  assert.ok(out.includes('/p?u=abs/media_3.ts'));
  assert.equal(out.some((line) => line.includes('evil.example.net')), false, 'a segment elsewhere is dropped');
  assert.equal(out.filter((line) => line.startsWith('#EXTINF')).length, 2, 'with its EXTINF line');
});

test('a playlist is recognised by type, or by name when the type is vague', () => {
  assert.equal(isHlsPlaylist('application/vnd.apple.mpegurl', STREAM), true);
  assert.equal(isHlsPlaylist('application/x-mpegURL; charset=utf-8', 'https://video.example.org/x'), true);
  assert.equal(isHlsPlaylist('text/plain', STREAM), true);
  assert.equal(isHlsPlaylist('video/MP2T', 'https://video.example.org/media_1.ts'), false);
});

test('one rule for every pack: a video-only camera is an HLS camera, its stream from the pack or from a lookup', () => {
  const server = readFileSync(new URL('../../server/providers/cctv.js', import.meta.url), 'utf8');
  assert.ok(server.includes('const listed = safeHlsPlaylistUrl(source.videoUrl);'), 'the stream a pack lists (Canadian, US or international)');
  assert.ok(server.includes("lookup.kind === 'hls'"), 'or the one a Road511 lookup found');
  assert.ok(server.includes("if (url.pathname.startsWith('/hls/')) {"));
  // A pack stream needs no lookup: no Road511 request is spent on it.
  assert.ok(server.includes("'resolved'\n      : source.lookup === 'road511'"));
  // Certificate checking is never relaxed; a broken chain only lets the BROWSER play the stream itself.
  assert.equal(/rejectUnauthorized\s*:\s*false/.test(server), false);
  assert.ok(server.includes('unverifiableStreamHosts.has(upstreamHostOf(stream))'));
  const client = readFileSync(new URL('./cctv.js', import.meta.url), 'utf8');
  assert.ok(client.includes("return normalizeFeedType(camera?.feedType) === 'hls';"));
  assert.ok(client.includes('return isStreamCamera(camera) && nativeHlsSupported() ? `${base}&hls=1` : base;'));
});
