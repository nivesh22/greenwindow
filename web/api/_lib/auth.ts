// Verifies a Supabase access token by asking Supabase Auth (GET /auth/v1/user), caching valid tokens for 60 s.
// The `apikey` header is the publishable key when available (VITE_SUPABASE_ANON_KEY is public by design and also
// readable server-side), else the service key. Tokens are never logged; the cache key is their sha256.
import type { AgentConfig } from '../../agent/config.js'
import type { AuthUser } from '../../agent/store/user_types.js'
import { z } from 'zod'

export const AUTH_CACHE_MS = 60_000
const MAX_CACHE = 500

const userSchema = z.object({ id: z.string().uuid(), is_anonymous: z.boolean().optional(), email: z.string().nullish() })

const cache = new Map<string, { user: AuthUser; expiresMs: number }>()

export function clearAuthCache(): void {
  cache.clear()
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('')
}

export function bearerToken(request: Request): string | null {
  const h = request.headers.get('authorization')
  const m = h ? /^Bearer\s+(\S+)$/i.exec(h.trim()) : null
  return m ? m[1]! : null
}

export async function verifyToken(
  token: string,
  config: Pick<AgentConfig, 'SUPABASE_URL' | 'SUPABASE_SERVICE_ROLE_KEY'>,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
  publishableKey: string | undefined = process.env.VITE_SUPABASE_ANON_KEY,
): Promise<AuthUser | null> {
  if (!config.SUPABASE_URL) return null
  const apikey = publishableKey || config.SUPABASE_SERVICE_ROLE_KEY
  if (!apikey) return null
  const nowMs = now()
  const key = await sha256Hex(token)
  const hit = cache.get(key)
  if (hit && hit.expiresMs > nowMs) return hit.user
  cache.delete(key)

  let res: Response
  try {
    res = await fetchImpl(config.SUPABASE_URL.replace(/\/+$/, '') + '/auth/v1/user', {
      method: 'GET',
      headers: { apikey, authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    })
  } catch {
    return null
  }
  if (!res.ok) return null
  let parsed: ReturnType<typeof userSchema.safeParse>
  try {
    parsed = userSchema.safeParse(await res.json())
  } catch {
    return null
  }
  if (!parsed.success) return null
  const u: AuthUser = { userId: parsed.data.id, isAnonymous: parsed.data.is_anonymous === true, email: parsed.data.email || null }
  if (cache.size >= MAX_CACHE) cache.clear()
  cache.set(key, { user: u, expiresMs: nowMs + AUTH_CACHE_MS })
  return u
}

/** `Authorization: Bearer <token>` -> AuthUser, or null when absent or invalid. */
export async function verifyAuth(
  request: Request,
  config: Pick<AgentConfig, 'SUPABASE_URL' | 'SUPABASE_SERVICE_ROLE_KEY'>,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
  publishableKey?: string,
): Promise<AuthUser | null> {
  const token = bearerToken(request)
  if (!token) return null
  return verifyToken(token, config, fetchImpl, now, publishableKey ?? process.env.VITE_SUPABASE_ANON_KEY)
}
