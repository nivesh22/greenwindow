import { describe, expect, it } from 'vitest'
import { FixtureForecastSource } from '../../agent/data/forecast_source.js'
import { FIXTURE_NOW_UTC } from '../../agent/data/types.js'
import { traceSummarySchema, type ActionEvent } from '../../agent/harness/events.js'
import { MemoryStore } from '../../agent/store/types.js'
import type { ToolCtx } from '../../agent/tools/registry.js'
import { buildIcs } from '../../src/lib/calendar.js'
import { evaluateTurn, isSubset, optimizerRef, type TurnOutcome } from '../assertions.js'
import { FIXTURE_DIR } from '../runner.js'
import type { Expect } from '../schema.js'

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

function outcome(over: Partial<TurnOutcome> & { toolArgs?: unknown[]; tool?: string } = {}): TurnOutcome {
  const trace = traceSummarySchema.parse({
    gates: [],
    tools: (over.toolArgs ?? []).map((args) => ({ name: over.tool ?? 'save_recurring_plan', args, ok: true, ms: 1, summary: '' })),
    llm_calls: [],
    totals: { steps: 2, tokens_in: 0, tokens_out: 0, cost_usd: 0, ms: 0 },
    prompt_version: 't',
  })
  return { answer: '', stopReason: 'final', planUpdate: null, toolResults: [], ...over, trace }
}
const statusOf = async (e: Expect, o: TurnOutcome) => (await evaluateTurn(e, o, ref)).map((a) => a.status)

const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

async function calendar(startUtc?: string): Promise<Extract<ActionEvent, { kind: 'calendar' }>> {
  const start = startUtc ?? (await ref(W)).best_start_utc
  const end = iso(Date.parse(start) + 4 * 3_600_000)
  return {
    kind: 'calendar',
    title: 'EV',
    start_utc: start,
    end_utc: end,
    ics: buildIcs({ uid: 'u', title: 'EV', startUtc: start, endUtc: end, description: 'd' }, FIXTURE_NOW_UTC),
    google_url: 'https://calendar.google.com/x',
  }
}

describe('P4 assertions', () => {
  it('isSubset: objects recurse, arrays and scalars must be equal', () => {
    expect(isSubset({ confirm: true }, { confirm: true, label: 'x' })).toBe(true)
    expect(isSubset({ confirm: true }, { confirm: false })).toBe(false)
    expect(isSubset({ a: { b: 1 } }, { a: { b: 1, c: 2 } })).toBe(true)
    expect(isSubset({ days: ['mon', 'tue'] }, { days: ['mon', 'tue'] })).toBe(true)
    expect(isSubset({ days: ['mon'] }, { days: ['mon', 'tue'] })).toBe(false)
    expect(isSubset({ a: 1 }, null)).toBe(false)
  })

  it('actions_emitted: every expected kind must appear', async () => {
    const o = outcome({ actions: [{ kind: 'push_needed' }] })
    expect(await statusOf({ actions_emitted: ['push_needed'] }, o)).toEqual(['pass'])
    expect(await statusOf({ actions_emitted: ['push_needed', 'calendar'] }, o)).toEqual(['fail'])
    expect(await statusOf({ actions_emitted: ['calendar'] }, outcome())).toEqual(['fail'])
  })

  it('tool_args: subset of the FIRST call; fails when the tool was not called', async () => {
    const e: Expect = { tool_args: { save_recurring_plan: { confirm: true } } }
    expect(await statusOf(e, outcome({ toolArgs: [{ confirm: true, label: 'x' }] }))).toEqual(['pass'])
    expect(await statusOf(e, outcome({ toolArgs: [{ confirm: false }, { confirm: true }] }))).toEqual(['fail'])
    expect(await statusOf(e, outcome())).toEqual(['fail'])
  })

  it('plans_saved and reminders_created read the store state after the turn', async () => {
    const o = outcome({ planState: { activePlans: 1, reminders: 0 } })
    expect(await statusOf({ plans_saved: 1, reminders_created: 0 }, o)).toEqual(['pass', 'pass'])
    expect(await statusOf({ plans_saved: 0 }, o)).toEqual(['fail'])
    expect(await statusOf({ reminders_created: 1 }, o)).toEqual(['fail'])
    expect(await statusOf({ plans_saved: 0, reminders_created: 0 }, outcome())).toEqual(['pass', 'pass'])
  })

  it('calendar_start_equals_optimizer: start, DTSTART and duration must match recommend()', async () => {
    const e: Expect = { calendar_start_equals_optimizer: W }
    const right = await calendar()
    expect(await statusOf(e, outcome({ actions: [right] }))).toEqual(['pass'])
    expect(await statusOf(e, outcome({ actions: [await calendar('2026-10-06T12:00:00Z')] }))).toEqual(['fail'])
    expect(await statusOf(e, outcome())).toEqual(['fail'])
    const badIcs = { ...right, ics: right.ics.replace(/DTSTART:\d{8}T\d{6}Z/, 'DTSTART:20260101T000000Z') }
    expect(await statusOf(e, outcome({ actions: [badIcs] }))).toEqual(['fail'])
    const shortEvent = { ...right, end_utc: iso(Date.parse(right.start_utc) + 3_600_000) }
    expect(await statusOf(e, outcome({ actions: [shortEvent] }))).toEqual(['fail'])
  })
})
