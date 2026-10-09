import { beforeEach, describe, expect, it } from 'vitest'
import { adminTraceResponseSchema, opsResponseSchema, plansResponseSchema, reminderResponseSchema } from '../agent/harness/api_schemas.js'
import type { NewPlan } from '../agent/store/plan_types.js'
import { MemoryUserStore } from '../agent/store/user_types.js'
import type { TraceExporter, TurnExport } from '../agent/telemetry/langfuse.js'
import { loadConfig } from '../agent/config.js'
import { clearAuthCache } from './_lib/auth.js'
import type { ApiDeps } from './_lib/deps.js'
import { deleteLangfuseTraces } from './_lib/langfuse_delete.js'
import { ADMIN, ANON, authFetch, errCode, makeDeps, NOW, OTHER, req, TURN, USER } from './_lib/p4_testing.js'
import { createOpsHandler } from './admin/ops.js'
import { createTraceHandler } from './admin/trace.js'
import { createFeedbackHandler } from './feedback.js'
import { createDeleteMeHandler } from './me/delete.js'
import { createPlansHandler } from './plans.js'
import { createSubscribeHandler } from './push/subscribe.js'
import { createRemindersHandler, MAX_AHEAD_MS } from './reminders.js'

beforeEach(() => clearAuthCache())

const onceJob: NewPlan = {
  userId: USER,
  label: 'Dishwasher',
  kind: 'once',
  job: { durationH: 2, powerKw: 1.2, mode: 'expected', earliestUtc: '2026-10-06T01:00:00Z', deadlineUtc: '2026-10-07T01:00:00Z' },
  rule: null,
  nextStartUtc: '2026-10-06T03:00:00Z',
  nextRunId: 'run1',
}
const recurring: NewPlan = {
  userId: USER,
  label: 'Washing',
  kind: 'recurring',
  job: { durationH: 2, powerKw: 2, mode: 'cautious' },
  rule: { days: ['mon', 'fri'], windowLocal: { from: '20:00', to: '23:00' }, remind: true },
  nextStartUtc: null,
  nextRunId: null,
}

describe('/api/plans', () => {
  it('405 for other methods, 401 without a token, 403 sign_in_required for anonymous sessions', async () => {
    const h = createPlansHandler(makeDeps().deps)
    expect((await h(req('/api/plans', 'POST', 'google', {}))).status).toBe(405)
    expect((await h(req('/api/plans', 'GET'))).status).toBe(401)
    const r = await h(req('/api/plans', 'GET', 'anon'))
    expect(r.status).toBe(403)
    expect(await errCode(r)).toBe('sign_in_required')
  })

  it('lists only the caller plans, mapped to the API shape; ?active=true hides cancelled ones', async () => {
    const { deps, plans } = makeDeps()
    const a = await plans.createPlan(onceJob)
    await plans.createPlan(recurring)
    await plans.createPlan({ ...onceJob, userId: OTHER, label: 'Not mine' })
    await plans.cancelPlan(USER, a.id)
    const h = createPlansHandler(deps)
    const all = plansResponseSchema.parse(await (await h(req('/api/plans', 'GET', 'google'))).json())
    expect(all.plans.map((p) => p.label)).toEqual(['Washing', 'Dishwasher'])
    expect(all.plans[1]).toMatchObject({
      kind: 'once',
      active: false,
      job: { duration_h: 2, power_kw: 1.2, mode: 'expected', earliest_utc: '2026-10-06T01:00:00Z', deadline_utc: '2026-10-07T01:00:00Z' },
      rule: null,
      next_start_utc: '2026-10-06T03:00:00Z',
    })
    expect(all.plans[0]!.rule).toEqual({ days: ['mon', 'fri'], window_local: { from: '20:00', to: '23:00' }, remind: true })
    const active = plansResponseSchema.parse(await (await h(req('/api/plans?active=true', 'GET', 'google'))).json())
    expect(active.plans.map((p) => p.label)).toEqual(['Washing'])
  })

  it('DELETE cancels the plan and its pending reminders; 400 bad id; 404 for missing or foreign plans', async () => {
    const { deps, plans } = makeDeps()
    const mine = await plans.createPlan(recurring)
    const theirs = await plans.createPlan({ ...recurring, userId: OTHER })
    await plans.addReminder({ userId: USER, planId: mine.id, sendAtUtc: '2026-10-06T10:00:00Z', payload: { title: 't', body: 'b', url: '/scheduler', startUtc: '2026-10-06T10:10:00Z' } })
    const h = createPlansHandler(deps)
    expect((await h(req('/api/plans', 'DELETE', 'google'))).status).toBe(400)
    expect((await h(req('/api/plans?id=nope', 'DELETE', 'google'))).status).toBe(400)
    expect((await h(req(`/api/plans?id=${theirs.id}`, 'DELETE', 'google'))).status).toBe(404)
    expect(plans.plans.find((p) => p.id === theirs.id)!.active).toBe(true)
    const ok = await h(req(`/api/plans?id=${mine.id}`, 'DELETE', 'google'))
    expect(ok.status).toBe(200)
    expect(plans.plans.find((p) => p.id === mine.id)!.active).toBe(false)
    expect(plans.reminders[0]!.status).toBe('cancelled')
    expect((await h(req(`/api/plans?id=${mine.id}`, 'DELETE', 'anon'))).status).toBe(403)
  })

  it('503 store_unavailable when the store throws', async () => {
    const { deps, plans } = makeDeps()
    plans.listPlans = async () => {
      throw new Error('db down')
    }
    const r = await createPlansHandler(deps)(req('/api/plans', 'GET', 'google'))
    expect(r.status).toBe(503)
    expect(await errCode(r)).toBe('store_unavailable')
  })
})

