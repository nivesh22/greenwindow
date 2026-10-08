import type { RetryPolicy } from '../harness/retry'
import { AllProvidersFailed, ModelRouter } from './router'
import { ev, providerError, ScriptedProvider } from './scripted'
import type { ModelProvider } from './types'

const req = { messages: [{ role: 'user' as const, content: 'hi' }], maxOutputTokens: 10, temperature: 0 }
const sig = (): AbortSignal => new AbortController().signal

function policy(sleeps: number[] = []): RetryPolicy {
  return { maxRetries: 2, random: () => 0.5, sleep: async (ms) => void sleeps.push(ms), now: () => 0 }
}

describe('ModelRouter', () => {
  it('returns the buffered events and fills in the entry model', async () => {
    const p = new ScriptedProvider([[ev.text('hi'), ev.finish()]], 'gemini-direct')
    const r = new ModelRouter([{ provider: p, model: 'gemini-3.8-flash' }], { retry: policy() })
    const out = await r.complete(req, sig())
    expect(out.events).toEqual([ev.text('hi'), ev.finish()])
    expect(out).toMatchObject({ provider: 'gemini-direct', model: 'gemini-3.8-flash' })
    expect(out.calls).toEqual([
      expect.objectContaining({ provider: 'gemini-direct', model: 'gemini-3.8-flash', failover: false, failoverReason: null, ok: true, attempts: 1 }),
    ])
    expect(p.requests[0]?.model).toBe('gemini-3.8-flash')
    expect(r.models).toEqual(['gemini-3.8-flash'])
  })

  it('retries a retryable error before any event, with backoff', async () => {
    const sleeps: number[] = []
    const p = new ScriptedProvider([providerError('server', { status: 503 }), providerError('network'), [ev.finish()]])
    const r = new ModelRouter([{ provider: p, model: 'm' }], { retry: policy(sleeps) })
    const out = await r.complete(req, sig())
    expect(out.calls[0]).toMatchObject({ ok: true, attempts: 3 })
    expect(sleeps).toEqual([250, 500])
  })

  it('fails over to the next entry once retries are exhausted', async () => {
    const a = new ScriptedProvider([providerError('server'), providerError('server'), providerError('server')], 'gemini-direct')
    const b = new ScriptedProvider([[ev.text('from b'), ev.finish()]], 'ai-gateway')
    const r = new ModelRouter([{ provider: a, model: 'ma' }, { provider: b, model: 'mb' }], { retry: policy() })
    const out = await r.complete(req, sig())
    expect(out).toMatchObject({ provider: 'ai-gateway', model: 'mb' })
    expect(out.calls).toEqual([
      expect.objectContaining({ provider: 'gemini-direct', ok: false, attempts: 3, failover: false, errorKind: 'server' }),
      expect.objectContaining({ provider: 'ai-gateway', ok: true, failover: true, failoverReason: 'retries_exhausted' }),
    ])
  })

  it('fails over immediately on 429 (no retry)', async () => {
    const a = new ScriptedProvider([providerError('rate_limit', { status: 429, retryAfterMs: 1000 })], 'gemini-direct')
    const b = new ScriptedProvider([[ev.finish()]], 'ai-gateway')
    const r = new ModelRouter([{ provider: a, model: 'ma' }, { provider: b, model: 'mb' }], { retry: policy() })
    const out = await r.complete(req, sig())
    expect(a.calls).toBe(1)
    expect(out.calls[1]).toMatchObject({ failover: true, failoverReason: 'rate_limit' })
  })

  it('never retries after an event was received; it fails over and discards the partial events', async () => {
    const a = new ScriptedProvider([{ events: [ev.text('partial')], error: providerError('network') }], 'gemini-direct')
    const b = new ScriptedProvider([[ev.text('clean'), ev.finish()]], 'ai-gateway')
    const r = new ModelRouter([{ provider: a, model: 'ma' }, { provider: b, model: 'mb' }], { retry: policy() })
    const out = await r.complete(req, sig())
    expect(a.calls).toBe(1)
    expect(out.events).toEqual([ev.text('clean'), ev.finish()])
    expect(out.calls[1]).toMatchObject({ failoverReason: 'mid_stream' })
  })

  it('throws AllProvidersFailed with every attempt when all entries fail', async () => {
    const a = new ScriptedProvider([providerError('client', { status: 400 })], 'gemini-direct')
    const b = new ScriptedProvider([providerError('rate_limit', { status: 429 })], 'ai-gateway')
    const r = new ModelRouter([{ provider: a, model: 'ma' }, { provider: b, model: 'mb' }], { retry: policy() })
    const err = await r.complete(req, sig()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AllProvidersFailed)
    const calls = (err as AllProvidersFailed).calls
    expect(calls.map((c) => [c.provider, c.errorKind, c.failoverReason])).toEqual([
      ['gemini-direct', 'client', null],
      ['ai-gateway', 'rate_limit', 'non_retryable'],
    ])
  })

  it('skips entries the breaker seam rejects and reports hooks', async () => {
    const a = new ScriptedProvider([], 'gemini-direct')
    const b = new ScriptedProvider([[ev.finish()]], 'ai-gateway')
    const seen: string[] = []
    const r = new ModelRouter([{ provider: a, model: 'ma' }, { provider: b, model: 'mb' }], {
      retry: policy(),
      hooks: { canUse: (e) => e.model !== 'ma', onSuccess: (e) => void seen.push(`ok:${e.model}`), onFailure: (e) => void seen.push(`fail:${e.model}`) },
    })
    const out = await r.complete(req, sig())
    expect(a.calls).toBe(0)
    expect(out.calls).toEqual([
      expect.objectContaining({ provider: 'gemini-direct', attempts: 0, ok: false }),
      expect.objectContaining({ provider: 'ai-gateway', failover: true, failoverReason: 'unavailable', ok: true }),
    ])
    expect(seen).toEqual(['ok:mb'])
  })

  it('does not fail over on abort; it rethrows the abort reason', async () => {
    const ctrl = new AbortController()
    const reason = new Error('wall')
    ctrl.abort(reason)
    const a = new ScriptedProvider([[ev.finish()]], 'gemini-direct')
    const b = new ScriptedProvider([[ev.finish()]], 'ai-gateway')
    const r = new ModelRouter([{ provider: a, model: 'ma' }, { provider: b, model: 'mb' }], { retry: policy() })
    await expect(r.complete(req, ctrl.signal)).rejects.toBe(reason)
    expect(b.calls).toBe(0)
  })
})

describe('first-event timeout', () => {
  it('fails over without retrying when the first provider sends nothing in time', async () => {
    const hang: ModelProvider = {
      id: 'gemini-direct',
      async *complete(_req, signal) {
        await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
        yield { type: 'finish', reason: 'stop' } as const
      },
    }
    let hangCalls = 0
    const counted: ModelProvider = { id: 'gemini-direct', complete: (r, s) => (hangCalls++, hang.complete(r, s)) }
    const ok = new ScriptedProvider([[{ type: 'text', delta: 'hi' }, { type: 'finish', reason: 'stop' }]])
    const router = new ModelRouter([{ provider: counted, model: 'slow' }, { provider: ok, model: 'fast' }], { firstEventTimeoutMs: 20 })
    const res = await router.complete({ messages: [], maxOutputTokens: 10, temperature: 0 }, new AbortController().signal)
    expect(res.model).toBe('fast')
    expect(hangCalls).toBe(1)
    expect(res.calls[0]).toMatchObject({ ok: false, errorKind: 'timeout' })
    expect(res.calls[1]).toMatchObject({ failover: true })
  })
})
