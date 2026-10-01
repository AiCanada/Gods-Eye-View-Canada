import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { trackedDevicePolicyRecords } from './deviceFeedsCore.mjs';
import {
  LOCAL_PROVIDER_CHANGED_MESSAGE,
  bindLocalIntegrityRoot,
  listenerPolicyParts,
  localClientCredential,
  localProviderTrusted,
  localRecordsTrusted,
  noteLocalCamerasSaved,
  noteLocalDevicesSaved,
  noteLocalProvidersSaved,
  noteLocalRecordsSaved,
  vendorFeedPolicyParts,
} from './localIntegrity.mjs';
import { getOpenSkyToken } from '../server/providers/aircraft/opensky.js';
import { privateCameraPolicyRecords } from './privateCamerasCore.mjs';
import { parseLlmAskRequest } from '../server/providers/llm/ask.js';
import { googleServerApiKey } from '../server/providers/places/google-key.js';
import { launchLibraryRequestHeaders } from '../server/providers/space/launch-library.js';
import { noteOutboundEnvSaved } from '../server/providers/ultra-help.js';

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-local-integrity-'));
  fs.mkdirSync(path.join(root, 'config'));
  return root;
}

function withEnv(values, run) {
  const previous = new Map();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function finish(root) {
  bindLocalIntegrityRoot('');
  fs.rmSync(root, { recursive: true, force: true });
}

const storePath = (root) => path.join(root, 'config', 'local-integrity.json');
const keyPath = (root) => path.join(root, 'config', 'local-integrity.key');

test('no check file is trusted and a read creates nothing', () => {
  const root = tempRoot();
  try {
    bindLocalIntegrityRoot(root);
    assert.equal(localRecordsTrusted(root, 'cameras', []), true);
    assert.equal(localProviderTrusted('openai'), true);
    assert.equal(localProviderTrusted(''), true);
    assert.equal(localProviderTrusted('not-a-section'), true);
    assert.equal(fs.existsSync(storePath(root)), false);
    assert.equal(fs.existsSync(keyPath(root)), false);
    bindLocalIntegrityRoot('');
    assert.equal(localProviderTrusted('openai'), true);
  } finally {
    finish(root);
  }
});

test('a camera or device check ignores where the map put it and refuses a new address', () => {
  const root = tempRoot();
  try {
    const cameras = {
      version: 2,
      sites: [{
        id: 'shop',
        kind: 'business',
        name: 'Shop',
        username: 'admin',
        password: 'hunter2',
        lat: 45,
        lon: -66,
        cameras: [{ id: 'dock', name: 'Dock', source: 'http://10.0.0.2/snap.jpg', lat: 45, lon: -66 }],
      }],
    };
    noteLocalRecordsSaved(root, 'cameras', privateCameraPolicyRecords(cameras));
    cameras.sites[0].lat = 1;
    cameras.sites[0].cameras[0].lat = 2;
    cameras.sites[0].name = 'Moved';
    assert.equal(localRecordsTrusted(root, 'cameras', privateCameraPolicyRecords(cameras)), true);
    cameras.sites[0].cameras[0].source = 'http://evil.example/snap.jpg';
    assert.equal(localRecordsTrusted(root, 'cameras', privateCameraPolicyRecords(cameras)), false);

    const devices = {
      version: 1,
      feeds: [
        { id: 'tracker-van', kind: 'tracker', name: 'Van', method: 'traccar', url: 'https://gps.example/', auth: 'bearer', token: 'TOPSECRET', lat: 45, lon: -66 },
        { id: 'security-phone', kind: 'security', name: 'Phone', method: 'http-json', url: 'https://phone.example/pos', auth: 'bearer', token: 'phone-bearer-fixture' },
      ],
    };
    noteLocalRecordsSaved(root, 'devices', trackedDevicePolicyRecords(devices));
    devices.feeds[0].lat = 46.1;
    devices.feeds[1].url = 'https://evil-phone.example/pos';
    assert.equal(localRecordsTrusted(root, 'devices', trackedDevicePolicyRecords(devices)), true);
    devices.feeds[0].url = 'https://evil.example/';
    assert.equal(localRecordsTrusted(root, 'devices', trackedDevicePolicyRecords(devices)), false);

    const text = fs.readFileSync(storePath(root), 'utf8');
    for (const secret of ['hunter2', '10.0.0.2', 'TOPSECRET', 'phone-bearer-fixture', 'gps.example', 'evil.example']) {
      assert.equal(text.includes(secret), false);
    }
    assert.match(JSON.parse(text).devicesMac, /^[0-9a-f]{64}$/);
    assert.match(JSON.parse(text).camerasMac, /^[0-9a-f]{64}$/);
  } finally {
    finish(root);
  }
});

test('an empty device list is checked, so a device added by hand does not match', () => {
  const root = tempRoot();
  try {
    noteLocalRecordsSaved(root, 'devices', []);
    assert.equal(localRecordsTrusted(root, 'devices', []), true);
    assert.equal(localRecordsTrusted(root, 'devices', [{ id: 'drone-a', url: 'https://evil.example/pos' }]), false);
    assert.equal(localRecordsTrusted(root, 'cameras', [{ id: 'shop' }]), true);
  } finally {
    finish(root);
  }
});

test('sections are independent, a bad check fails, and deleting the file trusts again', () => {
  const root = tempRoot();
  try {
    withEnv({
      OPENAI_API_KEY: 'openai-fixture-key',
      FIRMS_MAP_KEY: 'firms-fixture',
    }, () => {
      noteLocalProvidersSaved(['OPENAI_API_KEY', 'FIRMS_MAP_KEY'], root);
      bindLocalIntegrityRoot(root);
      process.env.OPENAI_API_KEY = 'openai-evil';
      assert.equal(localProviderTrusted('openai'), false);
      assert.equal(localProviderTrusted('firms'), true);
      const file = storePath(root);
      const body = JSON.parse(fs.readFileSync(file, 'utf8'));
      body.firmsMac = 'zzzz';
      fs.writeFileSync(file, `${JSON.stringify(body)}\n`);
      assert.equal(localProviderTrusted('firms'), false);
      assert.equal(fs.readFileSync(file, 'utf8').includes('zzzz'), true);
      fs.unlinkSync(file);
      process.env.OPENAI_API_KEY = 'openai-evil';
      assert.equal(localProviderTrusted('openai'), true);
      assert.equal(localProviderTrusted('firms'), true);
    });
  } finally {
    finish(root);
  }
});

test('a key that will not open the canary trusts, and the next save of one section closes the others', () => {
  const root = tempRoot();
  try {
    withEnv({
      OPENAI_API_KEY: 'openai-fixture-key',
      FIRMS_MAP_KEY: 'firms-fixture',
    }, () => {
      noteLocalProvidersSaved(['OPENAI_API_KEY', 'FIRMS_MAP_KEY'], root);
      bindLocalIntegrityRoot(root);
      fs.writeFileSync(keyPath(root), `${'ab'.repeat(32)}\n`);
      process.env.OPENAI_API_KEY = 'openai-evil';
      assert.equal(localProviderTrusted('openai'), true);
      assert.equal(localProviderTrusted('firms'), true);
      const wiped = JSON.parse(fs.readFileSync(storePath(root), 'utf8'));
      delete wiped.canary;
      fs.writeFileSync(storePath(root), `${JSON.stringify(wiped)}\n`);
      assert.equal(localProviderTrusted('openai'), true);
      fs.writeFileSync(keyPath(root), `${'ab'.repeat(32)}\n`);
      noteLocalProvidersSaved(['OPENAI_API_KEY'], root);
      assert.equal(localProviderTrusted('openai'), true);
      assert.equal(localProviderTrusted('firms'), false);
      noteLocalProvidersSaved(['FIRMS_MAP_KEY'], root);
      assert.equal(localProviderTrusted('firms'), true);
      assert.equal(fs.readFileSync(keyPath(root), 'utf8'), `${'ab'.repeat(32)}\n`);
    });
  } finally {
    finish(root);
  }
});

test('an unreadable check file is left alone on read and replaced by the next save', () => {
  const root = tempRoot();
  try {
    noteLocalRecordsSaved(root, 'cameras', []);
    const file = storePath(root);
    fs.writeFileSync(file, '{"version":2,"keep":"keep-me"}\n');
    assert.equal(localRecordsTrusted(root, 'cameras', []), false);
    assert.equal(fs.readFileSync(file, 'utf8').includes('keep-me'), true);
    fs.writeFileSync(file, '{');
    assert.equal(localRecordsTrusted(root, 'cameras', []), false);
    assert.equal(fs.readFileSync(file, 'utf8'), '{');
    noteLocalRecordsSaved(root, 'cameras', []);
    assert.equal(localRecordsTrusted(root, 'cameras', []), true);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 1);
  } finally {
    finish(root);
  }
});

