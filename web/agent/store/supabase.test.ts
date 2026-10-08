import { describe, expect, it, vi } from 'vitest'
import { StoreError, SupabaseStore } from './supabase.js'
import type { ConsumeArgs, SpanRecord, TurnRecord } from './types.js'

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

function fake(responses: Array<{ status?: number; body?: unknown; raw?: string } | Error>) {
  const calls: Call[] = []
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: init?.headers as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    })
    const r = responses.shift()
    if (!r) throw new Error('no more responses')
    if (r instanceof Error) throw r
    return new Response(r.raw ?? (r.body === undefined ? '' : JSON.stringify(r.body)), { status: r.status ?? 200 })
  }) as typeof fetch
  return { f, calls }
}

const args: ConsumeArgs = {
  userId: null,
  ipHash: 'h',
  isAnonymous: false,
  dailyCap: 20,
  anonCap: 3,
  ipHourlyCap: 20,
  globalDailyCap: 300,
  nowMs: Date.UTC(2026, 9, 8),
}
const mk = (key: string, f: typeof fetch) => new SupabaseStore({ url: 'https://x.supabase.co/', key, fetch: f })

describe('SupabaseStore', () => {
  it('consumeMessage posts the RPC args and maps the result', async () => {
    const { f, calls } = fake([{ body: { allowed: false, kind: 'rate', messages_left: null } }])
    const r = await mk('sb_secret_abc', f).consumeMessage(args)
    expect(r).toEqual({ allowed: false, kind: 'rate', messagesLeft: null })
    expect(calls[0]?.url).toBe('https://x.supabase.co/rest/v1/rpc/consume_message')
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.body).toEqual({
      p_user: null,
      p_ip_hash: 'h',
      p_is_anon: false,
      p_daily_cap: 20,
      p_anon_cap: 3,
      p_ip_hourly_cap: 20,
      p_global_daily_cap: 300,
    })
  })

  it('sends apikey only for sb_secret keys, both headers for legacy JWT keys', async () => {
    const ok = { body: { allowed: true, kind: null, messages_left: 2 } }
    const a = fake([ok])
    await mk('sb_secret_abc', a.f).consumeMessage(args)
    expect(a.calls[0]?.headers.apikey).toBe('sb_secret_abc')
    expect(a.calls[0]?.headers.Authorization).toBeUndefined()
    const b = fake([ok])
    await mk('eyJhbGciOi.x.y', b.f).consumeMessage(args)
    expect(b.calls[0]?.headers.apikey).toBe('eyJhbGciOi.x.y')
    expect(b.calls[0]?.headers.Authorization).toBe('Bearer eyJhbGciOi.x.y')
  })

  it('budget selects the month row; empty means zero spend', async () => {
    const { f, calls } = fake([{ body: [{ month: '2026-10', spent_usd: '1.25', paused: true }] }, { body: [] }])
    const s = mk('sb_secret_abc', f)
    expect(await s.budget(Date.UTC(2026, 9, 8))).toEqual({ month: '2026-10', spentUsd: 1.25, paused: true })
    expect(calls[0]?.url).toBe('https://x.supabase.co/rest/v1/cost_ledger?select=month,spent_usd,paused&month=eq.2026-10')
    expect(calls[0]?.method).toBe('GET')
    expect(await s.budget(Date.UTC(2026, 10, 1))).toEqual({ month: '2026-11', spentUsd: 0, paused: false })
  })

  it('addSpend calls the RPC', async () => {
    const { f, calls } = fake([{ body: { month: '2026-10', spent_usd: 5.01, paused: true } }])
    const r = await mk('sb_secret_abc', f).addSpend(0, 0.01, 5)
    expect(r).toEqual({ month: '2026-10', spentUsd: 5.01, paused: true })
    expect(calls[0]?.url).toBe('https://x.supabase.co/rest/v1/rpc/add_spend')
    expect(calls[0]?.body).toEqual({ p_usd: 0.01, p_limit_usd: 5 })
  })

  it('addSpend warns once on the 80% crossing and tolerates a missing alert_80', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { f } = fake([
      { body: { month: '2026-10', spent_usd: 4, paused: false, alerted_80: true, alert_80: true } },
      { body: { month: '2026-10', spent_usd: 4.1, paused: false, alerted_80: true, alert_80: false } },
      { body: { month: '2026-10', spent_usd: 4.2, paused: false } },
    ])
    const s = mk('sb_secret_abc', f)
    expect(await s.addSpend(0, 4, 5)).toEqual({ month: '2026-10', spentUsd: 4, paused: false })
    await s.addSpend(0, 0.1, 5)
    await s.addSpend(0, 0.1, 5)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('budget 80%', '2026-10')
    warn.mockRestore()
  })

  it('saveTurn inserts the turn then the spans in snake_case', async () => {
    const { f, calls } = fake([{ status: 201 }, { status: 201 }])
    const turn: TurnRecord = {
      id: 't1',
      conversationId: 'c1',
      userId: null,
      ipHash: 'h',
      intent: null,
      stopReason: 'final',
      promptVersion: 'v1',
      modelFinal: 'm',
      tokensIn: 1,
      tokensOut: 2,
      costUsd: 0.001,
      latencyMs: 12.4,
      createdAtUtc: '2026-10-08T10:00:00Z',
    }
    const span: SpanRecord = {
      id: 's1',
      turnId: 't1',
      parentId: null,
      kind: 'llm',
      name: 'chat',
      startedAtUtc: '2026-10-08T10:00:00Z',
      durationMs: 5,
      status: 'ok',
      attrs: { 'gen_ai.system': 'gemini' },
      tokensIn: 1,
      tokensOut: 2,
      costUsd: 0.001,
    }
    await mk('sb_secret_abc', f).saveTurn(turn, [span])
    expect(calls.map((c) => c.url)).toEqual(['https://x.supabase.co/rest/v1/turns', 'https://x.supabase.co/rest/v1/spans'])
    expect(calls[0]?.body).toMatchObject({ conversation_id: 'c1', stop_reason: 'final', latency_ms: 12, created_at: '2026-10-08T10:00:00Z' })
    expect(calls[1]?.body).toEqual([
      expect.objectContaining({ turn_id: 't1', parent_id: null, started_at: '2026-10-08T10:00:00Z', duration_ms: 5, attrs: { 'gen_ai.system': 'gemini' } }),
    ])
    expect(calls[0]?.headers.prefer).toBe('return=minimal')
  })

  it('maps failures to StoreError without leaking the key', async () => {
    const key = 'sb_secret_topsecret'
    const s1 = mk(key, fake([{ status: 401, body: { message: 'bad' } }]).f)
    await expect(s1.budget(0)).rejects.toMatchObject({ name: 'StoreError', code: 'http', status: 401 })
    const s2 = mk(key, fake([new Error('boom')]).f)
    const e = await s2.budget(0).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(StoreError)
    expect((e as StoreError).code).toBe('network')
    expect((e as StoreError).message).not.toContain(key)
    await expect(mk(key, fake([{ body: { nope: 1 } }]).f).consumeMessage(args)).rejects.toMatchObject({ code: 'parse' })
    await expect(mk(key, fake([{ raw: '{' }]).f).consumeMessage(args)).rejects.toMatchObject({ code: 'parse' })
  })
})
