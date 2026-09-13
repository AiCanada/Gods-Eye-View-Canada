import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CMR_MODIS_AQUA_L3_SST_URL,
  GIBS_CAPABILITIES_URL,
  createSstStatusSource,
  earthdataTokenInfo,
  latestGibsDates,
  latestModisAquaL3Granule,
} from '../server/providers/sst/status.js';

const jwt = (payload) =>
  [
    Buffer.from('{"alg":"RS256"}').toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature',
  ].join('.');

const CAPS = `
<Layer><ows:Identifier>SST_A</ows:Identifier>
  <Dimension><Value>2024-01-01/2024-12-31/P1D</Value><Value>2025-01-01/2026-09-12/P1D</Value></Dimension>
</Layer>
<Layer><ows:Identifier>SST_B</ows:Identifier>
  <Dimension><Value>2026-01-01/2026-04-23/P8D</Value></Dimension>
</Layer>`;

const CMR = {
  feed: {
    entry: [
      {
        time_start: '2026-07-31T00:00:00.000Z',
        links: [
          { href: 's3://bucket/AQUA_MODIS.20260731.L3m.DAY.SST.sst.9km.nc' },
          {
            href: 'https://oceandata.sci.gsfc.nasa.gov/cmr/getfile/AQUA_MODIS.20260731.L3m.DAY.SST.sst.9km.nc',
          },
        ],
      },
    ],
  },
};

const textResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(),
  body: null,
  text: async () => body,
});

test('token info reads the expiry from the JWT payload', () => {
  const token = jwt({ uid: 'someone', exp: 1794455492 });
  assert.deepEqual(earthdataTokenInfo(token, Date.parse('2026-09-13T00:00:00Z')), {
    configured: true,
    expiresAt: '2026-11-12T03:51:32.000Z',
    expired: false,
  });
  assert.equal(earthdataTokenInfo(token, Date.parse('2026-12-01T00:00:00Z')).expired, true);
  assert.deepEqual(earthdataTokenInfo(''), { configured: false, expiresAt: null, expired: false });
  assert.equal(earthdataTokenInfo('opaque-token').expiresAt, null);
});

test('newest GIBS date is the end of the last extent', () => {
  assert.deepEqual(latestGibsDates(CAPS, ['SST_A', 'SST_B', 'MISSING']), {
    SST_A: '2026-09-12',
    SST_B: '2026-04-23',
  });
});

test('newest OceanColor file is the first https Level-3 SST link', () => {
  assert.deepEqual(latestModisAquaL3Granule(CMR), {
    date: '2026-07-31',
    url: 'https://oceandata.sci.gsfc.nasa.gov/cmr/getfile/AQUA_MODIS.20260731.L3m.DAY.SST.sst.9km.nc',
  });
  assert.equal(latestModisAquaL3Granule({}), null);
});

test('status reports dates and access, and never leaks the token', async () => {
  const token = jwt({ exp: 1794455492 });
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET', auth: options.headers?.Authorization });
    if (url === GIBS_CAPABILITIES_URL) return textResponse(CAPS);
    if (url === CMR_MODIS_AQUA_L3_SST_URL) return textResponse(JSON.stringify(CMR));
    return { ok: true, status: 200 };
  };
  const status = createSstStatusSource({
    products: [
      { id: 'a', gibsLayer: 'SST_A' },
      { id: 'b', gibsLayer: 'SST_B' },
    ],
    fetchImpl,
    env: { EARTHDATA_TOKEN: token },
    now: () => Date.parse('2026-09-13T00:00:00Z'),
  });
  const payload = await status();
  assert.deepEqual(payload.products, [
    { id: 'a', latestDate: '2026-09-12' },
    { id: 'b', latestDate: '2026-04-23' },
  ]);
  assert.equal(payload.oceanColor.latestModisAquaL3Date, '2026-07-31');
  assert.equal(payload.earthdata.authenticated, true);
  assert.equal(payload.earthdata.httpStatus, 200);
  assert.ok(!JSON.stringify(payload).includes(token), 'the token never reaches the browser');

  const head = calls.find((call) => call.method === 'HEAD');
  assert.ok(head.url.startsWith('https://oceandata.sci.gsfc.nasa.gov/'));
  assert.equal(head.auth, `Bearer ${token}`);
  assert.equal(calls.filter((call) => call.auth).length, 1, 'only the OceanColor check carries the token');

  await status();
  assert.equal(calls.length, 3, 'a second status call is served from cache');
});

test('without a token nothing is sent to OceanColor', async () => {
  const calls = [];
  const status = createSstStatusSource({
    products: [{ id: 'a', gibsLayer: 'SST_A' }],
    fetchImpl: async (url, options = {}) => {
      calls.push(options.method || 'GET');
      if (url === GIBS_CAPABILITIES_URL) return textResponse(CAPS);
      return textResponse(JSON.stringify(CMR));
    },
    env: {},
  });
  const payload = await status();
  assert.equal(payload.earthdata.configured, false);
  assert.equal(payload.earthdata.authenticated, false);
  assert.ok(!calls.includes('HEAD'));
});

test('an upstream failure still answers, with no dates', async () => {
  const status = createSstStatusSource({
    products: [{ id: 'a', gibsLayer: 'SST_A' }],
    fetchImpl: async () => textResponse('', 503),
    env: {},
  });
  const payload = await status();
  assert.deepEqual(payload.products, [{ id: 'a', latestDate: null }]);
  assert.equal(payload.oceanColor.latestModisAquaL3Date, null);
});