test('an invalid key file is not overwritten and does not create a check file', () => {
  const root = tempRoot();
  try {
    fs.writeFileSync(keyPath(root), 'not-a-key\n');
    noteLocalRecordsSaved(root, 'cameras', []);
    noteLocalProvidersSaved(['OPENAI_API_KEY'], root);
    assert.equal(fs.readFileSync(keyPath(root), 'utf8'), 'not-a-key\n');
    assert.equal(fs.existsSync(storePath(root)), false);
    assert.equal(localRecordsTrusted(root, 'cameras', [{ id: 'shop', password: 'hunter2' }]), true);
  } finally {
    finish(root);
  }
});

test('unbound provider checks stay on, and binding then unbinding follows the file', () => {
  const root = tempRoot();
  try {
    withEnv({ OPENAI_API_KEY: 'openai-fixture-key', CESIUM_ION_TOKEN: undefined }, () => {
      noteLocalProvidersSaved(['OPENAI_API_KEY'], root);
      assert.equal(localClientCredential('cesium', 'CESIUM_ION_TOKEN', {}), undefined);
      bindLocalIntegrityRoot('');
      process.env.OPENAI_API_KEY = 'openai-evil';
      assert.equal(localProviderTrusted('openai'), true);
      bindLocalIntegrityRoot(root);
      assert.equal(localProviderTrusted('openai'), false);
      assert.equal(localClientCredential('openai', 'OPENAI_API_KEY'), '');
      bindLocalIntegrityRoot('');
      assert.equal(localProviderTrusted('openai'), true);
    });
  } finally {
    finish(root);
  }
});

