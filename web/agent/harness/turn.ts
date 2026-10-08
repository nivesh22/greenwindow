// One chat turn end to end (design §4). Stage 4 gates (guard_in ∥ router), stage 5 gates for plan intents
// (ask_or_act ∥ risk_mode), the loop, the deterministic grounding gate on the buffered answer (plan X4, design §6.4),
// then guard_out (stage 7). The answer is sent once, then the turn, its spans and its cost are persisted.
import { z } from 'zod'
import type { AgentConfig } from '../config.js'
import type { ForecastSource } from '../data/types.js'
import { decideOne, decidePair, type GateEnv } from '../gates/gate.js'
import { guardInSpec } from '../gates/guard_in.js'
import { guardOutInstruction, guardOutSpec, outputJevState } from '../gates/guard_out.js'
import { inputJevState, type InputState } from '../gates/input.js'
import { JevBackend } from '../gates/jev.js'
import { askOrActSpec, planJevState, planState, riskModeSpec, type AskOrActChoice as AskChoice } from '../gates/plan_gates.js'
import { isPlanIntent, routerSpec } from '../gates/router_gate.js'
import type { ChoiceBackend, GateDecision, Intent } from '../gates/types.js'
import { PROMPT_VERSION, SYSTEM_PROMPT } from '../prompts/system.js'
import { ASK_TEMPLATES, askInstruction, REFUSAL, SCOPE_REPLY, smalltalkReply } from '../prompts/templates.js'
import { CircuitBreaker } from '../providers/breaker.js'
import { OpenAICompatProvider } from '../providers/openai_compat.js'
import { ModelRouter, type RouteEntry } from '../providers/router.js'
import type { ModelProvider, Msg } from '../providers/types.js'
import type { Store } from '../store/types.js'
import { ATTR, Tracer } from '../telemetry/tracer.js'
import { CO2_WORDING } from '../tools/estimate_co2.js'
import { toPlanUpdate } from '../tools/index.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { RecommendWindowOutput } from '../tools/recommend_window.js'
import { formatDateTime, toIso } from '../../src/lib/time.js'
import { Budget } from './budget.js'
import type { ChatRequest, SseEvent, StopReason } from './events.js'
import { checkGrounding, regenerateInstruction, type ToolResultLike, type Violation } from './grounding.js'
import { runLoop, type LoopOptions, type LoopResult } from './loop.js'

export interface TurnDeps {
  config: AgentConfig
  store: Store
  data: ForecastSource
  registry: ToolRegistry
  router: ModelRouter
  /**
   * Backend for the decision gates. Omitted: Jev via the gateway when AI_GATEWAY_API_KEY is set, else null.
   * null: rules only. Evals inject a replay/fake backend here.
   */
  choiceBackend?: ChoiceBackend | null
  now?: () => number
  newId?: () => string
}

/** Jev through the AI Gateway when its key is configured, else null (the gates use their rules). */
export function defaultChoiceBackend(config: AgentConfig): ChoiceBackend | null {
  if (!config.AI_GATEWAY_API_KEY) return null
  return new JevBackend({ apiKey: config.AI_GATEWAY_API_KEY, url: config.JEV_URL, model: config.JEV_MODEL, timeoutMs: config.GATE_TIMEOUT_MS })
}

export interface TurnInput {
  request: ChatRequest
  ipHash: string
  nowMs: number
  /** From the limit check (null while anonymous limits are IP-only). */
  messagesLeft?: number | null
  signal: AbortSignal
}

/** One breaker per process (Fluid instance), shared by every turn's router (design §5.4). */
export const SHARED_BREAKER = new CircuitBreaker()

