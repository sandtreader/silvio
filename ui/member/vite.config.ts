/// <reference types="vitest/config" />
// Member PWA build (decision #11): served at the site root by the Fastify
// server in production; the dev server proxies /api to the local server.
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: '/',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        // The service worker's scope is the site root, but /admin (the admin
        // app) and /api must never be answered from the member app's cache —
        // without this the SPA navigation fallback hijacks them offline-style.
        navigateFallbackDenylist: [/^\/admin/, /^\/api\//],
      },
      manifest: {
        name: 'Silvio',
        short_name: 'Silvio',
        description: 'Silvio LETS — trade in your community currency',
        theme_color: '#2e7d32',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
        icons: [
          {
            src: 'icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any',
          },
        ],
      },
    }),
  ],
  server: {
    proxy: { '/api': 'http://localhost:1862' },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['test/setup.ts'],
  },
});
