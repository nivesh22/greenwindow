/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    globals: true,
    env: { TZ: 'UTC' },
    projects: [
      { extends: true, test: { name: 'app', include: ['src/**/*.test.{ts,tsx}'], environment: 'jsdom', setupFiles: ['./src/test/setup.ts'] } },
      // Server-side agent code: Node environment, no network (ScriptedProvider and fixtures only).
      { extends: true, test: { name: 'agent', include: ['agent/**/*.test.ts', 'api/**/*.test.ts'], environment: 'node' } },
    ],
  },
  build: {
    chunkSizeWarningLimit: 900, // budget is 400 KB gzipped (spec 10.5), checked separately
  },
  server: {
    fs: { allow: ['..'] }, // tests read shared fixtures from ../tests
  },
})
