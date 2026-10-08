// One chat turn end to end (design §4, P1a: no gates yet). Builds context, runs the loop, sends the buffered
// answer (plan X4), then persists the turn, its spans and its cost.
import type { AgentConfig } from '../config.js'
import type { ForecastSource } from '../data/types.js'
import { PROMPT_VERSION, SYSTEM_PROMPT } from '../prompts/system.js'
import { OpenAICompatProvider } from '../providers/openai_compat.js'
import { ModelRouter, type RouteEntry } from '../providers/router.js'
import type { ModelProvider, Msg } from '../providers/types.js'
import type { Store } from '../store/types.js'
import { Tracer } from '../telemetry/tracer.js'
import { toPlanUpdate } from '../tools/index.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { RecommendWindowOutput } from '../tools/recommend_window.js'
import { formatDateTime, toIso } from '../../src/lib/time.js'
import { Budget } from './budget.js'
import type { ChatRequest, SseEvent, StopReason } from './events.js'
import { runLoop } from './loop.js'

export interface TurnDeps {
  config: AgentConfig
  store: Store
  data: ForecastSource
  registry: ToolRegistry
  router: ModelRouter
  now?: () => number
  newId?: () => string
}

export interface TurnInput {
  request: ChatRequest
  ipHash: string
  nowMs: number
  signal: AbortSignal
}

/** Builds the failover chain from MODEL_ROUTE. Entries whose provider has no key are skipped. */
export function buildRouter(config: AgentConfig): ModelRouter {
  const providers: Partial<Record<'gemini-direct' | 'ai-gateway', ModelProvider>> = {}
  if (config.GEMINI_API_KEY) {
    providers['gemini-direct'] = new OpenAICompatProvider({ id: 'gemini-direct', baseUrl: config.GEMINI_BASE_URL, apiKey: config.GEMINI_API_KEY })
  }
  if (config.AI_GATEWAY_API_KEY) {
    providers['ai-gateway'] = new OpenAICompatProvider({ id: 'ai-gateway', baseUrl: config.GATEWAY_BASE_URL, apiKey: config.AI_GATEWAY_API_KEY })
  }
  const entries: RouteEntry[] = []
  for (const r of config.MODEL_ROUTE) {
    const provider = providers[r.provider]
    if (provider) entries.push({ provider, model: r.model })
  }
  return new ModelRouter(entries, { firstEventTimeoutMs: config.FIRST_TOKEN_TIMEOUT_MS })
}

const STOP_MESSAGES: Partial<Record<StopReason, string>> = {
  provider_down: 'The assistant is unavailable right now. The planner form on this page still works.',
  tool_error: 'Something went wrong while planning that. Please rephrase, or use the planner form on this page.',
  wall_clock: 'That took too long, so I stopped. Please try again, or use the planner form on this page.',
  cost_budget: 'I stopped to stay within my budget for one message. Please try a simpler question.',
  token_budget: 'I stopped to stay within my budget for one message. Please try a simpler question.',
  max_steps: 'I could not finish that in the steps I am allowed. Please try a simpler question.',
}

/** Facts the model needs and must not guess: the clock, the forecast run and freshness, and the scope. */
async function factsBlock(data: ForecastSource, nowMs: number, panel: ChatRequest['panel_state']): Promise<string> {
  const lines = [`Now: ${toIso(nowMs)} UTC (${formatDateTime(toIso(nowMs))} in London).`]
  try {
    const [meta, latest] = await Promise.all([data.meta(), data.latest()])
    const ageH = (nowMs - Date.parse(latest.data.issued_at_utc)) / 3_600_000
    lines.push(
      `Latest forecast run ${latest.data.run_id}, issued ${latest.data.issued_at_utc} (${ageH.toFixed(1)} h ago), ` +
        `covering ${latest.data.horizon} hours.${latest.stale || meta.stale ? ' The forecast data may be stale.' : ''}`,
    )
  } catch {
    lines.push('The forecast could not be loaded right now; tools may fail. Say so if they do.')
  }
  lines.push('Scope: Great Britain national average, 48-hour horizon, jobs of 1 to 12 whole hours.')
  if (panel) lines.push(`Planner panel (JSON, may have been edited by the user): ${JSON.stringify(panel)}`)
  return lines.join('\n')
}

