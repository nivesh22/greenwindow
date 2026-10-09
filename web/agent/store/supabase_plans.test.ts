import { describe, expect, it } from 'vitest'
import { SupabaseLedgerStore, SupabaseOpsStore, SupabasePlanStore } from './supabase_plans.js'

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

type Respond = (c: Call, n: number) => { status?: number; body?: unknown }

function mk<S>(make: (f: typeof fetch) => S, respond: Respond) {
  const calls: Call[] = []
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const c: Call = { url: String(input), method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : undefined }
    calls.push(c)
    const r = respond(c, calls.length - 1)
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status ?? 200 })
  }) as typeof fetch
  return { store: make(f), calls }
}
const plans = (respond: Respond) => mk((fetch) => new SupabasePlanStore({ url: 'https://x.supabase.co/', key: 'sb_secret_k', fetch }), respond)

const U = '11111111-1111-4111-8111-111111111111'
const P = '22222222-2222-4222-8222-222222222222'
const R = '33333333-3333-4333-8333-333333333333'

const planRow = (over: Record<string, unknown> = {}) => ({
  id: P,
  user_id: U,
  label: 'Dishwasher',
  kind: 'recurring',
  job: { duration_h: 2, power_kw: '1.200', mode: 'expected' },
  rule: { days: ['mon', 'wed'], window_local: { from: '20:00', to: '23:00' }, remind: true },
  next_start_utc: '2026-10-12T20:00:00+00:00',
  next_run_id: 'run1',
  active: true,
  created_at: '2026-10-09T10:00:00.123+00:00',
  ...over,
})
const reminderRow = (over: Record<string, unknown> = {}) => ({
  id: R,
  user_id: U,
  plan_id: P,
  send_at: '2026-10-12T19:50:00+00:00',
  sent_at: null,
  status: 'pending',
  attempts: 0,
  payload: { title: 't', body: 'b', url: '/scheduler', start_utc: '2026-10-12T20:00:00Z' },
  ...over,
})

describe('SupabasePlanStore plans', () => {
  it('maps rows to Plans and scopes every user query by user_id', async () => {
    const { store, calls } = plans(() => ({ body: [planRow()] }))
    const list = await store.listPlans(U, { activeOnly: true })
    expect(list[0]).toMatchObject({
      id: P,
      userId: U,
      kind: 'recurring',
      job: { durationH: 2, powerKw: 1.2, mode: 'expected' },
      rule: { days: ['mon', 'wed'], windowLocal: { from: '20:00', to: '23:00' }, remind: true },
      nextStartUtc: '2026-10-12T20:00:00Z',
      active: true,
    })
    expect(calls[0]!.url).toContain(`user_id=eq.${U}`)
    expect(calls[0]!.url).toContain('active=eq.true')
    expect(calls[0]!.headers.apikey).toBe('sb_secret_k')
    expect(calls[0]!.headers.Authorization).toBeUndefined()
  })

  it('createPlan posts snake_case JSON and rejects a rule/kind mismatch', async () => {
    const { store, calls } = plans(() => ({
      body: [planRow({ kind: 'once', rule: null, job: { duration_h: 2, power_kw: 1.2, mode: 'cautious', earliest_utc: '2026-10-10T10:00:00Z', deadline_utc: '2026-10-11T10:00:00Z' } })],
    }))
    const p = await store.createPlan({
      userId: U,
      label: 'x',
      kind: 'once',
      job: { durationH: 2, powerKw: 1.2, mode: 'cautious', earliestUtc: '2026-10-10T10:00:00Z', deadlineUtc: '2026-10-11T10:00:00Z' },
      rule: null,
      nextStartUtc: null,
      nextRunId: null,
    })
    expect(p.job.deadlineUtc).toBe('2026-10-11T10:00:00Z')
    expect(calls[0]!.body).toMatchObject({ user_id: U, kind: 'once', rule: null, job: { duration_h: 2, power_kw: 1.2, mode: 'cautious', earliest_utc: '2026-10-10T10:00:00Z' } })
    await expect(
      store.createPlan({ userId: U, label: 'x', kind: 'recurring', job: { durationH: 1, powerKw: 1, mode: 'expected' }, rule: null, nextStartUtc: null, nextRunId: null }),
    ).rejects.toThrow()
  })

  it('cancelPlan filters by id and user, cancels pending reminders, and is false for a foreign plan', async () => {
    const hit = plans((c) => (c.method === 'PATCH' && c.url.includes('/plans') ? { body: [{ id: P }] } : { status: 204 }))
    expect(await hit.store.cancelPlan(U, P)).toBe(true)
    expect(hit.calls[0]!.url).toContain(`id=eq.${P}&user_id=eq.${U}`)
    expect(hit.calls[0]!.body).toMatchObject({ active: false })
    expect(hit.calls[1]!.url).toContain('/reminders')
    expect(hit.calls[1]!.url).toContain(`user_id=eq.${U}`)
    expect(hit.calls[1]!.body).toEqual({ status: 'cancelled' })
    const miss = plans(() => ({ body: [] }))
    expect(await miss.store.cancelPlan('other', P)).toBe(false)
    expect(miss.calls).toHaveLength(1)
  })

  it('activeRecurringPlans pages through the recurring filter; setNextStart patches by id', async () => {
    const { store, calls } = plans((c) => (c.method === 'GET' ? { body: [planRow()] } : { status: 204 }))
    expect(await store.activeRecurringPlans()).toHaveLength(1)
    expect(calls[0]!.url).toContain('kind=eq.recurring&active=eq.true')
    await store.setNextStart(P, null, null)
    expect(calls[1]!.method).toBe('PATCH')
    expect(calls[1]!.body).toMatchObject({ next_start_utc: null, next_run_id: null })
  })
})

