// The golden eval suite as a Vitest file. Mode from EVAL_MODE (replay default, record, live).
//   npx vitest run --config evals/vitest.config.ts
// Writes web/evals/out/{results.json,summary.md}. The last test enforces the pass criteria (design §15.4).
import { afterAll, describe, expect, it } from 'vitest'
import {
  loadScenarios,
  parseMode,
  runScenario,
  verdictOf,
  writeReport,
  type SpendCap,
  type SuiteResult,
} from '../runner.js'
import type { ScenarioResult } from '../schema.js'

const mode = parseMode(process.env.EVAL_MODE)
const scenarios = loadScenarios()
const spend: SpendCap = { limitUsd: Number(process.env.EVAL_BUDGET_USD ?? '0.50'), spentUsd: 0 }
const results: ScenarioResult[] = []

describe(`agent evals (${mode})`, () => {
  for (const s of scenarios) {
    it(s.id, async (ctx) => {
      const r = await runScenario(s, { mode, spend })
      results.push(r)
      if (r.status === 'skipped') ctx.skip(r.note)
      // Failures do not throw here: the thresholds test below decides (>= 90% may pass with a few failures).
      if (r.status === 'failed') console.warn(`FAILED ${s.id}: ${r.note}`)
    })
  }

  afterAll(() => {
    const suite: SuiteResult = { mode, results }
    writeReport(suite, verdictOf(suite, { requireRecordings: process.env.EVAL_REQUIRE_RECORDINGS === '1' }))
  })

  it('suite thresholds (overall >= 90%, window correctness 100%, banned claims 0)', () => {
    const v = verdictOf({ mode, results }, { requireRecordings: process.env.EVAL_REQUIRE_RECORDINGS === '1' })
    const failed = results.filter((r) => r.status === 'failed').map((r) => `${r.id}: ${r.note}`)
    const detail = `${v.passed} passed, ${v.failed} failed, ${v.skipped} skipped\n${failed.join('\n')}`
    expect(v.reasons, detail).toEqual([])
  })
})
