// Per-turn budgets (design §5.3): steps, cumulative input tokens, output tokens per call, cost, wall clock.
import { costUsd } from '../config.js'
import type { Msg } from '../providers/types.js'
import { BudgetExceeded } from './errors.js'

export interface BudgetLimits {
  maxSteps: number
  maxInputTokens: number // cumulative over every model call in the turn
  maxOutputTokens: number // per call (request parameter)
  maxCostUsd: number // per turn
  wallMs: number
}

export interface BudgetOptions {
  now?: () => number
  /** Aborting this (e.g. the client disconnected or pressed Stop) also aborts the budget signal. */
  parentSignal?: AbortSignal
}

/** Rough token estimate used before a call and when a provider omits usage: chars / 4, rounded up. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function estimateMessagesTokens(messages: readonly Msg[]): number {
  let chars = 0
  for (const m of messages) {
    chars += m.content.length + m.role.length
    for (const c of m.toolCalls ?? []) chars += c.name.length + c.argsJson.length + c.id.length
  }
  return Math.ceil(chars / 4)
}

export class Budget {
  readonly limits: BudgetLimits
  readonly startedAtMs: number
  readonly deadlineMs: number
  /** Aborts at the deadline (reason: BudgetExceeded('wall_clock')) or when the parent signal aborts. */
  readonly signal: AbortSignal
  steps = 0
  inputTokens = 0
  outputTokens = 0
  costUsd = 0

  private readonly now: () => number
  private readonly timer: ReturnType<typeof setTimeout>

  constructor(limits: BudgetLimits, opts: BudgetOptions = {}) {
    this.limits = limits
    this.now = opts.now ?? Date.now
    this.startedAtMs = this.now()
    this.deadlineMs = this.startedAtMs + limits.wallMs
    const ctrl = new AbortController()
    this.timer = setTimeout(
      () => ctrl.abort(new BudgetExceeded('wall_clock', `turn exceeded ${limits.wallMs} ms`)),
      limits.wallMs,
    )
    this.timer.unref?.()
    this.signal = opts.parentSignal ? AbortSignal.any([ctrl.signal, opts.parentSignal]) : ctrl.signal
  }

  get maxOutputTokens(): number {
    return this.limits.maxOutputTokens
  }

  remainingMs(): number {
    return Math.max(0, this.deadlineMs - this.now())
  }

  /** Throws BudgetExceeded('wall_clock') once the deadline has passed or the signal has been aborted. */
  assertTime(): void {
    if (this.signal.aborted || this.now() >= this.deadlineMs) {
      throw new BudgetExceeded('wall_clock', `turn exceeded ${this.limits.wallMs} ms`)
    }
  }

  /**
   * Call before each model call. `models` are the models the call may end up on (the router's entries); the cost
   * check uses the most expensive one with the full output allowance. Counts the step when it passes.
   */
  assertCanStart(models: string | readonly string[], estInputTokens: number): void {
    this.assertTime()
    if (this.steps >= this.limits.maxSteps) {
      throw new BudgetExceeded('max_steps', `reached ${this.limits.maxSteps} steps`)
    }
    if (this.inputTokens + estInputTokens > this.limits.maxInputTokens) {
      throw new BudgetExceeded(
        'token_budget',
        `input tokens ${this.inputTokens} + ~${estInputTokens} would exceed ${this.limits.maxInputTokens}`,
      )
    }
    const list = typeof models === 'string' ? [models] : models
    const worst = Math.max(0, ...list.map((m) => costUsd(m, estInputTokens, this.limits.maxOutputTokens)))
    if (this.costUsd + worst > this.limits.maxCostUsd) {
      throw new BudgetExceeded(
        'cost_budget',
        `spent $${this.costUsd.toFixed(6)} + worst case $${worst.toFixed(6)} would exceed $${this.limits.maxCostUsd}`,
      )
    }
    this.steps += 1
  }

  /** Records actual (or estimated) usage after a call. Returns the call's cost. Overruns stop the next step. */
  charge(model: string, inputTokens: number, outputTokens: number, cachedInputTokens = 0): number {
    const cost = costUsd(model, inputTokens, outputTokens, cachedInputTokens)
    this.inputTokens += inputTokens
    this.outputTokens += outputTokens
    this.costUsd += cost
    return cost
  }

  /** Records a cost reported in dollars (gate calls: Jev returns its cost, not billable tokens). */
  chargeUsd(usd: number): void {
    if (Number.isFinite(usd) && usd > 0) this.costUsd += usd
  }

  /** Post-call check of the actual totals (throws BudgetExceeded). */
  assertWithinTotals(): void {
    if (this.inputTokens > this.limits.maxInputTokens) {
      throw new BudgetExceeded('token_budget', `input tokens ${this.inputTokens} exceed ${this.limits.maxInputTokens}`)
    }
    if (this.costUsd > this.limits.maxCostUsd) {
      throw new BudgetExceeded('cost_budget', `cost $${this.costUsd.toFixed(6)} exceeds $${this.limits.maxCostUsd}`)
    }
  }

  dispose(): void {
    clearTimeout(this.timer)
  }
}