describe('/api/push/subscribe', () => {
  const sub = { endpoint: 'https://push.example/abc', keys: { p256dh: 'pk', auth: 'ak' } }

  it('method, auth and body guards', async () => {
    const h = createSubscribeHandler(makeDeps().deps)
    expect((await h(req('/api/push/subscribe', 'GET', 'google'))).status).toBe(405)
    expect((await h(req('/api/push/subscribe', 'POST', undefined, { subscription: sub }))).status).toBe(401)
    expect((await h(req('/api/push/subscribe', 'POST', 'anon', { subscription: sub }))).status).toBe(403)
    expect((await h(req('/api/push/subscribe', 'POST', 'google', { subscription: { endpoint: 'nope', keys: sub.keys } }))).status).toBe(400)
    expect((await h(req('/api/push/subscribe', 'POST', 'google', {}))).status).toBe(400)
    const http = await h(req('/api/push/subscribe', 'POST', 'google', { subscription: { ...sub, endpoint: 'http://push.example/abc' } }))
    expect(http.status).toBe(400)
  })

  it('saves under the caller id, upserts the same endpoint, and deletes only the caller own', async () => {
    const { deps, plans } = makeDeps()
    const h = createSubscribeHandler(deps)
    expect((await h(req('/api/push/subscribe', 'POST', 'google', { subscription: sub }))).status).toBe(200)
    expect(plans.subs).toEqual([{ id: expect.any(String), userId: USER, endpoint: sub.endpoint, p256dh: 'pk', auth: 'ak' }])
    await h(req('/api/push/subscribe', 'POST', 'google', { subscription: { ...sub, keys: { p256dh: 'pk2', auth: 'ak2' } } }))
    expect(plans.subs).toHaveLength(1)
    expect(plans.subs[0]!.p256dh).toBe('pk2')
    // Another user cannot remove it.
    await h(req('/api/push/subscribe', 'DELETE', 'other', { endpoint: sub.endpoint }))
    expect(plans.subs).toHaveLength(1)
    expect((await h(req('/api/push/subscribe', 'DELETE', 'google', { endpoint: sub.endpoint }))).status).toBe(200)
    expect(plans.subs).toHaveLength(0)
    expect((await h(req('/api/push/subscribe', 'DELETE', 'google', {}))).status).toBe(400)
  })
})

