import { CCTV_FRAME_FETCH_TIMEOUT_MS, CCTV_FRAME_MAX_BODY_BYTES, CCTV_MEDIA_FETCH_TIMEOUT_MS, CCTV_MEDIA_MAX_BODY_BYTES } from '../../server/providers/cctv/constants.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  createPublicOnlyFetch,
  fetchCctvImageFromUpstream,
  createMotionJpegScanner,
  fetchCctvMediaUpstream,
  firstJpegInMotionStream,
  requestCctvImageWithReferer,
} from '../../server/providers/cctv/media.js';
import { isPublicAddress, isPublicHostname } from '../../server/providers/cctv/frame-resolver.js';
import { safeRoad511StillUrl } from '../../server/providers/cctv/road511-lookup.js';

/** A body that arrives in chunks and never declares a Content-Length. */
function chunkedImageResponse(chunkBytes, chunkCount, { onChunk = () => {}, onCancel = () => {} } = {}) {
  const stream = new ReadableStream({
    async pull(controller) {
      if (chunkCount <= 0) {
        controller.close();
        return;
      }
      chunkCount -= 1;
      onChunk();
      controller.enqueue(new Uint8Array(chunkBytes));
    },
    cancel: onCancel,
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
}

test('CCTV upstream frame fetch supplies a bounded abort signal', async () => {
  let observedSignal = null;
  const startedAt = Date.now();
  const result = await fetchCctvImageFromUpstream('https://example.com/frame.jpg', {
    timeoutMs: 20,
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
      observedSignal = options.signal;
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }),
  });

  assert.equal(result, null);
  assert.ok(observedSignal instanceof AbortSignal);
  assert.equal(observedSignal.aborted, true);
  assert.ok(Date.now() - startedAt < 500, 'test timeout should settle promptly');
  assert.ok(CCTV_FRAME_FETCH_TIMEOUT_MS < 10_000, 'production timeout must beat the active refresh cadence');
});

test('CCTV upstream frame fetch returns a valid image response', async () => {
  const result = await fetchCctvImageFromUpstream('https://example.com/frame.jpg', {
    timeoutMs: 100,
    fetchImpl: async () => new Response(Uint8Array.from([1, 2, 3]), {
      status: 200,
      headers: { 'Content-Type': 'image/jpeg' },
    }),
  });

  assert.equal(result?.ok, true);
  assert.equal(result?.contentType, 'image/jpeg');
  assert.deepEqual(result?.body, Buffer.from([1, 2, 3]));
});

test('CCTV upstream frame fetch rejects a declared oversize body without draining it', async () => {
  const chunkBytes = 64 * 1024;
  let pulled = 0;
  let cancelled = false;
  const result = await fetchCctvImageFromUpstream('https://example.com/frame.jpg', {
    timeoutMs: 1000,
    maxBytes: chunkBytes * 4,
    fetchImpl: async () => {
      const response = chunkedImageResponse(chunkBytes, 64, {
        onChunk: () => { pulled += 1; },
        onCancel: () => { cancelled = true; },
      });
      response.headers.set('Content-Length', String(chunkBytes * 64));
      return response;
    },
  });

  // Assert on the byte count, not the object: a regressed proxy returns a
  // multi-megabyte Buffer here, and diffing one into the failure report is
  // slower than the check it is reporting on.
  assert.equal(result?.body?.length ?? null, null, 'a declared oversize snapshot is a miss, not a buffered body');
  assert.equal(cancelled, true, 'the declared cap is enforced by cancelling, not reading');
  // Only the stream's own one-chunk prefetch may have run; the proxy pulls none.
  assert.ok(pulled <= 1, `declared cap short-circuits the read, pulled ${pulled} chunks`);
});

test('CCTV upstream frame fetch aborts an undeclared body once it crosses the cap', async () => {
  const chunkBytes = 64 * 1024;
  let pulled = 0;
  let cancelled = false;
  const result = await fetchCctvImageFromUpstream('https://example.com/frame.jpg', {
    timeoutMs: 1000,
    maxBytes: chunkBytes * 4,
    // Sixty-four chunks are offered with no Content-Length; a proxy that
    // buffers first would take all of them.
    fetchImpl: async () => chunkedImageResponse(chunkBytes, 64, {
      onChunk: () => { pulled += 1; },
      onCancel: () => { cancelled = true; },
    }),
  });

  assert.equal(result?.body?.length ?? null, null, 'a chunked body over the cap is a miss');
  // Four chunks fit, the fifth crosses the cap, and one more sits in the
  // stream's prefetch queue — nothing past that is ever pulled.
  assert.ok(pulled <= 6, `stopped reading at the cap, pulled ${pulled} chunks`);
  assert.equal(cancelled, true, 'the upstream stream is cancelled, not drained');
});

