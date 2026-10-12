import assert from 'node:assert/strict';
import test from 'node:test';
import { createThumbnails } from './thumbnails.js';

/* RESET on a saved thumbnail alignment, driven against stand-ins for the
 * layer state, the render service and the cards part. */
function harness(answer) {
  const saved = { lat: 45.1, lon: -66.1, bearingDeg: 30 };
  const pushes = [];
  const layerState = {
    _thumbAlignments: new Map([['cam-1', saved]]),
    _alignSession: { id: 'cam-1', draft: { ...saved }, saving: false },
    _recordById: new Map([['cam-1', {}]]),
  };
  const thumbnails = createThumbnails({
    state: layerState,
    services: {
      render: {
        holdContinuousRender() {},
        releaseContinuousRender() {},
      },
    },
    parts: {
      cards: {
        pushAmbientCardEntries() {
          pushes.push(layerState._thumbAlignments.get('cam-1') || null);
        },
      },
    },
    source: {},
  });
  const calls = [];
  const warnings = [];
  const realFetch = globalThis.fetch;
  const realWarn = console.warn;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method });
    // The card still shows the saved placement while the answer is on its way.
    assert.equal(layerState._thumbAlignments.get('cam-1'), saved);
    return answer();
  };
  console.warn = (...args) => warnings.push(args.join(' '));
  return {
    saved,
    layerState,
    thumbnails,
    pushes,
    calls,
    warnings,
    restore() {
      globalThis.fetch = realFetch;
      console.warn = realWarn;
    },
  };
}

test('the owner phone: a refused alignment RESET keeps the card exactly where it was, with no warning', async () => {
  const run = harness(
    () =>
      new Response(JSON.stringify({ removal: 'pc-only' }), {
        status: 403,
        headers: {
          'Content-Type': 'application/json',
          'X-GEV-Removal': 'pc-only',
        },
      }),
  );
  try {
    await run.thumbnails.resetThumbnailAlign();
    assert.deepEqual(run.calls, [
      { url: '/api/cctv/alignments/cam-1', method: 'DELETE' },
    ]);
    assert.equal(run.layerState._alignSession, null, 'aligning ends');
    assert.equal(run.layerState._thumbAlignments.get('cam-1'), run.saved);
    // Every repaint showed the saved placement; it never blinked to a reset.
    assert.ok(run.pushes.length > 0);
    assert.ok(run.pushes.every((alignment) => alignment === run.saved));
    assert.deepEqual(run.warnings, []);
  } finally {
    run.restore();
  }
});

test('the PC: RESET forgets the saved alignment once the server agrees', async () => {
  const run = harness(() => new Response(null, { status: 204 }));
  try {
    await run.thumbnails.resetThumbnailAlign();
    assert.equal(run.layerState._thumbAlignments.has('cam-1'), false);
    assert.equal(run.pushes.at(-1), null, 'the card is repainted reset');
    assert.deepEqual(run.warnings, []);
  } finally {
    run.restore();
  }
});

test('another refusal still resets the card for this session and warns why', async () => {
  const run = harness(
    () =>
      new Response(JSON.stringify({ error: 'Not saved here' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
  try {
    await run.thumbnails.resetThumbnailAlign();
    assert.equal(run.layerState._thumbAlignments.has('cam-1'), false);
    assert.equal(run.pushes.at(-1), null, 'the card is repainted reset');
    assert.equal(run.warnings.length, 1);
    assert.match(run.warnings[0], /could not be removed: Not saved here/);
  } finally {
    run.restore();
  }
});

test('the PC: RESET undoes a session-only placement the server refuses for this host', async () => {
  const run = harness(
    () =>
      new Response(JSON.stringify({ error: 'Refused for this host' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
  try {
    await run.thumbnails.resetThumbnailAlign();
    assert.equal(run.layerState._thumbAlignments.has('cam-1'), false);
    assert.equal(run.pushes.at(-1), null);
    assert.equal(run.warnings.length, 1);
  } finally {
    run.restore();
  }
});

test('the PC: RESET with no API at all still resets for this session', async () => {
  const run = harness(() => {
    throw new TypeError('Failed to fetch');
  });
  try {
    await run.thumbnails.resetThumbnailAlign();
    assert.equal(run.layerState._thumbAlignments.has('cam-1'), false);
    assert.equal(run.pushes.at(-1), null);
  } finally {
    run.restore();
  }
});
