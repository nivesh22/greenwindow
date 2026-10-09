// POST /api/chat: validates the body, applies limits, then streams a turn as SSE (design §8).
import { loadConfig, type AgentConfig } from '../agent/config.js'
import { chatRequestSchema } from '../agent/harness/events.js'
import { SupabaseStore } from '../agent/store/supabase.js'
import { SupabaseUserStore } from '../agent/store/supabase_users.js'
import type { AuthUser, UserStore } from '../agent/store/user_types.js'
import type { ConsumeResult, LimitKind, Store } from '../agent/store/types.js'
import { verifyAuth } from './_lib/auth.js'
import { errorBody, ipHash, json, sseResponse } from './_lib/http.js'
import { HttpForecastSource } from '../agent/data/forecast_source.js'
import { buildRouter, createTurnRunner } from '../agent/harness/turn.js'
import { exporterFromEnv } from '../agent/telemetry/langfuse.js'
import { SupabasePlanStore } from '../agent/store/supabase_plans.js'
import { buildRegistry } from '../agent/tools/index.js'
import type { TurnRunner } from './_lib/turn_runner.js'

export const maxDuration = 60

export interface ChatDeps {
  store: Store
  runTurn: TurnRunner
  config: AgentConfig
  now: () => number
  /** P3: admin exemption lookup. Optional so IP-only deployments and old tests keep working. */
  users?: Pick<UserStore, 'isAdmin'>
  fetch?: typeof fetch
  publishableKey?: string
}

const LIMIT_MESSAGES: Record<LimitKind, string> = {
  anon_limit: 'You have used your free messages.',
  daily_cap: 'You have reached today’s message limit. It resets at midnight UTC.',
  rate: 'Too many requests right now. Please try again in a little while.',
  budget_paused: 'The assistant is paused for this month to stay within its budget. The rest of the app still works.',
}

/** Admins are exempt from the per-user daily cap (SQL parameter is a 32-bit integer). */
const ADMIN_CAP = 1_000_000

const signInMessage = (cap: number) => `You’ve used your ${cap} free messages. Continue with Google to keep going — your conversation carries over.`

const notConfigured = () => json(503, errorBody('not_configured', 'The assistant is not configured.'))

export function createChatHandler(deps: ChatDeps): (request: Request) => Promise<Response> {
  const { store, runTurn, config, now } = deps
  const doFetch = deps.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a))
  return async (request) => {
    if (request.method !== 'POST') return json(405, errorBody('method_not_allowed', 'POST only'), { allow: 'POST' })
    if (!config.SUPABASE_URL || !config.SUPABASE_SERVICE_ROLE_KEY || !config.IP_SALT) return notConfigured()
    let raw: unknown
    try {
      raw = await request.json()
    } catch {
      return json(400, errorBody('bad_request', 'Body must be valid JSON.'))
    }
    const parsed = chatRequestSchema.safeParse(raw)
    if (!parsed.success) return json(400, errorBody('bad_request', 'Invalid request body.'))

    const nowMs = now()
    let auth: AuthUser | null = null
    if (request.headers.get('authorization')) {
      auth = await verifyAuth(request, config, doFetch, now, deps.publishableKey)
      if (!auth) return json(401, errorBody('unauthorized', 'Your session has expired. Please sign in again.'))
    }
    let admin = false
    if (auth && deps.users) {
      try {
        admin = await deps.users.isAdmin(auth.userId)
      } catch {
        admin = false
      }
    }
    const hash = await ipHash(request, config.IP_SALT)
    let res: ConsumeResult
    try {
      res = await store.consumeMessage({
        userId: auth?.userId ?? null,
        ipHash: hash,
        isAnonymous: auth?.isAnonymous ?? false,
        dailyCap: admin ? ADMIN_CAP : config.USER_DAILY_CAP,
        anonCap: config.ANON_MESSAGE_CAP,
        ipHourlyCap: config.IP_HOURLY_CAP,
        globalDailyCap: config.GLOBAL_DAILY_CAP,
        nowMs,
      })
    } catch {
      return json(503, errorBody('store_unavailable', 'Limits are temporarily unavailable.'))
    }

    if (!res.allowed) {
      const kind: LimitKind = res.kind ?? 'rate'
      return sseResponse(async (emit) => {
        const signIn = kind === 'anon_limit' && auth !== null
        emit({ type: 'limit', data: { kind, message: signIn ? signInMessage(config.ANON_MESSAGE_CAP) : LIMIT_MESSAGES[kind], sign_in: signIn } })
      }, request.signal)
    }
    return sseResponse(
      (emit, signal) => runTurn({ request: parsed.data, ipHash: hash, nowMs, messagesLeft: res.messagesLeft, auth, signal }, emit),
      request.signal,
    )
  }
}

// Module scope: reused across requests on a warm Fluid instance (forecast cache, registry).
let shared: { store: SupabaseStore; users: SupabaseUserStore; runTurn: TurnRunner; config: AgentConfig } | null = null

function getShared(config: AgentConfig): typeof shared {
  if (shared) return shared
  if (!config.SUPABASE_URL || !config.SUPABASE_SERVICE_ROLE_KEY || !config.GEMINI_API_KEY) return null
  const store = new SupabaseStore({ url: config.SUPABASE_URL, key: config.SUPABASE_SERVICE_ROLE_KEY })
  const data = new HttpForecastSource({ baseUrl: config.DATA_BASE_URL, backtestBaseUrl: config.BACKTEST_BASE_URL })
  const users = new SupabaseUserStore({ url: config.SUPABASE_URL, key: config.SUPABASE_SERVICE_ROLE_KEY })
  const plans = new SupabasePlanStore({ url: config.SUPABASE_URL, key: config.SUPABASE_SERVICE_ROLE_KEY })
  const runTurn = createTurnRunner({ config, store, users, plans, data, registry: buildRegistry(), router: buildRouter(config), telemetry: exporterFromEnv() })
  shared = { store, users, runTurn, config }
  return shared
}

export default {
  async fetch(request: Request): Promise<Response> {
    let config: AgentConfig
    try {
      config = loadConfig()
    } catch {
      return notConfigured()
    }
    const s = getShared(config)
    if (!s) return notConfigured()
    return createChatHandler({ store: s.store, runTurn: s.runTurn, config: s.config, now: Date.now, users: s.users })(request)
  },
}
