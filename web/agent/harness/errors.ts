// Contract (orchestrator-owned): typed errors used across the harness.
import type { StopReason } from './events.js'
import type { ProviderErrorInfo } from '../providers/types.js'

export class BudgetExceeded extends Error {
  readonly reason: Extract<StopReason, 'max_steps' | 'token_budget' | 'cost_budget' | 'wall_clock'>
  constructor(reason: BudgetExceeded['reason'], message: string) {
    super(message)
    this.reason = reason
  }
}

export class ProviderError extends Error {
  readonly info: ProviderErrorInfo
  constructor(info: ProviderErrorInfo, message: string) {
    super(message)
    this.info = info
  }
  get retryable(): boolean {
    return this.info.kind === 'network' || this.info.kind === 'timeout' || this.info.kind === 'server'
  }
}

/** Every configured provider failed for this step. */
export class ProvidersDown extends Error {}
