import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  fetchHlsClip,
  parseHlsPlaylist,
  rangedBufferResponse,
} from '../../server/providers/cctv/hls-clip.js';
import {
  createRoad511Lookup,
  road511StreamUrl,
  safeRoad511StreamUrl,
} from '../../server/providers/cctv/road511-lookup.js';

// Every request here goes to a fake fetch: no operator is ever contacted.
const BASE = 'https://streams.example.org/hls/public/50/cam_high';
const MASTER = '#EXTM3U\n#EXT-X-VERSION:9\n#EXT-X-STREAM-INF:BANDWIDTH=519352,CODECS="avc1.640016"\nvideo1_stream.m3u8\n';
const VARIANT = [
  '#EXTM3U', '#EXT-X-TARGETDURATION:2', '#EXT-X-MAP:URI="abc_init.mp4"',
  '#EXTINF:2.0,', 'abc_seg1.mp4', '#EXTINF:2.0,', 'abc_seg2.mp4', '#EXTINF:2.0,', 'abc_seg3.mp4', '#EXTINF:2.0,', 'abc_seg4.mp4', '',
].join('\n');

function fakeStreamHost(files) {
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(String(url));
    const body = files[String(url)];
    return body === undefined ? new Response('gone', { status: 404 }) : new Response(body, { status: 200 });
  };
  return { asked, fetchImpl };
}

test('an HLS playlist is read into variants, the init segment and the media segments', () => {
  const master = parseHlsPlaylist(MASTER, `${BASE}/index.m3u8`);
  assert.deepEqual(master.variants, [`${BASE}/video1_stream.m3u8`]);
  const variant = parseHlsPlaylist(VARIANT, `${BASE}/video1_stream.m3u8`);
  assert.equal(variant.initUrl, `${BASE}/abc_init.mp4`);
  assert.deepEqual(variant.segments.slice(-2), [`${BASE}/abc_seg3.mp4`, `${BASE}/abc_seg4.mp4`]);
  assert.deepEqual(parseHlsPlaylist('<html>blocked</html>', BASE), { variants: [], initUrl: '', segments: [] });
});

test('the clip is the init segment followed by the newest media segments, nothing decoded', async () => {
  const { asked, fetchImpl } = fakeStreamHost({
    [`${BASE}/index.m3u8`]: MASTER,
    [`${BASE}/video1_stream.m3u8`]: VARIANT,
    [`${BASE}/abc_init.mp4`]: 'INIT|',
    [`${BASE}/abc_seg2.mp4`]: 'two|',
    [`${BASE}/abc_seg3.mp4`]: 'three|',
    [`${BASE}/abc_seg4.mp4`]: 'four|',
  });
  const clip = await fetchHlsClip(`${BASE}/index.m3u8`, { fetchImpl, allowUrl: () => true });
  assert.equal(clip.contentType, 'video/mp4');
  assert.equal(clip.body.toString(), 'INIT|two|three|four|');
  assert.equal(asked.includes(`${BASE}/abc_seg1.mp4`), false, 'only the newest three');
});

test('a playlist cannot send the server to another host, and a TS stream yields nothing', async () => {
  const elsewhere = VARIANT.replace('abc_init.mp4', 'https://internal.example.net/init.mp4');
  const stray = fakeStreamHost({ [`${BASE}/index.m3u8`]: elsewhere, 'https://internal.example.net/init.mp4': 'SECRET' });
  assert.equal(await fetchHlsClip(`${BASE}/index.m3u8`, { fetchImpl: stray.fetchImpl, allowUrl: () => true }), null);
  assert.equal(stray.asked.includes('https://internal.example.net/init.mp4'), false);

  const refused = fakeStreamHost({ [`${BASE}/index.m3u8`]: VARIANT });
  assert.equal(await fetchHlsClip(`${BASE}/index.m3u8`, { fetchImpl: refused.fetchImpl, allowUrl: () => false }), null);
  assert.equal(refused.asked.length, 0, 'the caller\'s check comes before any request');

  const ts = fakeStreamHost({ [`${BASE}/index.m3u8`]: '#EXTM3U\n#EXTINF:2,\nseg1.ts\n#EXTINF:2,\nseg2.ts\n' });
  assert.equal(await fetchHlsClip(`${BASE}/index.m3u8`, { fetchImpl: ts.fetchImpl, allowUrl: () => true }), null, 'no init segment: not fragmented MP4');
});

test('a segment that rolled off the live window is skipped; an oversized stream is refused', async () => {
  const rolled = fakeStreamHost({
    [`${BASE}/index.m3u8`]: VARIANT,
    [`${BASE}/abc_init.mp4`]: 'INIT|',
    [`${BASE}/abc_seg4.mp4`]: 'four|',
  });
  assert.equal((await fetchHlsClip(`${BASE}/index.m3u8`, { fetchImpl: rolled.fetchImpl, allowUrl: () => true })).body.toString(), 'INIT|four|');
  const huge = fakeStreamHost({ [`${BASE}/index.m3u8`]: VARIANT, [`${BASE}/abc_init.mp4`]: 'x'.repeat(5000) });
  assert.equal(await fetchHlsClip(`${BASE}/index.m3u8`, { fetchImpl: huge.fetchImpl, allowUrl: () => true, maxBytes: 1000 }), null);
});