test('a directory or relay save does not write this check, and an OpenAI save does not write the Ultra one', () => {
  const root = tempRoot();
  try {
    withEnv({
      OPENAI_API_KEY: 'openai-fixture-key',
      TWILIO_AUTH_TOKEN: 'auth-fixture',
      ULTRA_DIRECTORY_URL: 'https://example.test/directory.json',
    }, () => {
      noteOutboundEnvSaved(['TWILIO_AUTH_TOKEN', 'ULTRA_DIRECTORY_URL'], root);
      assert.equal(fs.existsSync(storePath(root)), false);
      assert.equal(fs.existsSync(keyPath(root)), false);
      assert.equal(fs.existsSync(path.join(root, 'config', 'ultra-outbound.json')), false);
      noteOutboundEnvSaved(['OPENAI_API_KEY'], root);
      assert.equal(fs.existsSync(path.join(root, 'config', 'ultra-outbound.json')), false);
      const text = fs.readFileSync(storePath(root), 'utf8');
      assert.equal(text.includes('openai-fixture-key'), false);
      assert.equal(text.includes('auth-fixture'), false);
      assert.equal(text.includes('directory.json'), false);
      assert.match(JSON.parse(text).openaiMac, /^[0-9a-f]{64}$/);
      assert.equal('firmsMac' in JSON.parse(text), false);
    });
  } finally {
    finish(root);
  }
});

