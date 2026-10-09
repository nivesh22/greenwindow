// POST /api/me/delete: deletes the caller's account and every row they own (FR-7.4). Body: {confirm:'DELETE'}.
// Rows cascade from auth.users (migrations 0003 and 0005: profiles, devices, conversations, messages, summaries,
// impact_ledger, feedback, turns -> spans, plans -> reminders, push_subscriptions). The caller's Langfuse traces are
// removed first, best effort and time-boxed, when Langfuse credentials exist (_lib/langfuse_delete.ts).
import { deleteMeRequestSchema } from '../../agent/harness/api_schemas.js'
import { clearAuthCache } from '../_lib/auth.js'
import { authenticate, lazyFetch, methodNotAllowed, readBody, unauthorized, type ApiDeps } from '../_lib/deps.js'
import { errorBody, json } from '../_lib/http.js'
import { deleteLangfuseTraces } from '../_lib/langfuse_delete.js'

export const maxDuration = 15

export function createDeleteMeHandler(deps: ApiDeps): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== 'POST') return methodNotAllowed('POST')
    const auth = await authenticate(request, deps)
    if (!auth) return unauthorized()
    const body = await readBody(request, deleteMeRequestSchema)
    if (body instanceof Response) return body
    try {
      await deleteLangfuseTraces(auth.userId, deps.env, deps.fetch, deps.now(), 4000).catch((e: unknown) => {
        console.warn('langfuse trace deletion failed', e instanceof Error ? e.message : 'unknown')
      })
      await deps.users.deleteUserData(auth.userId)
      clearAuthCache()
      return json(200, { ok: true })
    } catch {
      return json(503, errorBody('store_unavailable', 'Could not delete your data right now. Please try again.'))
    }
  }
}

export default lazyFetch(createDeleteMeHandler)