test('CCTV upstream frame fetch still returns a chunked body under the cap', async () => {
  const chunkBytes = 1024;
  const result = await fetchCctvImageFromUpstream('https://example.com/frame.jpg', {
    timeoutMs: 1000,
    maxBytes: chunkBytes * 8,
    fetchImpl: async () => chunkedImageResponse(chunkBytes, 3),
  });

  assert.equal(result?.ok, true);
  assert.equal(result?.body?.length, chunkBytes * 3, 'every chunk is reassembled in order');
  assert.ok(CCTV_FRAME_MAX_BODY_BYTES > 0 && CCTV_FRAME_MAX_BODY_BYTES <= CCTV_MEDIA_MAX_BODY_BYTES,
    'the frame cap must be at or under the media route cap — pinned against the real constant');
});

test('CCTV media upstream fetch aborts when response headers never arrive', async () => {
  let observedSignal = null;
  const startedAt = Date.now();
  await assert.rejects(
    fetchCctvMediaUpstream('https://example.com/stream.m3u8', {
      timeoutMs: 25,
      fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
        observedSignal = signal;
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }),
    }),
    (error) => error.name === 'AbortError',
  );
  assert.equal(observedSignal?.aborted, true, 'the header deadline aborts the attempt');
  assert.ok(Date.now() - startedAt < 2_000, 'the deadline is the injected one, not the production one');
  assert.ok(CCTV_MEDIA_FETCH_TIMEOUT_MS >= 10_000, 'production keeps a generous header deadline for slow cameras');
});

test('CCTV media upstream fetch never cuts a stream whose headers arrived in time', async () => {
  let observedSignal = null;
  const upstream = await fetchCctvMediaUpstream('https://example.com/stream.m3u8', {
    timeoutMs: 20,
    fetchImpl: async (url, { signal }) => {
      observedSignal = signal;
      return { ok: true, status: 200, headers: new Map([['content-type', 'video/mp2t']]), body: null };
    },
  });
  assert.equal(upstream.ok, true);
  // Well past the header deadline: the timer was cleared at header arrival,
  // so the live body is still allowed to flow.
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(observedSignal?.aborted, false, 'a slow body after timely headers is never aborted here');
});

test('CCTV upstream frame fetch keeps a body that lands exactly on the cap', async () => {
  const chunkBytes = 512;
  const result = await fetchCctvImageFromUpstream('https://example.com/frame.jpg', {
    timeoutMs: 1000,
    maxBytes: chunkBytes * 4,
    fetchImpl: async () => chunkedImageResponse(chunkBytes, 4),
  });
  assert.equal(result?.ok, true, 'exactly-at-cap is under the ceiling, not over it');
  assert.equal(result?.body?.length, chunkBytes * 4);
});

test('CCTV upstream frame fetch ignores a garbage Content-Length and still caps the stream', async () => {
  const chunkBytes = 1024;
  let cancelled = false;
  const result = await fetchCctvImageFromUpstream('https://example.com/frame.jpg', {
    timeoutMs: 1000,
    maxBytes: chunkBytes * 2,
    fetchImpl: async () => {
      const response = chunkedImageResponse(chunkBytes, 8, { onCancel: () => { cancelled = true; } });
      response.headers.set('Content-Length', 'not-a-number');
      return response;
    },
  });
  assert.equal(result?.body?.length ?? null, null, 'an unparseable length falls back to counting bytes');
  assert.equal(cancelled, true);
});