/** Builds the failover chain from MODEL_ROUTE. Entries whose provider has no key are skipped. */
export function buildRouter(config: AgentConfig, breaker: CircuitBreaker = SHARED_BREAKER): ModelRouter {
  const providers: Partial<Record<'gemini-direct' | 'ai-gateway', ModelProvider>> = {}
  if (config.GEMINI_API_KEY) {
    providers['gemini-direct'] = new OpenAICompatProvider({
      id: 'gemini-direct',
      baseUrl: config.GEMINI_BASE_URL,
      apiKey: config.GEMINI_API_KEY,
      extraBody: config.GEMINI_REASONING_EFFORT === 'off' ? undefined : { reasoning_effort: config.GEMINI_REASONING_EFFORT },
    })
  }
  if (config.AI_GATEWAY_API_KEY) {
    providers['ai-gateway'] = new OpenAICompatProvider({ id: 'ai-gateway', baseUrl: config.GATEWAY_BASE_URL, apiKey: config.AI_GATEWAY_API_KEY })
  }
  const entries: RouteEntry[] = []
  for (const r of config.MODEL_ROUTE) {
    const provider = providers[r.provider]
    if (provider) entries.push({ provider, model: r.model })
  }
  return new ModelRouter(entries, { firstEventTimeoutMs: config.FIRST_TOKEN_TIMEOUT_MS, hooks: breaker })
}

export const STOP_MESSAGES: Partial<Record<StopReason, string>> = {
  provider_down: 'The assistant is unavailable right now. The planner form on this page still works.',
  tool_error: 'Something went wrong while planning that. Please rephrase, or use the planner form on this page.',
  wall_clock: 'That took too long, so I stopped. Please try again, or use the planner form on this page.',
  cost_budget: 'I stopped to stay within my budget for one message. Please try a simpler question.',
  token_budget: 'I stopped to stay within my budget for one message. Please try a simpler question.',
  max_steps: 'I could not finish that in the steps I am allowed. Please try a simpler question.',
}
const GENERIC_STOP = STOP_MESSAGES.tool_error ?? ''

export const NO_RELIABLE_ANSWER = "I couldn't produce a reliable answer; the planner form below shows the same numbers."

const toolMessageSchema = z.object({ tool: z.string(), ok: z.boolean(), data: z.unknown().optional(), error: z.unknown().optional() })

/** The turn's tool results, from the loop's tool messages (JSON {"tool","ok","data"|"error"}, see toolMessageContent). */
export function collectToolResults(messages: readonly Msg[]): ToolResultLike[] {
  const out: ToolResultLike[] = []
  for (const m of messages) {
    if (m.role !== 'tool') continue
    let raw: unknown
    try {
      raw = JSON.parse(m.content)
    } catch {
      continue
    }
    const p = toolMessageSchema.safeParse(raw)
    if (p.success) out.push({ tool: p.data.tool, ok: p.data.ok, data: p.data.ok ? p.data.data : p.data.error })
  }
  return out
}

const recSchema = z.object({ best_start_london: z.string(), robust: z.boolean() })
const co2Schema = z.object({ display: z.object({ point: z.string(), low: z.string(), high: z.string() }) })

function lastOk<T>(results: readonly ToolResultLike[], tool: string, schema: z.ZodType<T>): T | null {
  for (let i = results.length - 1; i >= 0; i--) {
    const r = results[i]
    if (r?.ok && r.tool === tool) {
      const p = schema.safeParse(r.data)
      if (p.success) return p.data
    }
  }
  return null
}

/** Fallback answer built only from the last recommend_window and estimate_co2 outputs (no model text). */
export function templatedAnswer(results: readonly ToolResultLike[]): string {
  const rec = lastOk(results, 'recommend_window', recSchema)
  if (!rec) return NO_RELIABLE_ANSWER
  const parts = [
    `The best time to start is ${rec.best_start_london}.`,
    rec.robust ? 'This recommendation is robust to forecast error.' : 'This recommendation is not robust to forecast error.',
  ]
  const co2 = lastOk(results, 'estimate_co2', co2Schema)
  if (co2) {
    parts.push(
      `The estimated difference in emissions compared with starting now is ${co2.display.point} (range ${co2.display.low} to ${co2.display.high}).`,
      CO2_WORDING.caveat,
    )
  }
  return parts.join(' ')
}

