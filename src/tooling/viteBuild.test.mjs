// First: this process works in an empty temp folder, and the app's Vite config
// is given it as its root, so no .env key, integrity store, cache or private
// config of this machine reaches the test.
import { isolatedCwd } from './isolatedCwd.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BROWSER_CSP, createBrowserViteConfig } from '../../build/vite.js';
import standaloneConfig, * as compatibility from '../../vite.config.js';
import * as providers from '../../server/providers/local.js';

test('explicit build inputs preserve browser-only defines, plugin order and loopback protections', () => {
  const plugin = { name: 'fixture-provider' };
  const config = createBrowserViteConfig({
    plugins: [plugin],
    googleApiKey: 'browser-fixture',
    cesiumToken: 'ion-fixture',
  });
  // The Host check runs before every other plugin's middleware.
  assert.equal(config.plugins[0].name, 'host-check');
  assert.equal(config.plugins[0].enforce, 'pre');
  assert.equal(config.plugins[3], plugin);
  assert.equal(config.server.host, 'localhost');
  assert.equal(config.server.port, 4173);
  assert.deepEqual(config.server.allowedHosts, ['localhost', '127.0.0.1']);
  assert.ok(config.server.fs.deny.includes('**/ENVIRONMENT'));
  assert.ok(config.server.fs.deny.includes('.env.*'));
  // The nested RuView checkout is a separate project: never watched, served
  // or scanned for dependencies by this app's dev server.
  assert.ok(config.server.watch.ignored.includes('**/RuView/**'));
  assert.ok(config.server.fs.deny.includes('**/RuView/**'));
  // A busy port fails the start rather than silently serving the next one.
  assert.equal(config.server.strictPort, true);
  // Runtime output and caches are never modules: the watcher skips them.
  for (const pattern of [
    '**/.gev-cache/**',
    '**/.gev-data/**',
    '**/.gev-logs/**',
    '**/dist/**',
    '**/qa-artifacts/**',
    '**/qa-shots/**',
    '**/config/ultra-media/**',
    '**/config/device-recordings/**',
  ]) {
    assert.ok(config.server.watch.ignored.includes(pattern), pattern);
  }
  // Logs and caches are also never served: dev-mode sirv skips the dotfile
  // filter, so only fs.deny keeps .gev-logs/dev-server.log off the network.
  // The AI World data (the owner's devices' recordings among them) neither.
  for (const pattern of [
    '**/.gev-cache/**',
    '**/.gev-data/**',
    '**/.gev-logs/**',
  ]) {
    assert.ok(config.server.fs.deny.includes(pattern), pattern);
  }
  // Private camera logins are never static files.
  assert.ok(config.server.fs.deny.includes('**/private-cameras.json'));
  assert.ok(config.server.fs.deny.includes('**/.private-cameras.json.*'));
  // Neither are the Ultra Security Package's numbers, sealed help tokens,
  // token key, help inbox, home list (other people's sealed tokens) or the
  // checks on the directory, the relay and the phone packages, nor their
  // temp files.
  for (const store of [
    '**/ultra-help.json',
    '**/.ultra-help.json.*',
    '**/ultra-tokens.json',
    '**/.ultra-tokens.json.*',
    '**/ultra-tokens.key',
    '**/.ultra-tokens.key.*',
    '**/ultra-inbox.json',
    '**/.ultra-inbox.json.*',
    '**/ultra-network.json',
    '**/.ultra-network.json.*',
    '**/ultra-outbound.json',
    '**/.ultra-outbound.json.*',
    '**/local-integrity.json',
    '**/.local-integrity.json.*',
    '**/local-integrity.key',
    '**/.local-integrity.key.*',
    '**/social-accounts.json',
    '**/.social-accounts.json.*',
    '**/social-accounts.key',
    '**/.social-accounts.key.*',
  ]) {
    assert.ok(config.server.fs.deny.includes(store), store);
  }
  assert.deepEqual(config.optimizeDeps.entries, ['index.html', 'tools/*.html']);
  assert.equal(config.server.headers['X-Frame-Options'], 'DENY');
  assert.equal(config.server.headers['X-Content-Type-Options'], 'nosniff');
  const csp = config.server.headers['Content-Security-Policy'];
  assert.equal(csp, BROWSER_CSP);
  for (const directive of [
    "script-src 'self' 'unsafe-eval' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ]) {
    assert.ok(csp.includes(directive), directive);
  }
  assert.ok(!csp.includes("script-src 'self' 'unsafe-inline'"));
  assert.deepEqual(config.preview.headers, config.server.headers);
  assert.deepEqual(config.define, {
    'import.meta.env.GOOGLE_MAPS_API_KEY': '"browser-fixture"',
    'import.meta.env.CESIUM_ION_TOKEN': '"ion-fixture"',
    'import.meta.env.MAPILLARY_CLIENT_TOKEN': '""',
  });
  assert.equal(
    createBrowserViteConfig({ mapillaryToken: 'MLY|1|abc' }).define[
      'import.meta.env.MAPILLARY_CLIENT_TOKEN'
    ],
    '"MLY|1|abc"',
  );
  // A wildcard bind keeps the Host-header check; LAN names are explicit.
  for (const host of ['0.0.0.0', '::'])
    assert.deepEqual(
      createBrowserViteConfig({ host, port: '4800' }).server.allowedHosts,
      ['localhost', '127.0.0.1'],
    );
  assert.deepEqual(
    createBrowserViteConfig({
      host: '0.0.0.0',
      allowedHosts: ['localhost', '127.0.0.1', 'globe.lan'],
    }).server.allowedHosts,
    ['localhost', '127.0.0.1', 'globe.lan'],
  );
  assert.equal(
    createBrowserViteConfig({ host: '::', port: '4800' }).server.port,
    4800,
  );
});

test('build helper does not discover environment values or construct local providers', () => {
  const before = process.env.GOOGLE_MAPS_API_KEY;
  process.env.GOOGLE_MAPS_API_KEY = 'environment-fixture';
  try {
    const config = createBrowserViteConfig();
    assert.equal(
      config.define['import.meta.env.GOOGLE_MAPS_API_KEY'],
      undefined,
    );
    assert.deepEqual(
      config.plugins.slice(3).map((plugin) => plugin.name),
      ['embed-framing', 'panel-build'],
    );
  } finally {
    if (before === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
    else process.env.GOOGLE_MAPS_API_KEY = before;
  }
});

test('root config retains existing named exports and standalone provider order', () => {
  for (const [name, value] of Object.entries(providers))
    assert.equal(compatibility[name], value, name);
  const config = standaloneConfig({ mode: 'test', sourceRoot: isolatedCwd });
  assert.deepEqual(
    config.plugins.slice(6, -6).map((plugin) => plugin.name),
    providers
      .localProviderPlugins({ sourceRoot: isolatedCwd })
      .map((plugin) => plugin.name),
  );
  // The single-instance guard stops the previous dev server before anything
  // else runs; the route guard is registered before every provider: it can
  // only wrap routes that are added after it. Host check, Cesium and the
  // application HTML plugin come first (build/vite.js). The health route
  // follows the guard and is dev-only.
  assert.equal(config.plugins[0].name, 'host-check');
  assert.equal(config.plugins[3].name, 'dev-single-instance');
  assert.equal(config.plugins[4].name, 'route-guard');
  assert.equal(config.plugins[5].name, 'gev-health');
  assert.equal(config.plugins[5].apply, 'serve');
  assert.equal(config.plugins.at(-7).name, 'gev-key-setup');
  // The local MCP route follows every provider and precedes the API fallback.
  assert.equal(config.plugins.at(-6).name, 'local-mcp');
  assert.equal(config.plugins.at(-5).name, 'api-not-found');
  // The tailnet copy of the dashboard serves the same middleware (off unless set).
  assert.equal(config.plugins.at(-4).name, 'gev-tailnet-dashboard');
  // Config-only, so it sits after the provider slice rather than in it.
  assert.equal(config.plugins.at(-3).name, 'gev-unwatched-runtime-dirs');
  assert.equal(config.plugins.at(-2).name, 'embed-framing');
  assert.equal(config.plugins.at(-1).name, 'panel-build');
});

test('directories the server writes while it runs are kept out of the dev watcher', () => {
  // Providers write cache files and logs here while the app runs, and the AI
  // World recorder its tape and models in .gev-data; none of it is source, so
  // the dev watcher has no reason to stat it.
  const config = standaloneConfig({ mode: 'test', sourceRoot: isolatedCwd });
  const plugin = config.plugins.find(
    ({ name }) => name === 'gev-unwatched-runtime-dirs',
  );
  // Dev only: preview and build have no watcher.
  assert.equal(plugin.apply, 'serve');
  assert.deepEqual(plugin.config().server.watch.ignored, [
    '**/.gev-cache/**',
    '**/.gev-logs/**',
    '**/.gev-data/**',
  ]);
});

test('build export resolves in Node and has no browser fallback', async () => {
  const exported = await import('gods-eye-view/build/vite');
  assert.equal(exported.createBrowserViteConfig, createBrowserViteConfig);
  const pkg = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url)),
  );
  assert.deepEqual(pkg.exports['./build/vite'], { node: './build/vite.js' });
});

