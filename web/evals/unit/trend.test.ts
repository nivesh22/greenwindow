import { describe, expect, it, vi } from 'vitest'
import { traceSummarySchema } from '../../agent/harness/events.js'
import { verdictOf, type SuiteResult } from '../runner.js'
import type { ScenarioResult } from '../schema.js'
import { buildEvalRunRow, recordEvalTrend, toEvalRunRow, type FetchLike } from '../trend.js'

const trace = (model: string) =>
  traceSummarySchema.parse({
    gates: [],
    tools: [],
    llm_calls: [{ model, provider: 'p', ok: true, failover: false, tokens_in: 1, tokens_out: 1, cost_usd: 0, ms: 1 }],
    totals: { steps: 1, tokens_in: 1, tokens_out: 1, cost_usd: 0.01, ms: 1 },
    prompt_version: 'system.v6',
  })

const result = (id: string, status: ScenarioResult['status'], windowStatus?: 'pass' | 'fail'): ScenarioResult => ({
  id,
  persona: 'household',
  status,
  note: status === 'failed' ? 'boom' : '',
  cost_usd: 0.01,
  turns: [
    {
      user: '',
      answer: '',
      stop_reason: 'final',
      cost_usd: 0.01,
      steps: 1,
      tools: [],
      banned_claims: 0,
      trace: trace('gemini-3.5-flash'),
      assertions: windowStatus ? [{ name: 'window_equals_optimizer', status: windowStatus, detail: '' }] : [],
    },
  ],
})

const suite = (mode: SuiteResult['mode']): SuiteResult => ({ mode, results: [result('a', 'passed', 'pass'), result('b', 'passed'), result('c', 'failed')] })
const KEY = 'service-role-secret-value'
const env = { SUPABASE_URL: 'https://example.supabase.co/', SUPABASE_SERVICE_ROLE_KEY: KEY, GITHUB_SHA: 'abc123' }

describe('eval trend rows', () => {
  it('builds the eval_runs row from the verdict', () => {
    const s = suite('live')
    const row = buildEvalRunRow(s, verdictOf(s), 'abc123')
    expect(row).toMatchObject({
      git_sha: 'abc123',
      mode: 'live',
      model: 'gemini-3.5-flash',
      prompt_version: 'system.v6',
      scenarios: 3,
      pass_rate: 0.6667,
      window_correctness: 1,
      banned_claims: 0,
      cost_usd: 0.03,
    })
    expect(row?.report).toMatchObject({ passed: 2, failed: 1, failures: [{ id: 'c', note: 'boom' }] })
    expect(row && toEvalRunRow(row)).toMatchObject({ gitSha: 'abc123', passRate: 0.6667, promptVersion: 'system.v6' })
  })

  it('replay and empty runs produce no row', () => {
    const s = suite('replay')
    expect(buildEvalRunRow(s, verdictOf(s), 'x')).toBeNull()
    const none: SuiteResult = { mode: 'live', results: [{ ...result('a', 'skipped'), turns: [] }] }
    expect(buildEvalRunRow(none, verdictOf(none), 'x')).toBeNull()
  })

  it('POSTs to PostgREST with the service key headers (record and live)', async () => {
    for (const mode of ['record', 'live'] as const) {
      const fetchMock = vi.fn<FetchLike>(async () => ({ ok: true, status: 201 }))
      const s = suite(mode)
      const out = await recordEvalTrend(s, verdictOf(s), env, fetchMock)
      expect(out).toEqual({ written: true })
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url, init] = fetchMock.mock.calls[0]!
      expect(url).toBe('https://example.supabase.co/rest/v1/eval_runs')
      expect(init.method).toBe('POST')
      expect(init.headers).toMatchObject({ apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' })
      expect(JSON.parse(init.body)).toMatchObject({ mode, git_sha: 'abc123', pass_rate: 0.6667 })
    }
  })

  it('never writes in replay, or without both env vars', async () => {
    const fetchMock = vi.fn<FetchLike>(async () => ({ ok: true, status: 201 }))
    const r = suite('replay')
    expect((await recordEvalTrend(r, verdictOf(r), env, fetchMock)).written).toBe(false)
    const l = suite('live')
    expect((await recordEvalTrend(l, verdictOf(l), { ...env, SUPABASE_SERVICE_ROLE_KEY: '' }, fetchMock)).written).toBe(false)
    expect((await recordEvalTrend(l, verdictOf(l), { GITHUB_SHA: 'x' }, fetchMock)).written).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports failures without throwing or leaking the key', async () => {
    const l = suite('live')
    const bad = await recordEvalTrend(l, verdictOf(l), env, async () => ({ ok: false, status: 401 }))
    expect(bad).toEqual({ written: false, reason: 'PostgREST answered 401' })
    const boom = await recordEvalTrend(l, verdictOf(l), env, async () => {
      throw new Error(`connect failed for ${KEY}`)
    })
    expect(boom.written).toBe(false)
    expect(JSON.stringify(boom)).not.toContain(KEY)
  })
})