test('a changed model address is refused only after this checkout is bound', () => {
  const root = tempRoot();
  const body = JSON.stringify({ provider: 'nvidia', question: 'where' });
  try {
    withEnv({
      NVIDIA_API_KEY: 'nv-fixture-key',
      NVIDIA_BASE_URL: undefined,
      NVIDIA_MODEL: undefined,
    }, () => {
      noteLocalProvidersSaved(['NVIDIA_API_KEY'], root);
      bindLocalIntegrityRoot('');
      const open = parseLlmAskRequest(body);
      assert.equal(open.ok, true);
      bindLocalIntegrityRoot(root);
      assert.equal(parseLlmAskRequest(body).ok, true);
      process.env.NVIDIA_BASE_URL = 'https://evil.example/v1';
      const refused = parseLlmAskRequest(body);
      assert.equal(refused.ok, false);
      assert.equal(refused.status, 409);
      assert.equal(refused.payload.error, LOCAL_PROVIDER_CHANGED_MESSAGE);
      assert.equal(refused.payload.provider, 'nvidia');
      bindLocalIntegrityRoot('');
      const again = parseLlmAskRequest(body);
      assert.equal(again.ok, true);
      assert.equal(again.settings.baseUrl, 'https://evil.example/v1');
    });
  } finally {
    finish(root);
  }
});

test('launch and Google credentials go blank when their check no longer matches', () => {
  const root = tempRoot();
  try {
    withEnv({
      LL2_API_TOKEN: 'll2-fixture',
      GOOGLE_MAPS_API_KEY: 'browser-fixture',
      GOOGLE_MAPS_SERVER_API_KEY: 'server-fixture',
    }, () => {
      bindLocalIntegrityRoot('');
      assert.equal(launchLibraryRequestHeaders('ll2-fixture').Authorization, 'Token ll2-fixture');
      assert.equal(googleServerApiKey(), 'server-fixture');
      noteLocalProvidersSaved(['LL2_API_TOKEN', 'GOOGLE_MAPS_API_KEY'], root);
      bindLocalIntegrityRoot(root);
      assert.equal(launchLibraryRequestHeaders('ll2-fixture').Authorization, 'Token ll2-fixture');
      assert.equal(googleServerApiKey(), 'server-fixture');
      process.env.LL2_API_TOKEN = 'll2-evil';
      process.env.GOOGLE_MAPS_SERVER_API_KEY = 'server-evil';
      assert.equal('Authorization' in launchLibraryRequestHeaders('ll2-still-passed'), false);
      assert.equal(googleServerApiKey(), '');
    });
  } finally {
    finish(root);
  }
});

test('a changed report address is its own check, and the port is not part of it', () => {
  const root = tempRoot();
  try {
    withEnv({
      DEVICE_REPORT_PUBLIC_BASE: 'https://reports.example/',
      DEVICE_REPORT_PUBLIC_HOST: 'reports.example',
      DEVICE_REPORT_TLS_CERT: 'C:\\certs\\listener.pem',
      DEVICE_REPORT_TLS_KEY: 'C:\\certs\\listener.key',
      DEVICE_REPORT_PORT: '44173',
    }, () => {
      const saved = listenerPolicyParts();
      assert.deepEqual(saved, {
        publicBase: 'https://reports.example',
        publicHost: 'reports.example',
        tlsCert: 'C:\\certs\\listener.pem',
        tlsKey: 'C:\\certs\\listener.key',
      });
      noteLocalDevicesSaved(root, [], process.env);
      const text = fs.readFileSync(storePath(root), 'utf8');
      assert.match(JSON.parse(text).listenerMac, /^[0-9a-f]{64}$/);
      assert.match(JSON.parse(text).devicesMac, /^[0-9a-f]{64}$/);
      assert.equal(text.includes('reports.example'), false);
      assert.equal(text.includes('listener.pem'), false);
      assert.equal(localRecordsTrusted(root, 'listener', listenerPolicyParts()), true);
      assert.equal(localRecordsTrusted(root, 'devices', []), true);
      process.env.DEVICE_REPORT_PORT = '9';
      assert.equal(localRecordsTrusted(root, 'listener', listenerPolicyParts()), true);
      process.env.DEVICE_REPORT_PUBLIC_BASE = 'https://evil.example';
      assert.equal(localRecordsTrusted(root, 'listener', listenerPolicyParts()), false);
      assert.equal(localRecordsTrusted(root, 'devices', []), true);
      process.env.DEVICE_REPORT_PUBLIC_BASE = 'not a url';
      assert.equal(listenerPolicyParts().publicBase, '');
      assert.equal(localRecordsTrusted(root, 'listener', listenerPolicyParts()), false);
      process.env.DEVICE_REPORT_PUBLIC_BASE = 'https://reports.example';
      process.env.DEVICE_REPORT_TLS_CERT = 'C:\\certs\\evil.pem';
      assert.equal(localRecordsTrusted(root, 'listener', listenerPolicyParts()), false);
      fs.unlinkSync(storePath(root));
      assert.equal(localRecordsTrusted(root, 'listener', listenerPolicyParts()), true);
    });
  } finally {
    finish(root);
  }
});