describe('SupabasePlanStore push subscriptions', () => {
  it('upserts on endpoint, deletes scoped by user, and by endpoint only for the 404/410 cleanup', async () => {
    const { store, calls } = plans((c) =>
      c.method === 'GET' ? { body: [{ id: 's1', user_id: U, endpoint: 'https://push/1', p256dh: 'k', auth: 'a' }] } : { status: 204 },
    )
    await store.savePushSubscription({ userId: U, endpoint: 'https://push/1', p256dh: 'k', auth: 'a' })
    expect(calls[0]!.url).toContain('on_conflict=endpoint')
    expect(calls[0]!.headers.prefer).toContain('merge-duplicates')
    expect(calls[0]!.body).toEqual({ user_id: U, endpoint: 'https://push/1', p256dh: 'k', auth: 'a' })
    expect(await store.listPushSubscriptions(U)).toEqual([{ id: 's1', userId: U, endpoint: 'https://push/1', p256dh: 'k', auth: 'a' }])
    expect(calls[1]!.url).toContain(`user_id=eq.${U}`)
    await store.deletePushSubscription(U, 'https://push/1')
    expect(calls[2]!.method).toBe('DELETE')
    expect(calls[2]!.url).toContain(`user_id=eq.${U}`)
    expect(calls[2]!.url).toContain('endpoint=eq.https%3A%2F%2Fpush%2F1')
    await store.deletePushSubscriptionByEndpoint('https://push/1')
    expect(calls[3]!.url).not.toContain('user_id')
  })
})

