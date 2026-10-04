import test from 'node:test';
import assert from 'node:assert/strict';
import { createCctvSource, createCctvLayer } from './index.js';

const camera = {
  id: 'pack/camera ?x',
  name: 'Camera & road',
  city: 'Austin',
  lat: 30.267,
  lon: -97.744,
  headingDeg: 45,
  fovDeg: 60,
  pitchDeg: -12,
};

test('camera catalog and health use fixed source routes and caller cancellation', async () => {
  const calls = [];
  const source = createCctvSource({
    fetchImpl: async (path, options) => {
      calls.push({ path, options });
      return new Response(
        JSON.stringify(
          path.endsWith('/sources') ? { sources: [] } : { cameras: [] },
        ),
      );
    },
  });
  const controller = new AbortController();
  await source.getCatalog({ signal: controller.signal });
  await source.getHealth({ signal: controller.signal });
  assert.deepEqual(
    calls.map((call) => call.path),
    ['/api/cctv/sources', '/api/cctv/health'],
  );
  for (const { options } of calls) {
    assert.equal(options.signal, controller.signal);
    assert.equal(options.cache, 'no-store');
  }
});

test('camera sources reject malformed snapshots and failures', async () => {
  for (const method of ['getCatalog', 'getHealth']) {
    const malformed = createCctvSource({
      fetchImpl: async () => new Response('{}'),
    });
    await assert.rejects(malformed[method](), /Malformed camera/);
    const denied = createCctvSource({
      fetchImpl: async () => new Response('', { status: 403 }),
    });
    await assert.rejects(denied[method](), /HTTP 403/);
  }
});

test('cancellation while reading a camera response body prevents publication', async () => {
  const controller = new AbortController();
  const source = createCctvSource({
    fetchImpl: async () => ({
      ok: true,
      json: async () => {
        controller.abort();
        return { sources: [] };
      },
    }),
  });
  await assert.rejects(source.getCatalog({ signal: controller.signal }), {
    name: 'AbortError',
  });
});

test('frame and media URLs preserve registered camera identity (contract 4: id and tick only)', () => {
  const source = createCctvSource();
  const frame = new URL(source.getFrameUrl(camera), 'https://example.test');
  const media = new URL(source.getMediaUrl(camera), 'https://example.test');
  assert.equal(
    frame.pathname,
    '/api/cctv/frame/' + encodeURIComponent(camera.id),
  );
  assert.equal(
    media.pathname,
    '/api/cctv/media/' + encodeURIComponent(camera.id),
  );
  // The server reads the camera's label and position from its own catalogue,
  // so none ride along; only the active plane and panel preview ask as active.
  assert.deepEqual([...frame.searchParams.keys()], ['ts']);
  const active = new URL(
    source.getFrameUrl(camera, 10_000, { active: true }),
    'https://example.test',
  );
  assert.deepEqual([...active.searchParams.keys()], ['ts', 'active']);
  assert.equal(active.searchParams.get('active'), '1');
  assert.deepEqual([...media.searchParams.keys()], ['ts']);
  // A home or business camera loads from its own loopback-only frame route.
  const privateFrame = new URL(
    source.getFrameUrl({
      ...camera,
      privateFrameUrl: '/api/private-cams/frame/porch',
    }),
    'https://example.test',
  );
  assert.equal(privateFrame.pathname, '/api/private-cams/frame/porch');
  assert.deepEqual([...privateFrame.searchParams.keys()], ['ts']);
});

test('the camera catalog is asked for the area around a point', async () => {
  const calls = [];
  const source = createCctvSource({
    fetchImpl: async (path) => {
      calls.push(path);
      return new Response(JSON.stringify({ sources: [], area: {} }));
    },
  });
  await source.getCatalog({ lat: 30.26721, lon: -97.74306, radiusKm: 50 });
  const url = new URL(calls[0], 'https://example.test');
  assert.equal(url.pathname, '/api/cctv/sources');
  assert.equal(url.searchParams.get('lat'), '30.26721');
  assert.equal(url.searchParams.get('lon'), '-97.74306');
  assert.equal(url.searchParams.get('radiusKm'), '50');
});

test('camera construction is inert and destruction cancels pending private-camera loading and its visibility listener', async (t) => {
  const original = globalThis.document;
  const listeners = new Set();
  globalThis.document = {
    addEventListener(type, handler) {
      if (type === 'visibilitychange') listeners.add(handler);
    },
    removeEventListener(type, handler) {
      if (type === 'visibilitychange') listeners.delete(handler);
    },
  };
  t.after(() => {
    globalThis.document = original;
  });
  const noop = () => {};
  const services = {
    overlays: {
      clearOverlaySource: noop,
      hitTestWorldOverlay: noop,
      setOverlayEntries: noop,
      setOverlaySourceVisible: noop,
    },
    sprites: { registerSpriteCollection: noop },
    activation: {},
    locations: {},
    picking: { unregisterPickOwner: noop },
    terrain: {},
    ground: {},
    mesh: {},
    focus: {},
    render: { releaseContinuousRender: noop },
  };
  // Init loads only this machine's private cameras: the viewer is at globe
  // view, so no public camera area is asked for until a place is selected.
  let resolvePrivate;
  let signal;
  let catalogCalls = 0;
  t.mock.method(globalThis, 'fetch', (url, init) => {
    assert.equal(String(url), '/api/private-cams/sources');
    signal = init.signal;
    return new Promise((resolve) => {
      resolvePrivate = resolve;
    });
  });
  const source = {
    ...createCctvSource(),
    getCatalog() {
      catalogCalls += 1;
      return Promise.resolve({ sources: [] });
    },
  };
  const a = createCctvLayer({ services, source });
  const b = createCctvLayer({ services, source });
  assert.equal(listeners.size, 0);
  const viewer = {
    scene: { primitives: { add: (value) => value, remove: () => true } },
  };
  const initializing = a.init(viewer);
  assert.equal(listeners.size, 1);
  assert.equal(signal.aborted, false);
  a.destroy(viewer);
  assert.equal(listeners.size, 0);
  assert.equal(signal.aborted, true);
  resolvePrivate({ ok: true, json: async () => ({ sources: [] }) });
  await assert.rejects(initializing, { name: 'AbortError' });
  assert.equal(catalogCalls, 0);
  assert.equal(a.getStats().count, 0);
  assert.equal(b.getStats().count, 0);
});

test('frames are read through the registered frame endpoint', async () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
  const requested = [];
  const source = createCctvSource({
    fetchImpl: async (url, init) => {
      requested.push({ url, cache: init.cache });
      return new Response(png, {
        headers: { 'Content-Type': 'Image/PNG; charset=binary' },
      });
    },
  });
  const frame = await source.getFrame(camera);
  assert.equal(frame.contentType, 'image/png');
  assert.deepEqual([...frame.bytes], [...png]);
  assert.equal(
    requested[0].url.split('?')[0],
    '/api/cctv/frame/pack%2Fcamera%20%3Fx',
  );
  assert.equal(requested[0].cache, 'no-store');
  const failing = createCctvSource({
    fetchImpl: async () => new Response(null, { status: 502 }),
  });
  await assert.rejects(failing.getFrame(camera), /Camera frame HTTP 502/);
});
