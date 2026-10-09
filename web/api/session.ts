// POST /api/session: Turnstile check + per-IP cap before the client calls supabase.auth.signInAnonymously().
// Turnstile verify: POST https://challenges.cloudflare.com/turnstile/v0/siteverify (form: secret, response, remoteip).
// The raw IP goes only to Cloudflare as `remoteip`; we store just the salted hash.
import { sessionRequestSchema } from '../agent/harness/api_schemas.js'
import { lazyFetch, methodNotAllowed, notConfigured, readBody, SESSIONS_PER_IP_HOUR, type ApiDeps } from './_lib/deps.js'
import { errorBody, ipHash, json } from './_lib/http.js'

export const maxDuration = 15

export const TURNSTILE_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

export function createSessionHandler(deps: ApiDeps): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== 'POST') return methodNotAllowed('POST')
    const secret = deps.env.TURNSTILE_SECRET
    if (!secret || !deps.config.IP_SALT) return notConfigured()
    const body = await readBody(request, sessionRequestSchema)
    if (body instanceof Response) return body

    const form = new URLSearchParams({ secret, response: body.turnstile_token })
    const ip = (request.headers.get('x-forwarded-for') ?? '').split(',')[0]?.trim()
    if (ip) form.set('remoteip', ip)
    let ok = false
    try {
      const res = await deps.fetch(TURNSTILE_URL, { method: 'POST', body: form, signal: AbortSignal.timeout(5000) })
      const data: unknown = res.ok ? await res.json() : null
      ok = typeof data === 'object' && data !== null && (data as { success?: unknown }).success === true
    } catch {
      return json(503, errorBody('verify_unavailable', 'Could not verify the challenge. Please try again.'))
    }
    if (!ok) return json(403, errorBody('turnstile_failed', 'Challenge failed. Please try again.'))

    try {
      const allowed = await deps.usage.consumeSession(await ipHash(request, deps.config.IP_SALT), SESSIONS_PER_IP_HOUR)
      if (!allowed) return json(429, errorBody('session_limit', 'Too many new sessions from this network. Please try again later.'), { 'retry-after': '3600' })
    } catch {
      return json(503, errorBody('store_unavailable', 'Limits are temporarily unavailable.'))
    }
    return json(200, { ok: true })
  }
}

export default lazyFetch(createSessionHandler)