test('CCTV upstream frame fetch retains owned bytes, not the chunk\'s backing allocation', async () => {
  const backing = new ArrayBuffer(4 * 1024 * 1024);
  const view = new Uint8Array(backing, 8, 3);
  view.set([7, 8, 9]);
  const result = await fetchCctvImageFromUpstream('https://example.com/frame.jpg', {
    timeoutMs: 1000,
    maxBytes: 1024,
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(view);
        controller.close();
      },
    }), { status: 200, headers: { 'Content-Type': 'image/jpeg' } }),
  });
  assert.equal(result?.ok, true);
  assert.deepEqual(Array.from(result.body), [7, 8, 9]);
  assert.ok(result.body.buffer.byteLength < backing.byteLength,
    'the 4 MB backing allocation is not retained behind a 3-byte frame');
});

test('CCTV upstream frame fetch refuses a body it cannot stream instead of buffering it uncapped', async () => {
  const result = await fetchCctvImageFromUpstream('https://example.com/frame.jpg', {
    timeoutMs: 1000,
    maxBytes: 1024,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'image/jpeg']]),
      body: { /* neither async-iterable nor reader-backed */ },
      arrayBuffer: async () => { throw new Error('arrayBuffer must never be used as an uncapped fallback'); },
    }),
  });
  assert.equal(result, null);
});

test('reader-only snapshots release their lock on success, overflow and read failure', async () => {
  for (const mode of ['success', 'overflow', 'failure']) {
    const body = new ReadableStream({
      pull(controller) {
        if (mode === 'failure') controller.error(new Error('read failed'));
        else { controller.enqueue(new Uint8Array(4)); controller.close(); }
      },
    });
    Object.defineProperty(body, Symbol.asyncIterator, { value: undefined });
    const result = await fetchCctvImageFromUpstream('https://example.com/frame.jpg', {
      maxBytes: mode === 'overflow' ? 2 : 8,
      fetchImpl: async () => ({ ok: true, headers: new Headers({ 'content-type': 'image/jpeg' }), body }),
    });
    assert.equal(body.locked, false, mode);
    assert.equal(result?.body.length ?? null, mode === 'success' ? 4 : null);
  }
});

test('the snapshot deadline remains active after headers while reading a stalled body', async () => {
  let signal;
  const result = await fetchCctvImageFromUpstream('https://example.com/frame.jpg', {
    timeoutMs: 20,
    fetchImpl: async (_url, init) => {
      signal = init.signal;
      return new Response(new ReadableStream({ start(controller) {
        signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      }}), { headers: { 'content-type': 'image/jpeg' } });
    },
  });
  assert.equal(result, null);
  assert.equal(signal.aborted, true);
});

test('only public addresses and public names pass the checks, trailing dots included', () => {
  for (const address of [
    '127.0.0.1', '127.8.9.10', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.5', '169.254.169.254',
    '100.64.0.1', '100.127.255.254', '0.0.0.0', '0.1.2.3', '224.0.0.1', '255.255.255.255',
    '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe80::1%eth0', '[::1]',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:0:0', '64:ff9b::a9fe:a9fe', '64:ff9b::',
    '', 'not-an-ip', 'localhost',
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const address of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8', '64:ff9b::808:808']) {
    assert.equal(isPublicAddress(address), true, address);
  }
  for (const host of ['localhost.', 'foo.localhost.', 'metadata.google.internal.', 'nas.local.', 'router.home.arpa..', '127.0.0.1.']) {
    assert.equal(isPublicHostname(host), false, host);
  }
  assert.equal(isPublicHostname('cams.example.org.'), true);
});

async function localServer(t, handler) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { port: server.address().port, hits };
}

test('the public-only fetch refuses a name that resolves to a private address, before connecting', async (t) => {
  const { port, hits } = await localServer(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'image/jpeg' });
    res.end('secretbytes');
  });
  const lookups = [];
  const guarded = createPublicOnlyFetch({
    lookup: (hostname, options, callback) => {
      lookups.push({ hostname, all: options?.all });
      callback(null, [{ address: '203.0.113.9', family: 4 }, { address: '127.0.0.1', family: 4 }]);
    },
  });
  await assert.rejects(guarded(`http://cams.example.test:${port}/secret.jpg`), /non-public/);
  assert.deepEqual(lookups[0], { hostname: 'cams.example.test', all: true }, 'every address is checked');
  // The system resolver: these names and literals never reach the local service.
  const real = createPublicOnlyFetch();
  for (const href of [`http://localhost:${port}/a.jpg`, `http://localhost.:${port}/b.jpg`, `http://127.0.0.1:${port}/c.jpg`, `http://[::1]:${port}/d.jpg`]) {
    await assert.rejects(real(href), href);
  }
  await assert.rejects(real(`ftp://localhost:${port}/e.jpg`));
  assert.equal(
    await fetchCctvImageFromUpstream(`http://localhost:${port}/f.jpg`, { allowUrl: () => true }),
    null,
    'a guarded still uses the public-only fetch by default',
  );
  assert.deepEqual(hits, [], 'the loopback service was never contacted');
});