export function createTurnRunner(deps: TurnDeps): (input: TurnInput, emit: (ev: SseEvent) => void) => Promise<void> {
  const now = deps.now ?? Date.now
  const newId = deps.newId ?? (() => crypto.randomUUID())
  const { config, store, data, registry, router } = deps

  return async ({ request, ipHash, nowMs, signal }, emit) => {
    const turnId = newId()
    const conversationId = request.conversation_id ?? newId()
    emit({ type: 'turn_start', data: { turn_id: turnId, conversation_id: conversationId, messages_left: null } })

    const tracer = new Tracer({ turnId, now, newId })
    const budget = new Budget(
      {
        maxSteps: config.MAX_STEPS,
        maxInputTokens: config.MAX_INPUT_TOKENS,
        maxOutputTokens: config.MAX_OUTPUT_TOKENS,
        maxCostUsd: config.MAX_TURN_COST_USD,
        wallMs: config.TURN_WALL_MS,
      },
      { now, parentSignal: signal },
    )
    const facts = await factsBlock(data, nowMs, request.panel_state)
    const messages: Msg[] = [
      { role: 'system', content: `${SYSTEM_PROMPT}\n\nFacts:\n${facts}` },
      ...request.history.map((h) => ({ role: h.role, content: h.content })),
      { role: 'user', content: request.message },
    ]

    const result = await runLoop(messages, {
      router,
      registry,
      tools: registry.forIntent(null),
      ctx: {
        userId: null,
        isAnonymous: true,
        nowMs,
        data,
        store,
        riskMode: request.panel_state?.mode ?? 'expected',
        turn: { lastRecommendation: null },
        signal: budget.signal,
      },
      budget,
      tracer,
      emit,
      toolTimeoutMs: config.TOOL_TIMEOUT_MS,
      temperature: 0,
      toPlanUpdate: (name, output) => (name === 'recommend_window' ? toPlanUpdate(output as RecommendWindowOutput) : null),
      now,
    })

    // X4: the answer is sent once. P1b adds the grounding check here, before sending.
    const text = result.stopReason === 'final' && result.text.trim().length > 0
      ? result.text.trim()
      : [result.text.trim(), STOP_MESSAGES[result.stopReason] ?? STOP_MESSAGES.tool_error].filter(Boolean).join('\n\n')
    emit({ type: 'answer', data: { text } })
    const trace = tracer.summary({ promptVersion: PROMPT_VERSION, steps: result.steps })
    emit({ type: 'done', data: { turn_id: turnId, stop_reason: result.stopReason, trace } })

    // Persist after `done` so the user is not kept waiting; failures are logged, never shown.
    try {
      await store.saveTurn(
        {
          id: turnId,
          conversationId,
          userId: null,
          ipHash,
          intent: null,
          stopReason: result.stopReason,
          promptVersion: PROMPT_VERSION,
          modelFinal: trace.llm_calls.at(-1)?.model ?? null,
          tokensIn: trace.totals.tokens_in,
          tokensOut: trace.totals.tokens_out,
          costUsd: trace.totals.cost_usd,
          latencyMs: Math.round(trace.totals.ms),
          createdAtUtc: toIso(nowMs),
        },
        tracer.records(),
      )
      if (trace.totals.cost_usd > 0) await store.addSpend(nowMs, trace.totals.cost_usd, config.MONTHLY_BUDGET_USD)
    } catch (err) {
      console.error('turn persist failed', turnId, err instanceof Error ? err.message : 'unknown')
    }
  }
}
