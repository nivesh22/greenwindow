// GET /api/admin/trace?turn_id=<uuid>: one turn with its spans, the user/assistant messages and feedback. Admins only.
// langfuse_url is null: a deep link needs the Langfuse project id, which is not in our env and is not guessed.
import { z } from 'zod'
import { adminTraceResponseSchema } from '../../agent/harness/api_schemas.js'
import { errorBody, json } from '../_lib/http.js'
import { lazyP4, methodNotAllowed, requireAdmin, storeUnavailable, type P4Deps } from '../_lib/p4.js'

export const maxDuration = 15

export function createTraceHandler(deps: P4Deps): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== 'GET') return methodNotAllowed('GET')
    const auth = await requireAdmin(request, deps)
    if (auth instanceof Response) return auth
    const id = z.string().uuid().safeParse(new URL(request.url).searchParams.get('turn_id'))
    if (!id.success) return json(400, errorBody('bad_request', 'turn_id must be a turn id.'))
    try {
      const t = await deps.ops.turnTrace(id.data)
      if (!t) return json(404, errorBody('not_found', 'No such turn.'))
      return json(
        200,
        adminTraceResponseSchema.parse({
          turn: {
            id: t.turn.id,
            conversation_id: t.turn.conversationId,
            user_id: t.turn.userId,
            intent: t.turn.intent,
            stop_reason: t.turn.stopReason,
            prompt_version: t.turn.promptVersion,
            model_final: t.turn.modelFinal,
            tokens_in: t.turn.tokensIn,
            tokens_out: t.turn.tokensOut,
            cost_usd: t.turn.costUsd,
            latency_ms: t.turn.latencyMs,
            created_at_utc: t.turn.createdAtUtc,
          },
          spans: t.spans.map((s) => ({
            id: s.id,
            parent_id: s.parentId,
            kind: s.kind,
            name: s.name,
            started_at_utc: s.startedAtUtc,
            duration_ms: s.durationMs,
            status: s.status,
            attrs: s.attrs,
            tokens_in: s.tokensIn,
            tokens_out: s.tokensOut,
            cost_usd: s.costUsd,
          })),
          user_message: t.userMessage,
          answer: t.answer,
          feedback: t.feedback,
          langfuse_url: null,
        }),
      )
    } catch {
      return storeUnavailable()
    }
  }
}

export default lazyP4(createTraceHandler)
