// Retry policy for model calls (design §5.4). Pure: randomness, sleep and the clock are injectable for tests.
import { ProviderError } from './errors.js'

export const MAX_RETRIES = 2
const BASE_MS = 250
const CAP_MS = 4_000

export interface RetryPolicy {
  maxRetries: number
  /** Uniform [0, 1). Jitter is 0.5 + random(), i.e. 0.5–1.5. */
  random: () => number
  sleep: (ms: number, signal: AbortSignal) => Promise<void>
  now: () => number
}

export const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(t)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: MAX_RETRIES,
  random: Math.random,
  sleep: defaultSleep,
  now: Date.now,
}

/** `min(4 s, 250 ms × 2^attempt) × jitter(0.5–1.5)`; attempt is 0 for the first retry. */
export function backoffMs(attempt: number, random: () => number): number {
  return Math.min(CAP_MS, BASE_MS * 2 ** attempt) * (0.5 + random())
}

/**
 * How long to wait before retry number `attempt` (0-based), or null when the error must not be retried here:
 * not retryable (rate limits fail over immediately, design §5.4), retries exhausted, or the wait would not fit in
 * the remaining wall time. A Retry-After header wins over the backoff when it fits.
 */
export function retryDelayMs(
  err: unknown,
  attempt: number,
  deadlineMs: number | null,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): number | null {
  if (!(err instanceof ProviderError) || !err.retryable) return null
  if (attempt >= policy.maxRetries) return null
  const delay = err.info.retryAfterMs ?? backoffMs(attempt, policy.random)
  if (deadlineMs !== null && policy.now() + delay >= deadlineMs) return null
  return delay
}

/** Runs `fn`, retrying retryable ProviderErrors per the policy. For non-streaming calls (e.g. gate classifiers). */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  signal: AbortSignal,
  deadlineMs: number | null,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt)
    } catch (err) {
      if (signal.aborted) throw err
      const delay = retryDelayMs(err, attempt, deadlineMs, policy)
      if (delay === null) throw err
      await policy.sleep(delay, signal)
    }
  }
}