test('only embed-mode documents may be framed, and only by the allowed ancestors', async () => {
  const { embedFramingPlugin, isEmbedDocumentRequest } =
    await import('../../build/embed-framing.js');
  assert.equal(isEmbedDocumentRequest('/?embed=1'), true);
  assert.equal(isEmbedDocumentRequest('/index.html?embed=1#v=2'), true);
  assert.equal(isEmbedDocumentRequest('/?embed=0'), false);
  assert.equal(isEmbedDocumentRequest('/api/x?embed=1'), false);
  assert.equal(isEmbedDocumentRequest('/src/main.js?embed=1'), false);
  let middleware;
  embedFramingPlugin({ ancestors: 'https://a.example' }).configureServer({
    middlewares: { use: (handler) => (middleware = handler) },
  });
  const response = () => {
    const headers = new Map();
    return {
      headers,
      setHeader(name, value) {
        headers.set(name.toLowerCase(), value);
        return this;
      },
    };
  };
  const embedded = response();
  middleware({ url: '/?embed=1' }, embedded, () => {});
  // The server's protections, written later at send time.
  embedded.setHeader('X-Frame-Options', 'DENY');
  embedded.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  embedded.setHeader('Content-Type', 'text/html');
  assert.deepEqual(Object.fromEntries(embedded.headers), {
    'content-security-policy': 'frame-ancestors https://a.example',
    'content-type': 'text/html',
  });
  let open;
  embedFramingPlugin({ ancestors: '*' }).configureServer({
    middlewares: { use: (handler) => (open = handler) },
  });
  const anywhere = response();
  open({ url: '/?embed=1' }, anywhere, () => {});
  anywhere.setHeader('X-Frame-Options', 'DENY');
  anywhere.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  assert.deepEqual(Object.fromEntries(anywhere.headers), {});
  // A full policy keeps its other directives; only the framing rule changes.
  const full = "default-src 'self'; script-src 'self'; frame-ancestors 'none'";
  const embeddedFull = response();
  middleware({ url: '/?embed=1' }, embeddedFull, () => {});
  embeddedFull.setHeader('Content-Security-Policy', full);
  assert.equal(
    embeddedFull.headers.get('content-security-policy'),
    "default-src 'self'; script-src 'self'; frame-ancestors https://a.example",
  );
  const anywhereFull = response();
  open({ url: '/?embed=1' }, anywhereFull, () => {});
  anywhereFull.setHeader('Content-Security-Policy', full);
  assert.equal(
    anywhereFull.headers.get('content-security-policy'),
    "default-src 'self'; script-src 'self'",
  );
  const normal = response();
  middleware({ url: '/' }, normal, () => {});
  normal.setHeader('X-Frame-Options', 'DENY');
  normal.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  assert.deepEqual(Object.fromEntries(normal.headers), {
    'x-frame-options': 'DENY',
    'content-security-policy': "frame-ancestors 'none'",
  });
  // Unset, no page may frame even embed-mode documents.
  for (const ancestors of ['', '   ']) {
    const plugin = embedFramingPlugin({ ancestors });
    assert.equal(plugin.name, 'embed-framing');
    assert.equal(plugin.configureServer, undefined);
    assert.equal(plugin.configurePreviewServer, undefined);
  }
});

