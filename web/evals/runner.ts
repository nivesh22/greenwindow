// The eval runner (design §15.4, plan X7/X11). Runs scenarios through the real turn runner and tool registry on the
// fixture ForecastSource with a frozen clock. Model and gate calls come from a recording (replay, CI), are recorded
// from real providers (record, orchestrator only), or go to real providers with a spend cap (live).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, type AgentConfig } from '../agent/config.js'
import { FixtureForecastSource } from '../agent/data/forecast_source.js'
import type { ChoiceBackend } from '../agent/gates/types.js'
import { HISTORY_MAX, type ChatRequest, type PlanUpdate, type SseEvent, type TraceSummary } from '../agent/harness/events.js'
import type { ToolResultLike } from '../agent/harness/grounding.js'
import { buildRouter, createTurnRunner, type TurnDeps, defaultChoiceBackend } from '../agent/harness/turn.js'
import { ModelRouter } from '../agent/providers/router.js'
import { MemoryStore } from '../agent/store/types.js'
import { buildRegistry } from '../agent/tools/index.js'
import { ToolRegistry, type ToolCtx, type ToolDef } from '../agent/tools/registry.js'
import { bannedClaimCount, evaluateTurn, optimizerRef, type TurnOutcome } from './assertions.js'
import {
  ReplayChoiceBackend,
  ReplayProvider,
  RecordingChoiceBackend,
  RecordingProvider,
  StaleTracker,
  emptyTurn,
  loadRecording,
  saveRecording,
  STALE_MESSAGE,
} from './recording.js'
import { scenarioSchema, type Recording, type Scenario, type ScenarioResult, type TurnResult } from './schema.js'

const HERE = dirname(fileURLToPath(import.meta.url))
export const EVALS_DIR = HERE
export const SCENARIOS_DIR = join(HERE, 'scenarios')
export const RECORDINGS_DIR = join(HERE, 'recordings')
export const OUT_DIR = join(HERE, 'out')
export const FIXTURE_DIR = resolve(HERE, '../../tests/app_data')

export type EvalMode = 'replay' | 'record' | 'live'

export function parseMode(v: string | undefined): EvalMode {
  if (v === undefined || v === '' || v === 'replay') return 'replay'
  if (v === 'record' || v === 'live') return v
  throw new Error(`EVAL_MODE must be replay, record or live (got "${v}")`)
}

export function loadScenarios(dir: string = SCENARIOS_DIR): Scenario[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => scenarioSchema.parse(JSON.parse(readFileSync(join(dir, f), 'utf8'))))
}

/**
 * The real gate backend (Jev) for record and live modes. The harness adds it with the gates work (P2.5); until
 * then gates run on their rule fallbacks and nothing is recorded for them. Wire it in here once it exists.
 */
export function loadChoiceBackend(config: AgentConfig): ChoiceBackend | null {
  return defaultChoiceBackend(config) // Jev via the gateway when AI_GATEWAY_API_KEY is set (record/live only)
}

export interface SpendCap {
  limitUsd: number
  spentUsd: number
}

export interface RunOptions {
  mode: EvalMode
  recordingsDir?: string
  fixtureDir?: string
  /** Builds the real router for record and live modes (default: buildRouter(loadConfig())). Tests inject a scripted one. */
  makeRouter?: (config: AgentConfig) => ModelRouter
  makeBackend?: (config: AgentConfig) => ChoiceBackend | null
  config?: AgentConfig
  /** Live mode: hard spend cap across the whole suite. */
  spend?: SpendCap
}

interface TurnRun {
  events: SseEvent[]
  toolResults: ToolResultLike[]
  stale: string | null
  recorded: ReturnType<typeof emptyTurn>
}

