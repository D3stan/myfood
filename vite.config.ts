import { defineConfig } from 'vitest/config';
import { VitePWA } from 'vite-plugin-pwa';

// One id per build: baked into the bundle as __BUILD__ and written to dist/web/build.txt for the server.
export default defineConfig(({ command }) => {
  const build = command === 'serve' ? 'dev' : Date.now().toString(36);
  return {
  root: 'src/web',
  define: { __BUILD__: JSON.stringify(build) },
  build: { outDir: '../../dist/web', emptyOutDir: true },
  server: { proxy: { '/api': 'http://127.0.0.1:3000' } },
  test: { root: '.', include: ['tests/**/*.test.ts'] },
  plugins: [
    { name: 'build-id', generateBundle() { this.emitFile({ type: 'asset', fileName: 'build.txt', source: build }); } },
    VitePWA({
      strategies: 'injectManifest',
      srcDir: '.',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      includeAssets: ['apple-touch-icon.png', 'favicon.svg'],
      injectManifest: { globPatterns: ['**/*.{js,css,html,woff2,png,svg}'] },
      manifest: {
        name: 'MyFood',
        short_name: 'MyFood',
        description: 'Shared pantry',
        display: 'standalone',
        start_url: '/',
        background_color: '#ece2c6',
        theme_color: '#ece2c6',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
};
});
