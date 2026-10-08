// Ordered model routing with retries and failover (design §5.4). P1a runs with one entry; the logic is written for
// N. P1b adds the circuit breaker through the RouterHooks seam (canUse/onSuccess/onFailure) and the
// first-token timeout.
//
// Each attempt's events are buffered and returned only once the stream finished cleanly (X4: nothing reaches the
// user before grounding), so restarting a step on the next provider is always safe. A provider that has yielded any
// event is never retried; it fails over instead.
import { ProviderError, ProvidersDown } from '../harness/errors'
import { DEFAULT_RETRY_POLICY, retryDelayMs, type RetryPolicy } from '../harness/retry'
import type { ModelEvent, ModelProvider, ModelRequest, ProviderId } from './types'

export interface RouteEntry {
  provider: ModelProvider
  model: string
}

export type FailoverReason = 'rate_limit' | 'retries_exhausted' | 'mid_stream' | 'non_retryable' | 'unavailable'

/** One provider attempt chain (initial call plus its retries). */
export interface LlmCallRecord {
  provider: ProviderId
  model: string
  /** True when this entry is not the first one tried for this call. */
  failover: boolean
  /** Why the previous entry was abandoned (null for the first entry). */
  failoverReason: FailoverReason | null
  ok: boolean
  /** Total attempts on this entry (1 + retries). */
  attempts: number
  startedAtMs: number
  ms: number
  errorKind: ProviderError['info']['kind'] | 'unknown' | null
}

export interface RoutedResponse {
  events: ModelEvent[]
  provider: ProviderId
  model: string
  /** Every entry tried, in order; the last one succeeded. */
  calls: LlmCallRecord[]
}

/** Seam for the P1b circuit breaker. All optional; the defaults allow every entry. */
export interface RouterHooks {
  canUse?(entry: RouteEntry): boolean
  onSuccess?(entry: RouteEntry): void
  onFailure?(entry: RouteEntry, err: unknown): void
}

/** Every entry failed. Carries the attempt records so the loop can trace them. */
export class AllProvidersFailed extends ProvidersDown {
  readonly calls: LlmCallRecord[]
  readonly lastError: unknown
  constructor(calls: LlmCallRecord[], lastError: unknown) {
    super(`all providers failed: ${calls.map((c) => `${c.provider}/${c.model}:${c.errorKind ?? 'skipped'}`).join(', ')}`)
    this.calls = calls
    this.lastError = lastError
  }
}

export interface RouterOptions {
  retry?: RetryPolicy
  hooks?: RouterHooks
  now?: () => number
}

class MidStreamError extends Error {
  readonly inner: unknown
  constructor(inner: unknown) {
    super('stream failed after events were received')
    this.inner = inner
  }
}

export class ModelRouter {
  readonly entries: readonly RouteEntry[]
  private readonly retry: RetryPolicy
  private readonly hooks: RouterHooks
  private readonly now: () => number

  constructor(entries: readonly RouteEntry[], opts: RouterOptions = {}) {
    if (entries.length === 0) throw new Error('ModelRouter needs at least one entry')
    this.entries = entries
    this.retry = opts.retry ?? DEFAULT_RETRY_POLICY
    this.hooks = opts.hooks ?? {}
    this.now = opts.now ?? Date.now
  }

  /** The models a call may end up on (for worst-case cost checks). */
  get models(): string[] {
    return this.entries.map((e) => e.model)
  }

  /**
   * Runs one model call. Throws AllProvidersFailed when every entry failed, or rethrows the abort reason when
   * `signal` aborts (no failover on abort).
   */
  async complete(req: Omit<ModelRequest, 'model'>, signal: AbortSignal, deadlineMs: number | null = null): Promise<RoutedResponse> {
    const calls: LlmCallRecord[] = []
    let reason: FailoverReason | null = null
    let lastError: unknown = null
    for (const entry of this.entries) {
      const failover = calls.length > 0
      if (this.hooks.canUse && !this.hooks.canUse(entry)) {
        calls.push(this.record(entry, failover, reason, false, 0, this.now(), null))
        reason = 'unavailable'
        continue
      }
      const started = this.now()
      let attempts = 0
      for (;;) {
        attempts += 1
        try {
          const events = await this.collect(entry, { ...req, model: entry.model }, signal)
          this.hooks.onSuccess?.(entry)
          calls.push(this.record(entry, failover, reason, true, attempts, started, null))
          return { events, provider: entry.provider.id, model: entry.model, calls }
        } catch (raw) {
          if (signal.aborted) throw signal.reason ?? raw
          const midStream = raw instanceof MidStreamError
          const err = midStream ? raw.inner : raw
          lastError = err
          const delay = midStream ? null : retryDelayMs(err, attempts - 1, deadlineMs, this.retry)
          if (delay !== null) {
            await this.retry.sleep(delay, signal)
            continue
          }
          this.hooks.onFailure?.(entry, err)
          calls.push(this.record(entry, failover, reason, false, attempts, started, err))
          reason = midStream
            ? 'mid_stream'
            : !(err instanceof ProviderError)
              ? 'non_retryable'
              : err.info.kind === 'rate_limit'
                ? 'rate_limit'
                : err.retryable
                  ? 'retries_exhausted'
                  : 'non_retryable'
          break
        }
      }
    }
    throw new AllProvidersFailed(calls, lastError)
  }

  private async collect(entry: RouteEntry, req: ModelRequest, signal: AbortSignal): Promise<ModelEvent[]> {
    const events: ModelEvent[] = []
    try {
      for await (const e of entry.provider.complete(req, signal)) events.push(e)
    } catch (err) {
      throw events.length > 0 ? new MidStreamError(err) : err
    }
    return events
  }

  private record(
    entry: RouteEntry,
    failover: boolean,
    reason: FailoverReason | null,
    ok: boolean,
    attempts: number,
    started: number,
    err: unknown,
  ): LlmCallRecord {
    return {
      provider: entry.provider.id,
      model: entry.model,
      failover,
      failoverReason: failover ? reason : null,
      ok,
      attempts,
      startedAtMs: started,
      ms: Math.max(0, this.now() - started),
      errorKind: ok || attempts === 0 ? null : err instanceof ProviderError ? err.info.kind : 'unknown',
    }
  }
}
