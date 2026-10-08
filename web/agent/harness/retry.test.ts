import { providerError } from '../providers/scripted'
import { backoffMs, retryDelayMs, withRetry, type RetryPolicy } from './retry'

const policy = (over: Partial<RetryPolicy> = {}): RetryPolicy => ({
  maxRetries: 2,
  random: () => 0.5, // jitter 1.0
  sleep: async () => undefined,
  now: () => 0,
  ...over,
})

describe('backoffMs', () => {
  it('doubles from 250 ms and caps at 4 s, with 0.5–1.5 jitter', () => {
    expect(backoffMs(0, () => 0.5)).toBe(250)
    expect(backoffMs(1, () => 0.5)).toBe(500)
    expect(backoffMs(10, () => 0.5)).toBe(4000)
    expect(backoffMs(0, () => 0)).toBe(125)
    expect(backoffMs(10, () => 0.999999)).toBeCloseTo(6000, 0)
  })
})

describe('retryDelayMs', () => {
  it('retries server, network and timeout errors at most twice', () => {
    for (const kind of ['server', 'network', 'timeout'] as const) {
      expect(retryDelayMs(providerError(kind), 0, null, policy())).toBe(250)
      expect(retryDelayMs(providerError(kind), 1, null, policy())).toBe(500)
      expect(retryDelayMs(providerError(kind), 2, null, policy())).toBeNull()
    }
  })

  it('never retries rate limits, client, malformed or non-provider errors', () => {
    expect(retryDelayMs(providerError('rate_limit', { retryAfterMs: 10 }), 0, null, policy())).toBeNull()
    expect(retryDelayMs(providerError('client'), 0, null, policy())).toBeNull()
    expect(retryDelayMs(providerError('malformed'), 0, null, policy())).toBeNull()
    expect(retryDelayMs(new Error('x'), 0, null, policy())).toBeNull()
  })

  it('honours Retry-After when it fits in the remaining wall time, else gives up', () => {
    const e = providerError('server', { status: 503, retryAfterMs: 3000 })
    expect(retryDelayMs(e, 0, 10_000, policy())).toBe(3000)
    expect(retryDelayMs(e, 0, 2_000, policy())).toBeNull()
  })

  it('gives up when the backoff would pass the deadline', () => {
    expect(retryDelayMs(providerError('server'), 0, 200, policy())).toBeNull()
  })
})

describe('withRetry', () => {
  it('retries then succeeds, sleeping the backoff', async () => {
    const sleeps: number[] = []
    let n = 0
    const out = await withRetry(
      async () => {
        n++
        if (n < 3) throw providerError('server')
        return 'ok'
      },
      new AbortController().signal,
      null,
      policy({ sleep: async (ms) => void sleeps.push(ms) }),
    )
    expect(out).toBe('ok')
    expect(sleeps).toEqual([250, 500])
  })

  it('rethrows after the retries are used up', async () => {
    let n = 0
    await expect(
      withRetry(async () => {
        n++
        throw providerError('network')
      }, new AbortController().signal, null, policy()),
    ).rejects.toMatchObject({ info: { kind: 'network' } })
    expect(n).toBe(3)
  })
})
