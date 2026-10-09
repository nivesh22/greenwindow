// Test helpers for the P4 endpoint tests: in-memory stores, a fake Supabase Auth, a recording push sender.
import { loadConfig } from '../../agent/config.js'
import { FixtureForecastSource } from '../../agent/data/forecast_source.js'
import { FIXTURE_NOW_UTC } from '../../agent/data/types.js'
import { MemoryPlanStore, type OpsRows, type OpsStore, type TurnTrace } from '../../agent/store/plan_types.js'
import { MemoryLedgerStore } from '../../agent/store/supabase_plans.js'
import { FIXTURE_DIR } from '../../agent/tools/testing.js'
import type { P4Deps } from './p4.js'
import type { PushSender, PushTarget } from './push.js'

export const ANON = '33333333-3333-4333-8333-333333333333'
export const USER = '44444444-4444-4444-8444-444444444444'
export const OTHER = '66666666-6666-4666-8666-666666666666'
export const ADMIN = '77777777-7777-4777-8777-777777777777'
export const TURN = '55555555-5555-4555-8555-555555555555'
export const CRON_SECRET = 'cron-secret-for-tests'
export const NOW = Date.parse(FIXTURE_NOW_UTC) // 2026-10-06T00:30:00Z, a Tuesday

const authUsers: Record<string, unknown> = {
  anon: { id: ANON, is_anonymous: true, email: null },
  google: { id: USER, is_anonymous: false, email: 'a@b.c' },
  other: { id: OTHER, is_anonymous: false, email: 'o@b.c' },
  admin: { id: ADMIN, is_anonymous: false, email: 'admin@b.c' },
}

export const authFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
  const token = String((init?.headers as Record<string, string>)?.authorization ?? '').replace('Bearer ', '')
  const u = authUsers[token]
  return u ? new Response(JSON.stringify(u)) : new Response('{"msg":"bad"}', { status: 401 })
}) as typeof fetch

export class FakeOpsStore implements OpsStore {
  admins = new Set<string>([ADMIN])
  trace: TurnTrace | null = null
  rows: OpsRows = { turns: [], spans: [], feedback: [], evalRuns: [], budget: { month: '2026-10', spentUsd: 0.5, evalSpentUsd: 0, paused: false } }
  sinceMs: number | null = null
  async isAdmin(userId: string): Promise<boolean> {
    return this.admins.has(userId)
  }
  async turnTrace(turnId: string): Promise<TurnTrace | null> {
    return this.trace && this.trace.turn.id === turnId ? this.trace : null
  }
  async opsRows(sinceMs: number): Promise<OpsRows> {
    this.sinceMs = sinceMs
    return this.rows
  }
}

export interface PushCall {
  target: PushTarget
  payload: string
}

export function makeDeps(over: Partial<P4Deps> & { nowMs?: number; pushErrors?: Record<string, unknown> } = {}) {
  const nowMs = over.nowMs ?? NOW
  const plans = new MemoryPlanStore({ now: () => nowMs })
  const ops = new FakeOpsStore()
  const ledger = new MemoryLedgerStore()
  const pushCalls: PushCall[] = []
  const pushErrors = over.pushErrors ?? {}
  const push: PushSender = async (target, payload) => {
    pushCalls.push({ target, payload })
    const err = pushErrors[target.endpoint]
    if (err !== undefined) throw err
  }
  const deps: P4Deps = {
    config: loadConfig({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_x', MONTHLY_BUDGET_USD: '5' }),
    env: { VITE_SUPABASE_ANON_KEY: 'sb_publishable_x', CRON_SECRET },
    fetch: authFetch,
    now: () => nowMs,
    plans,
    ops,
    ledger,
    data: new FixtureForecastSource(FIXTURE_DIR, () => nowMs),
    push,
    ...over,
  }
  return { deps, plans, ops, ledger, pushCalls }
}

export const req = (path: string, method: string, token?: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://x.test${path}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'x-forwarded-for': '9.9.9.9', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
  })

export const cronReq = (path: string, secret: string | null = CRON_SECRET, method = 'POST') =>
  new Request(`https://x.test${path}`, { method, headers: secret === null ? {} : { 'x-cron-secret': secret }, body: method === 'POST' ? '{}' : undefined })

export const errCode = async (r: Response) => ((await r.json()) as { error: { code: string } }).error.code
