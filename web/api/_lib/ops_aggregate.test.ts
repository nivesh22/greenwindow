import { describe, expect, it } from 'vitest'
import { opsResponseSchema } from '../../agent/harness/api_schemas.js'
import { PRICES_CHECKED } from '../../agent/config.js'
import type { OpsRows } from '../../agent/store/plan_types.js'
import { aggregateOps, confidenceBucket, percentile, DEFAULT_FREE_TIER_RPD } from './ops_aggregate.js'

const NOW = Date.UTC(2026, 9, 9, 12)
type T = OpsRows['turns'][number]
type S = OpsRows['spans'][number]

const turn = (id: string, over: Partial<T> = {}): T => ({
  id,
  intent: 'plan_job',
  stopReason: 'final',
  costUsd: 0.001,
  latencyMs: 1000,
  createdAtUtc: '2026-10-09T10:00:00Z',
  modelFinal: 'gemini-3.5-flash',
  ...over,
})
const span = (turnId: string, kind: S['kind'], name: string, over: Partial<S> = {}): S => ({ turnId, kind, name, durationMs: 100, status: 'ok', attrs: {}, ...over })
const rows = (over: Partial<OpsRows> = {}): OpsRows => ({
  turns: [],
  spans: [],
  feedback: [],
  evalRuns: [],
  budget: { month: '2026-10', spentUsd: 1.5, evalSpentUsd: 0.07, paused: false },
  ...over,
})
const run = (r: OpsRows, days = 3) => aggregateOps(r, { nowMs: NOW, days, budgetLimitUsd: 5 })

describe('helpers', () => {
  it('percentile is nearest-rank', () => {
    expect(percentile([], 0.5)).toBe(0)
    expect(percentile([5], 0.95)).toBe(5)
    const xs = Array.from({ length: 100 }, (_, i) => i + 1)
    expect(percentile(xs, 0.5)).toBe(50)
    expect(percentile(xs, 0.95)).toBe(95)
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2)
  })
  it('confidenceBucket covers 0..1 with the top edge in the last bucket', () => {
    expect([0, 0.05, 0.1, 0.55, 0.99, 1].map(confidenceBucket)).toEqual([0, 0, 1, 5, 9, 9])
    expect(confidenceBucket(-1)).toBe(0)
    expect(confidenceBucket(2)).toBe(9)
    expect(confidenceBucket('0.5')).toBeNull()
    expect(confidenceBucket(NaN)).toBeNull()
  })
})

