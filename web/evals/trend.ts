// Eval trend rows (PRD FR-9.5): after a record or live run, one `eval_runs` row per suite so the Ops page can chart
// pass rate, window correctness and cost over time. Replay never writes (it is deterministic and runs on every PR).
// Plain fetch to PostgREST with the service key (CI only). The key is never logged.
import { execSync } from 'node:child_process'
import type { EvalRunRow } from '../agent/store/plan_types.js'
import type { SuiteResult, Verdict } from './runner.js'

/** The insert body for public.eval_runs (snake_case columns). */
export interface EvalRunInsert {
  git_sha: string
  mode: 'replay' | 'record' | 'live'
  model: string | null
  prompt_version: string
  scenarios: number
  pass_rate: number
  window_correctness: number
  banned_claims: number
  cost_usd: number
  report: Record<string, unknown>
}

const round = (n: number, dp: number): number => Number(n.toFixed(dp))

/** The most frequent final model across the suite's successful LLM calls; null when nothing ran. */
function dominantModel(suite: SuiteResult): string | null {
  const counts = new Map<string, number>()
  for (const r of suite.results) {
    for (const t of r.turns) {
      for (const c of t.trace?.llm_calls ?? []) if (c.ok) counts.set(c.model, (counts.get(c.model) ?? 0) + 1)
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null
}

function promptVersionOf(suite: SuiteResult): string {
  for (const r of suite.results) for (const t of r.turns) if (t.trace?.prompt_version) return t.trace.prompt_version
  return 'unknown'
}

export function gitShaOf(env: Record<string, string | undefined>): string {
  const fromEnv = env.GITHUB_SHA?.trim()
  if (fromEnv) return fromEnv
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return 'unknown'
  }
}

/**
 * Builds the row, or null when there is nothing to chart (no scenario ran) or the mode is replay.
 * window_correctness is 1 when no window assertion ran (the column is not null); `report.window_assertions` says so.
 */
export function buildEvalRunRow(suite: SuiteResult, v: Verdict, gitSha: string): EvalRunInsert | null {
  if (suite.mode === 'replay' || v.overall === null) return null
  return {
    git_sha: gitSha,
    mode: suite.mode,
    model: dominantModel(suite),
    prompt_version: promptVersionOf(suite),
    scenarios: v.passed + v.failed,
    pass_rate: round(v.overall, 4),
    window_correctness: round(v.windowCorrectness ?? 1, 4),
    banned_claims: v.bannedClaims,
    cost_usd: round(v.costUsd, 6),
    report: {
      ok: v.ok,
      reasons: v.reasons,
      passed: v.passed,
      failed: v.failed,
      skipped: v.skipped,
      window_assertions: v.windowCorrectness === null ? 0 : 'present',
      failures: suite.results.filter((r) => r.status === 'failed').map((r) => ({ id: r.id, note: r.note.slice(0, 300) })),
    },
  }
}

/** The same row in the camelCase PlanStore contract (EvalRunRow), for callers that hold a PlanStore. */
export function toEvalRunRow(r: EvalRunInsert): EvalRunRow {
  return {
    gitSha: r.git_sha,
    mode: r.mode,
    model: r.model,
    promptVersion: r.prompt_version,
    scenarios: r.scenarios,
    passRate: r.pass_rate,
    windowCorrectness: r.window_correctness,
    bannedClaims: r.banned_claims,
    costUsd: r.cost_usd,
    report: r.report,
  }
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number }>

export type TrendOutcome = { written: true } | { written: false; reason: string }

/** Inserts the trend row when the mode and env allow it. Never throws and never prints the key. */
export async function recordEvalTrend(
  suite: SuiteResult,
  v: Verdict,
  env: Record<string, string | undefined>,
  fetchImpl: FetchLike = fetch,
): Promise<TrendOutcome> {
  if (suite.mode === 'replay') return { written: false, reason: 'replay mode never writes trend rows' }
  const url = env.SUPABASE_URL?.trim()
  const key = env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  if (!url || !key) return { written: false, reason: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set' }
  const row = buildEvalRunRow(suite, v, gitShaOf(env))
  if (!row) return { written: false, reason: 'no scenario ran' }
  try {
    const res = await fetchImpl(`${url.replace(/\/+$/, '')}/rest/v1/eval_runs`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(row),
    })
    return res.ok ? { written: true } : { written: false, reason: `PostgREST answered ${res.status}` }
  } catch (err) {
    return { written: false, reason: `request failed: ${err instanceof Error ? err.name : 'error'}` }
  }
}
