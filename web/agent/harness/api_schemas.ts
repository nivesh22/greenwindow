// Contract (orchestrator-owned): request/response bodies of the P3 endpoints, shared by server and client.
// Pure zod (like events.ts), so web/src may import it. All endpoints except /api/session require
// `Authorization: Bearer <Supabase access token>`; errors are { error: { code, message } } with a matching status.
import { z } from 'zod'
import { modeSchema } from './events.js'

const utcTs = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/, 'UTC timestamp')
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:mm')

export const apiErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) })

/** POST /api/session — verify Turnstile before the client calls supabase.auth.signInAnonymously(). Per-IP limited. */
export const sessionRequestSchema = z.object({ turnstile_token: z.string().min(1).max(4096) })
export const sessionResponseSchema = z.object({ ok: z.literal(true) })

/** POST /api/session/merge — after Google sign-in fell back to a new account (S6), move the anonymous user's data. */
export const mergeRequestSchema = z.object({ anon_access_token: z.string().min(1) })
export const mergeResponseSchema = z.object({ ok: z.literal(true), moved_conversations: z.number().int().nonnegative() })

/** GET /api/conversations/latest — the caller's most recent conversation for restoring the chat on reload. */
export const conversationResponseSchema = z.object({
  conversation: z
    .object({
      id: z.string().uuid(),
      messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string(), turn_id: z.string().nullable(), created_at_utc: utcTs })),
    })
    .nullable(),
  messages_left: z.number().int().nullable(), // anonymous users: free messages left; null when signed in
  is_anonymous: z.boolean(),
})

export const deviceSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1).max(60),
  kw: z.number().positive().max(10000),
  typical_hours: z.number().int().min(1).max(12).nullable(),
})
export const profileSchema = z.object({
  display_name: z.string().max(80).nullable(),
  risk_default: modeSchema,
  quiet_from: hhmm.nullable(),
  quiet_to: hhmm.nullable(),
})
/** GET /api/profile -> ProfileResponse; PUT /api/profile with ProfileUpdate -> ProfileResponse. Signed-in (non-anonymous) only. */
export const profileResponseSchema = z.object({ profile: profileSchema, devices: z.array(deviceSchema.extend({ id: z.string() })) })
export const profileUpdateSchema = z.object({
  profile: profileSchema.optional(),
  upsert_devices: z.array(deviceSchema).max(25).optional(),
  delete_device_ids: z.array(z.string()).max(25).optional(),
})

/** POST /api/feedback — thumbs on an assistant answer (FR-9.4). Anonymous sessions allowed. */
export const feedbackRequestSchema = z.object({
  turn_id: z.string().uuid(),
  rating: z.union([z.literal(1), z.literal(-1)]),
  comment: z.string().max(1000).nullable().default(null),
})
export const okResponseSchema = z.object({ ok: z.literal(true) })

/** POST /api/me/delete — delete all of the caller's data and the account (FR-7.4). Body must confirm. */
export const deleteMeRequestSchema = z.object({ confirm: z.literal('DELETE') })

export type ProfileResponse = z.infer<typeof profileResponseSchema>
export type ProfileUpdate = z.infer<typeof profileUpdateSchema>
export type ConversationResponse = z.infer<typeof conversationResponseSchema>
export type FeedbackRequest = z.infer<typeof feedbackRequestSchema>

// ---------- P4 (design §8, plan P4.3/P4.4) ----------

const weekday = z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])

export const planSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(['once', 'recurring']),
  job: z.object({
    duration_h: z.number().int().min(1).max(12),
    power_kw: z.number().positive(),
    mode: modeSchema,
    earliest_utc: utcTs.nullable(),
    deadline_utc: utcTs.nullable(),
  }),
  rule: z.object({ days: z.array(weekday).min(1), window_local: z.object({ from: hhmm, to: hhmm }), remind: z.boolean() }).nullable(),
  next_start_utc: utcTs.nullable(),
  active: z.boolean(),
  created_at_utc: utcTs,
})
/** GET /api/plans -> PlansResponse (signed-in only). DELETE /api/plans?id=<uuid> -> ok (cancels, keeps history). */
export const plansResponseSchema = z.object({ plans: z.array(planSchema) })

/** POST /api/push/subscribe {subscription} -> ok; DELETE /api/push/subscribe {endpoint} -> ok. Signed-in only. */
export const pushSubscribeRequestSchema = z.object({
  subscription: z.object({
    endpoint: z.string().url().max(2000),
    keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
  }),
})
export const pushUnsubscribeRequestSchema = z.object({ endpoint: z.string().url().max(2000) })