describe('aggregateOps', () => {
  it('empty input yields a valid, zeroed response with one entry per day', () => {
    const r = run(rows())
    expect(opsResponseSchema.safeParse(r).success).toBe(true)
    expect(r.daily.map((d) => d.day)).toEqual(['2026-10-07', '2026-10-08', '2026-10-09'])
    expect(r.daily.every((d) => d.turns === 0 && d.cost_usd === 0 && d.llm_requests === 0)).toBe(true)
    expect(r.latency).toEqual([])
    expect(r.failover).toEqual({ llm_calls: 0, failovers: 0, reasons: [] })
    expect(r.prices_checked).toBe(PRICES_CHECKED)
    expect(r.free_tier_rpd_estimate).toBe(DEFAULT_FREE_TIER_RPD)
    expect(r.generated_at_utc).toBe('2026-10-09T12:00:00Z')
  })

  it('budget carries the limit from options', () => {
    expect(run(rows()).budget).toEqual({ month: '2026-10', spent_usd: 1.5, eval_spent_usd: 0.07, limit_usd: 5, paused: false })
  })

  it('daily: turns, cost and intents per UTC day; turns before the window are ignored', () => {
    const r = run(
      rows({
        turns: [
          turn('a', { createdAtUtc: '2026-10-09T01:00:00Z', costUsd: 0.002 }),
          turn('b', { createdAtUtc: '2026-10-09T23:59:59Z', intent: 'faq', costUsd: 0.003 }),
          turn('c', { createdAtUtc: '2026-10-08T12:00:00Z', intent: null }),
          turn('old', { createdAtUtc: '2026-10-05T12:00:00Z' }),
        ],
      }),
    )
    const d9 = r.daily.find((d) => d.day === '2026-10-09')!
    expect(d9).toMatchObject({ turns: 2, cost_usd: 0.005, by_intent: { faq: 1, plan_job: 1 } })
    expect(r.daily.find((d) => d.day === '2026-10-08')).toMatchObject({ turns: 1, by_intent: { none: 1 } })
    expect(r.daily.reduce((n, d) => n + d.turns, 0)).toBe(3)
    expect(r.stop_reasons).toEqual([{ reason: 'final', n: 3 }])
  })

  it('latency p50/p95 per kind and name, ordered turn, gate, llm, tool, stage', () => {
    const turns = [turn('a', { latencyMs: 1000 }), turn('b', { latencyMs: 3000 })]
    const spans: S[] = []
    for (let i = 1; i <= 20; i++) spans.push(span('a', 'tool', 'recommend_window', { durationMs: i * 10 }))
    spans.push(span('a', 'llm', 'generate', { durationMs: 900 }), span('b', 'gate', 'router', { durationMs: 200 }), span('a', 'stage', 'ground', { durationMs: 5 }))
    const r = run(rows({ turns, spans }))
    expect(r.latency.map((l) => `${l.kind}:${l.name}`)).toEqual(['turn:turn', 'gate:router', 'llm:generate', 'tool:recommend_window', 'stage:ground'])
    expect(r.latency[0]).toEqual({ kind: 'turn', name: 'turn', n: 2, p50_ms: 1000, p95_ms: 3000 })
    expect(r.latency[3]).toMatchObject({ n: 20, p50_ms: 100, p95_ms: 190 })
  })

  it('spans whose turn is outside the window are dropped', () => {
    const r = run(rows({ turns: [turn('a')], spans: [span('a', 'tool', 't'), span('zzz', 'tool', 't'), span('zzz', 'llm', 'x')] }))
    expect(r.tools).toEqual([{ tool: 't', calls: 1, errors: 0 }])
    expect(r.failover.llm_calls).toBe(0)
  })

  it('failover rate and reasons', () => {
    const llm = (over: Record<string, unknown>) => span('a', 'llm', 'generate', { attrs: { 'gen_ai.request.model': 'gemini-3.5-flash', ...over } })
    const r = run(
      rows({
        turns: [turn('a')],
        spans: [
          llm({}),
          llm({ 'gw.failover': true, 'gw.failover_reason': 'rate_limited' }),
          llm({ 'gw.failover': true, 'gw.failover_reason': 'rate_limited' }),
          llm({ 'gw.failover': true, 'gw.failover_reason': 'timeout' }),
          llm({ 'gw.failover': true }),
          llm({ 'gw.failover': false, 'gw.failover_reason': 'ignored' }),
        ],
      }),
    )
    expect(r.failover).toEqual({
      llm_calls: 6,
      failovers: 4,
      reasons: [
        { reason: 'rate_limited', n: 2 },
        { reason: 'timeout', n: 1 },
        { reason: 'unknown', n: 1 },
      ],
    })
  })

  it('free-tier requests count llm spans whose model is free in the price table; paid and unknown models do not', () => {
    const llm = (model?: string) => span('a', 'llm', 'generate', { attrs: model ? { 'gen_ai.request.model': model } : {} })
    const r = run(
      rows({
        turns: [turn('a')],
        spans: [llm('gemini-3.5-flash'), llm('gemini-3.5-flash-lite'), llm('anthropic/claude-haiku-5.5'), llm('mystery-model'), llm()],
      }),
    )
    expect(r.daily.at(-1)).toMatchObject({ llm_requests: 5, free_tier_requests: 2 })
  })

  it('gates: source and choice mix, 10-bucket confidence histogram', () => {
    const gate = (name: string, choice: string, conf: number | null, source = 'jev') =>
      span('a', 'gate', name, { attrs: { 'gw.gate.choice': choice, 'gw.gate.source': source, ...(conf === null ? {} : { 'gw.gate.confidence': conf }) } })
    const r = run(
      rows({
        turns: [turn('a')],
        spans: [gate('router', 'plan_job', 0.95), gate('router', 'plan_job', 1), gate('router', 'faq', 0.3, 'rules'), gate('router', 'faq', null, 'rules'), gate('guard_in', 'allow', 0.5)],
      }),
    )
    expect(r.gates.map((g) => g.gate)).toEqual(['guard_in', 'router'])
    const router = r.gates[1]!
    expect(router).toMatchObject({ n: 4, by_source: { jev: 2, rules: 2 }, by_choice: { plan_job: 2, faq: 2 } })
    expect(router.confidence_hist).toEqual([0, 0, 0, 1, 0, 0, 0, 0, 0, 2])
    expect(router.confidence_hist).toHaveLength(10)
  })

  it('tools: calls and errors, busiest first', () => {
    const r = run(
      rows({
        turns: [turn('a')],
        spans: [span('a', 'tool', 'b'), span('a', 'tool', 'a'), span('a', 'tool', 'a', { status: 'error' }), span('a', 'tool', 'c', { status: 'error' })],
      }),
    )
    expect(r.tools).toEqual([
      { tool: 'a', calls: 2, errors: 1 },
      { tool: 'b', calls: 1, errors: 0 },
      { tool: 'c', calls: 1, errors: 1 },
    ])
  })

  it('stop reasons sorted by count', () => {
    const r = run(rows({ turns: [turn('a'), turn('b', { stopReason: 'max_steps' }), turn('c', { stopReason: 'max_steps' }), turn('d', { stopReason: 'provider_down' })] }))
    expect(r.stop_reasons).toEqual([
      { reason: 'max_steps', n: 2 },
      { reason: 'final', n: 1 },
      { reason: 'provider_down', n: 1 },
    ])
  })

  it('eval trend is oldest first; thumbs-down lists only negative ratings, newest first', () => {
    const ev = (createdAtUtc: string, passRate: number) => ({
      gitSha: 'abc',
      mode: 'replay' as const,
      model: null,
      promptVersion: 'v3',
      scenarios: 50,
      passRate,
      windowCorrectness: 1,
      bannedClaims: 0,
      costUsd: 0,
      report: {},
      createdAtUtc,
    })
    const r = run(
      rows({
        evalRuns: [ev('2026-10-09T09:00:00Z', 1), ev('2026-10-01T09:00:00Z', 0.9)],
        feedback: [
          { turnId: 't1', rating: -1, comment: 'wrong', createdAtUtc: '2026-10-08T10:00:00Z' },
          { turnId: 't2', rating: 1, comment: null, createdAtUtc: '2026-10-08T11:00:00Z' },
          { turnId: 't3', rating: -1, comment: null, createdAtUtc: '2026-10-09T10:00:00Z' },
          { turnId: 'old', rating: -1, comment: null, createdAtUtc: '2026-09-01T10:00:00Z' },
        ],
      }),
    )
    expect(r.evals.map((e) => e.pass_rate)).toEqual([0.9, 1])
    expect(r.evals[0]).toMatchObject({ git_sha: 'abc', mode: 'replay', created_at_utc: '2026-10-01T09:00:00Z' })
    expect(r.thumbs_down).toEqual([
      { turn_id: 't3', created_at_utc: '2026-10-09T10:00:00Z', comment: null },
      { turn_id: 't1', created_at_utc: '2026-10-08T10:00:00Z', comment: 'wrong' },
    ])
  })

  it('days is clamped to 1..90 and the output always validates', () => {
    expect(run(rows(), 0).daily).toHaveLength(1)
    expect(run(rows(), 500).daily).toHaveLength(90)
    const full = run(
      rows({
        turns: [turn('a')],
        spans: [span('a', 'gate', 'router', { attrs: { 'gw.gate.choice': 'x', 'gw.gate.confidence': 0.2, 'gw.gate.source': 'llm' } }), span('a', 'llm', 'g', { attrs: { 'gen_ai.request.model': 'gemini-3.5-flash' } })],
      }),
      14,
    )
    expect(opsResponseSchema.safeParse(full).success).toBe(true)
  })

  it('options override the RPD estimate, prices date and free-model check', () => {
    const r = aggregateOps(rows({ turns: [turn('a')], spans: [span('a', 'llm', 'g', { attrs: { 'gen_ai.request.model': 'm' } })] }), {
      nowMs: NOW,
      days: 1,
      budgetLimitUsd: 5,
      freeTierRpd: 1000,
      pricesChecked: '2026-01-01',
      isFreeModel: (m) => m === 'm',
    })
    expect(r.free_tier_rpd_estimate).toBe(1000)
    expect(r.prices_checked).toBe('2026-01-01')
    expect(r.daily[0]!.free_tier_requests).toBe(1)
  })
})
