import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Standalone config so the evals run without touching the shared web/vite.config.ts:
//   npx vitest run --config evals/vitest.config.ts
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export default defineConfig({
  root,
  test: {
    name: 'evals',
    include: ['evals/unit/**/*.test.ts', 'evals/suite/**/*.test.ts'],
    environment: 'node',
    env: { TZ: 'UTC' },
    testTimeout: 180_000,
    hookTimeout: 120_000,
  },
  server: { fs: { allow: ['..'] } },
})
