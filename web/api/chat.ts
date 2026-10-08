// POST /api/chat: validates the body, applies limits, then streams a turn as SSE (design §8).
import { loadConfig, type AgentConfig } from '../agent/config.js'
import { chatRequestSchema } from '../agent/harness/events.js'
import { SupabaseStore } from '../agent/store/supabase.js'
import type { ConsumeResult, LimitKind, Store } from '../agent/store/types.js'
import { errorBody, ipHash, json, sseResponse } from './_lib/http.js'
import { HttpForecastSource } from '../agent/data/forecast_source.js'
import { buildRouter, createTurnRunner } from '../agent/harness/turn.js'
import { buildRegistry } from '../agent/tools/index.js'
import type { TurnRunner } from './_lib/turn_runner.js'

export const maxDuration = 60

export interface ChatDeps {
  store: Store
  runTurn: TurnRunner
  config: AgentConfig
  now: () => number
}

const LIMIT_MESSAGES: Record<LimitKind, string> = {
  anon_limit: 'You have used your free messages.',
  daily_cap: 'You have reached today’s message limit. It resets at midnight UTC.',
  rate: 'Too many requests right now. Please try again in a little while.',
  budget_paused: 'The assistant is paused for this month to stay within its budget. The rest of the app still works.',
}

const notConfigured = () => json(503, errorBody('not_configured', 'The assistant is not configured.'))

export function createChatHandler(deps: ChatDeps): (request: Request) => Promise<Response> {
  const { store, runTurn, config, now } = deps
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
    const hash = await ipHash(request, config.IP_SALT)
    let res: ConsumeResult
    try {
      res = await store.consumeMessage({
        userId: null,
        ipHash: hash,
        isAnonymous: false,
        dailyCap: config.USER_DAILY_CAP,
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
        emit({ type: 'limit', data: { kind, message: LIMIT_MESSAGES[kind], sign_in: false } })
      }, request.signal)
    }
    return sseResponse(
      (emit, signal) => runTurn({ request: parsed.data, ipHash: hash, nowMs, signal }, emit),
      request.signal,
    )
  }
}

// Module scope: reused across requests on a warm Fluid instance (forecast cache, registry).
let shared: { store: SupabaseStore; runTurn: TurnRunner; config: AgentConfig } | null = null

function getShared(config: AgentConfig): typeof shared {
  if (shared) return shared
  if (!config.SUPABASE_URL || !config.SUPABASE_SERVICE_ROLE_KEY || !config.GEMINI_API_KEY) return null
  const store = new SupabaseStore({ url: config.SUPABASE_URL, key: config.SUPABASE_SERVICE_ROLE_KEY })
  const data = new HttpForecastSource({ baseUrl: config.DATA_BASE_URL, backtestBaseUrl: config.BACKTEST_BASE_URL })
  const runTurn = createTurnRunner({ config, store, data, registry: buildRegistry(), router: buildRouter(config) })
  shared = { store, runTurn, config }
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
    return createChatHandler({ store: s.store, runTurn: s.runTurn, config: s.config, now: Date.now })(request)
  },
}
