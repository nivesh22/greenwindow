// Contract (orchestrator-owned): the shared tool registry. Design §7.1. The chat uses it now; the MCP server
// (P5) will expose the same definitions.
import { z } from 'zod'
import type { Mode, Recommendation } from '../../src/scheduler/optimizer'
import type { ForecastSource } from '../data/types'
import type { Intent } from '../gates/types'
import type { ToolSpec } from '../providers/types'
import type { Store } from '../store/types'

export type Phase = 'P1' | 'P2' | 'P3' | 'P4'

/** The last recommend_window result in this turn, so estimate_co2/explain_uncertainty never take free numbers. */
export interface LastRecommendation {
  rec: Recommendation
  job: { durationH: number; powerKw: number; earliestUtc: string; deadlineUtc: string; mode: Mode }
  model: string
  runId: string
  /** The hourly forecast the recommendation used (for band widths and ranges). */
  hours: { ts: string; q10: number; q50: number; q90: number }[]
}

export interface ToolCtx {
  userId: string | null
  isAnonymous: boolean
  nowMs: number // server clock (frozen in tests/evals)
  data: ForecastSource
  store: Store
  /** Set by the risk_mode gate (P2); recommend_window uses it unless the user explicitly asked otherwise. */
  riskMode: Mode
  /** Mutable per-turn state shared between tools. */
  turn: { lastRecommendation: LastRecommendation | null }
  signal: AbortSignal
}

export interface ToolDef<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  name: string
  description: string // shown to the model; say what it returns and when to use it
  input: I
  output: O
  auth: 'anon' | 'user'
  sideEffect: boolean
  emitsPlan?: boolean // the loop emits plan_update from the output (recommend_window)
  phase: Phase
  intents: readonly Intent[] | 'all'
  /** Short status line for the UI, e.g. "Checking the forecast…". */
  statusText: string
  handler(ctx: ToolCtx, input: z.infer<I>): Promise<z.infer<O>>
}

/** A tool failure the model and the user can understand (e.g. the optimizer's InfeasibleJobError text). */
export class ToolUserError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export function defineTool<I extends z.ZodType, O extends z.ZodType>(def: ToolDef<I, O>): ToolDef<I, O> {
  return def
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDef>()

  constructor(defs: readonly ToolDef[] = []) {
    for (const d of defs) this.add(d)
  }

  add(def: ToolDef): void {
    if (this.tools.has(def.name)) throw new Error(`duplicate tool ${def.name}`)
    this.tools.set(def.name, def)
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name)
  }

  /** Tools offered for an intent (all tools when intent is null, i.e. before gates exist). */
  forIntent(intent: Intent | null): ToolDef[] {
    return [...this.tools.values()].filter((t) => intent === null || t.intents === 'all' || t.intents.includes(intent))
  }

  /** Provider tool specs (JSON Schema without $schema, additionalProperties: false from z.strictObject inputs). */
  specs(defs: readonly ToolDef[]): ToolSpec[] {
    return defs.map((d) => {
      const { $schema: _ignored, ...parameters } = z.toJSONSchema(d.input) as Record<string, unknown>
      return { name: d.name, description: d.description, parameters }
    })
  }
}
