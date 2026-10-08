import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../agent/config.js'
import type { SseEvent } from '../agent/harness/events.js'
import { MemoryStore, type ConsumeResult, type Store } from '../agent/store/types.js'
import { createChatHandler } from './chat.js'
import { HEARTBEAT_MS, ipHash, sseResponse } from './_lib/http.js'
import { placeholderRunner } from './_lib/turn_runner.js'

const FULL_ENV = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_x', IP_SALT: 'salt-salt-salt-salt' }
const body = {
  conversation_id: null,
  message: 'hi',
  panel_state: null,
  client_now_utc: '2026-10-08T10:00:00Z',
}
const post = (b: unknown, headers: Record<string, string> = {}) =>
  new Request('https://x.test/api/chat', {
    method: 'POST',
    body: typeof b === 'string' ? b : JSON.stringify(b),
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '1.2.3.4, 5.6.7.8', ...headers },
  })
const mkHandler = (env: Record<string, string> = FULL_ENV, store: Store = new MemoryStore()) =>
  createChatHandler({ store, runTurn: placeholderRunner, config: loadConfig(env), now: () => Date.UTC(2026, 9, 8, 10) })

function parseSse(text: string): Array<{ event: string; data: unknown }> {
  return text
    .split('\n\n')
    .filter((b) => b.startsWith('event:'))
    .map((b) => {
      const [e, d] = b.split('\n')
      return { event: e!.slice(7), data: JSON.parse(d!.slice(6)) }
    })
}