test('the public-only fetch connects to the address it checked, and never follows a redirect', async (t) => {
  const { port, hits } = await localServer(t, (req, res) => {
    if (req.url === '/moved') {
      res.writeHead(302, { location: `http://localhost:${port}/secret.jpg` });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'image/jpeg', 'x-frame': 'one' });
    res.end('frame');
  });
  // cams.example.test resolves nowhere: an answer proves the socket used the checked lookup's address.
  const guarded = createPublicOnlyFetch({
    lookup: (_hostname, _options, callback) => callback(null, [{ address: '127.0.0.1', family: 4 }]),
    addressAllowed: (address) => address === '127.0.0.1',
  });
  const ok = await guarded(`http://cams.example.test:${port}/frame.jpg`, { headers: { 'User-Agent': 'test' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/jpeg');
  assert.equal(ok.headers.get('x-frame'), 'one');
  assert.equal(await ok.text(), 'frame');
  const moved = await guarded(`http://cams.example.test:${port}/moved`);
  assert.equal(moved.status, 302);
  assert.equal(moved.headers.get('location'), `http://localhost:${port}/secret.jpg`);
  assert.deepEqual(hits, ['/frame.jpg', '/moved'], 'the redirect target is never requested');
  const image = await fetchCctvImageFromUpstream(`http://cams.example.test:${port}/frame.jpg`, {
    allowUrl: () => true,
    fetchImpl: guarded,
  });
  assert.equal(image?.body?.toString(), 'frame');
});

test('a still no catalogue vouches for follows at most two redirects, each hop re-checked', async () => {
  const jpeg = () => new Response(Uint8Array.from([1, 2, 3]), { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
  const moved = (location) => () => new Response(null, { status: 302, headers: { location } });
  const allowUrl = (href) => Boolean(safeRoad511StillUrl(href));
  const run = async (answers, options = { allowUrl }) => {
    const calls = [];
    const statuses = [];
    const result = await fetchCctvImageFromUpstream('https://cams.example.org/a.jpg', {
      ...options,
      onResponse: ({ status }) => statuses.push(status),
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), redirect: init.redirect });
        return answers[calls.length - 1]();
      },
    });
    return { result, calls, statuses };
  };

  let { result, calls, statuses } = await run([moved('http://localhost:8123/api/camera_proxy/x')]);
  assert.equal(result, null, 'a hop to a local name is refused');
  assert.deepEqual(calls, [{ url: 'https://cams.example.org/a.jpg', redirect: 'manual' }]);
  assert.deepEqual(statuses, [302]);
  for (const location of ['http://169.254.169.254/latest/meta-data', 'http://metadata.google.internal./x', 'ftp://cams.example.org/x.jpg', 'https://u:p@cams.example.org/x.jpg']) {
    ({ result, calls } = await run([moved(location)]));
    assert.equal(result, null, location);
    assert.equal(calls.length, 1, location);
  }

  ({ result, calls } = await run([moved('/b.jpg'), moved('https://cdn.example.org/c.jpg'), jpeg]));
  assert.equal(result?.ok, true, 'two public hops are followed');
  assert.deepEqual(calls.map((c) => c.url), ['https://cams.example.org/a.jpg', 'https://cams.example.org/b.jpg', 'https://cdn.example.org/c.jpg']);
  assert.ok(calls.every((c) => c.redirect === 'manual'));

  ({ result, calls } = await run([moved('/1.jpg'), moved('/2.jpg'), moved('/3.jpg'), jpeg]));
  assert.equal(result, null, 'a third hop is one too many');
  assert.equal(calls.length, 3);

  ({ result, calls } = await run([() => ({ type: 'opaqueredirect', status: 0, ok: false, headers: new Headers(), body: null })]));
  assert.equal(result, null, 'an opaque redirect has nowhere checked to go');
  ({ result, calls } = await run([moved('')]));
  assert.equal(result, null);

  ({ result, calls } = await run([jpeg], { allowUrl: () => false }));
  assert.equal(result, null, 'the first URL is checked too');
  assert.equal(calls.length, 0);

  ({ result, calls } = await run([jpeg], {}));
  assert.equal(result?.ok, true);
  assert.equal(calls[0].redirect, undefined, 'a catalogue still keeps fetch\'s own redirect handling');
});

