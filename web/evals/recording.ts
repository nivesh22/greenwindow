// Record / replay for model calls and gate (ChoiceBackend) calls. Replay refuses to continue when a request
// differs from the recording: a stale recording must be re-recorded, never silently skipped (plan X11).
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ChoiceBackend } from '../agent/gates/types.js'
import type { ModelEvent, ModelProvider, ModelRequest, ProviderId } from '../agent/providers/types.js'
import { recordingSchema, type RecordedGateCall, type RecordedModelCall, type RecordedTurn, type Recording } from './schema.js'

export const STALE_MESSAGE = 'recording stale — re-record with EVAL_MODE=record'

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

/** sha256 of the JSON of messages + tools + toolChoice (the model ID is deliberately excluded). */
export function requestFingerprint(req: Pick<ModelRequest, 'messages' | 'tools' | 'toolChoice'>): string {
  return sha256(JSON.stringify({ messages: req.messages, tools: req.tools ?? null, toolChoice: req.toolChoice ?? null }))
}

export function gateFingerprint(req: { instructions: string; state: Record<string, unknown>; options: Record<string, string> }): string {
  return sha256(JSON.stringify({ instructions: req.instructions, state: req.state, options: req.options }))
}

export function recordingPath(dir: string, scenarioId: string): string {
  return join(dir, `${scenarioId}.json`)
}

export function loadRecording(dir: string, scenarioId: string): Recording | null {
  const file = recordingPath(dir, scenarioId)
  if (!existsSync(file)) return null
  return recordingSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
}

export function saveRecording(dir: string, rec: Recording): void {
  const file = recordingPath(dir, rec.scenario_id)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(rec, null, 1)}\n`)
}

/** Shared by replay components: the first problem found, so the runner can fail the scenario with it. */
export class StaleTracker {
  problem: string | null = null
  mark(detail: string): void {
    this.problem ??= `${STALE_MESSAGE} (${detail})`
  }
}

/** Plays recorded model calls back in order. Any difference in the request marks the recording stale. */
export class ReplayProvider implements ModelProvider {
  readonly id: ProviderId = 'scripted'
  private next = 0
  private readonly calls: readonly RecordedModelCall[]
  private readonly stale: StaleTracker
  constructor(calls: readonly RecordedModelCall[], stale: StaleTracker) {
    this.calls = calls
    this.stale = stale
  }

  get consumed(): number {
    return this.next
  }

  async *complete(req: ModelRequest, signal: AbortSignal): AsyncGenerator<ModelEvent> {
    signal.throwIfAborted()
    const call = this.calls[this.next]
    if (!call) {
      this.stale.mark(`model call ${this.next + 1} was not recorded`)
      throw new Error(`replay: model call ${this.next + 1} not in recording`)
    }
    if (call.fingerprint !== requestFingerprint(req)) {
      this.stale.mark(`model call ${this.next + 1} request differs`)
      throw new Error(`replay: model call ${this.next + 1} request differs from the recording`)
    }
    this.next += 1
    for (const e of call.events) yield e
  }
}

/** Answers gate calls from the recording, matched by request fingerprint (gates may run in parallel). */
export class ReplayChoiceBackend implements ChoiceBackend {
  readonly source: ChoiceBackend['source']
  private readonly used = new Set<number>()
  private readonly calls: readonly RecordedGateCall[]
  private readonly stale: StaleTracker
  constructor(calls: readonly RecordedGateCall[], stale: StaleTracker, source: ChoiceBackend['source'] = 'jev') {
    this.calls = calls
    this.stale = stale
    this.source = source
  }

  async choose<C extends string>(
    req: { instructions: string; state: Record<string, unknown>; options: Record<C, string> },
    signal: AbortSignal,
  ): Promise<{ choice: C; confidence: number; probabilities: Partial<Record<C, number>>; costUsd: number }> {
    signal.throwIfAborted()
    const fp = gateFingerprint(req)
    const i = this.calls.findIndex((c, idx) => !this.used.has(idx) && c.fingerprint === fp)
    const hit = this.calls[i]
    if (i < 0 || !hit) {
      this.stale.mark('a gate request differs or was not recorded')
      throw new Error('replay: gate call not in recording')
    }
    this.used.add(i)
    if ('error' in hit) throw new Error(`replay: recorded gate failure (${hit.error})`)
    return { ...hit.result, choice: hit.result.choice as C, probabilities: hit.result.probabilities as Partial<Record<C, number>> }
  }
}

/** Wraps a real provider and keeps every completed stream. Failed attempts are not kept. */
export class RecordingProvider implements ModelProvider {
  readonly id: ProviderId
  private readonly inner: ModelProvider
  private readonly sink: RecordedModelCall[]
  constructor(inner: ModelProvider, sink: RecordedModelCall[]) {
    this.inner = inner
    this.sink = sink
    this.id = inner.id
  }

  async *complete(req: ModelRequest, signal: AbortSignal): AsyncGenerator<ModelEvent> {
    const events: ModelEvent[] = []
    for await (const e of this.inner.complete(req, signal)) {
      events.push(e)
      yield e
    }
    this.sink.push({ fingerprint: requestFingerprint(req), model: req.model, events })
  }
}

export class RecordingChoiceBackend implements ChoiceBackend {
  readonly source: ChoiceBackend['source']
  private readonly inner: ChoiceBackend
  private readonly sink: RecordedGateCall[]
  constructor(inner: ChoiceBackend, sink: RecordedGateCall[]) {
    this.inner = inner
    this.sink = sink
    this.source = inner.source
  }

  async choose<C extends string>(
    req: { instructions: string; state: Record<string, unknown>; options: Record<C, string> },
    signal: AbortSignal,
  ): Promise<{ choice: C; confidence: number; probabilities: Partial<Record<C, number>>; costUsd: number }> {
    let out: { choice: C; confidence: number; probabilities: Partial<Record<C, number>>; costUsd: number }
    try {
      out = await this.inner.choose(req, signal)
    } catch (err) {
      // Keep the failure so replay takes the same rule-fallback path (otherwise the call looks "not recorded").
      this.sink.push({ fingerprint: gateFingerprint(req), error: err instanceof Error ? err.name || 'Error' : 'error' })
      throw err
    }
    this.sink.push({
      fingerprint: gateFingerprint(req),
      result: { choice: out.choice, confidence: out.confidence, probabilities: out.probabilities as Record<string, number>, costUsd: out.costUsd },
    })
    return out
  }
}

export function emptyTurn(): RecordedTurn {
  return { model_calls: [], gate_calls: [] }
}
