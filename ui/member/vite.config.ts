/// <reference types="vitest/config" />
// Member PWA build (decisions #11/#12): served at /app/ inside the
// server-rendered brochure shell by the Fastify server in production; the
// dev server proxies /api to the local server.
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: '/app/',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        // The service worker is scoped to /app/, so brochure pages
        // (/, /market), /admin and /api are outside its reach and are never
        // answered from the app's cache — brochure HTML must always come
        // fresh from the server (decision #12). The explicit fallback keeps
        // SPA navigations within /app/; the /api denylist is belt-and-braces
        // should anything ever route API-shaped navigations under scope.
        navigateFallback: '/app/index.html',
        navigateFallbackDenylist: [/^\/api\//],
      },
      manifest: {
        name: 'Silvio',
        short_name: 'Silvio',
        description: 'Silvio LETS — trade in your community currency',
        theme_color: '#2e7d32',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/app/',
        scope: '/app/',
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