test('a clip is served with byte ranges, which a <video> needs', () => {
  const body = Buffer.from('0123456789');
  const whole = rangedBufferResponse(body, 'video/mp4', undefined);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers['Accept-Ranges'], 'bytes');
  const part = rangedBufferResponse(body, 'video/mp4', 'bytes=2-5');
  assert.equal(part.status, 206);
  assert.equal(part.headers['Content-Range'], 'bytes 2-5/10');
  assert.equal(part.body.toString(), '2345');
  assert.equal(rangedBufferResponse(body, 'video/mp4', 'bytes=7-').body.toString(), '789');
  assert.equal(rangedBufferResponse(body, 'video/mp4', 'bytes=-3').body.toString(), '789');
  assert.equal(rangedBufferResponse(body, 'video/mp4', 'bytes=50-60').status, 416);
  assert.equal(rangedBufferResponse(body, 'video/mp4', 'garbage').status, 200);
});

test('a video-only Road511 camera resolves to its stream; stills still win; unsafe streams are refused', () => {
  const nj = { data: { properties: { camera_type: 'Video', has_stream: true, hls_url: 'https://nj-511.example.org/hls/public/50/cam_high/index.m3u8', stream_auth: 'otp' } } };
  assert.equal(road511StreamUrl(nj), 'https://nj-511.example.org/hls/public/50/cam_high/index.m3u8');
  assert.equal(road511StreamUrl({ data: { url: 'https://cams.example.org/1.jpg' } }), '');
  for (const bad of ['http://plain.example.org/a.m3u8', 'https://user:pw@x.example.org/a.m3u8', 'https://localhost/a.m3u8', 'https://10.0.0.5/a.m3u8', 'https://x.example.org/a.mp4', 'rtsp://x.example.org/a.m3u8', '']) {
    assert.equal(safeRoad511StreamUrl(bad), '', bad);
  }
});

test('the lookup remembers a stream as a stream, and re-asks cameras written off before streams were read', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gev-road511-hls-'));
  try {
    const cacheFile = path.join(dir, 'road511-lookups.json');
    const at = 1_000_000;
    // An old cache: two "no image" answers from before streams were read, one still.
    writeFileSync(cacheFile, JSON.stringify({ format: 'gev-road511-lookups/1', entries: {
      'us511-NJ-cam-90': { state: 'no-image', at },
      'us511-TX-cam-1': { state: 'resolved', url: 'https://cams.example.org/1.jpg', at },
    } }));
    const format = JSON.parse(readFileSync(cacheFile, 'utf8')).format;
    let calls = 0;
    const lookup = createRoad511Lookup({
      cacheFile,
      env: { ROAD511_API_KEY: 'k' },
      now: () => at + 1000,
      sleep: async () => {},
      flushDelayMs: 0,
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({ data: { properties: { hls_url: 'https://nj-511.example.org/hls/cam/index.m3u8' } } }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    await lookup.ready();
    const camera = { id: 'us511-NJ-cam-90', lookup: 'road511', feedType: 'none' };
    assert.equal(lookup.peek(camera).lookupState, 'unresolved', 'the old "no image" is not trusted');
    assert.deepEqual(lookup.peek({ id: 'us511-TX-cam-1', lookup: 'road511', feedType: 'none' }), { lookupState: 'resolved', url: 'https://cams.example.org/1.jpg', kind: 'still' });
    const result = await lookup.lookup(camera);
    assert.equal(result.lookupState, 'resolved');
    assert.equal(result.kind, 'hls');
    assert.equal(calls, 1);
    assert.equal(lookup.peek(camera).kind, 'hls');
    assert.ok(format, 'cache format unchanged');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('video plays only when its camera is clicked, and one clip address serves one set of bytes', () => {
  const client = readFileSync(new URL('./cctv.js', import.meta.url), 'utf8');
  // No background video: the thumbnail pacer never loads a stream.
  assert.ok(client.includes('if (isVideoFeedType(normalizeFeedType(record.camera.feedType))) return;'));
  assert.equal(client.includes('fetchCardFrameFromVideo'), false);
  // Only an explicit activation (a click) may start a video; an automatic one paints a note.
  assert.ok(client.includes("if (mode === 'video' && _videoPlayCameraId !== record.camera.id) {"));
  assert.ok(client.includes("runtime.idleNote = 'VIDEO · CLICK THE CAMERA TO PLAY';"));
  assert.ok(client.includes('if (explicit && _videoPlayCameraId !== cameraId) {'));
  // Once played, the last picture it showed is its thumbnail ("no current picture: show the prior one").
  assert.ok(client.includes('return !_cardFrameSlots.get(camera.id)?.frame;'));
  assert.ok(client.includes('Object.assign(slot, applyFrameResult(slot, { ok: true, frame: card }, now));'));
  // Browsers without HLS: the next clip loads in a second element; the finished one keeps its last picture up.
  assert.ok(client.includes("const next = document.createElement('video');"));
  assert.ok(client.includes('runtime.video = next;'));
  // Every byte range of one clip address comes from the same build (a rebuilt clip answered 416).
  const server = readFileSync(new URL('../../server/providers/cctv.js', import.meta.url), 'utf8');
  assert.ok(server.includes("url.searchParams.get('clip') || url.searchParams.get('ts')"));
  assert.ok(server.includes('const key = `${cameraId}|${token}`;'));
});
