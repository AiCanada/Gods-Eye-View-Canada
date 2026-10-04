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
import { routeGuardPlugin } from './route-guard.js';
import { singleInstancePlugin } from './single-instance.js';
import { standaloneVoiceTools } from './voiceTools.js';

const root = fileURLToPath(new URL('../../', import.meta.url));

/** Load this checkout's configuration and attach its local provider middleware. */
export default defineConfig(({ command, mode }) => {
  const loaded = loadEnv(mode, root, '');
  for (const [key, value] of Object.entries(loaded)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  bindLocalIntegrityRoot(root);
  return createBrowserViteConfig({
    // The guard goes first: it wraps every route registered after it
    // (the provider routes and the MCP endpoint alike).
    plugins: [
      // Stops the previous dev server of this checkout before the port is taken.
      singleInstancePlugin({ root }),
      routeGuardPlugin(),
      ...localProviderPlugins({ realtime: { tools: standaloneVoiceTools() } }),
      localMcpPlugin(),
      apiNotFoundPlugin(),
    ],
    googleApiKey: localClientCredential('google', 'GOOGLE_MAPS_API_KEY'),
    cesiumToken: localClientCredential('cesium', 'CESIUM_ION_TOKEN'),
    host: process.env.HOST,
    port: process.env.PORT,
    allowedHosts: resolveAllowedHosts(process.env.GEV_ALLOWED_HOSTS),
    command,
  });
});
