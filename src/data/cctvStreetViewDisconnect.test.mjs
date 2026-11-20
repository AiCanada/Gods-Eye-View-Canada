// Real sockets: a client that closes its connection while the camera upstream
// is still pending must not get a Street View call outside its own budget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cctvProxy } from '../../server/providers/cctv.js';

// Fork: Street View is opt-in (CCTV_STREETVIEW_FALLBACK=1) and for the active
// camera only, and a camera that just failed waits out its backoff without
// asking again, so each request below uses a camera of its own.
const CAMS = Array.from({ length: 3 }, (_, i) => ({
  id: `still-fixture-${i}`,
  name: `Still fixture ${i}`,
  lat: 30.27,
  lon: -97.74,
  feedType: 'image',
  url: `https://cams.upstream.invalid/still-${i}.jpg`,
}));

test('a client that disconnects mid-fetch stays inside its own Street View budget', async (t) => {
  const saved = { ...process.env };
  process.env.CCTV_SOURCES_JSON = JSON.stringify(CAMS);
  process.env.CCTV_SOURCES_FILE = 'absent-source-file.json';
  process.env.CCTV_FORCE_AUSTIN = '0';
  process.env.GOOGLE_MAPS_SERVER_API_KEY = 'fixture-key';
  delete process.env.GOOGLE_MAPS_API_KEY;
  process.env.GEV_RATELIMIT_GOOGLE_PER_MIN = '1';
  process.env.CCTV_STREETVIEW_FALLBACK = '1';
  const nativeFetch = globalThis.fetch;
  let streetViewCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).startsWith('https://maps.googleapis.com/')) {
      streetViewCalls += 1;
      return new Response('street-view', {
        headers: { 'content-type': 'image/jpeg' },
      });
    }
    await new Promise((r) => setTimeout(r, 400));
    return new Response(null, { status: 503 });
  };
  // A temp root: the camera server reads and writes nothing in the checkout.
  const root = mkdtempSync(join(tmpdir(), 'gev-cctv-sv-'));
  let handler;
  cctvProxy({ sourceRoot: root }).configureServer({
    middlewares: { use: (_r, fn) => (handler = fn) },
  });
  const server = http.createServer((req, res) => {
    req.url = req.url.replace(/^\/api\/cctv/, '');
    handler(req, res, () => res.end());
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => {
    server.close();
    rmSync(root, { recursive: true, force: true });
    globalThis.fetch = nativeFetch;
    for (const k of Object.keys(process.env))
      if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });
  const { port } = server.address();
  const get = (cam, abortAfterMs) =>
    new Promise((resolve) => {
      const req = http.get(
        {
          host: '127.0.0.1',
          port,
          path: `/api/cctv/frame/${cam.id}?active=1`,
          headers: { host: `localhost:${port}` },
          agent: false,
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.headers['x-cctv-source']));
        },
      );
      req.on('error', () => resolve('aborted'));
      if (abortAfterMs)
        setTimeout(() => {
          req.destroy();
          resolve('aborted');
        }, abortAfterMs);
    });

  assert.equal(await get(CAMS[0]), 'streetview');
  assert.equal(await get(CAMS[1]), 'synthetic', 'the cap of one is spent');
  assert.equal(streetViewCalls, 1);
  await get(CAMS[2], 50);
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(
    streetViewCalls,
    1,
    'an aborted request spent the key outside its own budget',
  );
});