export type GroundingChoice = 'pass' | 'regenerated' | 'templated'

export interface GroundedAnswer {
  text: string
  stopReason: StopReason
  /** null: there was no model text to check, so no gate span was recorded. */
  choice: GroundingChoice | null
}

/**
 * The grounding gate (design §6.4, X4). A final answer that fails gets one rewrite with toolChoice 'none' through the
 * same router and budget; if that fails too (or cannot run), a templated answer replaces it and the stop becomes
 * guard_blocked. Partial text of a non-final stop is kept only when grounded (the stop reason is unchanged).
 * Records a `grounding` gate span, which shows in done.trace.gates.
 */
export async function groundAnswer(
  result: LoopResult,
  opts: {
    loop: LoopOptions
    userTexts: readonly string[]
    tracer: Tracer
    now: () => number
    /** Replaces templatedAnswer() and the guard_blocked stop (e.g. the ask path's fixed question). */
    fallback?: { text: string; stopReason: StopReason }
  },
): Promise<GroundedAnswer> {
  const { tracer, now } = opts
  const toolResults = collectToolResults(result.messages)
  const check = (text: string) => checkGrounding({ text, toolResults, userTexts: opts.userTexts })
  const started = now()
  const record = (choice: GroundingChoice, violations: Violation[], retry: Violation[] | null): void => {
    const durationMs = Math.max(0, now() - started)
    opts.loop.emit({ type: 'gate', data: { gate: 'grounding', choice, confidence: 1, source: 'rules', latency_ms: durationMs } })
    tracer.addSpan({
      kind: 'gate',
      name: 'grounding',
      parentId: opts.loop.parentSpanId ?? null,
      startedAtMs: started,
      durationMs,
      status: choice === 'templated' ? 'error' : 'ok',
      attrs: {
        [ATTR.gateChoice]: choice,
        [ATTR.gateSource]: 'rules',
        [ATTR.gateConfidence]: 1,
        'gw.gate.violations': violations,
        ...(retry ? { 'gw.gate.violations_retry': retry } : {}),
      },
    })
  }
  const draft = result.text.trim()

  if (result.stopReason !== 'final') {
    const stopMsg = STOP_MESSAGES[result.stopReason] ?? GENERIC_STOP
    if (draft === '') return { text: stopMsg, stopReason: result.stopReason, choice: null }
    const c = check(draft)
    const choice: GroundingChoice = c.ok ? 'pass' : 'templated'
    record(choice, c.violations, null)
    return { text: c.ok ? `${draft}\n\n${stopMsg}` : stopMsg, stopReason: result.stopReason, choice }
  }
  if (draft === '') return { text: GENERIC_STOP, stopReason: 'final', choice: null }

  const first = check(draft)
  if (first.ok) {
    record('pass', [], null)
    return { text: draft, stopReason: 'final', choice: 'pass' }
  }

  let retry: Violation[] = []
  try {
    const regen = await runLoop([...result.messages, { role: 'user', content: regenerateInstruction(first.violations) }], {
      ...opts.loop,
      toolChoice: 'none',
    })
    const text = regen.text.trim()
    if (regen.stopReason === 'final' && text !== '') {
      const second = check(text)
      if (second.ok) {
        record('regenerated', first.violations, [])
        return { text, stopReason: 'final', choice: 'regenerated' }
      }
      retry = second.violations
    }
  } catch (err) {
    console.error('grounding rewrite failed', err instanceof Error ? err.message : 'unknown')
  }
  record('templated', first.violations, retry)
  const fb = opts.fallback ?? { text: templatedAnswer(toolResults), stopReason: 'guard_blocked' as const }
  return { text: fb.text, stopReason: fb.stopReason, choice: 'templated' }
}

/**
 * Stage 7 (design §6.2): guard_out over a grounded final answer. A non-pass (the gate already applied its
 * confidence threshold) regenerates once, unless grounding already used the one rewrite; the rewrite must pass
 * grounding and guard_out again, else the templated answer replaces it (stop guard_blocked).
 */
