// Scenario, recording and result formats for the golden eval suite (design §15, plan X7/X11).
// Scenarios are JSON (not YAML) so the suite needs no new dependency.
import { z } from 'zod'
import { FIXTURE_NOW_UTC } from '../agent/data/types.js'
import { panelStateSchema, stopReasonSchema, type TraceSummary } from '../agent/harness/events.js'
import type { ModelEvent } from '../agent/providers/types.js'

const utcTs = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'UTC timestamp')
const localTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'YYYY-MM-DDTHH:mm (UK local)')

export const PERSONAS = ['household', 'developer', 'business', 'accuracy', 'injection', 'offtopic', 'edge'] as const

export const expectSchema = z.strictObject({
  /** gate name -> expected choice. Skipped (with a note) when the trace has no such gate. */
  gates: z.record(z.string(), z.string()).optional(),
  /** Subset of the turn's tool calls, in order. */
  tools_called: z.array(z.string()).optional(),
  tool_not_called: z.array(z.string()).optional(),
  window_equals_optimizer: z
    .strictObject({
      duration_h: z.number().int().min(1).max(12),
      power_kw: z.number().positive(),
      deadline_local: localTime,
      earliest_local: localTime.optional(),
      mode: z.enum(['expected', 'cautious']),
    })
    .optional(),
  co2_equals_tool: z.boolean().optional(),
  contains_caveat: z.boolean().optional(),
  no_banned_claim: z.boolean().optional(),
  says_assumed: z.boolean().optional(),
  asks_one_question: z.boolean().optional(),
  refuses: z.boolean().optional(),
  max_steps: z.number().int().positive().optional(),
  max_cost_usd: z.number().nonnegative().optional(),
  stop_reason: stopReasonSchema.optional(),
  /** Case-insensitive substrings the answer must / must not contain. */
  answer_contains: z.array(z.string()).optional(),
  answer_excludes: z.array(z.string()).optional(),
  /** Regular expressions (case-insensitive) the answer must match, e.g. a limitation message. */
  answer_matches: z.array(z.string()).optional(),
})
export type Expect = z.infer<typeof expectSchema>

export const scenarioSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  persona: z.enum(PERSONAS),
  description: z.string().optional(),
  now_utc: utcTs.default(FIXTURE_NOW_UTC),
  panel_state: panelStateSchema.nullable().default(null),
  turns: z.array(z.strictObject({ user: z.string().min(1).max(2000), expect: expectSchema.default({}) })).min(1),
})
export type Scenario = z.infer<typeof scenarioSchema>

// ---- Recordings (EVAL_MODE=record writes them, replay reads them). One file per scenario. ----

const modelEventSchema: z.ZodType<ModelEvent> = z.union([
  z.object({ type: z.literal('text'), delta: z.string() }),
  z.object({
    type: z.literal('tool_call'),
    call: z.object({ id: z.string(), name: z.string(), argsJson: z.string(), extra: z.record(z.string(), z.unknown()).optional() }),
  }),
  z.object({ type: z.literal('usage'), inputTokens: z.number(), outputTokens: z.number(), cachedInputTokens: z.number() }),
  z.object({ type: z.literal('finish'), reason: z.enum(['stop', 'tool_calls', 'length', 'content_filter']) }),
])

export const recordedModelCallSchema = z.object({ fingerprint: z.string(), model: z.string(), events: z.array(modelEventSchema) })
export const recordedGateCallSchema = z.object({
  fingerprint: z.string(),
  result: z.object({
    choice: z.string(),
    confidence: z.number(),
    probabilities: z.record(z.string(), z.number()),
    costUsd: z.number(),
  }),
})
export const recordingSchema = z.object({
  version: z.literal(1),
  scenario_id: z.string(),
  turns: z.array(z.object({ model_calls: z.array(recordedModelCallSchema), gate_calls: z.array(recordedGateCallSchema) })),
})
export type RecordedModelCall = z.infer<typeof recordedModelCallSchema>
export type RecordedGateCall = z.infer<typeof recordedGateCallSchema>
export type Recording = z.infer<typeof recordingSchema>
export type RecordedTurn = Recording['turns'][number]

// ---- Results ----

export type AssertionStatus = 'pass' | 'fail' | 'skip'
export interface AssertionResult {
  name: string
  status: AssertionStatus
  detail: string
}

export interface TurnResult {
  user: string
  answer: string
  stop_reason: string
  cost_usd: number
  steps: number
  tools: string[]
  /** Banned-claim violations in the answer, counted whether or not the scenario asserts it. */
  banned_claims: number
  assertions: AssertionResult[]
  trace: TraceSummary | null
}

export type ScenarioStatus = 'passed' | 'failed' | 'skipped'
export interface ScenarioResult {
  id: string
  persona: string
  status: ScenarioStatus
  /** Why skipped, or the first failure (e.g. "recording stale — re-record with EVAL_MODE=record"). */
  note: string
  cost_usd: number
  turns: TurnResult[]
}
