// Guard: server code runs as native Node ESM on Vercel, which needs explicit extensions on relative imports.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const SHARED = ['src/scheduler/optimizer.ts', 'src/lib/time.ts', 'src/lib/format.ts', 'src/data/schemas.ts', 'src/data/parse.ts', 'src/data/models.ts', 'src/lib/calendar.ts']

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
  })
}

it('every relative import in server code ends in .js', () => {
  const files = [...walk(join(ROOT, 'agent')), ...walk(join(ROOT, 'api')), ...SHARED.map((f) => join(ROOT, f))]
  const bad: string[] = []
  for (const f of files) {
    for (const m of readFileSync(f, 'utf8').matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
      if (!m[1]!.endsWith('.js')) bad.push(`${f}: ${m[1]}`)
    }
  }
  expect(bad).toEqual([])
})