test('rejected snapshot responses abort the upstream download', async () => {
  for (const [status, contentType] of [[503, 'image/jpeg'], [200, 'text/html']]) {
    let signal;
    const result = await fetchCctvImageFromUpstream('https://example.com/frame.jpg', {
      fetchImpl: async (_url, init) => {
        signal = init.signal;
        return new Response('rejected', { status, headers: { 'content-type': contentType } });
      },
    });
    assert.equal(result, null);
    assert.equal(signal.aborted, true);
  }
});

const jpegAnswer = (status = 200, contentType = 'image/jpeg') => ({
  status,
  headers: new Headers({ 'content-type': contentType }),
  body: status === 200 && contentType.startsWith('image/') ? Buffer.from('jpeg') : null,
  contentType,
});

test('a host that refuses fetch is asked through node:https, then asked that way first', async () => {
  const url = 'https://refuses-fetch.example.org/cam/1.jpg';
  let fetches = 0;
  const asked = [];
  const seen = [];
  const options = {
    fetchImpl: async () => {
      fetches += 1;
      return new Response('no', { status: 403, headers: { 'content-type': 'text/html' } });
    },
    refererRequest: async (href) => {
      asked.push(href);
      return jpegAnswer();
    },
    onResponse: (response) => seen.push(response.status),
  };
  const first = await fetchCctvImageFromUpstream(url, options);
  assert.equal(first.ok, true);
  assert.equal(first.contentType, 'image/jpeg');
  assert.deepEqual(seen, [403, 200]);
  assert.equal(fetches, 1);

  const second = await fetchCctvImageFromUpstream(url, options);
  assert.equal(second.ok, true);
  assert.equal(fetches, 1, 'the remembered host skips the refused fetch');
  assert.deepEqual(asked, [url, url]);
});

test('a refusal on both paths is a miss, asked three times in all, and the host is not remembered', async () => {
  const url = 'https://refuses-everything.example.org/cam/1.jpg';
  let fetches = 0;
  let asks = 0;
  const options = {
    fetchImpl: async () => {
      fetches += 1;
      return new Response('no', { status: 403 });
    },
    refererRequest: async () => {
      asks += 1;
      return jpegAnswer(403, 'text/html');
    },
  };
  assert.equal(await fetchCctvImageFromUpstream(url, options), null);
  assert.equal(asks, 3, 'a refused new connection is retried twice');
  assert.equal(await fetchCctvImageFromUpstream(url, options), null);
  assert.equal(fetches, 2, 'fetch is still tried first');
});

test('a remembered host is forgotten only when it REFUSES; a camera-level miss sends nothing more', async () => {
  const url = 'https://changes-its-mind.example.org/cam/1.jpg';
  let fetches = 0;
  let asks = 0;
  let httpsStatus = 200;
  let refuseFetch = true;
  const seen = [];
  const options = {
    fetchImpl: async () => {
      fetches += 1;
      return refuseFetch
        ? new Response('no', { status: 403 })
        : new Response('jpeg', { status: 200, headers: { 'content-type': 'image/jpeg' } });
    },
    refererRequest: async () => {
      asks += 1;
      return httpsStatus === 200 ? jpegAnswer() : jpegAnswer(httpsStatus, 'text/html');
    },
    onResponse: (response) => seen.push(response.status),
  };
  assert.equal((await fetchCctvImageFromUpstream(url, options)).ok, true);
  assert.deepEqual([fetches, asks], [1, 1]);

  // One camera's 404, and a 429, are not the host refusing: one request each,
  // no fetch, no repeat, and the last status the caller saw is the real one.
  for (const status of [404, 429]) {
    httpsStatus = status;
    seen.length = 0;
    assert.equal(await fetchCctvImageFromUpstream(url, options), null);
    assert.deepEqual(seen, [status]);
  }
  assert.deepEqual([fetches, asks], [1, 3]);
  httpsStatus = 200;
  assert.equal((await fetchCctvImageFromUpstream(url, options)).ok, true);
  assert.deepEqual([fetches, asks], [1, 4], 'still remembered: asked through node:https first');

  // A refusal forgets the host and tries fetch once. With fetch refused as well
  // that is the answer: no third node:https request.
  httpsStatus = 403;
  assert.equal(await fetchCctvImageFromUpstream(url, options), null);
  assert.deepEqual([fetches, asks], [2, 7]);
  // Forgotten: fetch first again, and a host that now answers fetch is served by it.
  refuseFetch = false;
  assert.equal((await fetchCctvImageFromUpstream(url, options)).ok, true);
  assert.deepEqual([fetches, asks], [3, 7]);
});

