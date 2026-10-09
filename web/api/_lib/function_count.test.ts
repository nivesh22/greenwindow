// Guard: Vercel Hobby deploys at most 12 Functions when there is no framework. Vercel counts EVERY .ts/.js file in api/
// outside "_" files and folders, test files included (2026-10-09: 11 handlers + 5 tests failed the deploy with
// exceeded_serverless_functions_per_deployment). Keep tests in api/_tests/. See api/_lib/dispatch.ts.
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const API = join(import.meta.dirname, '..')

function functions(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    if (n.startsWith('_')) return []
    const p = join(dir, n)
    if (statSync(p).isDirectory()) return functions(p)
    return /\.(ts|js)$/.test(n) ? [p] : []
  })
}

it('api/ stays within the Vercel Hobby limit of 12 Functions', () => {
  expect(functions(API).length).toBeLessThanOrEqual(12)
})
