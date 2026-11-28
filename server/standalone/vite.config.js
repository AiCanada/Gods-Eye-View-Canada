import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import { resolveAllowedHosts } from '../../build/allowedHosts.js';
import { createBrowserViteConfig } from '../../build/vite.js';
import {
  bindLocalIntegrityRoot,
  localClientCredential,
} from '../shared/localIntegrity.mjs';
import { localProviderPlugins } from '../providers/local.js';
import { localMcpPlugin } from '../mcp/plugin.js';
import { apiNotFoundPlugin } from './api-not-found.js';
import { conformanceReferencesPlugin } from './conformance-references.js';
import { googleTokenUnavailablePlugin } from './google-token-unavailable.js';
import { healthPlugin } from './health.js';
import { routeGuardPlugin } from './route-guard.js';
import { singleInstancePlugin } from './single-instance.js';
import { standaloneVoiceTools } from './voiceTools.js';
import { tailnetDashboardPlugin } from '../../Mirror of PC GEVC on Cell/tailnet-dashboard.js';
import { unwatchedRuntimeDirsPlugin } from './unwatched-cache.js';

const root = fileURLToPath(new URL('../../', import.meta.url));

/** Env-file values this process applied, kept across Vite restarts (the config module is re-bundled each time). */
const ENV_FILE_VALUES = Symbol.for('gev.standalone.envFileValues');

/**
 * Apply the env files' values without overriding the shell. A key applied from
 * a file earlier that no file sets any more is removed again, and a changed
 * value replaces the old one.
 * @param {() => Record<string, string>} read loadEnv's answer
 */
export function applyEnvFiles(read, env = process.env) {
  const previous = globalThis[ENV_FILE_VALUES] ?? new Map();
  for (const [key, value] of previous) if (env[key] === value) delete env[key];
  const applied = new Map();
  for (const [key, value] of Object.entries(read())) {
    if (env[key] !== undefined) continue;
    env[key] = value;
    applied.set(key, value);
  }
  globalThis[ENV_FILE_VALUES] = applied;
}
/**
 * Load this checkout's configuration and attach its local provider middleware.
 * Vite passes no `sourceRoot`; a test passes an empty temp folder, so it loads
 * none of this machine's .env keys, integrity store, data, caches or private
 * config, and its single-instance lock is not the running dev server's.
 * `nominatimStorageDir` binds the geocoder's cache to an owned directory.
 */
export function standaloneConfig(
  { command, mode, sourceRoot },
  { nominatimStorageDir } = {},
) {
  // Without one, everything below is exactly as it was: this checkout.
  const checkout = sourceRoot || root;
  applyEnvFiles(() => loadEnv(mode, checkout, ''));
  bindLocalIntegrityRoot(checkout);
  const tools = standaloneVoiceTools();
  return createBrowserViteConfig({
    // The guard goes first: it wraps every route registered after it
    // (the provider routes and the MCP endpoint alike).
    plugins: [
      // Stops the previous dev server of this checkout before the port is taken.
      singleInstancePlugin({ root: checkout }),
      routeGuardPlugin(),
      // `/__gev/health` for the supervisor's liveness probe (dev only).
      healthPlugin(),
      ...localProviderPlugins({
        realtime: { tools },
        gemini: { tools },
        ...(sourceRoot ? { sourceRoot } : {}),
        nominatimStorageDir,
      }),
      localMcpPlugin(),
      googleTokenUnavailablePlugin(),
      conformanceReferencesPlugin(),
      apiNotFoundPlugin(),
      // The same dashboard on this machine's Tailscale address (off unless set).
      tailnetDashboardPlugin(),
      unwatchedRuntimeDirsPlugin(),
    ],
    googleApiKey: localClientCredential('google', 'GOOGLE_MAPS_API_KEY'),
    cesiumToken: localClientCredential('cesium', 'CESIUM_ION_TOKEN'),
    photonUrl: process.env.PHOTON_URL,
    mapillaryToken: process.env.MAPILLARY_CLIENT_TOKEN,
    host: process.env.HOST,
    port: process.env.PORT,
    allowedHosts: resolveAllowedHosts(process.env.GEV_ALLOWED_HOSTS),
    command,
  });
}

export default defineConfig(standaloneConfig);