test('a host with a request budget never gets a second attempt', async () => {
  let asks = 0;
  const result = await fetchCctvImageFromUpstream('https://511.example.org/map/Cctv/7', {
    secondAttempt: false,
    fetchImpl: async () => new Response('no', { status: 403 }),
    refererRequest: async () => {
      asks += 1;
      return jpegAnswer();
    },
  });
  assert.equal(result, null);
  assert.equal(asks, 0);
});

test('a still no catalogue vouches for never takes the unguarded node:https path', async () => {
  let asks = 0;
  const result = await fetchCctvImageFromUpstream('https://cams.example.org/a.jpg', {
    allowUrl: () => true,
    fetchImpl: async () => new Response('no', { status: 403 }),
    refererRequest: async () => {
      asks += 1;
      return jpegAnswer();
    },
  });
  assert.equal(result, null);
  assert.equal(asks, 0);
});

test('the node:https still request names the site as referrer, caps the body and follows no redirect', async (t) => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, referer: req.headers.referer, accept: req.headers.accept });
    if (req.url === '/moved.jpg') {
      res.writeHead(302, { location: '/frame.jpg' });
      res.end();
    } else if (req.url === '/big.jpg') {
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      res.end(Buffer.alloc(4096));
    } else {
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      res.end('jpeg');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    // The still path keeps its connections alive; close them so the server can stop.
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const options = { timeoutMs: 2000, maxBytes: 1024 };

  const frame = await requestCctvImageWithReferer(`${base}/frame.jpg`, options);
  assert.equal(frame.status, 200);
  assert.equal(frame.body.toString(), 'jpeg');
  assert.equal(requests[0].referer, `${base}/`);
  assert.equal(requests[0].accept, undefined);

  const moved = await requestCctvImageWithReferer(`${base}/moved.jpg`, options);
  assert.equal(moved.status, 302);
  assert.equal(moved.body, null);
  assert.equal(requests.length, 2, 'the redirect was not followed');

  const big = await requestCctvImageWithReferer(`${base}/big.jpg`, options);
  assert.equal(big.body, null);
  assert.equal(await requestCctvImageWithReferer('not a url', options), null);
});

const SOI = [0xff, 0xd8, 0xff, 0xe0];
const EOI = [0xff, 0xd9];
const fakeJpeg = (fill, size = 40) => Buffer.from([...SOI, ...Array(size).fill(fill), ...EOI]);

