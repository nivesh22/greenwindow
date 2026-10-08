// Shared gate machinery (design §6, plan X10): ask the ChoiceBackend (Jev) first; on timeout, error, an unknown
// option or low confidence, the gate's deterministic rules decide. The decide functions never throw.
import type { ChoiceAnswer, ChoiceQuestion } from './jev.js'
import { isMultiChoice } from './jev.js'
import type { ChoiceBackend, Gate, GateDecision, GateName } from './types.js'

export interface RuleDecision<C extends string> {
  choice: C
  confidence: number
  reason: string
}

export interface GateSpec<S, C extends string> {
  name: GateName
  instructions: string
  /** option -> description (sent to Jev as `criteria`). */
  options: Record<C, string>
  threshold: number
  rules(s: S): RuleDecision<C>
  /**
   * Post-processes a Jev answer that met the threshold (e.g. guard_in's P(allow) rule, risk_mode's explicit-mode
   * override). Return a RuleDecision to replace it, or null to accept it as is.
   */
  override?(s: S, a: ChoiceAnswer & { choice: C }): RuleDecision<C> | null
}

export interface GateEnv {
  backend: ChoiceBackend | null
  now: () => number
}

type Outcome = { ok: true; answer: ChoiceAnswer; costUsd: number } | { ok: false; error: string; costUsd: number }

function rulesDecision<S, C extends string>(spec: GateSpec<S, C>, s: S, latencyMs: number, costUsd: number, why: string | null): GateDecision<C> {
  const r = spec.rules(s)
  return {
    gate: spec.name,
    choice: r.choice,
    confidence: r.confidence,
    probabilities: { [r.choice]: r.confidence } as Partial<Record<C, number>>,
    source: 'rules',
    latencyMs,
    costUsd,
    reason: why ? `${why}; rules: ${r.reason}` : `rules: ${r.reason}`,
  }
}

/** Turns a backend outcome into the gate's decision (threshold, override, fallback). */
function finish<S, C extends string>(
  spec: GateSpec<S, C>,
  s: S,
  out: Outcome | null,
  source: GateDecision<C>['source'],
  latencyMs: number,
): GateDecision<C> {
  if (out === null) return rulesDecision(spec, s, latencyMs, 0, null)
  if (!out.ok) return rulesDecision(spec, s, latencyMs, out.costUsd, `${source} failed (${out.error})`)
  const a = out.answer
  if (!Object.hasOwn(spec.options, a.choice)) return rulesDecision(spec, s, latencyMs, out.costUsd, `${source} chose an unknown option`)
  const tag = `${source} ${a.choice} ${a.confidence.toFixed(2)}`
  if (a.confidence < spec.threshold) return rulesDecision(spec, s, latencyMs, out.costUsd, `${tag} below ${spec.threshold}`)
  const typed = a as ChoiceAnswer & { choice: C }
  const probabilities = a.probabilities as Partial<Record<C, number>>
  const o = spec.override?.(s, typed) ?? null
  if (o) {
    return { gate: spec.name, choice: o.choice, confidence: o.confidence, probabilities, source: 'rules', latencyMs, costUsd: out.costUsd, reason: `${tag} overridden: ${o.reason}` }
  }
  return { gate: spec.name, choice: typed.choice, confidence: a.confidence, probabilities, source, latencyMs, costUsd: out.costUsd }
}

function errText(e: unknown): string {
  if (e && typeof e === 'object' && 'kind' in e && typeof e.kind === 'string') return e.kind
  return e instanceof Error ? e.message : 'error'
}

function safeFinish<S>(spec: GateSpec<S, string>, s: S, out: Outcome | null, source: GateDecision<string>['source'], latencyMs: number): GateDecision<string> {
  try {
    return finish(spec, s, out, source, latencyMs)
  } catch (e) {
    // A rules function must never break a turn; the last-resort default is the first option.
    const first = Object.keys(spec.options)[0] ?? ''
    return { gate: spec.name, choice: first, confidence: 0, probabilities: {}, source: 'rules', latencyMs, costUsd: 0, reason: `gate error: ${errText(e)}` }
  }
}

/**
 * Decides several gates over one shared state. With a multi-choice backend (Jev) this is ONE call; a plain
 * ChoiceBackend gets one `choose` per gate, in parallel. Never throws. The call's cost is split evenly.
 */
async function decideMany<S>(
  env: GateEnv,
  specs: readonly GateSpec<S, string>[],
  s: S,
  jevState: Record<string, unknown>,
  signal: AbortSignal,
): Promise<GateDecision<string>[]> {
  const started = env.now()
  const { backend } = env
  const elapsed = (): number => Math.max(0, env.now() - started)
  if (!backend) return specs.map((spec) => safeFinish(spec, s, null, 'rules', elapsed()))

  let outcomes: Outcome[]
  if (isMultiChoice(backend)) {
    const questions: Record<string, ChoiceQuestion> = {}
    for (const spec of specs) questions[spec.name] = { instructions: spec.instructions, options: spec.options }
    try {
      const r = await backend.chooseMany({ state: jevState, questions }, signal)
      const share = r.costUsd / specs.length
      outcomes = specs.map((spec): Outcome => {
        const a: ChoiceAnswer | undefined = r.answers[spec.name]
        return a ? { ok: true, answer: a, costUsd: share } : { ok: false, error: 'missing answer', costUsd: share }
      })
    } catch (e) {
      outcomes = specs.map((): Outcome => ({ ok: false, error: errText(e), costUsd: 0 }))
    }
  } else {
    outcomes = await Promise.all(
      specs.map(async (spec): Promise<Outcome> => {
        try {
          const r = await backend.choose({ instructions: spec.instructions, state: jevState, options: spec.options }, signal)
          return { ok: true, answer: { choice: r.choice, confidence: r.confidence, probabilities: r.probabilities }, costUsd: r.costUsd }
        } catch (e) {
          return { ok: false, error: errText(e), costUsd: 0 }
        }
      }),
    )
  }
  const latency = elapsed()
  return specs.map((spec, i) => safeFinish(spec, s, outcomes[i] ?? null, backend.source, latency))
}

export async function decideOne<S, C extends string>(
  env: GateEnv,
  spec: GateSpec<S, C>,
  s: S,
  jevState: Record<string, unknown>,
  signal: AbortSignal,
): Promise<GateDecision<C>> {
  const [a] = await decideMany<S>(env, [spec], s, jevState, signal)
  return a as GateDecision<C>
}

/** Two gates in one backend call (guard_in ∥ router, ask_or_act ∥ risk_mode). */
export async function decidePair<S, A extends string, B extends string>(
  env: GateEnv,
  specA: GateSpec<S, A>,
  specB: GateSpec<S, B>,
  s: S,
  jevState: Record<string, unknown>,
  signal: AbortSignal,
): Promise<[GateDecision<A>, GateDecision<B>]> {
  const [a, b] = await decideMany<S>(env, [specA, specB], s, jevState, signal)
  return [a as GateDecision<A>, b as GateDecision<B>]
}

/** A single gate as the contract's Gate interface. */
export function makeGate<S, C extends string>(spec: GateSpec<S, C>, env: GateEnv, jevState: (s: S) => Record<string, unknown>): Gate<S, C> {
  return {
    name: spec.name,
    options: Object.keys(spec.options) as C[],
    threshold: spec.threshold,
    decide: (s, signal) => decideOne(env, spec, s, jevState(s), signal),
  }
}

/** Truncates a string for the Jev state (keeps it well inside Jev's 32k-token state limit). */
export function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`
}
