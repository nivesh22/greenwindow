import { CircuitBreaker } from './breaker.js'
import { AllProvidersFailed, ModelRouter } from './router.js'
import { ev, providerError, ScriptedProvider } from './scripted.js'

const noRetry = { maxRetries: 0, random: () => 0.5, sleep: async () => undefined, now: () => 0 }
const req = { messages: [{ role: 'user' as const, content: 'hi' }], maxOutputTokens: 100, temperature: 0 }
const signal = new AbortController().signal

function clock() {
  let t = 1_000_000
  return { now: () => t, advance: (ms: number) => void (t += ms) }
}

describe('CircuitBreaker', () => {
  const entry = { provider: new ScriptedProvider(), model: 'm1' }
  const other = { provider: new ScriptedProvider(), model: 'm2' }

  it('opens after 3 failures within 60 s and stays open 5 min', () => {
    const c = clock()
    const b = new CircuitBreaker({ now: c.now })
    b.onFailure(entry)
    c.advance(20_000)
    b.onFailure(entry)
    expect(b.canUse(entry)).toBe(true)
    c.advance(20_000)
    b.onFailure(entry)
    expect(b.canUse(entry)).toBe(false)
    expect(b.canUse(other)).toBe(true) // per provider+model
    c.advance(299_999)
    expect(b.canUse(entry)).toBe(false)
    c.advance(1)
    expect(b.canUse(entry)).toBe(true) // closed with a clean slate
    b.onFailure(entry)
    expect(b.canUse(entry)).toBe(true)
  })

  it('does not open when the failures are spread over more than 60 s', () => {
    const c = clock()
    const b = new CircuitBreaker({ now: c.now })
    b.onFailure(entry)
    c.advance(30_000)
    b.onFailure(entry)
    c.advance(30_000) // the first failure is now 60 s old and drops out
    b.onFailure(entry)
    expect(b.canUse(entry)).toBe(true)
  })

  it('a success clears the failure count', () => {
    const b = new CircuitBreaker({ now: clock().now })
    b.onFailure(entry)
    b.onFailure(entry)
    b.onSuccess(entry)
    b.onFailure(entry)
    expect(b.canUse(entry)).toBe(true)
  })

  it('keys by provider id and model', () => {
    const b = new CircuitBreaker({ now: clock().now, threshold: 1 })
    b.onFailure({ provider: new ScriptedProvider([], 'gemini-direct'), model: 'm1' })
    expect(b.isOpen('gemini-direct:m1')).toBe(true)
    expect(b.isOpen('scripted:m1')).toBe(false)
  })
})

describe('CircuitBreaker in the router', () => {
  it('429s open the breaker; the router then skips the entry as unavailable and goes to the fallback', async () => {
    const c = clock()
    const breaker = new CircuitBreaker({ now: c.now })
    const primary = new ScriptedProvider([
      providerError('rate_limit', { status: 429 }),
      providerError('rate_limit', { status: 429 }),
      providerError('rate_limit', { status: 429 }),
    ])
    const fallback = new ScriptedProvider(Array.from({ length: 5 }, () => [ev.text('ok'), ev.finish()]), 'ai-gateway')
    const router = new ModelRouter(
      [{ provider: primary, model: 'p' }, { provider: fallback, model: 'f' }],
      { retry: noRetry, hooks: breaker, now: c.now },
    )
    for (let i = 0; i < 3; i++) {
      const r = await router.complete(req, signal)
      expect(r.calls.map((x) => [x.model, x.ok, x.failoverReason])).toEqual([['p', false, null], ['f', true, 'rate_limit']])
    }
    expect(primary.calls).toBe(3)

    const r = await router.complete(req, signal)
    expect(primary.calls).toBe(3) // skipped: nothing sent
    expect(r.calls.map((x) => [x.model, x.ok, x.attempts, x.failoverReason])).toEqual([['p', false, 0, null], ['f', true, 1, 'unavailable']])

    c.advance(300_000)
    primary.push([ev.text('back'), ev.finish()])
    const back = await router.complete(req, signal)
    expect(back.model).toBe('p')
  })

  it('every entry open: AllProvidersFailed without sending a request', async () => {
    const breaker = new CircuitBreaker({ now: clock().now, threshold: 1 })
    const p = new ScriptedProvider([providerError('server', { status: 500 })])
    const router = new ModelRouter([{ provider: p, model: 'p' }], { retry: noRetry, hooks: breaker })
    await expect(router.complete(req, signal)).rejects.toBeInstanceOf(AllProvidersFailed)
    await expect(router.complete(req, signal)).rejects.toBeInstanceOf(AllProvidersFailed)
    expect(p.calls).toBe(1)
  })
})