describe('SupabasePlanStore reminders', () => {
  const nr = { userId: U, planId: P, sendAtUtc: '2026-10-12T19:50:00Z', payload: { title: 't', body: 'b', url: '/scheduler', startUtc: '2026-10-12T20:00:00Z' } }

  it('addReminder ignores duplicates on (plan_id, send_at) and reads the existing row back', async () => {
    const { store, calls } = plans((c) => (c.method === 'POST' ? { body: [] } : { body: [reminderRow()] }))
    const r = await store.addReminder(nr)
    expect(r.id).toBe(R)
    expect(calls[0]!.url).toContain('on_conflict=plan_id,send_at')
    expect(calls[0]!.headers.prefer).toContain('ignore-duplicates')
    expect(calls[0]!.body).toMatchObject({ user_id: U, plan_id: P, send_at: '2026-10-12T19:50:00.000Z', payload: { start_utc: '2026-10-12T20:00:00Z' } })
    expect(calls[1]!.method).toBe('GET')
    expect(calls[1]!.url).toContain(`plan_id=eq.${P}`)
    expect(calls[1]!.url).toContain(`user_id=eq.${U}`)
    expect(calls[1]!.url).toContain('send_at=eq.2026-10-12T19%3A50%3A00.000Z')
  })

  it('addReminder returns the inserted row without a read-back; one-off reminders plain insert', async () => {
    const ins = plans(() => ({ body: [reminderRow()] }))
    expect((await ins.store.addReminder(nr)).payload.startUtc).toBe('2026-10-12T20:00:00Z')
    expect(ins.calls).toHaveLength(1)
    const once = plans(() => ({ body: [reminderRow({ plan_id: null })] }))
    expect((await once.store.addReminder({ ...nr, planId: null })).planId).toBeNull()
    expect(once.calls[0]!.url).not.toContain('on_conflict')
  })

  it('dueReminders orders by send_at with a limit; markReminder increments attempts and stamps sent_at', async () => {
    const { store, calls } = plans((c) =>
      c.method === 'GET' && c.url.includes('select=attempts') ? { body: [{ attempts: 1 }] } : c.method === 'GET' ? { body: [reminderRow()] } : { status: 204 },
    )
    const now = Date.UTC(2026, 9, 12, 19, 51)
    expect(await store.dueReminders(now, 100)).toHaveLength(1)
    expect(calls[0]!.url).toContain('status=eq.pending')
    expect(calls[0]!.url).toContain('send_at=lte.2026-10-12T19%3A51%3A00.000Z')
    expect(calls[0]!.url).toContain('order=send_at.asc&limit=100')
    await store.markReminder(R, 'sent', now)
    const patch = calls.at(-1)!
    expect(patch.method).toBe('PATCH')
    expect(patch.body).toEqual({ status: 'sent', attempts: 2, sent_at: '2026-10-12T19:51:00.000Z' })
    await store.markReminder(R, 'failed', now)
    expect(calls.at(-1)!.body).toEqual({ status: 'failed', attempts: 2 })
  })

  it('listReminders is scoped by user', async () => {
    const { store, calls } = plans(() => ({ body: [] }))
    await store.listReminders(U, { pendingOnly: true })
    expect(calls[0]!.url).toContain(`user_id=eq.${U}&status=eq.pending`)
  })

  it('recordEvalRun posts snake_case', async () => {
    const { store, calls } = plans(() => ({ status: 201 }))
    await store.recordEvalRun({ gitSha: 'abc', mode: 'replay', model: null, promptVersion: 'v3', scenarios: 50, passRate: 1, windowCorrectness: 1, bannedClaims: 0, costUsd: 0, report: {} })
    expect(calls[0]!.url).toContain('/eval_runs')
    expect(calls[0]!.body).toMatchObject({ git_sha: 'abc', prompt_version: 'v3', pass_rate: 1 })
  })

  it('HTTP errors surface as StoreError', async () => {
    const { store } = plans(() => ({ status: 500, body: { message: 'boom' } }))
    await expect(store.dueReminders(0, 1)).rejects.toMatchObject({ code: 'http', status: 500 })
  })
})