test('a changed camera site file is its own check and does not follow the camera list', () => {
  const root = tempRoot();
  try {
    const feed = vendorFeedPolicyParts({
      feedUrl: 'https://cams.vendor.example/#/feed',
      imageHosts: ['clips.vendor.example'],
      cloudHostSuffixes: ['vendor.example'],
    });
    noteLocalCamerasSaved(root, [], feed);
    const text = fs.readFileSync(storePath(root), 'utf8');
    assert.match(JSON.parse(text).vendorFeedMac, /^[0-9a-f]{64}$/);
    assert.equal(text.includes('vendor.example'), false);
    assert.equal(text.includes('clips.vendor.example'), false);
    assert.equal(localRecordsTrusted(root, 'vendorFeed', feed), true);
    assert.equal(localRecordsTrusted(root, 'cameras', []), true);
    const moved = vendorFeedPolicyParts({
      feedUrl: 'https://cams.other.example/#/feed',
      imageHosts: ['clips.other.example'],
      cloudHostSuffixes: ['other.example'],
    });
    assert.equal(localRecordsTrusted(root, 'vendorFeed', moved), false);
    assert.equal(localRecordsTrusted(root, 'cameras', []), true);
    noteLocalRecordsSaved(root, 'cameras', [{ id: 'shop' }]);
    assert.equal(localRecordsTrusted(root, 'vendorFeed', moved), false);
    assert.equal(localRecordsTrusted(root, 'cameras', [{ id: 'shop' }]), true);
  } finally {
    finish(root);
  }
});

test('a changed OpenSky sign-in is not used', async () => {
  const root = tempRoot();
  let pending = null;
  try {
    withEnv({
      OPENSKY_CLIENT_ID: 'id-fixture',
      OPENSKY_CLIENT_SECRET: 'secret-fixture',
      OPENSKY_USERNAME: '',
      OPENSKY_PASSWORD: '',
      OPENSKY_AUTH_MODE: 'oauth',
    }, () => {
      noteLocalProvidersSaved(['OPENSKY_CLIENT_ID'], root);
      bindLocalIntegrityRoot(root);
      const text = fs.readFileSync(storePath(root), 'utf8');
      assert.equal(text.includes('secret-fixture'), false);
      assert.equal(text.includes('id-fixture'), false);
      assert.match(JSON.parse(text).openskyMac, /^[0-9a-f]{64}$/);
      assert.equal(localProviderTrusted('opensky'), true);
      assert.equal(localProviderTrusted('firms'), true);
      process.env.OPENSKY_AUTH_MODE = 'basic';
      assert.equal(localProviderTrusted('opensky'), false);
      assert.equal(localProviderTrusted('firms'), true);
      pending = getOpenSkyToken();
      process.env.OPENSKY_AUTH_MODE = 'oauth';
      assert.equal(localProviderTrusted('opensky'), true);
      bindLocalIntegrityRoot('');
    });
    assert.equal(await pending, null);
  } finally {
    finish(root);
  }
});
