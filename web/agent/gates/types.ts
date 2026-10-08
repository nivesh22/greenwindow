// Contract (orchestrator-owned): decision gates. Design §6, amended by plan X3 (Jev is one optional backend;
// rules and an LLM classifier come first). Gates never throw: they fall back internally and say so in `source`.

export const INTENTS = [
  'plan_job',
  'plan_batch',
  'recurring',
  'explain_forecast',
  'model_accuracy',
  'impact_history',
  'profile_update',
  'smalltalk',
  'off_topic',
] as const
export type Intent = (typeof INTENTS)[number]

export type GateName = 'guard_in' | 'router' | 'ask_or_act' | 'risk_mode' | 'guard_out'
export type GateSource = 'jev' | 'llm' | 'rules'

export interface GateDecision<C extends string> {
  gate: GateName
  choice: C
  confidence: number // 0..1
  probabilities: Partial<Record<C, number>>
  source: GateSource
  latencyMs: number
  costUsd: number
  reason?: string
}

export interface Gate<S, C extends string> {
  name: GateName
  options: readonly C[]
  threshold: number // below this confidence, the gate's documented default applies
  decide(state: S, signal: AbortSignal): Promise<GateDecision<C>>
}

/** A backend that answers "pick one of these options" (Jev, an LLM classifier). Rules are plain functions. */
export interface ChoiceBackend {
  source: Exclude<GateSource, 'rules'>
  choose<C extends string>(
    req: { instructions: string; state: Record<string, unknown>; options: Record<C, string> },
    signal: AbortSignal,
  ): Promise<{ choice: C; confidence: number; probabilities: Partial<Record<C, number>>; costUsd: number }>
}