describe('POST /api/reminders', () => {
  const startIn = (ms: number) => new Date(NOW + ms).toISOString().replace('.000Z', 'Z')
  const body = (ms: number, extra: Record<string, unknown> = {}) => ({ start_utc: startIn(ms), label: 'Dishwasher', ...extra })
  const subscribe = (plans: ReturnType<typeof makeDeps>['plans']) => plans.savePushSubscription({ userId: USER, endpoint: 'https://push.example/1', p256dh: 'k', auth: 'a' })

  it('method, auth and body guards', async () => {
    const h = createRemindersHandler(makeDeps().deps)
    expect((await h(req('/api/reminders', 'GET', 'google'))).status).toBe(405)
    expect((await h(req('/api/reminders', 'POST', undefined, body(3_600_000)))).status).toBe(401)
    expect((await h(req('/api/reminders', 'POST', 'anon', body(3_600_000)))).status).toBe(403)
    expect((await h(req('/api/reminders', 'POST', 'google', { start_utc: 'tomorrow', label: 'x' }))).status).toBe(400)
    expect((await h(req('/api/reminders', 'POST', 'google', { start_utc: startIn(3_600_000), label: '' }))).status).toBe(400)
    expect((await h(req('/api/reminders', 'POST', 'google', body(3_600_000, { lead_min: 500 })))).status).toBe(400)
  })

  it('409 push_needed without a subscription', async () => {
    const { deps } = makeDeps()
    const r = await createRemindersHandler(deps)(req('/api/reminders', 'POST', 'google', body(3_600_000)))
    expect(r.status).toBe(409)
    expect(await errCode(r)).toBe('push_needed')
  })

  it('rejects past starts and starts more than 48 h ahead (checked before the subscription)', async () => {
    const { deps, plans } = makeDeps()
    await subscribe(plans)
    const h = createRemindersHandler(deps)
    const past = await h(req('/api/reminders', 'POST', 'google', body(-60_000)))
    expect(past.status).toBe(400)
    expect(await errCode(past)).toBe('start_in_past')
    const far = await h(req('/api/reminders', 'POST', 'google', body(MAX_AHEAD_MS + 3_600_000)))
    expect(far.status).toBe(400)
    expect(await errCode(far)).toBe('start_too_far')
    expect((await h(req('/api/reminders', 'POST', 'google', body(MAX_AHEAD_MS)))).status).toBe(200)
  })

  it('creates a reminder at start - lead (default 10 min), and repeating the request returns the same one', async () => {
    const { deps, plans } = makeDeps()
    await subscribe(plans)
    const h = createRemindersHandler(deps)
    const r = await h(req('/api/reminders', 'POST', 'google', body(3 * 3_600_000)))
    expect(r.status).toBe(200)
    const out = reminderResponseSchema.parse(await r.json())
    expect(out.send_at_utc).toBe(startIn(3 * 3_600_000 - 10 * 60_000))
    expect(plans.reminders[0]).toMatchObject({ userId: USER, planId: null, status: 'pending', payload: { url: '/scheduler', startUtc: startIn(3 * 3_600_000) } })
    expect(plans.reminders[0]!.payload.body).toContain('Dishwasher')
    const again = reminderResponseSchema.parse(await (await h(req('/api/reminders', 'POST', 'google', body(3 * 3_600_000)))).json())
    expect(again.reminder_id).toBe(out.reminder_id)
    expect(plans.reminders).toHaveLength(1)
    const custom = reminderResponseSchema.parse(await (await h(req('/api/reminders', 'POST', 'google', body(3 * 3_600_000, { lead_min: 30 })))).json())
    expect(custom.send_at_utc).toBe(startIn(3 * 3_600_000 - 30 * 60_000))
    expect(plans.reminders).toHaveLength(2)
  })

  it('a start closer than the lead is due immediately (send_at = now)', async () => {
    const { deps, plans } = makeDeps()
    await subscribe(plans)
    const r = reminderResponseSchema.parse(await (await createRemindersHandler(deps)(req('/api/reminders', 'POST', 'google', body(5 * 60_000)))).json())
    expect(r.send_at_utc).toBe(startIn(0))
  })
})

describe('GET /api/admin/ops', () => {
  it('401 without a token; 403 for anonymous and non-admin users; 405 for POST', async () => {
    const { deps } = makeDeps()
    const h = createOpsHandler(deps)
    expect((await h(req('/api/admin/ops', 'GET'))).status).toBe(401)
    expect((await h(req('/api/admin/ops', 'GET', 'anon'))).status).toBe(403)
    const r = await h(req('/api/admin/ops', 'GET', 'google'))
    expect(r.status).toBe(403)
    expect(await errCode(r)).toBe('forbidden')
    expect((await h(req('/api/admin/ops', 'POST', 'admin'))).status).toBe(405)
  })

  it('admin gets a schema-valid response; the window starts at 00:00 UTC of the first day; budget limit from config', async () => {
    const { deps, ops } = makeDeps()
    const h = createOpsHandler(deps)
    const r = await h(req('/api/admin/ops', 'GET', 'admin'))
    expect(r.status).toBe(200)
    const body = opsResponseSchema.parse(await r.json())
    expect(body.days).toBe(14)
    expect(body.daily).toHaveLength(14)
    expect(body.budget).toMatchObject({ limit_usd: 5, spent_usd: 0.5 })
    expect(ops.sinceMs).toBe(Date.UTC(2026, 9, 6) - 13 * 86_400_000)
    const seven = opsResponseSchema.parse(await (await h(req('/api/admin/ops?days=7', 'GET', 'admin'))).json())
    expect(seven.daily).toHaveLength(7)
  })

  it('400 for a bad days value; 503 when the store fails', async () => {
    const { deps, ops } = makeDeps()
    const h = createOpsHandler(deps)
    for (const d of ['0', '91', 'x', '1.5']) expect((await h(req(`/api/admin/ops?days=${d}`, 'GET', 'admin'))).status).toBe(400)
    ops.opsRows = async () => {
      throw new Error('db')
    }
    expect((await h(req('/api/admin/ops', 'GET', 'admin'))).status).toBe(503)
  })
})

