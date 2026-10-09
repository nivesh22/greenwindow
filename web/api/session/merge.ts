// POST /api/session/merge: after Google sign-in fell back to a new account (S6), move the anonymous user's data.
import { mergeRequestSchema } from '../../agent/harness/api_schemas.js'
import { authenticate, lazyFetch, methodNotAllowed, readBody, unauthorized, type ApiDeps } from '../_lib/deps.js'
import { verifyToken } from '../_lib/auth.js'
import { errorBody, json } from '../_lib/http.js'

export const maxDuration = 15

export function createMergeHandler(deps: ApiDeps): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== 'POST') return methodNotAllowed('POST')
    const caller = await authenticate(request, deps)
    if (!caller) return unauthorized()
    if (caller.isAnonymous) return json(403, errorBody('sign_in_required', 'Sign in with Google to merge a session.'))
    const body = await readBody(request, mergeRequestSchema)
    if (body instanceof Response) return body
    const anon = await verifyToken(body.anon_access_token, deps.config, deps.fetch, deps.now, deps.env.VITE_SUPABASE_ANON_KEY)
    if (!anon || !anon.isAnonymous) return json(400, errorBody('bad_anon_token', 'The anonymous session is not valid.'))
    if (anon.userId === caller.userId) return json(200, { ok: true, moved_conversations: 0 })
    try {
      let moved = 0
      if (deps.users.reassignCounted) moved = await deps.users.reassignCounted(anon.userId, caller.userId)
      else await deps.users.reassign(anon.userId, caller.userId)
      return json(200, { ok: true, moved_conversations: moved })
    } catch {
      return json(503, errorBody('store_unavailable', 'Could not merge right now.'))
    }
  }
}

export default lazyFetch(createMergeHandler)
