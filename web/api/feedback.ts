// POST /api/feedback: thumbs on an assistant answer (FR-9.4). Any valid session, anonymous included.
import { feedbackRequestSchema } from '../agent/harness/api_schemas.js'
import { authenticate, lazyFetch, methodNotAllowed, readBody, unauthorized, type ApiDeps } from './_lib/deps.js'
import { errorBody, json } from './_lib/http.js'

export const maxDuration = 15

export function createFeedbackHandler(deps: ApiDeps): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== 'POST') return methodNotAllowed('POST')
    const auth = await authenticate(request, deps)
    if (!auth) return unauthorized()
    const body = await readBody(request, feedbackRequestSchema)
    if (body instanceof Response) return body
    try {
      await deps.users.saveFeedback({ turnId: body.turn_id, userId: auth.userId, rating: body.rating, comment: body.comment })
      return json(200, { ok: true })
    } catch {
      return json(503, errorBody('store_unavailable', 'Could not save feedback right now.'))
    }
  }
}

export default lazyFetch(createFeedbackHandler)
