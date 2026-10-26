import { fileURLToPath } from 'node:url';
import { applicationHtmlPlugin } from './application-html.js';
import cesium from 'vite-plugin-cesium';
import { DEFAULT_ALLOWED_HOSTS, hostCheckPlugin } from './allowedHosts.js';
import { embedFramingPlugin } from './embed-framing.js';
import { panelBuildPlugin } from './panel.js';

/**
 * The repository root (this file lives at `<root>/build/vite.js`), as a
 * forward-slash path for glob matching. Vite's `fs.deny` patterns are
 * matched against the full absolute file path, and a bare `**\/dist/**`
 * matches a `dist` directory at *any* depth — including dependencies that
 * ship their own, such as `node_modules/vite/dist/client/client.mjs` (the
 * dev client itself). Anchoring to this repository's root denies only the
 * project's own build output.
 */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
  .replace(/\\/g, '/')
  .replace(/\/$/, '');

export function escapeFsDenyPath(path) {
  return path.replace(/[()[\]{}*?!+@|]/g, '\\$&');
}

const REPO_ROOT_GLOB = escapeFsDenyPath(REPO_ROOT);

/**
 * Content-Security-Policy for every document the dev/preview server serves.
 * No inline script is permitted, and the only foreign script origins are the
 * three that the Bhote Koshi event's embedded media needs (YouTube, Facebook
 * and X), which frame-src matches for their players and posts. 'unsafe-eval' is
 * required: Knockout (bundled inside @cesium/widgets) resolves the global
 * object with `(0, eval)("this")` at module load, and without it the Cesium
 * widget never initializes (verified in headless Chrome). It also covers
 * Cesium's WASM decoders. `blob:` is required in the built app: Cesium's
 * bundled workers bootstrap through `importScripts(blob:...)`, which a worker
 * checks against script-src (the dev server loads them by URL instead).
 * Widen any other directive only for a real violation.
 */