/**
 * POST /api/reminders — the plan panel's "Remind me" button (J6). The server computes send_at = start - lead and
 * refuses starts in the past or more than 48 h ahead. Signed-in only, needs a push subscription (409 push_needed).
 */
export const reminderRequestSchema = z.object({
  start_utc: utcTs,
  label: z.string().min(1).max(80),
  lead_min: z.number().int().min(0).max(120).default(10),
})
export const reminderResponseSchema = z.object({ ok: z.literal(true), reminder_id: z.string(), send_at_utc: utcTs })

/** GET /api/admin/ops?days=14 (admins only; others 403). Every panel of the Ops page (FR-8.3). */
export const opsResponseSchema = z.object({
  generated_at_utc: utcTs,
  days: z.number().int().min(1).max(90),
  budget: z.object({ month: z.string(), spent_usd: z.number(), eval_spent_usd: z.number(), limit_usd: z.number(), paused: z.boolean() }),
  daily: z.array(
    z.object({
      day: z.string(), // YYYY-MM-DD UTC
      turns: z.number().int(),
      cost_usd: z.number(),
      by_intent: z.record(z.string(), z.number().int()),
      llm_requests: z.number().int(),
      free_tier_requests: z.number().int(),
    }),
  ),
  free_tier_rpd_estimate: z.number().int(),
  latency: z.array(z.object({ kind: z.enum(['turn', 'gate', 'llm', 'tool', 'stage']), name: z.string(), n: z.number().int(), p50_ms: z.number(), p95_ms: z.number() })),
  failover: z.object({ llm_calls: z.number().int(), failovers: z.number().int(), reasons: z.array(z.object({ reason: z.string(), n: z.number().int() })) }),
  gates: z.array(
    z.object({
      gate: z.string(),
      n: z.number().int(),
      by_source: z.record(z.string(), z.number().int()),
      by_choice: z.record(z.string(), z.number().int()),
      confidence_hist: z.array(z.number().int()).length(10), // buckets [0,0.1) ... [0.9,1]
    }),
  ),
  tools: z.array(z.object({ tool: z.string(), calls: z.number().int(), errors: z.number().int() })),
  stop_reasons: z.array(z.object({ reason: z.string(), n: z.number().int() })),
  evals: z.array(
    z.object({
      created_at_utc: utcTs,
      git_sha: z.string(),
      mode: z.string(),
      pass_rate: z.number(),
      window_correctness: z.number(),
      banned_claims: z.number().int(),
      cost_usd: z.number(),
    }),
  ),
  thumbs_down: z.array(z.object({ turn_id: z.string(), created_at_utc: utcTs, comment: z.string().nullable() })),
  prices_checked: z.string(), // date the model prices in pricing.ts were last checked
})
export type OpsResponse = z.infer<typeof opsResponseSchema>

/** GET /api/admin/trace?turn_id=<uuid> (admins only): one turn with its spans, messages and feedback. */
export const adminTraceResponseSchema = z.object({
  turn: z.object({
    id: z.string(),
    conversation_id: z.string(),
    user_id: z.string().nullable(),
    intent: z.string().nullable(),
    stop_reason: z.string(),
    prompt_version: z.string(),
    model_final: z.string().nullable(),
    tokens_in: z.number().int(),
    tokens_out: z.number().int(),
    cost_usd: z.number(),
    latency_ms: z.number().int(),
    created_at_utc: utcTs,
  }),
  spans: z.array(
    z.object({
      id: z.string(),
      parent_id: z.string().nullable(),
      kind: z.enum(['gate', 'llm', 'tool', 'stage']),
      name: z.string(),
      started_at_utc: utcTs,
      duration_ms: z.number(),
      status: z.enum(['ok', 'error']),
      attrs: z.record(z.string(), z.unknown()),
      tokens_in: z.number().int(),
      tokens_out: z.number().int(),
      cost_usd: z.number(),
    }),
  ),
  user_message: z.string().nullable(),
  answer: z.string().nullable(),
  feedback: z.array(z.object({ rating: z.union([z.literal(1), z.literal(-1)]), comment: z.string().nullable() })),
  langfuse_url: z.string().url().nullable(), // deep link when Langfuse is configured
})
export type AdminTraceResponse = z.infer<typeof adminTraceResponseSchema>
export type PlansResponse = z.infer<typeof plansResponseSchema>