function wrapRegistry(base: ToolRegistry, log: ToolResultLike[]): ToolRegistry {
  const wrapped: ToolDef[] = base.forIntent(null).map((d) => ({
    ...d,
    handler: async (ctx: ToolCtx, input: unknown) => {
      try {
        const out: unknown = await d.handler(ctx, input)
        log.push({ tool: d.name, ok: true, data: out })
        return out
      } catch (err) {
        log.push({ tool: d.name, ok: false, data: { message: err instanceof Error ? err.message : 'unknown' } })
        throw err
      }
    },
  }))
  return new ToolRegistry(wrapped)
}

async function runTurn(
  scenario: Scenario,
  request: ChatRequest,
  turnIndex: number,
  recording: Recording | null,
  opts: RunOptions,
): Promise<TurnRun> {
  const nowMs = Date.parse(scenario.now_utc)
  const fixtureDir = opts.fixtureDir ?? FIXTURE_DIR
  const stale = new StaleTracker()
  const recorded = emptyTurn()
  const toolResults: ToolResultLike[] = []
  const config = opts.config ?? loadConfig(opts.mode === 'replay' ? {} : process.env)

  let router: ModelRouter
  let backend: ChoiceBackend | null = null
  let replayProvider: ReplayProvider | null = null
  if (opts.mode === 'replay') {
    const turn = recording?.turns[turnIndex]
    const calls = turn?.model_calls ?? []
    replayProvider = new ReplayProvider(calls, stale)
    router = new ModelRouter([{ provider: replayProvider, model: calls[0]?.model ?? 'gemini-3.5-flash' }])
    if (turn && turn.gate_calls.length > 0) backend = new ReplayChoiceBackend(turn.gate_calls, stale)
  } else {
    const real = opts.makeRouter ? opts.makeRouter(config) : buildRouter(config)
    const realBackend = (opts.makeBackend ?? loadChoiceBackend)(config)
    if (opts.mode === 'record') {
      router = new ModelRouter(
        real.entries.map((e) => ({ provider: new RecordingProvider(e.provider, recorded.model_calls), model: e.model })),
        { firstEventTimeoutMs: config.FIRST_TOKEN_TIMEOUT_MS },
      )
      backend = realBackend ? new RecordingChoiceBackend(realBackend, recorded.gate_calls) : null
    } else {
      router = real
      backend = realBackend
    }
  }

  const events: SseEvent[] = []
  const deps: TurnDeps = {
    config,
    store: new MemoryStore(),
    data: new FixtureForecastSource(fixtureDir, () => nowMs),
    registry: wrapRegistry(buildRegistry(), toolResults),
    router,
    now: () => nowMs,
    // The harness-engineer adds `choiceBackend` to TurnDeps; passing it through a spread keeps this compiling both ways.
    ...(backend ? ({ choiceBackend: backend } as object) : {}),
  }
  const run = createTurnRunner(deps)
  await run({ request, ipHash: 'eval', nowMs, messagesLeft: null, signal: new AbortController().signal }, (ev) => events.push(ev))
  if (replayProvider && !stale.problem && replayProvider.consumed < (recording?.turns[turnIndex]?.model_calls.length ?? 0)) {
    stale.mark('the recording has model calls the run did not make')
  }
  return { events, toolResults, stale: stale.problem, recorded }
}

function outcomeOf(run: TurnRun): TurnOutcome | null {
  let answer = ''
  let trace: TraceSummary | null = null
  let stopReason = ''
  let plan: PlanUpdate | null = null
  for (const ev of run.events) {
    if (ev.type === 'answer') answer = ev.data.text
    else if (ev.type === 'plan_update') plan = ev.data
    else if (ev.type === 'done') {
      trace = ev.data.trace
      stopReason = ev.data.stop_reason
    }
  }
  if (!trace) return null
  return { answer, stopReason, trace, planUpdate: plan, toolResults: run.toolResults }
}

