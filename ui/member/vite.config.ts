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
    // Object form: the string shorthand implies changeOrigin: true, which
    // rewrites Host to localhost:1862 and trips the server's Origin==Host
    // CSRF check. The browser's Host must pass through (tenancy only reads
    // the hostname, so 'localhost:5173' still resolves the dev group).
    // /i is the image store (#14) — member/listing photos and brand chrome
    // load from it directly, so dev must proxy it alongside the API.
    proxy: {
      '/api': { target: 'http://localhost:1862' },
      '/i': { target: 'http://localhost:1862' },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['test/setup.ts'],
  },
});
