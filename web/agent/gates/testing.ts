// Test helpers: scripted ChoiceBackends (no network). FakeChoiceBackend answers by question id, which is the gate
// name in the harness's multi-question calls ('decision' for a single choose()). An Error answer is thrown.
import type { ChoiceAnswer, ChoiceQuestion, ChooseManyResult, MultiChoiceBackend } from './jev.js'
import { JevError } from './jev.js'
import type { ChoiceBackend } from './types.js'

/** One answer for every call, or a queue (one per call; the last one repeats). */
export type FakeAnswer = ChoiceAnswer | Error | (ChoiceAnswer | Error)[]

export interface FakeCall {
  state: Record<string, unknown>
  questions: string[]
}

export class FakeChoiceBackend implements MultiChoiceBackend {
  readonly source = 'jev' as const
  readonly calls: FakeCall[] = []
  answers: Partial<Record<string, FakeAnswer>>
  costPerCall: number

  constructor(answers: Partial<Record<string, FakeAnswer>> = {}, costPerCall = 0.00002) {
    this.answers = answers
    this.costPerCall = costPerCall
  }

  async chooseMany<K extends string>(req: { state: Record<string, unknown>; questions: Record<K, ChoiceQuestion> }, signal: AbortSignal): Promise<ChooseManyResult<K>> {
    signal.throwIfAborted()
    const ids = Object.keys(req.questions) as K[]
    this.calls.push({ state: req.state, questions: ids })
    const out = {} as Record<K, ChoiceAnswer>
    for (const id of ids) {
      const scripted = this.answers[id]
      const a = Array.isArray(scripted) ? (scripted.length > 1 ? scripted.shift() : scripted[0]) : scripted
      if (a instanceof Error) throw a
      if (!a) throw new JevError('invalid_response', `no scripted answer for ${id}`)
      out[id] = a
    }
    return { answers: out, costUsd: this.costPerCall, latencyMs: 0 }
  }

  async choose<C extends string>(
    req: { instructions: string; state: Record<string, unknown>; options: Record<C, string> },
    signal: AbortSignal,
  ): Promise<{ choice: C; confidence: number; probabilities: Partial<Record<C, number>>; costUsd: number }> {
    const r = await this.chooseMany({ state: req.state, questions: { decision: { instructions: req.instructions, options: req.options } } }, signal)
    const a = r.answers.decision
    return { choice: a.choice as C, confidence: a.confidence, probabilities: a.probabilities as Partial<Record<C, number>>, costUsd: r.costUsd }
  }
}

/** A plain (single-question) ChoiceBackend, as an LLM classifier or an eval replay might implement it. */
export class SingleChoiceBackend implements ChoiceBackend {
  readonly source = 'llm' as const
  readonly calls: string[] = []
  private readonly pick: (instructions: string, options: string[]) => ChoiceAnswer

  constructor(pick: (instructions: string, options: string[]) => ChoiceAnswer) {
    this.pick = pick
  }

  async choose<C extends string>(
    req: { instructions: string; state: Record<string, unknown>; options: Record<C, string> },
  ): Promise<{ choice: C; confidence: number; probabilities: Partial<Record<C, number>>; costUsd: number }> {
    this.calls.push(req.instructions)
    const a = this.pick(req.instructions, Object.keys(req.options))
    return { choice: a.choice as C, confidence: a.confidence, probabilities: a.probabilities as Partial<Record<C, number>>, costUsd: 0.00001 }
  }
}

export const answer = (choice: string, confidence = 0.9, probabilities?: Partial<Record<string, number>>): ChoiceAnswer => ({
  choice,
  confidence,
  probabilities: probabilities ?? { [choice]: confidence },
})
