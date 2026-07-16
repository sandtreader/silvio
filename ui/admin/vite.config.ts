/// <reference types="vitest/config" />
// Admin app build config (decision #11): served at /admin/ by the Silvio
// server in production; in dev the Vite proxy forwards /api to the local
// server so cookie sessions stay same-origin.

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/admin/',
  plugins: [react()],
  server: {
    // Object form: the string shorthand implies changeOrigin: true, which
    // rewrites Host to localhost:1862 and trips the server's Origin==Host
    // CSRF check. The browser's Host must pass through (tenancy only reads
    // the hostname, so 'localhost:5173' still resolves the dev group).
    // /i is the image store (#14) — brand previews and CMS thumbnails load
    // from it directly, so dev must proxy it alongside the API.
    proxy: {
      '/api': { target: 'http://localhost:1862' },
      '/i': { target: 'http://localhost:1862' },
    },
  },
  test: {
    environment: 'jsdom',
    // globals enables testing-library's automatic afterEach cleanup
    globals: true,
    setupFiles: ['./test/setup.ts'],
  },
});
