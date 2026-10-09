// Guard: Vercel Hobby deploys at most 12 Functions when there is no framework, one per file in api/ (files and folders
// starting with "_" are not Functions). Going over fails the whole deployment. See api/_lib/dispatch.ts.
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const API = join(import.meta.dirname, '..')

function functions(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    if (n.startsWith('_')) return []
    const p = join(dir, n)
    if (statSync(p).isDirectory()) return functions(p)
    return /\.(ts|js)$/.test(n) && !/\.(test|local)\.ts$/.test(n) ? [p] : []
  })
}

it('api/ stays within the Vercel Hobby limit of 12 Functions', () => {
  expect(functions(API).length).toBeLessThanOrEqual(12)
})
