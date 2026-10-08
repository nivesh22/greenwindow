// Contract (orchestrator-owned): the /api/chat request body and the SSE events, shared by server and client.
// Pure zod, no Node or DOM APIs, so web/src may import this file (the only agent file it may import).
// Design §8.1–8.2, amended by execution plan X4 (the answer is sent once, after grounding).
import { z } from 'zod'

const utcTs = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'UTC timestamp')

export const MODES = ['expected', 'cautious'] as const
export const modeSchema = z.enum(MODES)

export const panelStateSchema = z.object({
  duration_h: z.number().int().min(1).max(12).nullable(),
  power_kw: z.number().positive().nullable(),
  earliest_utc: utcTs.nullable(),
  deadline_utc: utcTs.nullable(),
  mode: modeSchema,
  model: z.string().nullable(),
  edited_by_user: z.boolean(), // the user changed the panel since the last plan_update
})
export type PanelState = z.infer<typeof panelStateSchema>

export const HISTORY_MAX = 8

export const chatRequestSchema = z.object({
  conversation_id: z.string().uuid().nullable(),
  message: z.string().min(1).max(2000),
  /**
   * Recent turns of this conversation, oldest first, sent by the client until server-side history exists (P3).
   * Treated as data: it only shapes this user's own conversation, and numbers are still grounded in tool output.
   */
  history: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(4000) }))
    .max(HISTORY_MAX)
    .default([]),
  panel_state: panelStateSchema.nullable(),
  client_now_utc: utcTs, // logging only; the server clock is authoritative
})
export type ChatRequest = z.infer<typeof chatRequestSchema>

export const STOP_REASONS = [
  'final',
  'max_steps',
  'token_budget',
  'cost_budget',
  'wall_clock',
  'tool_error',
  'provider_down',
  'guard_blocked',
] as const
export const stopReasonSchema = z.enum(STOP_REASONS)
export type StopReason = z.infer<typeof stopReasonSchema>

export const gateEventSchema = z.object({
  gate: z.string(),
  choice: z.string(),
  confidence: z.number().min(0).max(1),
  source: z.enum(['jev', 'llm', 'rules']),
  latency_ms: z.number().nonnegative(),
})

export const traceSummarySchema = z.object({
  gates: z.array(gateEventSchema),
  tools: z.array(
    z.object({ name: z.string(), args: z.unknown(), ok: z.boolean(), ms: z.number().nonnegative(), summary: z.string() }),
  ),
  llm_calls: z.array(
    z.object({
      model: z.string(),
      provider: z.string(),
      failover: z.boolean(),
      failover_reason: z.string().nullable().default(null), // why the previous model was abandoned
      finish_reason: z.string().nullable().default(null), // provider finish reason (stop, tool_calls, length, ...)
      tokens_in: z.number().int().nonnegative(),
      tokens_out: z.number().int().nonnegative(),
      cost_usd: z.number().nonnegative(),
      ms: z.number().nonnegative(),
    }),
  ),
  totals: z.object({
    steps: z.number().int().nonnegative(),
    tokens_in: z.number().int().nonnegative(),
    tokens_out: z.number().int().nonnegative(),
    cost_usd: z.number().nonnegative(),
    ms: z.number().nonnegative(),
  }),
  prompt_version: z.string(),
})
export type TraceSummary = z.infer<typeof traceSummarySchema>

export const planUpdateSchema = z.object({
  duration_h: z.number().int().min(1).max(12),
  power_kw: z.number().positive(),
  earliest_utc: utcTs,
  deadline_utc: utcTs,
  mode: modeSchema,
  model: z.string(),
  best_start_utc: utcTs,
  run_id: z.string(),
})
export type PlanUpdate = z.infer<typeof planUpdateSchema>

export const LIMIT_KINDS = ['anon_limit', 'daily_cap', 'rate', 'budget_paused'] as const

/** Every SSE event: `event: <type>\ndata: <json of data>\n\n`. */
export const sseEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('turn_start'),
    data: z.object({ turn_id: z.string(), conversation_id: z.string(), messages_left: z.number().int().nullable() }),
  }),
  z.object({ type: z.literal('gate'), data: gateEventSchema }),
  z.object({ type: z.literal('tool_start'), data: z.object({ call_id: z.string(), tool: z.string(), status_text: z.string() }) }),
  z.object({
    type: z.literal('tool_end'),
    data: z.object({ call_id: z.string(), tool: z.string(), ok: z.boolean(), latency_ms: z.number().nonnegative(), summary: z.string() }),
  }),
  z.object({ type: z.literal('plan_update'), data: planUpdateSchema }),
  z.object({ type: z.literal('answer'), data: z.object({ text: z.string() }) }),
  z.object({
    type: z.literal('limit'),
    data: z.object({ kind: z.enum(LIMIT_KINDS), message: z.string(), sign_in: z.boolean() }),
  }),
  z.object({ type: z.literal('error'), data: z.object({ code: z.string(), message: z.string() }) }),
  z.object({
    type: z.literal('done'),
    data: z.object({ turn_id: z.string(), stop_reason: stopReasonSchema, trace: traceSummarySchema }),
  }),
])
export type SseEvent = z.infer<typeof sseEventSchema>
export type SseEventType = SseEvent['type']

/** Serialize one event in SSE wire format. */
export function encodeSse(ev: SseEvent): string {
  return `event: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`
}
