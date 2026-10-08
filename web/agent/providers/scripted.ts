// Deterministic provider for harness tests: plays back a pre-set sequence of responses, one per complete() call.
import { ProviderError } from '../harness/errors'
import type { ModelEvent, ModelProvider, ModelRequest, ProviderErrorInfo, ProviderId } from './types'

/** One scripted response: events to yield, optionally followed by an error (a mid-stream failure). */
export type ScriptStep = ModelEvent[] | { events: ModelEvent[]; error: ProviderError } | ProviderError

export function providerError(
  kind: ProviderErrorInfo['kind'],
  opts: { provider?: ProviderId; status?: number | null; retryAfterMs?: number | null; message?: string } = {},
): ProviderError {
  return new ProviderError(
    { provider: opts.provider ?? 'scripted', status: opts.status ?? null, retryAfterMs: opts.retryAfterMs ?? null, kind },
    opts.message ?? `scripted ${kind} error`,
  )
}

/** Shorthands for building scripts. */
export const ev = {
  text: (delta: string): ModelEvent => ({ type: 'text', delta }),
  call: (name: string, args: unknown, id = `call_${name}`): ModelEvent => ({
    type: 'tool_call',
    call: { id, name, argsJson: typeof args === 'string' ? args : JSON.stringify(args) },
  }),
  usage: (inputTokens: number, outputTokens: number, cachedInputTokens = 0): ModelEvent => ({
    type: 'usage',
    inputTokens,
    outputTokens,
    cachedInputTokens,
  }),
  finish: (reason: 'stop' | 'tool_calls' | 'length' | 'content_filter' = 'stop'): ModelEvent => ({ type: 'finish', reason }),
}

export class ScriptedProvider implements ModelProvider {
  readonly id: ProviderId
  /** Every request received, in order (deep-copied so later mutation by the caller does not change them). */
  readonly requests: ModelRequest[] = []
  private readonly script: ScriptStep[]
  private readonly failures = new Map<number, ProviderError>()

  constructor(script: ScriptStep[] = [], id: ProviderId = 'scripted') {
    this.script = [...script]
    this.id = id
  }

  get calls(): number {
    return this.requests.length
  }

  /** Makes call number `n` (1-based) throw `err` before yielding anything. Does not consume a script step. */
  failOnCall(n: number, err: ProviderError): this {
    this.failures.set(n, err)
    return this
  }

  push(...steps: ScriptStep[]): this {
    this.script.push(...steps)
    return this
  }

  async *complete(req: ModelRequest, signal: AbortSignal): AsyncGenerator<ModelEvent> {
    this.requests.push(structuredClone(req))
    signal.throwIfAborted()
    const forced = this.failures.get(this.requests.length)
    if (forced) throw forced
    const step = this.script.shift()
    if (step === undefined) throw new Error(`ScriptedProvider: script exhausted at call ${this.requests.length}`)
    if (step instanceof ProviderError) throw step
    const events = Array.isArray(step) ? step : step.events
    for (const e of events) {
      signal.throwIfAborted()
      yield e
    }
    if (!Array.isArray(step)) throw step.error
  }
}
