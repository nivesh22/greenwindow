// Shared guard for the pg_cron -> /api/cron/* calls (migration 0005, gw_call_app): header `x-cron-secret`.
import { errorBody, json } from './http.js'

async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
}

/** Constant-time string equality: compares fixed-length SHA-256 digests, so length and content leak no timing. */
export async function secretsEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256(a), sha256(b)])
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!
  return diff === 0
}

/** null when the request carries the right secret; otherwise the 503 (secret unset) or 401 (mismatch) Response. */
export async function checkCronSecret(request: Request, secret: string | undefined): Promise<Response | null> {
  if (!secret) return json(503, errorBody('not_configured', 'Cron is not configured.'))
  const given = request.headers.get('x-cron-secret')
  if (!given || !(await secretsEqual(given, secret))) return json(401, errorBody('unauthorized', 'Invalid cron secret.'))
  return null
}
