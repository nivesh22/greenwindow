// Pure aggregation for GET /api/admin/ops (FR-8.3): raw store rows -> opsResponseSchema. No I/O, no clock reads.
// Spans carry no timestamp in OpsRows, so each span is attributed to the UTC day of its turn.
import type { OpsResponse } from '../../agent/harness/api_schemas.js'
import { PRICES, PRICES_CHECKED } from '../../agent/config.js'
import type { OpsRows } from '../../agent/store/plan_types.js'
import { ATTR } from '../../agent/telemetry/tracer.js'

const DAY_MS = 86_400_000

/**
 * Daily request allowance used for the "free-tier requests vs limit" panel. The Gemini free-tier RPD for our model
 * IDs is not published in a form we could verify (docs/spikes.md open item 4), so this is an estimate that the
 * owner can override (OpsOptions.freeTierRpd) once read from AI Studio.
 */
export const DEFAULT_FREE_TIER_RPD = 250

export interface OpsOptions {
  nowMs: number
  days: number
  budgetLimitUsd: number
  freeTierRpd?: number
  pricesChecked?: string
  /** Free-tier lookup for a model id; defaults to the price table in agent/config.ts. */
  isFreeModel?: (model: string) => boolean
}

const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10)
const round = (n: number, dp: number): number => {
  const f = 10 ** dp
  return Math.round(n * f) / f
}

/** Nearest-rank percentile of an ascending-sorted array (p in (0, 1]); 0 for an empty array. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0
  const rank = Math.max(1, Math.ceil(p * sorted.length))
  return sorted[Math.min(sorted.length, rank) - 1]!
}

/** Bucket index 0..9 for a confidence in [0, 1] ([0.9, 1] is the last bucket); null for a non-finite value. */
export function confidenceBucket(c: unknown): number | null {
  if (typeof c !== 'number' || !Number.isFinite(c)) return null
  return Math.min(9, Math.max(0, Math.floor(c * 10)))
}