const TURN = '44444444-4444-4444-8444-444444444444'
const turn = {
  id: TURN,
  conversation_id: P,
  user_id: U,
  ip_hash: 'h',
  intent: 'plan_job',
  stop_reason: 'final',
  prompt_version: 'v3',
  model_final: 'gemini-3.5-flash',
  tokens_in: 100,
  tokens_out: 20,
  cost_usd: '0.000100',
  latency_ms: 1500,
  created_at: '2026-10-09T10:00:00+00:00',
}
const span = {
  id: '55555555-5555-4555-8555-555555555555',
  turn_id: TURN,
  parent_id: null,
  kind: 'llm',
  name: 'generate',
  started_at: '2026-10-09T10:00:00+00:00',
  duration_ms: 900,
  status: 'ok',
  attrs: { 'gen_ai.request.model': 'gemini-3.5-flash' },
  tokens_in: 100,
  tokens_out: 20,
  cost_usd: 0,
}

const ops = (respond: Respond) =>
  mk((fetch) => new SupabaseOpsStore({ url: 'https://x.supabase.co', key: 'sb_secret_k', fetch, now: () => Date.UTC(2026, 9, 9, 12) }), respond)

describe('SupabaseOpsStore', () => {
  it('isAdmin reads the admins table', async () => {
    expect(await ops(() => ({ body: [{ user_id: U }] })).store.isAdmin(U)).toBe(true)
    const none = ops(() => ({ body: [] }))
    expect(await none.store.isAdmin(U)).toBe(false)
    expect(none.calls[0]!.url).toContain(`/admins?user_id=eq.${U}`)
  })

  it('turnTrace joins spans, messages, feedback and the anonymous flag; null for an unknown turn', async () => {
    const { store, calls } = ops((c) => {
      if (c.url.includes('/turns')) return { body: [turn] }
      if (c.url.includes('/spans')) return { body: [span] }
      if (c.url.includes('/messages')) return { body: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }] }
      if (c.url.includes('/feedback')) return { body: [{ rating: -1, comment: 'wrong' }] }
      if (c.url.includes('/auth/v1/admin/users/')) return { body: { id: U, is_anonymous: true } }
      return { status: 404 }
    })
    const t = await store.turnTrace(TURN)
    expect(t).toMatchObject({
      turn: { id: TURN, costUsd: 0.0001, createdAtUtc: '2026-10-09T10:00:00Z', stopReason: 'final' },
      userMessage: 'hi',
      answer: 'hello',
      isAnonymous: true,
      feedback: [{ rating: -1, comment: 'wrong' }],
    })
    expect(t!.spans[0]).toMatchObject({ kind: 'llm', durationMs: 900, startedAtUtc: '2026-10-09T10:00:00Z' })
    expect(calls.some((c) => c.url.includes(`/messages?turn_id=eq.${TURN}`))).toBe(true)
    const missing = ops(() => ({ body: [] }))
    expect(await missing.store.turnTrace(TURN)).toBeNull()
  })

  it('turnTrace tolerates a failing auth lookup (isAnonymous null)', async () => {
    const { store } = ops((c) => {
      if (c.url.includes('/turns')) return { body: [turn] }
      if (c.url.includes('/auth/')) return { status: 500 }
      return { body: [] }
    })
    const t = await store.turnTrace(TURN)
    expect(t?.isAnonymous).toBeNull()
    expect(t?.userMessage).toBeNull()
  })

  it('opsRows fetches bounded, ordered slices and the current month ledger row', async () => {
    const { store, calls } = ops((c) => {
      if (c.url.includes('/turns')) return { body: [turn] }
      if (c.url.includes('/spans')) return { body: [span] }
      if (c.url.includes('/feedback')) return { body: [{ turn_id: TURN, rating: -1, comment: null, created_at: '2026-10-09T11:00:00+00:00' }] }
      if (c.url.includes('/eval_runs')) {
        return {
          body: [
            {
              git_sha: 'b',
              mode: 'replay',
              model: null,
              prompt_version: 'v3',
              scenarios: 50,
              pass_rate: '1.0000',
              window_correctness: 1,
              banned_claims: 0,
              cost_usd: 0,
              report: {},
              created_at: '2026-10-09T09:00:00+00:00',
            },
          ],
        }
      }
      if (c.url.includes('/cost_ledger')) return { body: [{ month: '2026-10', spent_usd: '1.250000', eval_spent_usd: '0.07', paused: false }] }
      return { status: 404 }
    })
    const r = await store.opsRows(Date.UTC(2026, 8, 25))
    expect(r.turns[0]).toEqual({
      id: TURN,
      intent: 'plan_job',
      stopReason: 'final',
      costUsd: 0.0001,
      latencyMs: 1500,
      createdAtUtc: '2026-10-09T10:00:00Z',
      modelFinal: 'gemini-3.5-flash',
    })
    expect(r.spans[0]).toEqual({ turnId: TURN, kind: 'llm', name: 'generate', durationMs: 900, status: 'ok', attrs: { 'gen_ai.request.model': 'gemini-3.5-flash' } })
    expect(r.feedback[0]).toMatchObject({ rating: -1, createdAtUtc: '2026-10-09T11:00:00Z' })
    expect(r.evalRuns[0]).toMatchObject({ passRate: 1, createdAtUtc: '2026-10-09T09:00:00Z' })
    expect(r.budget).toEqual({ month: '2026-10', spentUsd: 1.25, evalSpentUsd: 0.07, paused: false })
    const turnsUrl = calls.find((c) => c.url.includes('/turns'))!.url
    expect(turnsUrl).toContain('created_at=gte.2026-09-25T00%3A00%3A00.000Z')
    expect(turnsUrl).toContain('limit=1000&offset=0')
    const spansUrl = calls.find((c) => c.url.includes('/spans'))!.url
    expect(spansUrl).toContain('select=turn_id,kind,name,duration_ms,status,attrs')
    expect(calls.find((c) => c.url.includes('/cost_ledger'))!.url).toContain('month=eq.2026-10')
  })

  it('opsRows pages past 1000 rows and defaults the budget to zeros', async () => {
    const many = Array.from({ length: 1000 }, (_, i) => ({ ...span, id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` }))
    let spanCalls = 0
    const { store, calls } = ops((c) => {
      if (c.url.includes('/spans')) {
        spanCalls++
        return { body: spanCalls === 1 ? many : [span] }
      }
      return { body: [] }
    })
    const r = await store.opsRows(0)
    expect(r.spans).toHaveLength(1001)
    expect(calls.filter((c) => c.url.includes('/spans')).map((c) => /offset=(\d+)/.exec(c.url)![1])).toEqual(['0', '1000'])
    expect(r.budget).toEqual({ month: '2026-10', spentUsd: 0, evalSpentUsd: 0, paused: false })
  })
})

describe('SupabaseLedgerStore', () => {
  it('lists unrealized rows without a note and sets realized scoped by user', async () => {
    const { store, calls } = mk(
      (fetch) => new SupabaseLedgerStore({ url: 'https://x.supabase.co', key: 'sb_secret_k', fetch }),
      (c) =>
        c.method === 'GET'
          ? {
              body: [
                { id: 'i1', user_id: U, window_start_utc: '2026-10-08T01:00:00+00:00', run_now_start_utc: '2026-10-08T00:00:00+00:00', duration_h: 2, energy_kwh: '2.400' },
              ],
            }
          : { status: 204 },
    )
    const rows = await store.pendingImpact(Date.UTC(2026, 9, 9), 500)
    expect(rows[0]).toEqual({ id: 'i1', userId: U, windowStartUtc: '2026-10-08T01:00:00Z', runNowStartUtc: '2026-10-08T00:00:00Z', durationH: 2, energyKwh: 2.4 })
    expect(calls[0]!.url).toContain('realized_g=is.null&realized_note=is.null')
    await store.setRealized(U, 'i1', 120, null, Date.UTC(2026, 9, 9))
    expect(calls[1]!.url).toContain(`id=eq.i1&user_id=eq.${U}`)
    expect(calls[1]!.body).toMatchObject({ realized_g: 120, realized_note: null })
  })
})
