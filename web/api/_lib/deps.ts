// Shared plumbing for the P3 endpoints: deps, method/JSON/auth guards, and the lazily built production deps.
import { loadConfig, type AgentConfig } from '../../agent/config.js'
import { SupabaseUserStore } from '../../agent/store/supabase_users.js'
import type { AuthUser, UserStore } from '../../agent/store/user_types.js'
import type { z } from 'zod'
import { verifyAuth } from './auth.js'
import { errorBody, json } from './http.js'

/** The SQL-backed helpers that are not part of UserStore. */
export interface UsageApi {
  /** true = a new anonymous session is allowed for this IP hash (per-hour cap). */
  consumeSession(ipHash: string, cap: number): Promise<boolean>
  anonMessagesUsed(userId: string): Promise<number>
}

/** Environment values the handlers read (names only here; values come from Vercel env vars). */
export interface ApiEnv {
  TURNSTILE_SECRET?: string
  VITE_SUPABASE_ANON_KEY?: string
  /** Optional Langfuse credentials, used by /api/me/delete to remove the caller's traces. */
  LANGFUSE_PUBLIC_KEY?: string
  LANGFUSE_SECRET_KEY?: string
  LANGFUSE_BASE_URL?: string
}

export interface ApiDeps {
  users: UserStore & { reassignCounted?: (from: string, to: string) => Promise<number> }
  usage: UsageApi
  config: AgentConfig
  env: ApiEnv
  fetch: typeof fetch
  now: () => number
}

export const SESSIONS_PER_IP_HOUR = 5

export const notConfigured = () => json(503, errorBody('not_configured', 'The service is not configured.'))
export const methodNotAllowed = (allow: string) => json(405, errorBody('method_not_allowed', `${allow} only`), { allow })
export const unauthorized = () => json(401, errorBody('unauthorized', 'Sign in required.'))

export function isConfigured(config: AgentConfig): boolean {
  return Boolean(config.SUPABASE_URL && config.SUPABASE_SERVICE_ROLE_KEY)
}

export function authenticate(request: Request, deps: Pick<ApiDeps, 'config' | 'fetch' | 'now' | 'env'>): Promise<AuthUser | null> {
  return verifyAuth(request, deps.config, deps.fetch, deps.now, deps.env.VITE_SUPABASE_ANON_KEY)
}

/** Parses a JSON body with a zod schema; returns the data or a 400 Response. */
export async function readBody<T>(request: Request, schema: z.ZodType<T>): Promise<T | Response> {
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return json(400, errorBody('bad_request', 'Body must be valid JSON.'))
  }
  const r = schema.safeParse(raw)
  return r.success ? r.data : json(400, errorBody('bad_request', 'Invalid request body.'))
}

let shared: ApiDeps | null = null

/** Production deps (module scope, reused on warm instances). null when Supabase is not configured. */
export function getApiDeps(): ApiDeps | null {
  if (shared) return shared
  let config: AgentConfig
  try {
    config = loadConfig()
  } catch {
    return null
  }
  if (!config.SUPABASE_URL || !config.SUPABASE_SERVICE_ROLE_KEY) return null
  const store = new SupabaseUserStore({ url: config.SUPABASE_URL, key: config.SUPABASE_SERVICE_ROLE_KEY })
  shared = {
    users: store,
    usage: store,
    config,
    env: {
      TURNSTILE_SECRET: process.env.TURNSTILE_SECRET,
      VITE_SUPABASE_ANON_KEY: process.env.VITE_SUPABASE_ANON_KEY,
      LANGFUSE_PUBLIC_KEY: process.env.LANGFUSE_PUBLIC_KEY,
      LANGFUSE_SECRET_KEY: process.env.LANGFUSE_SECRET_KEY,
      LANGFUSE_BASE_URL: process.env.LANGFUSE_BASE_URL,
    },
    fetch: (input, init) => fetch(input, init),
    now: Date.now,
  }
  return shared
}

/** Wraps a handler factory into the Vercel default export, answering 503 when deps are unavailable. */
export function lazyFetch(create: (deps: ApiDeps) => (request: Request) => Promise<Response>): { fetch: (request: Request) => Promise<Response> } {
  let handler: ((request: Request) => Promise<Response>) | null = null
  return {
    async fetch(request) {
      const deps = getApiDeps()
      if (!deps) return notConfigured()
      handler ??= create(deps)
      return handler(request)
    },
  }
}
