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
import { healthPlugin } from './health.js';
import { routeGuardPlugin } from './route-guard.js';
import { singleInstancePlugin } from './single-instance.js';
import { standaloneVoiceTools } from './voiceTools.js';
import { tailnetDashboardPlugin } from '../../Mirror of PC GEVC on Cell/tailnet-dashboard.js';
import { unwatchedRuntimeDirsPlugin } from './unwatched-cache.js';

const root = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Load this checkout's configuration and attach its local provider middleware.
 * Vite passes no `sourceRoot`; a test passes an empty temp folder, so it loads
 * none of this machine's .env keys, integrity store, data, caches or private
 * config, and its single-instance lock is not the running dev server's.
 */
export default defineConfig(({ command, mode, sourceRoot }) => {
  // Without one, everything below is exactly as it was: this checkout.
  const checkout = sourceRoot || root;
  const loaded = loadEnv(mode, checkout, '');
  for (const [key, value] of Object.entries(loaded)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
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
      }),
      localMcpPlugin(),
      apiNotFoundPlugin(),
      // The same dashboard on this machine's Tailscale address (off unless set).
      tailnetDashboardPlugin(),
      unwatchedRuntimeDirsPlugin(),
    ],
    googleApiKey: localClientCredential('google', 'GOOGLE_MAPS_API_KEY'),
    cesiumToken: localClientCredential('cesium', 'CESIUM_ION_TOKEN'),
    mapillaryToken: process.env.MAPILLARY_CLIENT_TOKEN,
    host: process.env.HOST,
    port: process.env.PORT,
    allowedHosts: resolveAllowedHosts(process.env.GEV_ALLOWED_HOSTS),
    command,
  });
});
