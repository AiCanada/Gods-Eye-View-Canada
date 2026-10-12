import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cctvProxy } from '../../server/providers/cctv.js';
import {
  OWNER_DEVICE_AUTHORITY_HEADER,
  OWNER_DEVICE_HEADER,
  OWNER_DEVICE_REMOVAL_BODY,
  OWNER_DEVICE_REMOVAL_HEADER,
  setOwnerDeviceToken,
} from '../keySetupCore.mjs';

const TOKEN = '9'.repeat(64);
const MIRROR = 'http://100.64.0.1:4173';
const CAMERA = 'us511-TX-cam-60';

/** A pack with one camera, and only that pack. */
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'gev-cctv-align-owner-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'config'));
  const file = path.join(root, 'config', 'pack.json');
  writeFileSync(
    file,
    JSON.stringify([
      {
        id: CAMERA,
        name: 'I-10 at Main',
        city: 'Houston',
        country: 'US',
        region: 'TX',
        lat: 29.76,
        lon: -95.37,
        feedType: 'image',
        url: 'https://cams.example.org/60.jpg',
      },
    ]),
  );
  for (const [name, value] of Object.entries({
    CCTV_SOURCES_FILE: file,
    CCTV_SOURCES_JSON: undefined,
    CCTV_COUNTRIES: 'US',
    ...Object.fromEntries(
      [
        'ONTARIO',
        'FINTRAFFIC',
        'DRIVEBC',
        'TXDOT',
        'TALLINN',
        'TARKTEE',
        'WARENDORF',
        'NSW',
        'CALGARY',
        'DELDOT',
      ].map((name) => [`CCTV_${name}_ENABLED`, '0']),
    ),
    CCTV_STREETVIEW_FALLBACK: undefined,
    ROAD511_API_KEY: undefined,
  })) {
    const previous = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
  return root;
}

/** Mounts the CCTV middleware; requests carry a method, headers and socket. */
function install(plugin) {
  let handler;
  plugin.configureServer({
    middlewares: {
      use(_route, fn) {
        handler = fn;
      },
    },
  });
  return async (
    url,
    { method = 'GET', headers = {}, remoteAddress = '127.0.0.1', body } = {},
  ) => {
    const chunks = body === undefined ? [] : [JSON.stringify(body)];
    const req = {
      url,
      method,
      headers,
      socket: { remoteAddress },
      async *[Symbol.asyncIterator]() {
        yield* chunks;
      },
    };
    const res = {
      writeHead(status, responseHeaders) {
        Object.assign(this, { status, headers: responseHeaders });
      },
      setHeader() {},
      end(chunk) {
        this.body = String(chunk ?? '');
      },
    };
    await handler(req, res);
    return res;
  };
}

const ownerHeaders = (extra = {}) => ({
  host: '100.64.0.1:4173',
  origin: MIRROR,
  'sec-fetch-site': 'same-origin',
  'content-type': 'application/json',
  [OWNER_DEVICE_HEADER]: TOKEN,
  [OWNER_DEVICE_AUTHORITY_HEADER]: MIRROR,
  ...extra,
});
const pcHeaders = {
  host: 'localhost:4173',
  origin: 'http://localhost:4173',
  'sec-fetch-site': 'same-origin',
  'content-type': 'application/json',
};

test('the owner device may save a CCTV thumbnail alignment but never forget one; the PC still may', async (t) => {
  setOwnerDeviceToken(TOKEN);
  t.after(() => setOwnerDeviceToken(''));
  const root = fixture(t);
  const request = install(cctvProxy({ sourceRoot: root }));
  const owner = (method, body, extra) =>
    request(`/alignments/${CAMERA}`, {
      method,
      body,
      remoteAddress: '100.64.0.10',
      headers: ownerHeaders(extra),
    });
  const spot = { lat: 29.7601, lon: -95.3701, bearingDeg: 90 };

  const saved = await owner('POST', spot);
  assert.equal(saved.status, 200, saved.body);
  assert.deepEqual(JSON.parse(saved.body).alignment, spot);
  const listed = JSON.parse((await request('/alignments')).body).alignments;
  assert.ok(
    JSON.stringify(listed).includes(CAMERA),
    'the saved alignment is listed',
  );

  // Forgetting it from the owner device is refused, with or without an Origin,
  // with no message (only the marker and the exact body), and nothing on disk
  // changes.
  const file = path.join(root, 'config', 'cctv_thumbnail_alignments.json');
  const before = existsSync(file) ? readFileSync(file, 'utf8') : null;
  for (const extra of [{}, { origin: undefined }]) {
    const refused = await owner('DELETE', undefined, extra);
    assert.equal(refused.status, 403);
    assert.equal(refused.headers[OWNER_DEVICE_REMOVAL_HEADER], 'pc-only');
    assert.equal(String(refused.body), '{"removal":"pc-only"}');
    assert.deepEqual(JSON.parse(refused.body), { removal: 'pc-only' });
    assert.equal(Object.hasOwn(JSON.parse(refused.body), 'error'), false);
  }
  assert.equal(existsSync(file) ? readFileSync(file, 'utf8') : null, before);
  assert.ok(
    JSON.stringify(JSON.parse((await request('/alignments')).body)).includes(
      CAMERA,
    ),
    'the alignment is still there',
  );

  // Without a valid stamp the request is not the owner device, and the
  // ordinary host gate decides as before (an IP-literal Host is served).
  const forged = await request(`/alignments/${CAMERA}`, {
    method: 'DELETE',
    remoteAddress: '100.64.0.10',
    headers: ownerHeaders({ [OWNER_DEVICE_HEADER]: '8'.repeat(64) }),
  });
  assert.notDeepEqual(JSON.parse(forged.body), {
    ...OWNER_DEVICE_REMOVAL_BODY,
  });
  assert.equal(forged.headers?.[OWNER_DEVICE_REMOVAL_HEADER], undefined);

  // The PC on loopback still removes it.
  const pc = await request(`/alignments/${CAMERA}`, {
    method: 'DELETE',
    headers: pcHeaders,
  });
  assert.equal(pc.status, 200, pc.body);
});