export async function guardOutStage(
  result: LoopResult,
  answer: GroundedAnswer,
  opts: { loop: LoopOptions; userTexts: readonly string[]; env: GateEnv; threshold: number; record: (d: GateDecision<string>) => void },
): Promise<GroundedAnswer> {
  if (answer.stopReason !== 'final' || (answer.choice !== 'pass' && answer.choice !== 'regenerated')) return answer
  const toolResults = collectToolResults(result.messages)
  const spec = guardOutSpec(opts.threshold)
  const judge = async (text: string) => {
    const d = await decideOne(opts.env, spec, { text, toolResults }, outputJevState({ text, toolResults }), opts.loop.budget.signal)
    opts.record(d)
    return d
  }
  const templated = (): GroundedAnswer => ({ text: templatedAnswer(toolResults), stopReason: 'guard_blocked', choice: 'templated' })

  const first = await judge(answer.text)
  if (first.choice === 'pass') return answer
  if (answer.choice === 'regenerated') return templated()
  try {
    const regen = await runLoop([...result.messages, { role: 'user', content: guardOutInstruction(first.choice) }], { ...opts.loop, toolChoice: 'none' })
    const text = regen.text.trim()
    if (regen.stopReason === 'final' && text !== '' && checkGrounding({ text, toolResults, userTexts: opts.userTexts }).ok) {
      const second = await judge(text)
      if (second.choice === 'pass') return { text, stopReason: 'final', choice: 'regenerated' }
    }
  } catch (err) {
    console.error('guard_out rewrite failed', err instanceof Error ? err.message : 'unknown')
  }
  return templated()
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
  const backend = deps.choiceBackend === undefined ? defaultChoiceBackend(config) : deps.choiceBackend

  return async (input, emit) => {
    const { request, ipHash, nowMs, signal } = input
    const turnId = newId()
    const conversationId = request.conversation_id ?? newId()
    emit({ type: 'turn_start', data: { turn_id: turnId, conversation_id: conversationId, messages_left: input.messagesLeft ?? null } })

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
    let intent: Intent | null = null

    const finishTurn = async (text: string, stopReason: StopReason): Promise<void> => {
      budget.dispose()
      emit({ type: 'answer', data: { text } })
      const trace = tracer.summary({ promptVersion: PROMPT_VERSION, steps: budget.steps })
      emit({ type: 'done', data: { turn_id: turnId, stop_reason: stopReason, trace } })

      // Persist after `done` so the user is not kept waiting; failures are logged, never shown.
      try {
        await store.saveTurn(
          {
            id: turnId,
            conversationId,
            userId: null,
            ipHash,
            intent,
            stopReason,
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

    /** One gate decision: a live `gate` event, a `gate` span (FR-3.6) and its cost on the turn budget. */
    const recordGate = (d: GateDecision<string>, options: readonly string[]): void => {
      const end = now()
      tracer.addSpan({
        kind: 'gate',
        name: d.gate,
        startedAtMs: end - d.latencyMs,
        durationMs: d.latencyMs,
        status: 'ok',
        costUsd: d.costUsd,
        attrs: {
          [ATTR.gateChoice]: d.choice,
          [ATTR.gateConfidence]: d.confidence,
          [ATTR.gateSource]: d.source,
          [ATTR.costUsd]: d.costUsd,
          'gw.gate.probabilities': d.probabilities,
          'gw.gate.options': options,
          ...(d.reason ? { 'gw.gate.reason': d.reason } : {}),
        },
      })
      budget.chargeUsd(d.costUsd)
      emit({ type: 'gate', data: { gate: d.gate, choice: d.choice, confidence: Math.min(1, Math.max(0, d.confidence)), source: d.source, latency_ms: d.latencyMs } })
    }
    const gateEnv: GateEnv = { backend, now }
    const history = request.history.map((h) => ({ role: h.role, content: h.content }))

    // Stage 4 (guard_in ∥ router, one backend call) runs alongside loading the facts.
    const inState: InputState = { message: request.message, history, panel: request.panel_state }
    const stage4 = config.GATES_ENABLED
      ? decidePair(gateEnv, guardInSpec(config.GATE_GUARD_IN_MIN), routerSpec(config.GATE_ROUTER_MIN), inState, inputJevState(inState), budget.signal)
      : null
    const [facts, gates4] = await Promise.all([factsBlock(data, nowMs, request.panel_state), stage4])

    let riskMode = request.panel_state?.mode ?? 'expected'
    let ask: Exclude<AskChoice, 'act'> | null = null
    if (gates4) {
      const [guard, route] = gates4
      recordGate(guard, Object.keys(guardInSpec(0).options))
      recordGate(route, Object.keys(routerSpec(0).options))
      intent = route.choice
      if (guard.choice === 'injection' || guard.choice === 'abuse') return finishTurn(REFUSAL, 'guard_blocked')
      if (guard.choice === 'off_topic' || route.choice === 'off_topic') return finishTurn(SCOPE_REPLY, 'final')
      if (route.choice === 'smalltalk') return finishTurn(smalltalkReply(request.message), 'final')

      // Stage 5 (plan intents): ask_or_act ∥ risk_mode, one backend call.
      if (isPlanIntent(route.choice)) {
        const ps = planState(route.choice, request.message, history, request.panel_state)
        const [aoa, risk] = await decidePair(gateEnv, askOrActSpec(config.GATE_ASK_OR_ACT_MIN), riskModeSpec(config.GATE_RISK_MODE_MIN), ps, planJevState(ps), budget.signal)
        recordGate(aoa, Object.keys(askOrActSpec(0).options))
        recordGate(risk, Object.keys(riskModeSpec(0).options))
        riskMode = risk.choice
        if (aoa.choice !== 'act') ask = aoa.choice
      }
    }

    const instruction = ask
      ? askInstruction(ask)
      : intent && isPlanIntent(intent)
        ? `Risk mode for this plan: ${riskMode} (from the user's wording or their default). Do not pass "mode" to recommend_window unless the user explicitly asks for a mode.`
        : null
    const messages: Msg[] = [
      { role: 'system', content: `${SYSTEM_PROMPT}\n\nFacts:\n${facts}${instruction ? `\n\n${instruction}` : ''}` },
      ...history,
      { role: 'user', content: request.message },
    ]

    const loopOpts: LoopOptions = {
      router,
      registry,
      // Ask path: no tools at all (and toolChoice 'none' below), so the model can only ask its one question.
      tools: ask ? [] : registry.forIntent(intent),
      ...(ask ? { toolChoice: 'none' as const } : {}),
      ctx: {
        userId: null,
        isAnonymous: true,
        nowMs,
        data,
        store,
        riskMode,
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
    }
    const result = await runLoop(messages, loopOpts)
    // X4: the answer is sent once, after the grounding gate. Numbers the user wrote are allowed too.
    // Allowed number sources besides this turn's tools: what the user wrote, and earlier answers (each was
    // grounded when sent; a forged history can only affect the sender's own conversation).
    const userTexts = [...request.history.map((h) => h.content), request.message]
    const grounded = await groundAnswer(result, {
      loop: loopOpts,
      userTexts,
      tracer,
      now,
      ...(ask ? { fallback: { text: ASK_TEMPLATES[ask], stopReason: 'final' as const } } : {}),
    })
    // Stage 7: guard_out on answers that went through the plan/explain loop (the ask path has no figures).
    const answer =
      config.GATES_ENABLED && !ask
        ? await guardOutStage(result, grounded, {
            loop: loopOpts,
            userTexts,
            env: gateEnv,
            threshold: config.GATE_GUARD_OUT_MIN,
            record: (d) => recordGate(d, Object.keys(guardOutSpec(0).options)),
          })
        : grounded
    await finishTurn(answer.text, answer.stopReason)
  }
}
