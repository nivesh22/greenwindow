// Circuit breaker per provider+model (design §5.4), plugged into the router through RouterHooks. Held in module
// memory, so it lives as long as the function instance. Opens after `threshold` failures within `windowMs` (a 429
// counts like any other failure) and stays open for `openMs`; while open the router skips the entry ("unavailable").
// After `openMs` the entry is closed again with a clean slate.
import type { RouteEntry, RouterHooks } from './router.js'

export interface BreakerOptions {
  threshold?: number
  windowMs?: number
  openMs?: number
  now?: () => number
}

interface State {
  failures: number[] // timestamps within the window
  openUntil: number | null
}

export const breakerKey = (e: RouteEntry): string => `${e.provider.id}:${e.model}`

export class CircuitBreaker implements RouterHooks {
  readonly threshold: number
  readonly windowMs: number
  readonly openMs: number
  private readonly now: () => number
  private readonly states = new Map<string, State>()

  constructor(opts: BreakerOptions = {}) {
    this.threshold = opts.threshold ?? 3
    this.windowMs = opts.windowMs ?? 60_000
    this.openMs = opts.openMs ?? 300_000
    this.now = opts.now ?? Date.now
  }

  /** True when `key` is open right now (closes it first if its open period has ended). */
  isOpen(key: string): boolean {
    const s = this.states.get(key)
    if (!s || s.openUntil === null) return false
    if (this.now() < s.openUntil) return true
    this.states.delete(key)
    return false
  }

  canUse(entry: RouteEntry): boolean {
    return !this.isOpen(breakerKey(entry))
  }

  onSuccess(entry: RouteEntry): void {
    this.states.delete(breakerKey(entry))
  }

  onFailure(entry: RouteEntry): void {
    const key = breakerKey(entry)
    const t = this.now()
    const s = this.states.get(key) ?? { failures: [], openUntil: null }
    s.failures = [...s.failures.filter((f) => t - f < this.windowMs), t]
    if (s.failures.length >= this.threshold) s.openUntil = t + this.openMs
    this.states.set(key, s)
  }

  /** For tests and ops: forget every state. */
  reset(): void {
    this.states.clear()
  }
}
