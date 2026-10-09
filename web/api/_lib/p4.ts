// Shared plumbing for the P4 endpoints (plans, push, reminders, cron, admin): deps, guards, lazily built production deps.
import { loadConfig, type AgentConfig } from '../../agent/config.js'
import { HttpForecastSource } from '../../agent/data/forecast_source.js'
import type { ForecastSource } from '../../agent/data/types.js'
import type { OpsStore, PlanStore } from '../../agent/store/plan_types.js'
import { SupabaseLedgerStore, SupabaseOpsStore, SupabasePlanStore, type LedgerStore } from '../../agent/store/supabase_plans.js'
import type { AuthUser } from '../../agent/store/user_types.js'
import { authenticate, methodNotAllowed, notConfigured, unauthorized, type ApiEnv } from './deps.js'
import { errorBody, json } from './http.js'
import { createWebPushSender, type PushSender } from './push.js'

export interface P4Env extends ApiEnv {
  /** Shared secret that pg_cron sends in `x-cron-secret`. */
  CRON_SECRET?: string
  VAPID_SUBJECT?: string
  VITE_VAPID_PUBLIC_KEY?: string
  VAPID_PRIVATE_KEY?: string
}

export interface P4Deps {
  config: AgentConfig
  env: P4Env
  fetch: typeof fetch
  now: () => number
  plans: PlanStore
  ops: OpsStore
  ledger: LedgerStore
  data: ForecastSource
  /** null when the VAPID keys are not configured (the reminders cron then answers 503). */
  push: PushSender | null
}

export const forbidden = (message: string) => json(403, errorBody('forbidden', message))
export const signInRequired = () => json(403, errorBody('sign_in_required', 'Sign in to use this feature.'))
export const storeUnavailable = () => json(503, errorBody('store_unavailable', 'This is temporarily unavailable. Please try again.'))
export { methodNotAllowed }

/** The signed-in (non-anonymous) caller, or the 401/403 Response to return. */
export async function requireSignedIn(request: Request, deps: Pick<P4Deps, 'config' | 'fetch' | 'now' | 'env'>): Promise<AuthUser | Response> {
  const auth = await authenticate(request, deps)
  if (!auth) return unauthorized()
  if (auth.isAnonymous) return signInRequired()
  return auth
}

/** An admin caller (rows in `admins`), or the 401/403 Response to return. */
export async function requireAdmin(request: Request, deps: Pick<P4Deps, 'config' | 'fetch' | 'now' | 'env' | 'ops'>): Promise<AuthUser | Response> {
  const auth = await authenticate(request, deps)
  if (!auth) return unauthorized()
  if (auth.isAnonymous) return forbidden('Admins only.')
  try {
    if (!(await deps.ops.isAdmin(auth.userId))) return forbidden('Admins only.')
  } catch {
    return storeUnavailable()
  }
  return auth
}

export function pushFromEnv(env: P4Env): PushSender | null {
  if (!env.VAPID_SUBJECT || !env.VITE_VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return null
  return createWebPushSender({ subject: env.VAPID_SUBJECT, publicKey: env.VITE_VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY })
}

let shared: P4Deps | null = null

/** Production deps (module scope, reused on warm instances). null when Supabase is not configured. */
export function getP4Deps(): P4Deps | null {
  if (shared) return shared
  let config: AgentConfig
  try {
    config = loadConfig()
  } catch {
    return null
  }
  if (!config.SUPABASE_URL || !config.SUPABASE_SERVICE_ROLE_KEY) return null
  const sb = { url: config.SUPABASE_URL, key: config.SUPABASE_SERVICE_ROLE_KEY }
  const env: P4Env = {
    VITE_SUPABASE_ANON_KEY: process.env.VITE_SUPABASE_ANON_KEY,
    CRON_SECRET: process.env.CRON_SECRET,
    VAPID_SUBJECT: process.env.VAPID_SUBJECT,
    VITE_VAPID_PUBLIC_KEY: process.env.VITE_VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY,
  }
  shared = {
    config,
    env,
    fetch: (input, init) => fetch(input, init),
    now: Date.now,
    plans: new SupabasePlanStore(sb),
    ops: new SupabaseOpsStore(sb),
    ledger: new SupabaseLedgerStore(sb),
    data: new HttpForecastSource({ baseUrl: config.DATA_BASE_URL, backtestBaseUrl: config.BACKTEST_BASE_URL }),
    push: pushFromEnv(env),
  }
  return shared
}

/** Wraps a handler factory into the Vercel default export, answering 503 when deps are unavailable. */
export function lazyP4(create: (deps: P4Deps) => (request: Request) => Promise<Response>): { fetch: (request: Request) => Promise<Response> } {
  let handler: ((request: Request) => Promise<Response>) | null = null
  return {
    async fetch(request) {
      const deps = getP4Deps()
      if (!deps) return notConfigured()
      handler ??= create(deps)
      return handler(request)
    },
  }
}