describe('chat handler', () => {
  it('rejects non-POST with 405', async () => {
    const r = await mkHandler()(new Request('https://x.test/api/chat'))
    expect(r.status).toBe(405)
  })

  it('400 on bad JSON and on schema failure', async () => {
    const h = mkHandler()
    const r1 = await h(post('{nope'))
    expect(r1.status).toBe(400)
    expect(((await r1.json()) as { error: { code: string } }).error.code).toBe('bad_request')
    const r2 = await h(post({ ...body, message: '' }))
    expect(r2.status).toBe(400)
    expect(((await r2.json()) as { error: { code: string; message: string } }).error.code).toBe('bad_request')
  })

  it('503 not_configured when server keys are missing', async () => {
    const r = await mkHandler({})(post(body))
    expect(r.status).toBe(503)
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('not_configured')
  })

  it('503 when the store fails (fail closed)', async () => {
    const store: Store = Object.assign(new MemoryStore(), {
      consumeMessage: (): Promise<ConsumeResult> => Promise.reject(new Error('down')),
    })
    const r = await mkHandler(FULL_ENV, store)(post(body))
    expect(r.status).toBe(503)
  })

  it('streams a single limit event when not allowed', async () => {
    const store = new MemoryStore()
    await store.addSpend(Date.UTC(2026, 9, 8), 10, 5) // pauses the month
    const r = await mkHandler(FULL_ENV, store)(post(body))
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('text/event-stream')
    const evs = parseSse(await r.text())
    expect(evs).toHaveLength(1)
    expect(evs[0]?.event).toBe('limit')
    expect(evs[0]?.data).toMatchObject({ kind: 'budget_paused', sign_in: false })
  })

  it('budget: allowed until addSpend reaches the limit, then budget_paused', async () => {
    const store = new MemoryStore()
    const nowMs = Date.UTC(2026, 9, 8, 10)
    const h = mkHandler(FULL_ENV, store)
    expect(parseSse(await (await h(post(body))).text())[0]?.event).toBe('turn_start')
    await store.addSpend(nowMs, 4.99, 5)
    expect(parseSse(await (await h(post(body, { 'x-forwarded-for': '9.9.9.9' }))).text())[0]?.event).toBe('turn_start')
    await store.addSpend(nowMs, 0.01, 5)
    const evs = parseSse(await (await h(post(body, { 'x-forwarded-for': '8.8.8.8' }))).text())
    expect(evs).toHaveLength(1)
    expect(evs[0]?.data).toMatchObject({ kind: 'budget_paused', message: expect.stringContaining('paused for this month') })
  })

  it('IP hourly cap boundary: the cap-th message passes, the next is rate-limited with a clear message', async () => {
    const cap = loadConfig(FULL_ENV).IP_HOURLY_CAP
    const h = mkHandler(FULL_ENV)
    for (let i = 0; i < cap; i++) {
      expect(parseSse(await (await h(post(body))).text())[0]?.event).toBe('turn_start')
    }
    const evs = parseSse(await (await h(post(body))).text())
    expect(evs).toHaveLength(1)
    expect(evs[0]?.data).toMatchObject({ kind: 'rate', message: expect.stringContaining('Too many requests') })
    // A different IP is unaffected.
    expect(parseSse(await (await h(post(body, { 'x-forwarded-for': '7.7.7.7' }))).text())[0]?.event).toBe('turn_start')
  })

  it('passes configured caps to the store and messages_left to the runner', async () => {
    const seen: unknown[] = []
    const store: Store = Object.assign(new MemoryStore(), {
      consumeMessage: async (a: unknown): Promise<ConsumeResult> => {
        seen.push(a)
        return { allowed: true, kind: null, messagesLeft: 2 }
      },
    })
    let left: number | null | undefined
    const cfg = loadConfig(FULL_ENV)
    const h = createChatHandler({
      store,
      config: cfg,
      now: () => 0,
      runTurn: async ({ messagesLeft }) => {
        left = messagesLeft
      },
    })
    await (await h(post(body))).text()
    expect(seen[0]).toMatchObject({ ipHourlyCap: cfg.IP_HOURLY_CAP, globalDailyCap: cfg.GLOBAL_DAILY_CAP })
    expect(left).toBe(2)
  })

  it('happy path: turn_start, answer, done with SSE framing and headers', async () => {
    const r = await mkHandler()(post(body))
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('text/event-stream')
    expect(r.headers.get('cache-control')).toBe('no-cache, no-transform')
    const text = await r.text()
    expect(text).toMatch(/^event: turn_start\ndata: \{.*\}\n\nevent: answer\ndata: \{"text":"The assistant is being built."\}\n\nevent: done\n/)
    const evs = parseSse(text)
    expect(evs.map((e) => e.event)).toEqual(['turn_start', 'answer', 'done'])
    expect(evs[2]?.data).toMatchObject({ stop_reason: 'final', trace: { gates: [], tools: [], llm_calls: [] } })
  })

  it('passes the hashed IP (never the raw IP) to the runner and store', async () => {
    const seen: string[] = []
    const h = createChatHandler({
      store: new MemoryStore(),
      config: loadConfig(FULL_ENV),
      now: () => 0,
      runTurn: async ({ ipHash: hash }, emit: (ev: SseEvent) => void) => {
        seen.push(hash)
        emit({ type: 'answer', data: { text: 'x' } })
      },
    })
    await (await h(post(body))).text()
    const expected = await ipHash(post(body), FULL_ENV.IP_SALT)
    expect(seen).toEqual([expected])
    expect(expected).toMatch(/^[0-9a-f]{64}$/)
    expect(expected).not.toContain('1.2.3.4')
  })
})

describe('ipHash', () => {
  it('uses only the first x-forwarded-for hop and depends on the salt', async () => {
    const a = await ipHash(post(body, { 'x-forwarded-for': '1.1.1.1, 9.9.9.9' }), 's')
    const b = await ipHash(post(body, { 'x-forwarded-for': '1.1.1.1' }), 's')
    const c = await ipHash(post(body, { 'x-forwarded-for': '1.1.1.1' }), 't')
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })
})

describe('sseResponse', () => {
  afterEach(() => vi.useRealTimers())

  it('emits an error event then closes when run rejects', async () => {
    const r = sseResponse(async () => {
      throw new Error('kaput')
    })
    const evs = parseSse(await r.text())
    expect(evs).toEqual([{ event: 'error', data: { code: 'internal', message: 'kaput' } }])
  })

  it('sends heartbeat comments every 10 s and stops on client abort', async () => {
    vi.useFakeTimers()
    const ac = new AbortController()
    let runSignal: AbortSignal | undefined
    const r = sseResponse((_emit, signal) => {
      runSignal = signal
      return new Promise<void>(() => {})
    }, ac.signal)
    const reader = r.body!.getReader()
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS)
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toBe(': heartbeat\n\n')
    ac.abort()
    expect(runSignal?.aborted).toBe(true)
    expect((await reader.read()).done).toBe(true)
  })
})
