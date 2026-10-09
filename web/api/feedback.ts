// POST /api/feedback: thumbs on an assistant answer (FR-9.4). Any valid session, anonymous included.
// After saving, the rating is also sent to Langfuse as a `user_feedback` score (design §14); a thumbs-down on an
// unsampled turn first exports that turn from Supabase. Langfuse is best effort: the response never fails because of it.
// Serverless choice: the export is AWAITED, but raced against LANGFUSE_WAIT_MS. Not awaiting would let the platform
// freeze the function before the score is flushed; waiting without a bound would delay the user. On timeout the
// response is sent and the work may be dropped (Supabase already holds the feedback, so nothing is lost).
import { feedbackRequestSchema } from '../agent/harness/api_schemas.js'
import type { OpsStore } from '../agent/store/plan_types.js'
import { SupabaseOpsStore } from '../agent/store/supabase_plans.js'
import { exporterFromEnv, NOOP_EXPORTER, type TraceExporter, type TurnExport } from '../agent/telemetry/langfuse.js'
import { authenticate, getApiDeps, lazyFetch, methodNotAllowed, readBody, unauthorized, type ApiDeps } from './_lib/deps.js'
import { errorBody, json } from './_lib/http.js'

export const maxDuration = 15

export const LANGFUSE_WAIT_MS = 3000

export interface FeedbackExtras {
  exporter: TraceExporter
  /** Source of the turn for the Langfuse export; null disables loading (score only for sampled turns). */
  ops: Pick<OpsStore, 'turnTrace'> | null
  waitMs?: number
}

const NO_EXTRAS: FeedbackExtras = { exporter: NOOP_EXPORTER, ops: null }

/**
 * Maps the stored turn to what the Langfuse exporter needs. Payloads (LLM I/O) are not stored, so the map is empty.
 * Only the caller's own turns: a rating on someone else's turn id must not export or score that turn.
 */
export function loader(ops: Pick<OpsStore, 'turnTrace'> | null, turnId: string, callerId: string): () => Promise<TurnExport | null> {
  return async () => {
    if (!ops) return null
    const t = await ops.turnTrace(turnId)
    if (!t || t.turn.userId !== callerId) return null
    return { turn: t.turn, spans: t.spans, payloads: new Map(), userMessage: t.userMessage ?? '', answer: t.answer ?? '', isAnonymous: t.isAnonymous }
  }
}

async function scoreWithTimeout(extras: FeedbackExtras, f: { turnId: string; rating: 1 | -1; comment: string | null; callerId: string }): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, extras.waitMs ?? LANGFUSE_WAIT_MS)
  })
  try {
    const { callerId, ...score } = f
    await Promise.race([extras.exporter.scoreFeedback({ ...score, load: loader(extras.ops, f.turnId, callerId) }), timeout])
  } catch {
    // scoreFeedback never throws; this also covers a misbehaving exporter.
  } finally {
    clearTimeout(timer)
  }
}

export function createFeedbackHandler(deps: ApiDeps, extras: FeedbackExtras = NO_EXTRAS): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== 'POST') return methodNotAllowed('POST')
    const auth = await authenticate(request, deps)
    if (!auth) return unauthorized()
    const body = await readBody(request, feedbackRequestSchema)
    if (body instanceof Response) return body
    try {
      await deps.users.saveFeedback({ turnId: body.turn_id, userId: auth.userId, rating: body.rating, comment: body.comment })
    } catch {
      return json(503, errorBody('store_unavailable', 'Could not save feedback right now.'))
    }
    await scoreWithTimeout(extras, { turnId: body.turn_id, rating: body.rating, comment: body.comment, callerId: auth.userId })
    return json(200, { ok: true })
  }
}

let production: FeedbackExtras | null = null

function productionExtras(): FeedbackExtras {
  if (production) return production
  const d = getApiDeps()
  const exporter = exporterFromEnv()
  production = {
    exporter,
    ops: d && exporter !== NOOP_EXPORTER && d.config.SUPABASE_URL && d.config.SUPABASE_SERVICE_ROLE_KEY
      ? new SupabaseOpsStore({ url: d.config.SUPABASE_URL, key: d.config.SUPABASE_SERVICE_ROLE_KEY })
      : null,
  }
  return production
}

export default lazyFetch((deps) => createFeedbackHandler(deps, productionExtras()))