test('the first picture of a motion-JPEG stream is found by its length, or by the next boundary', () => {
  const picture = fakeJpeg(7);
  const declared = Buffer.concat([
    Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${picture.length}\r\n\r\n`),
    picture,
    Buffer.from('\r\n--frame\r\n'),
  ]);
  assert.deepEqual(firstJpegInMotionStream(declared, 'frame'), picture);
  assert.equal(firstJpegInMotionStream(declared.subarray(0, declared.length - 20), 'frame'), null, 'not whole yet');

  // A length that also counts the line break after the picture (seen live).
  const padded = Buffer.concat([
    Buffer.from(`--frame\r\nContent-Length: ${picture.length + 2}\r\n\r\n`),
    picture,
    Buffer.from('\r\n--frame\r\n'),
  ]);
  assert.deepEqual(firstJpegInMotionStream(padded, 'frame'), picture);

  // No length: an embedded preview's end marker must not end the picture early.
  const withPreview = Buffer.from([...SOI, 1, 2, ...EOI, 3, 4, 5, ...EOI]);
  const undeclared = Buffer.concat([Buffer.from('--frame\r\nContent-Type: image/jpeg\r\n\r\n'), withPreview, Buffer.from('\r\n--frame\r\n')]);
  assert.deepEqual(firstJpegInMotionStream(undeclared, 'frame'), withPreview);
  assert.equal(firstJpegInMotionStream(undeclared.subarray(0, undeclared.length - 11), 'frame'), null, 'no boundary yet');
  assert.deepEqual(firstJpegInMotionStream(undeclared, ''), withPreview, 'works without a boundary parameter');
  assert.equal(firstJpegInMotionStream(Buffer.from('--frame\r\n\r\nnot a picture'), 'frame'), null);
});

test('a camera published only as a motion-JPEG stream yields its first picture, and the stream is hung up', async () => {
  const picture = fakeJpeg(9, 300);
  let cancelled = false;
  let pulls = 0;
  const body = new ReadableStream({
    pull(controller) {
      pulls += 1;
      const part = Buffer.concat([Buffer.from(`--myboundary\r\nContent-Type: image/jpeg\r\nContent-Length: ${picture.length}\r\n\r\n`), picture, Buffer.from('\r\n')]);
      // Deliver in two pieces so the finder has to wait for the rest.
      controller.enqueue(new Uint8Array(pulls % 2 ? part.subarray(0, 100) : part.subarray(100)));
    },
    cancel() {
      cancelled = true;
    },
  }, { highWaterMark: 0 });
  const result = await fetchCctvImageFromUpstream('https://streams.example.org/cam', {
    fetchImpl: async () => new Response(body, { headers: { 'content-type': 'multipart/x-mixed-replace;boundary=--myboundary' } }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.contentType, 'image/jpeg');
  assert.deepEqual(result.body, picture);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(cancelled, true);
  assert.ok(pulls <= 4, `read ${pulls} pieces of an endless stream`);
});

test('a motion-JPEG stream that never completes a picture within the cap is a miss', async () => {
  const body = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(Buffer.concat([Buffer.from(SOI), Buffer.alloc(600, 1)])));
    },
  }, { highWaterMark: 0 });
  const result = await fetchCctvImageFromUpstream('https://streams.example.org/endless', {
    maxBytes: 2048,
    fetchImpl: async () => new Response(body, { headers: { 'content-type': 'multipart/x-mixed-replace; boundary=frame' } }),
  });
  assert.equal(result, null);
});

test('the motion-JPEG scanner works chunk by chunk, and a wrong declared length does not strand it', () => {
  const CRLF = String.fromCharCode(13, 10);
  const picture = fakeJpeg(5, 900);
  const stream = Buffer.concat([
    Buffer.from(`--cam${CRLF}Content-Type: image/jpeg${CRLF}${CRLF}`),
    picture,
    Buffer.from(`${CRLF}--cam${CRLF}Content-Type: image/jpeg${CRLF}${CRLF}`),
  ]);
  const scanner = createMotionJpegScanner('cam');
  let found = null;
  let pushes = 0;
  for (let at = 0; at < stream.length && !found; at += 7) {
    pushes += 1;
    found = scanner.push(stream.subarray(at, at + 7));
  }
  assert.deepEqual(found, picture);
  assert.ok(pushes > 100, 'fed in many small pieces');

  // A declared length far larger than the picture: the next delimiter settles it.
  const lying = Buffer.concat([
    Buffer.from(`--cam${CRLF}Content-Length: 99999999${CRLF}${CRLF}`),
    picture,
    Buffer.from(`${CRLF}--cam${CRLF}`),
  ]);
  assert.deepEqual(firstJpegInMotionStream(lying, 'cam'), picture);

  // The boundary word alone inside the data is not a delimiter; two dashes and the word is.
  const body = Buffer.concat([Buffer.from([...SOI, 1]), Buffer.from('cam'), Buffer.from([2, ...EOI])]);
  const tricky = Buffer.concat([Buffer.from(`--cam${CRLF}${CRLF}`), body, Buffer.from(`${CRLF}--cam${CRLF}`)]);
  assert.deepEqual(firstJpegInMotionStream(tricky, 'cam'), body);
});
