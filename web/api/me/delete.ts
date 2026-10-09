// POST /api/me/delete: deletes the caller's account and every row they own (FR-7.4). Body: {confirm:'DELETE'}.
import { deleteMeRequestSchema } from '../../agent/harness/api_schemas.js'
import { clearAuthCache } from '../_lib/auth.js'
import { authenticate, lazyFetch, methodNotAllowed, readBody, unauthorized, type ApiDeps } from '../_lib/deps.js'
import { errorBody, json } from '../_lib/http.js'

export const maxDuration = 15

export function createDeleteMeHandler(deps: ApiDeps): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== 'POST') return methodNotAllowed('POST')
    const auth = await authenticate(request, deps)
    if (!auth) return unauthorized()
    const body = await readBody(request, deleteMeRequestSchema)
    if (body instanceof Response) return body
    try {
      await deps.users.deleteUserData(auth.userId)
      clearAuthCache()
      return json(200, { ok: true })
    } catch {
      return json(503, errorBody('store_unavailable', 'Could not delete your data right now. Please try again.'))
    }
  }
}

export default lazyFetch(createDeleteMeHandler)