describe('GET /api/admin/trace', () => {
  const trace = {
    turn: {
      id: TURN,
      conversationId: '88888888-8888-4888-8888-888888888888',
      userId: USER,
      ipHash: 'secret-hash',
      intent: 'plan_job',
      stopReason: 'final' as const,
      promptVersion: 'v3',
      modelFinal: 'gemini-3.5-flash',
      tokensIn: 10,
      tokensOut: 5,
      costUsd: 0.001,
      latencyMs: 900,
      createdAtUtc: '2026-10-06T00:00:00Z',
    },
    spans: [
      {
        id: '99999999-9999-4999-8999-999999999999',
        turnId: TURN,
        parentId: null,
        kind: 'llm' as const,
        name: 'generate',
        startedAtUtc: '2026-10-06T00:00:00Z',
        durationMs: 800,
        status: 'ok' as const,
        attrs: { 'gen_ai.request.model': 'gemini-3.5-flash' },
        tokensIn: 10,
        tokensOut: 5,
        costUsd: 0,
      },
    ],
    userMessage: 'hi',
    answer: 'hello',
    isAnonymous: false,
    feedback: [{ rating: -1 as const, comment: 'bad' }],
  }

  it('guards: 401, 403 anonymous / non-admin, 405, 400 bad id, 404 unknown turn', async () => {
    const { deps } = makeDeps()
    const h = createTraceHandler(deps)
    expect((await h(req(`/api/admin/trace?turn_id=${TURN}`, 'GET'))).status).toBe(401)
    expect((await h(req(`/api/admin/trace?turn_id=${TURN}`, 'GET', 'anon'))).status).toBe(403)
    expect((await h(req(`/api/admin/trace?turn_id=${TURN}`, 'GET', 'google'))).status).toBe(403)
    expect((await h(req(`/api/admin/trace?turn_id=${TURN}`, 'DELETE', 'admin'))).status).toBe(405)
    expect((await h(req('/api/admin/trace', 'GET', 'admin'))).status).toBe(400)
    expect((await h(req('/api/admin/trace?turn_id=zzz', 'GET', 'admin'))).status).toBe(400)
    expect((await h(req(`/api/admin/trace?turn_id=${TURN}`, 'GET', 'admin'))).status).toBe(404)
  })

  it('returns the validated trace without the ip hash', async () => {
    const { deps, ops } = makeDeps()
    ops.trace = trace
    const r = await createTraceHandler(deps)(req(`/api/admin/trace?turn_id=${TURN}`, 'GET', 'admin'))
    expect(r.status).toBe(200)
    const text = await r.text()
    expect(text).not.toContain('secret-hash')
    const body = adminTraceResponseSchema.parse(JSON.parse(text))
    expect(body).toMatchObject({
      turn: { id: TURN, user_id: USER, stop_reason: 'final', cost_usd: 0.001 },
      spans: [{ kind: 'llm', name: 'generate', duration_ms: 800 }],
      user_message: 'hi',
      answer: 'hello',
      feedback: [{ rating: -1, comment: 'bad' }],
      langfuse_url: null,
    })
  })
})

// ---------- feedback -> Langfuse, account deletion ----------

