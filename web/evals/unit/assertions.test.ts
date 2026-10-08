import { describe, expect, it } from 'vitest'
import { FixtureForecastSource } from '../../agent/data/forecast_source.js'
import { FIXTURE_NOW_UTC } from '../../agent/data/types.js'
import { traceSummarySchema, type PlanUpdate } from '../../agent/harness/events.js'
import { MemoryStore } from '../../agent/store/types.js'
import type { ToolCtx } from '../../agent/tools/registry.js'
import { evaluateTurn, isSubsequence, optimizerRef, questionCount, GATES_NOT_WIRED, type TurnOutcome } from '../assertions.js'
import type { Expect } from '../schema.js'
import { FIXTURE_DIR } from '../runner.js'

const NOW = Date.parse(FIXTURE_NOW_UTC)
const ref = optimizerRef(
  (): ToolCtx => ({
    userId: null,
    isAnonymous: true,
    nowMs: NOW,
    data: new FixtureForecastSource(FIXTURE_DIR, () => NOW),
    store: new MemoryStore(),
    riskMode: 'expected',
    turn: { lastRecommendation: null },
    signal: new AbortController().signal,
  }),
)
const W = { duration_h: 4, power_kw: 7, deadline_local: '2026-10-06T08:00', mode: 'expected' as const }

function outcome(over: Partial<TurnOutcome> & { tools?: string[]; gates?: { gate: string; choice: string }[]; steps?: number; cost?: number } = {}): TurnOutcome {
  const trace = traceSummarySchema.parse({
    gates: (over.gates ?? []).map((g) => ({ ...g, confidence: 1, source: 'rules', latency_ms: 0 })),
    tools: (over.tools ?? []).map((name) => ({ name, args: {}, ok: true, ms: 1, summary: '' })),
    llm_calls: [],
    totals: { steps: over.steps ?? 2, tokens_in: 0, tokens_out: 0, cost_usd: over.cost ?? 0, ms: 0 },
    prompt_version: 't',
  })
  return { answer: '', stopReason: 'final', planUpdate: null, toolResults: [], ...over, trace }
}

const run = (e: Expect, o: TurnOutcome) => evaluateTurn(e, o, ref)
const statusOf = async (e: Expect, o: TurnOutcome) => (await run(e, o)).map((a) => a.status)

describe('helpers', () => {
  it('subsequence keeps order', () => {
    expect(isSubsequence(['a', 'c'], ['a', 'b', 'c'])).toBe(true)
    expect(isSubsequence(['c', 'a'], ['a', 'b', 'c'])).toBe(false)
    expect(isSubsequence([], [])).toBe(true)
  })
  it('counts question sentences', () => {
    expect(questionCount('How long will it run? Tell me.')).toBe(1)
    expect(questionCount('How long? And how many kW?')).toBe(2)
    expect(questionCount('No questions here.')).toBe(0)
  })
})

