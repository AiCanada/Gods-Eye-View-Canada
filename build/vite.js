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