export async function runScenario(scenario: Scenario, opts: RunOptions): Promise<ScenarioResult> {
  const base = { id: scenario.id, persona: scenario.persona }
  const dir = opts.recordingsDir ?? RECORDINGS_DIR
  let recording: Recording | null = null
  if (opts.mode === 'replay') {
    recording = loadRecording(dir, scenario.id)
    if (!recording) return { ...base, status: 'skipped', note: 'skipped (no recording)', cost_usd: 0, turns: [] }
    if (recording.turns.length !== scenario.turns.length) {
      return { ...base, status: 'failed', note: `${STALE_MESSAGE} (turn count differs)`, cost_usd: 0, turns: [] }
    }
  }
  const nowMs = Date.parse(scenario.now_utc)
  const refCtx = (): ToolCtx => ({
    userId: null,
    isAnonymous: true,
    nowMs,
    data: new FixtureForecastSource(opts.fixtureDir ?? FIXTURE_DIR, () => nowMs),
    store: new MemoryStore(),
    riskMode: 'expected',
    turn: { lastRecommendation: null },
    signal: new AbortController().signal,
  })
  const ref = optimizerRef(refCtx)

  const history: ChatRequest['history'] = []
  let conversationId: string | null = null
  const turns: TurnResult[] = []
  const recordedTurns: Recording['turns'] = []
  let cost = 0
  let note = ''
  let failed = false

  for (const [i, t] of scenario.turns.entries()) {
    if (opts.mode === 'live' && opts.spend && opts.spend.spentUsd >= opts.spend.limitUsd) {
      return { ...base, status: 'skipped', note: `skipped (EVAL_BUDGET_USD $${opts.spend.limitUsd} reached)`, cost_usd: cost, turns }
    }
    const request: ChatRequest = {
      conversation_id: conversationId,
      message: t.user,
      history: history.slice(-HISTORY_MAX),
      panel_state: scenario.panel_state,
      client_now_utc: scenario.now_utc,
    }
    let run: TurnRun
    try {
      run = await runTurn(scenario, request, i, recording, opts)
    } catch (err) {
      return { ...base, status: 'failed', note: `turn ${i + 1} threw: ${err instanceof Error ? err.message : 'unknown'}`, cost_usd: cost, turns }
    }
    recordedTurns.push(run.recorded)
    const start = run.events.find((e) => e.type === 'turn_start')
    if (start?.type === 'turn_start') conversationId = start.data.conversation_id
    if (run.stale) return { ...base, status: 'failed', note: run.stale, cost_usd: cost, turns }
    const o = outcomeOf(run)
    if (!o) return { ...base, status: 'failed', note: `turn ${i + 1} produced no done event`, cost_usd: cost, turns }

    const turnCost = o.trace.totals.cost_usd
    cost += turnCost
    if (opts.spend) opts.spend.spentUsd += turnCost
    const assertions = await evaluateTurn(t.expect, o, ref)
    const bad = assertions.filter((a) => a.status === 'fail')
    if (bad.length > 0) {
      failed = true
      note ||= `turn ${i + 1}: ${bad.map((a) => `${a.name} (${a.detail})`).join('; ')}`
    }
    turns.push({
      user: t.user,
      answer: o.answer,
      stop_reason: o.stopReason,
      cost_usd: turnCost,
      steps: o.trace.totals.steps,
      tools: o.trace.tools.map((x) => x.name),
      banned_claims: bannedClaimCount(o.answer, o.toolResults),
      assertions,
      trace: o.trace,
    })
    history.push({ role: 'user', content: t.user }, { role: 'assistant', content: o.answer })
  }

  if (opts.mode === 'record') saveRecording(dir, { version: 1, scenario_id: scenario.id, turns: recordedTurns })
  return { ...base, status: failed ? 'failed' : 'passed', note, cost_usd: cost, turns }
}

// ---- Suite, verdict, report ----

export interface SuiteResult {
  mode: EvalMode
  results: ScenarioResult[]
}

export interface Verdict {
  ok: boolean
  reasons: string[]
  passed: number
  failed: number
  skipped: number
  overall: number | null
  windowCorrectness: number | null
  bannedClaims: number
  costUsd: number
}

export const THRESHOLDS = { overall: 0.9, window: 1, banned: 0 } as const

