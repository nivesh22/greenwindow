// Jev (TypeSafe AI) through Vercel AI Gateway, TypeSafe-native route (docs/spikes.md S1 + "Live checks", verified
// 2026-10-08; https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe). Plain fetch, no SDK.
//   POST {JEV_URL}  Authorization: Bearer AI_GATEWAY_API_KEY
//   { model, state, questions: { <id>: { type: 'choice', instructions, criteria: { <option>: <description> } } } }
//   -> { answers: { <id>: { type: 'choice', choice, confidence, probabilities } }, usage, provider_metadata.gateway.cost }
// Jev evaluates the questions of one request in parallel, so paired gates share one call (chooseMany).
// Every failure throws JevError; the gates catch it and fall back to their rules.
import { z } from 'zod'
import { costUsd } from '../config.js'
import type { ChoiceBackend } from './types.js'

export type JevErrorKind = 'timeout' | 'aborted' | 'network' | 'http' | 'invalid_response'

export class JevError extends Error {
  readonly kind: JevErrorKind
  readonly status: number | null
  constructor(kind: JevErrorKind, message: string, status: number | null = null) {
    super(message)
    this.kind = kind
    this.status = status
  }
}

export interface ChoiceQuestion {
  instructions: string
  /** option -> description */
  options: Record<string, string>
}

export interface ChoiceAnswer {
  choice: string
  confidence: number
  probabilities: Partial<Record<string, number>>
}

export interface ChooseManyResult<K extends string> {
  answers: Record<K, ChoiceAnswer>
  /** Cost of the whole call (all questions). */
  costUsd: number
  latencyMs: number
}

/** A ChoiceBackend that can answer several questions over one state in one call. */
export interface MultiChoiceBackend extends ChoiceBackend {
  chooseMany<K extends string>(
    req: { state: Record<string, unknown>; questions: Record<K, ChoiceQuestion> },
    signal: AbortSignal,
  ): Promise<ChooseManyResult<K>>
}

export function isMultiChoice(b: ChoiceBackend): b is MultiChoiceBackend {
  return typeof (b as Partial<MultiChoiceBackend>).chooseMany === 'function'
}

const answerSchema = z.object({
  type: z.literal('choice'),
  choice: z.string(),
  confidence: z.number().min(0).max(1),
  probabilities: z.record(z.string(), z.number().min(0).max(1)).optional(),
})

const responseSchema = z.object({
  answers: z.record(z.string(), z.unknown()),
  usage: z.object({ input_tokens: z.number().nonnegative().optional() }).partial().optional(),
  provider_metadata: z
    .object({ gateway: z.object({ cost: z.union([z.string(), z.number()]).optional() }).partial().optional() })
    .partial()
    .optional(),
})

export interface JevOptions {
  apiKey: string
  url: string
  model: string
  timeoutMs: number
  fetch?: typeof fetch
  now?: () => number
}

export class JevBackend implements MultiChoiceBackend {
  readonly source = 'jev' as const
  private readonly opts: JevOptions
  private readonly fetchFn: typeof fetch
  private readonly now: () => number

  constructor(opts: JevOptions) {
    this.opts = opts
    this.fetchFn = opts.fetch ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a))
    this.now = opts.now ?? Date.now
  }

  async choose<C extends string>(
    req: { instructions: string; state: Record<string, unknown>; options: Record<C, string> },
    signal: AbortSignal,
  ): Promise<{ choice: C; confidence: number; probabilities: Partial<Record<C, number>>; costUsd: number }> {
    const r = await this.chooseMany({ state: req.state, questions: { decision: { instructions: req.instructions, options: req.options } } }, signal)
    const a = r.answers.decision
    return { choice: a.choice as C, confidence: a.confidence, probabilities: a.probabilities as Partial<Record<C, number>>, costUsd: r.costUsd }
  }

  async chooseMany<K extends string>(
    req: { state: Record<string, unknown>; questions: Record<K, ChoiceQuestion> },
    signal: AbortSignal,
  ): Promise<ChooseManyResult<K>> {
    const ids = Object.keys(req.questions) as K[]
    if (ids.length === 0) throw new JevError('invalid_response', 'no questions')
    const started = this.now()
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), this.opts.timeoutMs)
    const combined = AbortSignal.any([signal, timeout.signal])
    const questions: Record<string, unknown> = {}
    for (const id of ids) {
      const q = req.questions[id]
      questions[id] = { type: 'choice', instructions: q.instructions, criteria: q.options }
    }

    let res: Response
    let raw: unknown
    try {
      res = await this.fetchFn(this.opts.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.opts.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.opts.model, state: req.state, questions }),
        signal: combined,
      })
      if (!res.ok) throw new JevError('http', `jev http ${res.status}`, res.status)
      raw = await res.json()
    } catch (err) {
      if (err instanceof JevError) throw err
      if (timeout.signal.aborted) throw new JevError('timeout', `jev timed out after ${this.opts.timeoutMs} ms`)
      if (signal.aborted) throw new JevError('aborted', 'jev call aborted')
      if (err instanceof SyntaxError) throw new JevError('invalid_response', 'jev response is not JSON')
      throw new JevError('network', err instanceof Error ? err.message : 'network error')
    } finally {
      clearTimeout(timer)
    }

    const parsed = responseSchema.safeParse(raw)
    if (!parsed.success) throw new JevError('invalid_response', 'jev response does not match the schema')
    const answers = {} as Record<K, ChoiceAnswer>
    for (const id of ids) {
      const a = answerSchema.safeParse(parsed.data.answers[id])
      if (!a.success) throw new JevError('invalid_response', `jev answer "${id}" missing or malformed`)
      if (!Object.hasOwn(req.questions[id].options, a.data.choice)) {
        throw new JevError('invalid_response', `jev answer "${id}" chose an unknown option`)
      }
      answers[id] = { choice: a.data.choice, confidence: a.data.confidence, probabilities: a.data.probabilities ?? { [a.data.choice]: a.data.confidence } }
    }
    return { answers, costUsd: callCost(parsed.data, this.opts.model), latencyMs: Math.max(0, this.now() - started) }
  }
}

/** The gateway's reported cost (a decimal string), else priced from usage, else 0. */
function callCost(r: z.infer<typeof responseSchema>, model: string): number {
  const c = r.provider_metadata?.gateway?.cost
  const n = typeof c === 'string' ? Number(c) : c
  if (typeof n === 'number' && Number.isFinite(n) && n >= 0) return n
  const inTok = r.usage?.input_tokens
  return typeof inTok === 'number' ? costUsd(model, inTok, 0) : 0
}
