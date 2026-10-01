import cesium from 'vite-plugin-cesium';

/** Build browser assets with explicit inputs; never load environment or providers. */
export function createBrowserViteConfig({
  plugins = [],
  googleApiKey,
  cesiumToken,
  host = 'localhost',
  port = 4173,
} = {}) {
  return {
    plugins: [cesium(), ...plugins],
    server: {
      host: host || 'localhost',
      port: parseInt(port, 10) || 4173,
      allowedHosts:
        host === '0.0.0.0' || host === '::'
          ? true
          : ['localhost', '127.0.0.1', '.local'],
      // RuView is a separate checkout nested in this folder: this dev server
      // never watches, scans or serves it.
      watch: { ignored: ['**/RuView/**'] },
      fs: {
        deny: [
          '.env',
          '.env.*',
          '*.{crt,pem}',
          '**/.git/**',
          '**/ENVIRONMENT',
          '**/RuView/**',
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
        ],
      },
      // These headers protect the document containing Provider Settings.
      headers: {
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "frame-ancestors 'none'",
      },
    },
    define: {
      'import.meta.env.GOOGLE_MAPS_API_KEY': JSON.stringify(googleApiKey),
      'import.meta.env.CESIUM_ION_TOKEN': JSON.stringify(cesiumToken),
    },
    // Scan only this app's own pages for dependencies, not every HTML file below it.
    optimizeDeps: { entries: ['index.html', 'tools/*.html'] },
    build: { chunkSizeWarningLimit: 1500 },
  };
}