test('the CSP admits the event media embeds and the Maps JavaScript API, and no other script origin', async () => {
  const { embeddedMediaFrameUrl, resolveEmbeddedMediaSource } =
    await import('../../src/data/bhoteKoshiEmbeddedMedia.js');
  const directive = (name) =>
    BROWSER_CSP.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${name} `))
      ?.split(/\s+/)
      .slice(1) ?? [];
  const scripts = directive('script-src');
  const frames = directive('frame-src');
  // The player API, the Facebook SDK and X's widget script.
  for (const origin of [
    'https://www.youtube.com',
    'https://connect.facebook.net',
    'https://platform.twitter.com',
  ])
    assert.ok(scripts.includes(origin), origin);
  // Only those three and Google Street View's Maps JavaScript API, never a
  // wildcard or a scheme.
  assert.deepEqual(
    scripts.filter(
      (source) => source.startsWith('http') || source === 'https:',
    ),
    [
      'https://www.youtube.com',
      'https://connect.facebook.net',
      'https://platform.twitter.com',
      'https://maps.googleapis.com',
    ],
  );
  assert.ok(!scripts.some((source) => source.includes('*')));
  // Every frame the event builds for a YouTube or Facebook source is allowed.
  for (const link of [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ',
    'https://www.facebook.com/facebook/videos/10153231379946729/',
  ]) {
    const source = resolveEmbeddedMediaSource(link);
    assert.ok(source, link);
    const origin = new URL(embeddedMediaFrameUrl(source, {})).origin;
    assert.ok(frames.includes(origin), `${link} -> ${origin}`);
  }
  // X posts load in X's own frames.
  assert.ok(frames.includes('https://platform.twitter.com'));
});
