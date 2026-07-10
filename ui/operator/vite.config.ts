/// <reference types="vitest/config" />
// Operator console build config (decision #21): served at /operator/ by the
// Silvio server in production; in dev the Vite proxy forwards /api to the
// local server so cookie sessions stay same-origin.

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/operator/',
  plugins: [react()],
  server: {
    proxy: { '/api': 'http://localhost:1862' },
  },
  test: {
    environment: 'jsdom',
    // globals enables testing-library's automatic afterEach cleanup
    globals: true,
    setupFiles: ['./test/setup.ts'],
  },
});