export async function runSuite(scenarios: readonly Scenario[], opts: RunOptions): Promise<SuiteResult> {
  const results: ScenarioResult[] = []
  for (const s of scenarios) results.push(await runScenario(s, opts))
  return { mode: opts.mode, results }
}

export function verdictOf(suite: SuiteResult, opts: { requireRecordings?: boolean } = {}): Verdict {
  const r = suite.results
  const passed = r.filter((x) => x.status === 'passed').length
  const failed = r.filter((x) => x.status === 'failed').length
  const skipped = r.filter((x) => x.status === 'skipped').length
  const ran = passed + failed
  const overall = ran === 0 ? null : passed / ran
  const win = r.flatMap((x) => x.turns.flatMap((t) => t.assertions)).filter((a) => a.name === 'window_equals_optimizer' && a.status !== 'skip')
  const windowCorrectness = win.length === 0 ? null : win.filter((a) => a.status === 'pass').length / win.length
  const bannedClaims = r.reduce((n, x) => n + x.turns.reduce((m, t) => m + t.banned_claims, 0), 0)
  const costUsd = r.reduce((n, x) => n + x.cost_usd, 0)
  const reasons: string[] = []
  if (overall !== null && overall < THRESHOLDS.overall) reasons.push(`overall pass rate ${(overall * 100).toFixed(1)}% < ${THRESHOLDS.overall * 100}%`)
  if (windowCorrectness !== null && windowCorrectness < THRESHOLDS.window) reasons.push(`window correctness ${(windowCorrectness * 100).toFixed(1)}% < 100%`)
  if (bannedClaims > THRESHOLDS.banned) reasons.push(`${bannedClaims} banned claim(s) in answers`)
  if (ran === 0 && opts.requireRecordings) reasons.push('no scenario ran (no recordings) and EVAL_REQUIRE_RECORDINGS is set')
  if (suite.mode === 'live' && r.some((x) => x.note.includes('EVAL_BUDGET_USD'))) reasons.push('live run stopped at EVAL_BUDGET_USD before finishing')
  return { ok: reasons.length === 0, reasons, passed, failed, skipped, overall, windowCorrectness, bannedClaims, costUsd }
}

const pct = (x: number | null): string => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`)

export function markdownSummary(suite: SuiteResult, v: Verdict): string {
  const lines = [
    `# GreenWindow Assistant evals (${suite.mode})`,
    '',
    `Result: **${v.ok ? 'PASS' : 'FAIL'}**${v.reasons.length ? ` — ${v.reasons.join('; ')}` : ''}`,
    '',
    `- Scenarios: ${v.passed} passed, ${v.failed} failed, ${v.skipped} skipped`,
    `- Overall pass rate: ${pct(v.overall)} (threshold ${THRESHOLDS.overall * 100}%)`,
    `- Window correctness: ${pct(v.windowCorrectness)} (threshold 100%)`,
    `- Banned claims: ${v.bannedClaims} (threshold 0)`,
    `- Cost: $${v.costUsd.toFixed(4)}`,
    '',
    '| Scenario | Persona | Status | Note |',
    '|---|---|---|---|',
    ...suite.results.map((x) => `| ${x.id} | ${x.persona} | ${x.status} | ${x.note.replace(/\|/g, '\\|').slice(0, 300)} |`),
    '',
  ]
  const skippedAssertions = suite.results.flatMap((x) => x.turns.flatMap((t) => t.assertions)).filter((a) => a.status === 'skip')
  if (skippedAssertions.length > 0) {
    lines.push(`${skippedAssertions.length} assertion(s) skipped, e.g. "${skippedAssertions[0]?.detail}".`, '')
  }
  return lines.join('\n')
}

export function writeReport(suite: SuiteResult, v: Verdict, dir: string = OUT_DIR): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'results.json'), `${JSON.stringify({ verdict: v, ...suite }, null, 1)}\n`)
  writeFileSync(join(dir, 'summary.md'), markdownSummary(suite, v))
}
