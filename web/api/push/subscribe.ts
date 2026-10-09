// POST /api/push/subscribe {subscription} saves the browser's Web Push subscription; DELETE {endpoint} removes it.
// Signed-in (non-anonymous) users only. The endpoint must be https.
import { pushSubscribeRequestSchema, pushUnsubscribeRequestSchema } from '../../agent/harness/api_schemas.js'
import { readBody } from '../_lib/deps.js'
import { errorBody, json } from '../_lib/http.js'
import { lazyP4, methodNotAllowed, requireSignedIn, storeUnavailable, type P4Deps } from '../_lib/p4.js'

export const maxDuration = 15

const insecure = () => json(400, errorBody('bad_request', 'The push endpoint must use https.'))

export function createSubscribeHandler(deps: P4Deps): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== 'POST' && request.method !== 'DELETE') return methodNotAllowed('POST, DELETE')
    const auth = await requireSignedIn(request, deps)
    if (auth instanceof Response) return auth
    if (request.method === 'POST') {
      const body = await readBody(request, pushSubscribeRequestSchema)
      if (body instanceof Response) return body
      if (!body.subscription.endpoint.startsWith('https://')) return insecure()
      try {
        await deps.plans.savePushSubscription({
          userId: auth.userId,
          endpoint: body.subscription.endpoint,
          p256dh: body.subscription.keys.p256dh,
          auth: body.subscription.keys.auth,
        })
        return json(200, { ok: true })
      } catch {
        return storeUnavailable()
      }
    }
    const body = await readBody(request, pushUnsubscribeRequestSchema)
    if (body instanceof Response) return body
    try {
      await deps.plans.deletePushSubscription(auth.userId, body.endpoint)
      return json(200, { ok: true })
    } catch {
      return storeUnavailable()
    }
  }
}

export default lazyP4(createSubscribeHandler)