function userDeps(over: Partial<ApiDeps> = {}) {
  const users = new MemoryUserStore()
  const deps: ApiDeps = {
    users,
    usage: { consumeSession: async () => true, anonMessagesUsed: async () => 0 },
    config: loadConfig({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_x' }),
    env: { VITE_SUPABASE_ANON_KEY: 'sb_publishable_x' },
    fetch: authFetch,
    now: () => NOW,
    ...over,
  }
  return { deps, users }
}

describe('POST /api/feedback -> Langfuse', () => {
  const trace = {
    turn: {
      id: TURN,
      conversationId: 'c',
      userId: ANON,
      ipHash: 'h',
      intent: null,
      stopReason: 'final' as const,
      promptVersion: 'v3',
      modelFinal: null,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      latencyMs: 1,
      createdAtUtc: '2026-10-06T00:00:00Z',
    },
    spans: [],
    userMessage: 'hi',
    answer: null,
    isAnonymous: true,
    feedback: [],
  }

  it('saves, then scores in Langfuse with a loader that maps the stored turn (empty payloads)', async () => {
    const { deps, users } = userDeps()
    const scored: { turnId: string; rating: 1 | -1; comment: string | null; loaded: TurnExport | null }[] = []
    const exporter: TraceExporter = {
      exportTurn: async () => false,
      scoreFeedback: async (f) => {
        scored.push({ turnId: f.turnId, rating: f.rating, comment: f.comment, loaded: await f.load() })
      },
    }
    const ops = { turnTrace: async (id: string) => (id === TURN ? trace : null) }
    const h = createFeedbackHandler(deps, { exporter, ops })
    const r = await h(req('/api/feedback', 'POST', 'anon', { turn_id: TURN, rating: -1, comment: 'wrong' }))
    expect(r.status).toBe(200)
    expect(users.feedback[0]).toMatchObject({ turnId: TURN, rating: -1, comment: 'wrong' })
    expect(scored).toHaveLength(1)
    expect(scored[0]).toMatchObject({ turnId: TURN, rating: -1, comment: 'wrong' })
    expect(scored[0]!.loaded).toMatchObject({ userMessage: 'hi', answer: '', isAnonymous: true })
    expect(scored[0]!.loaded!.payloads.size).toBe(0)
    expect(scored[0]!.loaded!.turn.id).toBe(TURN)
  })

  it("never loads another user's turn for Langfuse (no export, no score data)", async () => {
    const { deps } = userDeps()
    const loaded: (TurnExport | null)[] = []
    const exporter: TraceExporter = {
      exportTurn: async () => false,
      scoreFeedback: async (f) => {
        loaded.push(await f.load())
      },
    }
    const someoneElse = { ...trace, turn: { ...trace.turn, userId: '00000000-0000-4000-8000-00000000beef' } }
    const h = createFeedbackHandler(deps, { exporter, ops: { turnTrace: async () => someoneElse } })
    const r = await h(req('/api/feedback', 'POST', 'anon', { turn_id: TURN, rating: -1 }))
    expect(r.status).toBe(200)
    expect(loaded).toEqual([null])
  })

  it('does not call Langfuse when saving fails, and a failing or hanging exporter does not fail or delay the response', async () => {
    const { deps, users } = userDeps()
    let calls = 0
    const throwing: TraceExporter = {
      exportTurn: async () => false,
      scoreFeedback: async () => {
        calls++
        throw new Error('langfuse down')
      },
    }
    const hang: TraceExporter = { exportTurn: async () => false, scoreFeedback: () => new Promise<void>(() => {}) }
    const ok = await createFeedbackHandler(deps, { exporter: throwing, ops: null })(req('/api/feedback', 'POST', 'anon', { turn_id: TURN, rating: 1 }))
    expect(ok.status).toBe(200)
    expect(calls).toBe(1)
    const t0 = Date.now()
    const slow = await createFeedbackHandler(deps, { exporter: hang, ops: null, waitMs: 30 })(req('/api/feedback', 'POST', 'anon', { turn_id: TURN, rating: 1 }))
    expect(slow.status).toBe(200)
    expect(Date.now() - t0).toBeLessThan(1000)

    users.saveFeedback = async () => {
      throw new Error('db')
    }
    calls = 0
    const bad = await createFeedbackHandler(deps, { exporter: throwing, ops: null })(req('/api/feedback', 'POST', 'anon', { turn_id: TURN, rating: 1 }))
    expect(bad.status).toBe(503)
    expect(calls).toBe(0)
  })
})

describe('Langfuse trace deletion (/api/me/delete)', () => {
  const env = { LANGFUSE_PUBLIC_KEY: 'pk-lf-1', LANGFUSE_SECRET_KEY: 'sk-lf-1', LANGFUSE_BASE_URL: 'https://cloud.langfuse.com/' }

  function lf(handler: (url: URL, init: RequestInit) => Response) {
    const calls: { url: URL; init: RequestInit }[] = []
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      calls.push({ url, init: init ?? {} })
      return handler(url, init ?? {})
    }) as typeof fetch
    return { f, calls }
  }

  it('skips without credentials', async () => {
    const { f, calls } = lf(() => new Response('{}'))
    expect(await deleteLangfuseTraces(USER, {}, f, NOW)).toEqual({ skipped: true, found: 0, deleted: 0 })
    expect(calls).toHaveLength(0)
  })

  it('lists root observations by userId with Basic auth, follows the cursor, de-duplicates and bulk-deletes', async () => {
    const { f, calls } = lf((url, init) => {
      if (init.method === 'GET') {
        const cursor = url.searchParams.get('cursor')
        return new Response(
          JSON.stringify(
            cursor === null
              ? { data: [{ id: 'o1', traceId: 't1' }, { id: 'o2', traceId: 't2' }], meta: { cursor: 'next' } }
              : { data: [{ id: 'o3', traceId: 't2' }, { id: 'o4', traceId: null }, { id: 'o5', traceId: 't3' }], meta: {} },
          ),
        )
      }
      return new Response('{"message":"ok"}')
    })
    const out = await deleteLangfuseTraces(USER, env, f, NOW)
    expect(out).toEqual({ skipped: false, found: 3, deleted: 3 })
    const first = calls[0]!
    expect(first.url.origin + first.url.pathname).toBe('https://cloud.langfuse.com/api/public/v2/observations')
    expect(first.url.searchParams.get('userId')).toBe(USER)
    expect(first.url.searchParams.get('isRootObservation')).toBe('true')
    expect(first.url.searchParams.get('limit')).toBe('1000')
    expect(first.url.searchParams.get('fromStartTime')).toBeTruthy()
    expect((first.init.headers as Record<string, string>).authorization).toBe('Basic ' + btoa('pk-lf-1:sk-lf-1'))
    expect(calls[1]!.url.searchParams.get('cursor')).toBe('next')
    const del = calls[2]!
    expect(del.init.method).toBe('DELETE')
    expect(del.url.pathname).toBe('/api/public/traces')
    expect(JSON.parse(String(del.init.body))).toEqual({ traceIds: ['t1', 't2', 't3'] })
  })

  it('does not call delete when the user has no traces; errors propagate to the caller', async () => {
    const empty = lf(() => new Response(JSON.stringify({ data: [], meta: {} })))
    expect(await deleteLangfuseTraces(USER, env, empty.f, NOW)).toEqual({ skipped: false, found: 0, deleted: 0 })
    expect(empty.calls).toHaveLength(1)
    const bad = lf(() => new Response('no', { status: 500 }))
    await expect(deleteLangfuseTraces(USER, env, bad.f, NOW)).rejects.toThrow('langfuse list 500')
  })

  it('the delete handler still deletes the account when Langfuse fails, and only uses Langfuse when configured', async () => {
    const lfCalls: string[] = []
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('langfuse')) {
        lfCalls.push(url)
        return new Response('boom', { status: 500 })
      }
      return authFetch(input, init)
    }) as typeof fetch
    const { deps, users } = userDeps({ fetch: fetchImpl, env: { VITE_SUPABASE_ANON_KEY: 'k', ...env } })
    await users.upsertProfile({ userId: USER, displayName: 'N', riskDefault: 'expected', quietFrom: null, quietTo: null })
    const r = await createDeleteMeHandler(deps)(req('/api/me/delete', 'POST', 'google', { confirm: 'DELETE' }))
    expect(r.status).toBe(200)
    expect(lfCalls).toHaveLength(1)
    expect(users.profiles.has(USER)).toBe(false)

    clearAuthCache()
    const plain = userDeps({ fetch: fetchImpl })
    await plain.users.upsertProfile({ userId: USER, displayName: 'N', riskDefault: 'expected', quietFrom: null, quietTo: null })
    expect((await createDeleteMeHandler(plain.deps)(req('/api/me/delete', 'POST', 'google', { confirm: 'DELETE' }))).status).toBe(200)
    expect(lfCalls).toHaveLength(1)
  })
})

describe('admin identity', () => {
  it('the test admin is not a regular user', async () => {
    const { deps } = makeDeps()
    expect(await deps.ops.isAdmin(ADMIN)).toBe(true)
    expect(await deps.ops.isAdmin(USER)).toBe(false)
  })
})