describe('evaluateTurn', () => {
  it('tools_called is an ordered subset; tool_not_called catches extras', async () => {
    const o = outcome({ tools: ['lookup_device', 'recommend_window', 'estimate_co2'] })
    expect(await statusOf({ tools_called: ['lookup_device', 'estimate_co2'] }, o)).toEqual(['pass'])
    expect(await statusOf({ tools_called: ['estimate_co2', 'lookup_device'] }, o)).toEqual(['fail'])
    expect(await statusOf({ tool_not_called: ['get_forecast'] }, o)).toEqual(['pass'])
    expect(await statusOf({ tool_not_called: ['estimate_co2'] }, o)).toEqual(['fail'])
  })

  it('gate assertions skip with a "gates not wired" note when the trace lacks the gate', async () => {
    const o = outcome({ gates: [{ gate: 'grounding', choice: 'pass' }] })
    const [a] = await run({ gates: { router: 'plan_job' } }, o)
    expect(a?.status).toBe('skip')
    expect(a?.detail).toContain(GATES_NOT_WIRED)
    expect(await statusOf({ gates: { grounding: 'pass' } }, o)).toEqual(['pass'])
    expect(await statusOf({ gates: { grounding: 'templated' } }, o)).toEqual(['fail'])
  })

  it('window_equals_optimizer compares plan_update to recommend() and checks the London time in the answer', async () => {
    const r = await ref(W)
    const plan: PlanUpdate = {
      duration_h: 4, power_kw: 7, earliest_utc: r.earliest_utc, deadline_utc: r.deadline_utc, mode: 'expected',
      model: r.model, best_start_utc: r.best_start_utc, run_id: r.run_id,
    }
    const clock = /\d{1,2}:\d{2}/.exec(r.best_start_london)?.[0] ?? ''
    const good = outcome({ planUpdate: plan, answer: `Start at ${clock} London time.` })
    expect(await statusOf({ window_equals_optimizer: W }, good)).toEqual(['pass'])

    const wrongStart = outcome({ planUpdate: { ...plan, best_start_utc: '2026-10-06T23:00:00Z' }, answer: `Start at ${clock}.` })
    expect(await statusOf({ window_equals_optimizer: W }, wrongStart)).toEqual(['fail'])
    const wrongText = outcome({ planUpdate: plan, answer: 'Start at 99:99.' })
    expect(await statusOf({ window_equals_optimizer: W }, wrongText)).toEqual(['fail'])
    expect(await statusOf({ window_equals_optimizer: W }, outcome({ answer: clock }))).toEqual(['fail'])
  })

  it('co2_equals_tool needs the tool figure in the answer', async () => {
    const toolResults = [{ tool: 'estimate_co2', ok: true, data: { display: { point: '1.2 kg', low: '0.5 kg', high: '1.9 kg' } } }]
    expect(await statusOf({ co2_equals_tool: true }, outcome({ toolResults, answer: 'About 1.2 kg less (estimate).' }))).toEqual(['pass'])
    expect(await statusOf({ co2_equals_tool: true }, outcome({ toolResults, answer: 'About 3 kg less.' }))).toEqual(['fail'])
    expect(await statusOf({ co2_equals_tool: true }, outcome({ answer: 'x' }))).toEqual(['fail'])
  })

  it('caveat, banned claim, assumed', async () => {
    expect(await statusOf({ contains_caveat: true }, outcome({ answer: 'This is an estimate of the difference in average grid intensity.' }))).toEqual(['pass'])
    expect(await statusOf({ contains_caveat: true }, outcome({ answer: 'Start at 3am.' }))).toEqual(['fail'])
    expect(await statusOf({ no_banned_claim: true }, outcome({ answer: 'You saved 2 kg of CO2 by waiting.' }))).toEqual(['fail'])
    expect(await statusOf({ no_banned_claim: true }, outcome({ answer: 'The estimated difference in average grid intensity is small.' }))).toEqual(['pass'])
    expect(await statusOf({ says_assumed: true }, outcome({ answer: 'I assumed a typical 1.2 kW draw.' }))).toEqual(['pass'])
    expect(await statusOf({ says_assumed: true }, outcome({ answer: 'Start at 3am.' }))).toEqual(['fail'])
  })

  it('asks_one_question: exactly one ? and no plan_update', async () => {
    expect(await statusOf({ asks_one_question: true }, outcome({ answer: 'How long should it run?' }))).toEqual(['pass'])
    expect(await statusOf({ asks_one_question: true }, outcome({ answer: 'How long? And how much power?' }))).toEqual(['fail'])
  })

  it('refuses: no tools and guard_blocked or a scope reply', async () => {
    expect(await statusOf({ refuses: true }, outcome({ answer: 'Sorry, I can only help with electricity planning.' }))).toEqual(['pass'])
    expect(await statusOf({ refuses: true }, outcome({ stopReason: 'guard_blocked', answer: 'No.' }))).toEqual(['pass'])
    expect(await statusOf({ refuses: true }, outcome({ answer: 'Sure, here is a recipe.' }))).toEqual(['fail'])
    expect(await statusOf({ refuses: true }, outcome({ tools: ['get_forecast'], answer: 'Sorry, I cannot.' }))).toEqual(['fail'])
  })

  it('budgets, stop reason and text matches', async () => {
    const o = outcome({ steps: 6, cost: 0.02, stopReason: 'max_steps', answer: 'Hello World' })
    expect(await statusOf({ max_steps: 5 }, o)).toEqual(['fail'])
    expect(await statusOf({ max_steps: 6 }, o)).toEqual(['pass'])
    expect(await statusOf({ max_cost_usd: 0.01 }, o)).toEqual(['fail'])
    expect(await statusOf({ stop_reason: 'final' }, o)).toEqual(['fail'])
    expect(await statusOf({ answer_contains: ['hello'], answer_excludes: ['secret'], answer_matches: ['w.rld'] }, o)).toEqual(['pass', 'pass', 'pass'])
    expect(await statusOf({ answer_excludes: ['hello'] }, o)).toEqual(['fail'])
  })
})