export const BROWSER_CSP = [
  "default-src 'self'",
  // The Bhote Koshi event's embedded media: the YouTube player API, the
  // Facebook video SDK and X's post widget (src/data/bhoteKoshiEmbeddedMedia.js);
  // and the Maps JavaScript API that Street Level's Google Street View runs on.
  "script-src 'self' 'unsafe-eval' blob: https://www.youtube.com https://connect.facebook.net https://platform.twitter.com https://maps.googleapis.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "connect-src 'self' blob: data: https: wss: ws:",
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  // The same media's players and posts, which load in frames.
  "frame-src 'self' blob: https://www.youtube-nocookie.com https://www.youtube.com https://www.facebook.com https://platform.twitter.com",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** Response headers shared by the dev and preview servers. */
export const BROWSER_HEADERS = Object.freeze({
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': BROWSER_CSP,
  // Responses are only ever used as the type the server declares.
  'X-Content-Type-Options': 'nosniff',
});

/**
 * Content-Security-Policy for every `/api` response. API routes return data,
 * never a document, so a response opened directly in a tab gets no origin and
 * can load nothing.
 */
export const API_CSP = "default-src 'none'; sandbox";

/** Response headers every `/api` response carries. */
export const API_HEADERS = Object.freeze({
  'Content-Security-Policy': API_CSP,
  'X-Content-Type-Options': 'nosniff',
});

/**
 * Whether a request reaches an `/api` mount, by the router's own rule: the
 * prefix compared without case and followed by the end, `/` or `.`. The router
 * reads an absolute-form target's path without resolving dot segments, so the
 * path is taken here the same way (scheme and authority dropped, backslashes as
 * slashes), alongside the raw and the fully parsed path; any match counts.
 */
function isApiPath(url) {
  const raw = String(url || '/');
  const target = raw
    .trim()
    .split(/[?#]/, 1)[0]
    .replace(/\\/g, '/')
    .replace(/^[a-z][a-z0-9+.-]*:(?:\/\/[^/]*)?/i, '');
  let parsed = '';
  try {
    parsed = new URL(raw, 'http://localhost').pathname;
  } catch {
    /* the unparsed paths still decide */
  }
  return [raw.split(/[?#]/, 1)[0], target, parsed].some((path) =>
    /^\/api(?:$|[/.])/i.test(path),
  );
}

/**
 * Vite plugin that sets API_HEADERS on every API response before any other
 * middleware runs, so success, error, partial, refused and unknown-route
 * answers all carry them. Vite's `server.headers` and `preview.headers` only
 * reach the documents and assets Vite serves itself. A route may still add
 * headers; a route's own Content-Security-Policy is sent as an additional
 * policy, which can only restrict further, never replace this one.
 */
export function apiResponseHeadersPlugin() {
  const install = (server) => {
    server.middlewares.use((req, res, next) => {
      if (!isApiPath(req.url)) return next();
      for (const [name, value] of Object.entries(API_HEADERS))
        res.setHeader(name, value);
      const setHeader = res.setHeader.bind(res);
      res.setHeader = (name, value) =>
        String(name).toLowerCase() === 'content-security-policy' &&
        String(value) !== API_CSP
          ? setHeader(name, `${API_CSP}, ${value}`)
          : setHeader(name, value);
      next();
    });
  };
  return {
    name: 'api-response-headers',
    enforce: 'pre',
    configureServer: install,
    configurePreviewServer: install,
  };
}

/** Build browser assets with explicit inputs; never load environment or providers. */
export function createBrowserViteConfig({
  plugins = [],
  publicDir,
  googleApiKey,
  cesiumToken,
  mapillaryToken,
  host = 'localhost',
  port = 4173,
  allowedHosts = DEFAULT_ALLOWED_HOSTS,
  command,
} = {}) {
  return {
    plugins: [
      // First, so every API response, including a Host refusal, carries them.
      apiResponseHeadersPlugin(),
      // Next, so no provider route answers a Host the server does not allow.
      hostCheckPlugin(),
      cesium(),
      applicationHtmlPlugin(),
      ...plugins,
      embedFramingPlugin(),
      panelBuildPlugin(),
    ],
    ...(publicDir === undefined ? {} : { publicDir }),
    // A production build must not clean the dependency cache a running dev
    // server is still serving optimized module URLs from.
    ...(command === 'build' ? { cacheDir: 'node_modules/.vite-build' } : {}),
    optimizeDeps: {
      // Scan only this app's own pages for dependencies, not every HTML file below it.
      entries: ['index.html', 'tools/*.html'],
      // First reached through the SDR worker or a dynamic import. Pre-bundle
      // them at startup so first use cannot invalidate already-transformed
      // URLs with Vite's "Outdated Optimize Dep" 504 response.
      include: [
        '@jtarrio/signals/demod/demodulator.js',
        '@jtarrio/signals/demod/modes.js',
        '@jtarrio/webrtlsdr/rtlsdr.js',
        'egm96-universal',
        // Loaded on demand when the first street-level image opens.
        'mapillary-js',
      ],
    },
    server: {
      host: host || 'localhost',
      port: parseInt(port, 10) || 4173,
      // The port is a contract (Pinokio, the README and the supervisor all
      // assume it): a busy port fails the start instead of silently moving
      // to the next one. PORT= stays the way to choose another.
      strictPort: true,
      // A wildcard bind only chooses interfaces; it never disables Vite's
      // Host-header check. LAN hostnames are added explicitly (see
      // build/allowedHosts.js); IP addresses are always accepted.
      allowedHosts: [...allowedHosts],
      // RuView is a separate checkout nested in this folder: this dev server
      // never watches, scans or serves it. The rest are runtime output and
      // caches (provider caches, logs, builds, QA captures, Ultra media and
      // device recordings) that are never served as modules: watching them
      // only costs handles and wakes the watcher on every write. Vite adds
      // these to its own ignore list; public/ and config/*.json stay watched.
      watch: {
        ignored: [
          '**/RuView/**',
          '**/.gev-cache/**',
          // The AI World data (world tape, datasets, models): written all
          // the time, thousands of files a day.
          '**/.gev-data/**',
          '**/.gev-logs/**',
          '**/dist/**',
          '**/qa-artifacts/**',
          '**/qa-shots/**',
          '**/config/ultra-media/**',
          '**/config/device-recordings/**',
        ],
      },
      fs: {
        deny: [
          '.env',
          '.env.*',
          '*.{crt,pem}',
          '**/.git/**',
          '**/ENVIRONMENT',
          '**/RuView/**',
          // Runtime output: provider caches and the supervisor/realtime logs
          // (process ids, launcher chain, absolute paths, provider stacks).
          // Vite's static server does not skip dotfiles in dev mode, so these
          // must be denied explicitly; the watch ignores above do not serve.
          '**/.gev-cache/**',
          '**/.gev-logs/**',
          // The AI World data: recorded feeds, the owner's own devices
          // (personal class) among them, datasets and models. Only its
          // /api/ai-world routes read it, never the static server.
          '**/.gev-data/**',
          // Private camera logins (also refused by that plugin's own guard,
          // which catches the spellings a pattern cannot).
          '**/private-cameras.json',
          '**/.private-cameras.json.*',
          // Ultra Security Package stores: the owner's numbers, the sealed
          // help tokens with their key, the help inbox, the home list of
          // other people's sealed help tokens, and the checks on the
          // directory, the relay and the phone packages (also refused by
          // the device-feeds guard, which catches the other spellings).
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
          // Checks on cameras, tracked devices and provider keys, and the
          // key those checks are made with. Addresses and secrets stay in
          // their own files; this one is still never served.
          '**/local-integrity.json',
          '**/.local-integrity.json.*',
          '**/local-integrity.key',
          '**/.local-integrity.key.*',
          // Social Media Analysis logins. The password is sealed in the json
          // file; neither file is served.
          '**/social-accounts.json',
          '**/.social-accounts.json.*',
          '**/social-accounts.key',
          '**/.social-accounts.key.*',
          // Root-anchored: a bare '**/dist/**' would also deny every
          // dependency's own dist/ (e.g. node_modules/vite/dist/client),
          // breaking /@vite/client and other dev-client assets.
          `${REPO_ROOT_GLOB}/dist/**`,
        ],
      },
      // These headers protect the document containing Provider Settings and
      // give the whole page a real Content-Security-Policy (BROWSER_CSP).
      // Embed-mode documents are framable instead: embed-framing.js rewrites
      // only the frame-ancestors directive and keeps the rest of the policy.
      headers: BROWSER_HEADERS,
    },
    // The preview server serves the same documents, so it carries the same
    // framing + CSP hardening (one constant, no drift).
    preview: { headers: BROWSER_HEADERS },
    define: {
      'import.meta.env.GOOGLE_MAPS_API_KEY': JSON.stringify(googleApiKey),
      'import.meta.env.CESIUM_ION_TOKEN': JSON.stringify(cesiumToken),
      // Mapillary client tokens are public by design (see SECURITY.md).
      'import.meta.env.MAPILLARY_CLIENT_TOKEN': JSON.stringify(
        mapillaryToken ?? '',
      ),
    },
    build: { chunkSizeWarningLimit: 1500 },
  };
}
