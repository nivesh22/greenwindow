// SupabaseStore: Store implementation over plain fetch to Supabase PostgREST (no supabase-js). Schema and RPC
// signatures: supabase/migrations/20261008000001_init.sql (keep in sync). Never log keys or request headers.
//
// Auth headers. Per https://supabase.com/docs/guides/api/api-keys : "Send publishable and secret keys on the
// `apikey` header, not on `Authorization: Bearer`" (the new keys are not JWTs, so JWT verification of a Bearer
// value fails). So `sb_secret_...` keys go on `apikey` only. Legacy JWT service_role keys (start with `eyJ`) get
// both `apikey` and `Authorization: Bearer`, as PostgREST expects for JWTs. The docs page does not state outright
// that PostgREST rejects a Bearer sb_secret_ key; apikey-only is the documented recommendation.
import { z } from 'zod'
import type { BudgetState, ConsumeArgs, ConsumeResult, SpanRecord, Store, TurnRecord } from './types.js'

export class StoreError extends Error {
  readonly code: 'http' | 'network' | 'parse'
  readonly status: number | null
  constructor(code: StoreError['code'], message: string, status: number | null = null) {
    super(message)
    this.name = 'StoreError'
    this.code = code
    this.status = status
  }
}

export interface SupabaseStoreOptions {
  url: string
  key: string
  fetch?: typeof fetch
  timeoutMs?: number
}

const consumeSchema = z.object({
  allowed: z.boolean(),
  kind: z.enum(['anon_limit', 'daily_cap', 'rate', 'budget_paused']).nullable(),
  messages_left: z.number().int().nullable(),
})

const ledgerSchema = z.object({
  month: z.string(),
  spent_usd: z.coerce.number(), // numeric may arrive as number or string
  paused: z.boolean(),
})

const monthOf = (ms: number): string => new Date(ms).toISOString().slice(0, 7)

export function authHeaders(key: string): Record<string, string> {
  return key.startsWith('sb_secret_') ? { apikey: key } : { apikey: key, Authorization: `Bearer ${key}` }
}

export class SupabaseStore implements Store {
  private readonly base: string
  private readonly key: string
  private readonly doFetch: typeof fetch
  private readonly timeoutMs: number

  constructor(opts: SupabaseStoreOptions) {
    this.base = opts.url.replace(/\/+$/, '') + '/rest/v1'
    this.key = opts.key
    this.doFetch = opts.fetch ?? ((input, init) => fetch(input, init))
    this.timeoutMs = opts.timeoutMs ?? 8000
  }

  private async call(path: string, init: { method: 'GET' | 'POST'; body?: unknown; prefer?: string }): Promise<unknown> {
    const headers: Record<string, string> = { ...authHeaders(this.key), accept: 'application/json' }
    if (init.body !== undefined) headers['content-type'] = 'application/json'
    if (init.prefer) headers.prefer = init.prefer
    const label = path.split('?')[0]
    let res: Response
    try {
      res = await this.doFetch(this.base + path, {
        method: init.method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (e) {
      throw new StoreError('network', `Supabase request failed: ${e instanceof Error ? e.name : 'error'}`)
    }
    if (!res.ok) {
      let detail = ''
      try {
        detail = (await res.text()).slice(0, 200)
      } catch {
        // ignore
      }
      throw new StoreError('http', `Supabase ${label} returned ${res.status} ${detail}`.trim(), res.status)
    }
    const text = await res.text()
    if (text === '') return null
    try {
      return JSON.parse(text)
    } catch {
      throw new StoreError('parse', `Supabase ${label} returned invalid JSON`, res.status)
    }
  }

  private parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
    const r = schema.safeParse(value)
    if (!r.success) throw new StoreError('parse', `Unexpected ${what} response shape`)
    return r.data
  }

  async consumeMessage(a: ConsumeArgs): Promise<ConsumeResult> {
    const raw = await this.call('/rpc/consume_message', {
      method: 'POST',
      body: {
        p_user: a.userId,
        p_ip_hash: a.ipHash,
        p_is_anon: a.isAnonymous,
        p_daily_cap: a.dailyCap,
        p_anon_cap: a.anonCap,
        p_ip_hourly_cap: a.ipHourlyCap,
        p_global_daily_cap: a.globalDailyCap,
      },
    })
    const r = this.parse(consumeSchema, raw, 'consume_message')
    return { allowed: r.allowed, kind: r.kind, messagesLeft: r.messages_left }
  }

  async budget(nowMs: number): Promise<BudgetState> {
    const month = monthOf(nowMs)
    const raw = await this.call(`/cost_ledger?select=month,spent_usd,paused&month=eq.${month}`, { method: 'GET' })
    const rows = this.parse(z.array(ledgerSchema), raw, 'cost_ledger')
    const row = rows[0]
    return row ? { month: row.month, spentUsd: row.spent_usd, paused: row.paused } : { month, spentUsd: 0, paused: false }
  }

  async addSpend(_nowMs: number, usd: number, limitUsd: number): Promise<BudgetState> {
    // The SQL function uses the database clock for the month.
    const raw = await this.call('/rpc/add_spend', { method: 'POST', body: { p_usd: usd, p_limit_usd: limitUsd } })
    const r = this.parse(ledgerSchema, raw, 'add_spend')
    return { month: r.month, spentUsd: r.spent_usd, paused: r.paused }
  }

  async saveTurn(turn: TurnRecord, spans: SpanRecord[]): Promise<void> {
    await this.call('/turns', {
      method: 'POST',
      prefer: 'return=minimal',
      body: {
        id: turn.id,
        conversation_id: turn.conversationId,
        user_id: turn.userId,
        ip_hash: turn.ipHash,
        intent: turn.intent,
        stop_reason: turn.stopReason,
        prompt_version: turn.promptVersion,
        model_final: turn.modelFinal,
        tokens_in: turn.tokensIn,
        tokens_out: turn.tokensOut,
        cost_usd: turn.costUsd,
        latency_ms: Math.round(turn.latencyMs),
        created_at: turn.createdAtUtc,
      },
    })
    if (spans.length === 0) return
    await this.call('/spans', {
      method: 'POST',
      prefer: 'return=minimal',
      body: spans.map((s) => ({
        id: s.id,
        turn_id: s.turnId,
        parent_id: s.parentId,
        kind: s.kind,
        name: s.name,
        started_at: s.startedAtUtc,
        duration_ms: Math.round(s.durationMs),
        status: s.status,
        attrs: s.attrs,
        tokens_in: s.tokensIn,
        tokens_out: s.tokensOut,
        cost_usd: s.costUsd,
      })),
    })
  }
}
