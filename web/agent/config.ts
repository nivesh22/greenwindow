// Tunable numbers and IDs (design §1 "Fixed vs tunable"). Parsed from env with zod defaults; fails fast on bad
// values. Secrets are read here and nowhere else; never log this object.
import { z } from 'zod'

const num = (d: number) => z.coerce.number().finite().default(d)

const envSchema = z.object({
  // Secrets (server-only). Optional here so unit tests run without them; the API handler asserts what it needs.
  GEMINI_API_KEY: z.string().min(1).optional(),
  AI_GATEWAY_API_KEY: z.string().min(1).optional(),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  IP_SALT: z.string().min(16).optional(),

  // Models (docs/spikes.md live checks, 2026-10-08). MODEL_ROUTE is the failover order, "<provider>:<model>" comma
  // separated. Haiku (paid, ~2 s, ~$0.001/turn) is second: Gemini's free per-minute limits made flash-lite
  // failovers take 15-45 s. The free Gemini models remain as last resorts.
  MODEL_ROUTE: z
    .string()
    .default('gemini-direct:gemini-3.5-flash,ai-gateway:anthropic/claude-haiku-5.5,gemini-direct:gemini-3.5-flash-lite,gemini-direct:gemini-3.8-flash')
    .transform((v, ctx) => {
      const route = v.split(',').map((e) => e.trim()).filter(Boolean).map((e) => {
        const i = e.indexOf(':')
        return { provider: e.slice(0, i), model: e.slice(i + 1) }
      })
      for (const r of route) {
        if (r.provider !== 'gemini-direct' && r.provider !== 'ai-gateway') ctx.addIssue({ code: 'custom', message: `bad provider in MODEL_ROUTE: ${r.provider}` })
        if (!r.model) ctx.addIssue({ code: 'custom', message: 'empty model in MODEL_ROUTE' })
      }
      return route as { provider: 'gemini-direct' | 'ai-gateway'; model: string }[]
    }),
  CHEAP_MODEL: z.string().default('gemini-3.5-flash-lite'),
  GEMINI_REASONING_EFFORT: z.enum(['low', 'medium', 'high', 'off']).default('low'),
  GEMINI_BASE_URL: z.string().url().default('https://generativelanguage.googleapis.com/v1beta/openai'),
  GATEWAY_BASE_URL: z.string().url().default('https://ai-gateway.vercel.sh/v1'),
  DATA_BASE_URL: z.string().url().default('https://raw.githubusercontent.com/nivesh22/greenwindow/data/app_data'),
  // backtest_summary.json is served by the site itself. Previews are behind Vercel login, so use production.
  BACKTEST_BASE_URL: z.string().url().default('https://greenwindow-one.vercel.app'),

  // Per-turn budgets (design §5.3).
  MAX_STEPS: num(6),
  MAX_INPUT_TOKENS: num(40_000),
  MAX_OUTPUT_TOKENS: num(2048), // includes Gemini reasoning tokens (docs/spikes.md)
  MAX_TURN_COST_USD: num(0.01),
  TURN_WALL_MS: num(45_000),
  TOOL_TIMEOUT_MS: num(5_000),
  FIRST_TOKEN_TIMEOUT_MS: num(15_000), // whole-call wait for the first stream event; Gemini may send one chunk at the end

  // Spend and limits (design §10–11).
  MONTHLY_BUDGET_USD: num(5),
  ANON_MESSAGE_CAP: num(3),
  USER_DAILY_CAP: num(20),
  IP_HOURLY_CAP: num(20),
  GLOBAL_DAILY_CAP: num(300),
})

export type AgentConfig = z.infer<typeof envSchema>

export function loadConfig(env: Record<string, string | undefined> = process.env): AgentConfig {
  return envSchema.parse(env)
}

export interface Price {
  inUsdPerMTok: number
  outUsdPerMTok: number
  cachedInUsdPerMTok: number
  free: boolean // free tier: costs $0 but requests are counted (FR-10.4)
}

/**
 * Price table, checked live 2026-10-08 (docs/spikes.md "Live checks"). Gemini is used on the free tier (no billing
 * on the key). Haiku 5.5 via the gateway: $0.10 / $0.50 per 1M below 100k input tokens (our turns stay far below).
 * Unknown models are priced at a deliberately high worst case so the kill switch trips early, never late.
 */
export const PRICES: Record<string, Price> = {
  'gemini-3.8-flash': { inUsdPerMTok: 0, outUsdPerMTok: 0, cachedInUsdPerMTok: 0, free: true },
  'gemini-3.5-flash-lite': { inUsdPerMTok: 0, outUsdPerMTok: 0, cachedInUsdPerMTok: 0, free: true },
  'gemini-3.5-flash': { inUsdPerMTok: 0, outUsdPerMTok: 0, cachedInUsdPerMTok: 0, free: true },
  'anthropic/claude-haiku-5.5': { inUsdPerMTok: 0.1, outUsdPerMTok: 0.5, cachedInUsdPerMTok: 0.01, free: false },
  'typesafe-ai/jev': { inUsdPerMTok: 0.042, outUsdPerMTok: 0, cachedInUsdPerMTok: 0.042, free: false },
}
export const PRICES_CHECKED = '2026-10-08'

const WORST: Price = { inUsdPerMTok: 1, outUsdPerMTok: 5, cachedInUsdPerMTok: 1, free: false }

export function priceOf(model: string): Price {
  return PRICES[model] ?? WORST
}

export function costUsd(model: string, inputTokens: number, outputTokens: number, cachedInputTokens = 0): number {
  const p = priceOf(model)
  const uncached = Math.max(0, inputTokens - cachedInputTokens)
  return (uncached * p.inUsdPerMTok + cachedInputTokens * p.cachedInUsdPerMTok + outputTokens * p.outUsdPerMTok) / 1e6
}
