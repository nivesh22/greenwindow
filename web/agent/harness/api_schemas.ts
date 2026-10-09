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