const bump = (m: Map<string, number>, k: string, by = 1): void => void m.set(k, (m.get(k) ?? 0) + by)
const toRecord = (m: Map<string, number>): Record<string, number> => Object.fromEntries([...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
const byCountDesc = <T extends { n: number }>(rows: T[], key: (r: T) => string): T[] => rows.sort((a, b) => b.n - a.n || (key(a) < key(b) ? -1 : 1))
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

export function aggregateOps(rows: OpsRows, opts: OpsOptions): OpsResponse {
  const isFree = opts.isFreeModel ?? ((m: string) => PRICES[m]?.free === true)
  const days = Math.min(90, Math.max(1, Math.floor(opts.days)))
  const fromMs = Date.UTC(...ymd(opts.nowMs)) - (days - 1) * DAY_MS

  // Only turns inside the requested window count; spans follow their turn.
  const turns = rows.turns.filter((t) => Date.parse(t.createdAtUtc) >= fromMs)
  const dayOfTurn = new Map(turns.map((t) => [t.id, dayOf(Date.parse(t.createdAtUtc))]))

  // ---- daily
  const daily = new Map<string, { turns: number; cost: number; intents: Map<string, number>; llm: number; free: number }>()
  for (let i = 0; i < days; i++) daily.set(dayOf(fromMs + i * DAY_MS), { turns: 0, cost: 0, intents: new Map(), llm: 0, free: 0 })
  for (const t of turns) {
    const d = daily.get(dayOfTurn.get(t.id)!)
    if (!d) continue
    d.turns++
    d.cost += t.costUsd
    bump(d.intents, t.intent ?? 'none')
  }

  // ---- spans
  const lat = new Map<string, number[]>() // `${kind}\u0000${name}`
  const addLat = (kind: string, name: string, ms: number) => {
    const k = `${kind}\u0000${name}`
    const a = lat.get(k)
    if (a) a.push(ms)
    else lat.set(k, [ms])
  }
  for (const t of turns) addLat('turn', 'turn', t.latencyMs)

  let llmCalls = 0
  let failovers = 0
  const reasons = new Map<string, number>()
  const gates = new Map<string, { n: number; src: Map<string, number>; choice: Map<string, number>; hist: number[] }>()
  const tools = new Map<string, { calls: number; errors: number }>()

  for (const s of rows.spans) {
    const day = dayOfTurn.get(s.turnId)
    if (day === undefined) continue
    addLat(s.kind, s.name, s.durationMs)
    if (s.kind === 'llm') {
      llmCalls++
      const d = daily.get(day)
      if (d) {
        d.llm++
        const model = str(s.attrs[ATTR.requestModel])
        if (model && isFree(model)) d.free++
      }
      if (s.attrs[ATTR.failover] === true) {
        failovers++
        bump(reasons, str(s.attrs[ATTR.failoverReason]) ?? 'unknown')
      }
    } else if (s.kind === 'gate') {
      let g = gates.get(s.name)
      if (!g) {
        g = { n: 0, src: new Map(), choice: new Map(), hist: new Array<number>(10).fill(0) }
        gates.set(s.name, g)
      }
      g.n++
      bump(g.src, str(s.attrs[ATTR.gateSource]) ?? 'unknown')
      bump(g.choice, str(s.attrs[ATTR.gateChoice]) ?? 'unknown')
      const b = confidenceBucket(s.attrs[ATTR.gateConfidence])
      if (b !== null) g.hist[b] = (g.hist[b] ?? 0) + 1
    } else if (s.kind === 'tool') {
      const t = tools.get(s.name) ?? { calls: 0, errors: 0 }
      t.calls++
      if (s.status === 'error') t.errors++
      tools.set(s.name, t)
    }
  }

  const stop = new Map<string, number>()
  for (const t of turns) bump(stop, t.stopReason)

  const KIND_ORDER = ['turn', 'gate', 'llm', 'tool', 'stage'] as const
  const latency = [...lat.entries()]
    .map(([k, v]) => {
      const [kind, name] = k.split('\u0000') as [(typeof KIND_ORDER)[number], string]
      const sorted = [...v].sort((a, b) => a - b)
      return { kind, name, n: sorted.length, p50_ms: round(percentile(sorted, 0.5), 1), p95_ms: round(percentile(sorted, 0.95), 1) }
    })
    .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  return {
    generated_at_utc: iso(opts.nowMs),
    days,
    budget: {
      month: rows.budget.month,
      spent_usd: round(rows.budget.spentUsd, 6),
      eval_spent_usd: round(rows.budget.evalSpentUsd, 6),
      limit_usd: opts.budgetLimitUsd,
      paused: rows.budget.paused,
    },
    daily: [...daily.entries()].map(([day, d]) => ({
      day,
      turns: d.turns,
      cost_usd: round(d.cost, 6),
      by_intent: toRecord(d.intents),
      llm_requests: d.llm,
      free_tier_requests: d.free,
    })),
    free_tier_rpd_estimate: opts.freeTierRpd ?? DEFAULT_FREE_TIER_RPD,
    latency,
    failover: { llm_calls: llmCalls, failovers, reasons: byCountDesc([...reasons.entries()].map(([reason, n]) => ({ reason, n })), (r) => r.reason) },
    gates: [...gates.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([gate, g]) => ({ gate, n: g.n, by_source: toRecord(g.src), by_choice: toRecord(g.choice), confidence_hist: g.hist })),
    tools: [...tools.entries()]
      .map(([tool, t]) => ({ tool, calls: t.calls, errors: t.errors }))
      .sort((a, b) => b.calls - a.calls || (a.tool < b.tool ? -1 : 1)),
    stop_reasons: byCountDesc([...stop.entries()].map(([reason, n]) => ({ reason, n })), (r) => r.reason),
    evals: [...rows.evalRuns]
      .sort((a, b) => Date.parse(a.createdAtUtc) - Date.parse(b.createdAtUtc))
      .map((e) => ({
        created_at_utc: e.createdAtUtc,
        git_sha: e.gitSha,
        mode: e.mode,
        pass_rate: e.passRate,
        window_correctness: e.windowCorrectness,
        banned_claims: e.bannedClaims,
        cost_usd: e.costUsd,
      })),
    thumbs_down: rows.feedback
      .filter((f) => f.rating === -1 && Date.parse(f.createdAtUtc) >= fromMs)
      .sort((a, b) => Date.parse(b.createdAtUtc) - Date.parse(a.createdAtUtc))
      .slice(0, 50)
      .map((f) => ({ turn_id: f.turnId, created_at_utc: f.createdAtUtc, comment: f.comment })),
    prices_checked: opts.pricesChecked ?? PRICES_CHECKED,
  }
}

function ymd(ms: number): [number, number, number] {
  const d = new Date(ms)
  return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()]
}
