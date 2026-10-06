/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    env: { TZ: 'UTC' },
  },
  build: {
    chunkSizeWarningLimit: 900, // budget is 400 KB gzipped (spec 10.5), checked separately
  },
  server: {
    fs: { allow: ['..'] }, // tests read shared fixtures from ../tests
  },
})
