// Impact-ledger realization (design §9, FR-4.12), run daily by /api/cron/ledger. The arithmetic is the same as the
// lazy path in tools/memory.ts get_impact (energy x (actual run-now average - actual chosen-window average)).
// Keep the two in step: memory.ts keeps its helper private (not in this agent's paths), so it is restated here.
import type { ForecastSource } from '../../agent/data/types.js'
import type { LedgerStore, PendingImpact } from '../../agent/store/supabase_plans.js'
import { HOUR_MS } from '../../src/lib/time.js'

export const SETTLE_MS = 2 * HOUR_MS
export const ACTUALS_WINDOW_MS = 7 * 24 * HOUR_MS
export const NO_ACTUALS_NOTE = 'no actuals after 7 days'
const BATCH = 500

/** Mean of ci_actual over `durationH` hours from `startMs`; null unless every hour has an actual. */
export function avgActual(byTs: Map<number, number | null>, startMs: number, durationH: number): number | null {
  const n = Math.max(1, Math.ceil(durationH))
  let sum = 0
  for (let i = 0; i < n; i++) {
    const v = byTs.get(startMs + i * HOUR_MS)
    if (v === null || v === undefined) return null
    sum += v
  }
  return sum / n
}

export type Realization = { kind: 'realized'; grams: number } | { kind: 'unavailable' } | { kind: 'pending' }

/** Pure: what to do with one pending row at `nowMs`. */
export function realize(row: PendingImpact, byTs: Map<number, number | null>, nowMs: number): Realization {
  const endMs = Date.parse(row.windowStartUtc) + row.durationH * HOUR_MS
  if (endMs + SETTLE_MS > nowMs) return { kind: 'pending' }
  const chosen = avgActual(byTs, Date.parse(row.windowStartUtc), row.durationH)
  const runNow = avgActual(byTs, Date.parse(row.runNowStartUtc), row.durationH)
  if (chosen !== null && runNow !== null) return { kind: 'realized', grams: Math.round(row.energyKwh * (runNow - chosen)) }
  return nowMs - endMs > ACTUALS_WINDOW_MS ? { kind: 'unavailable' } : { kind: 'pending' }
}

export interface LedgerSummary {
  checked: number
  realized: number
  unavailable: number
  pending: number
  errors: number
}

export async function runLedger(deps: { ledger: LedgerStore; data: ForecastSource; now: () => number }): Promise<LedgerSummary> {
  const nowMs = deps.now()
  // A window must have ended >= SETTLE_MS ago, and lasts at least one hour: so it started at least 3 h ago.
  const rows = await deps.ledger.pendingImpact(nowMs - SETTLE_MS - HOUR_MS, BATCH)
  const sum: LedgerSummary = { checked: rows.length, realized: 0, unavailable: 0, pending: 0, errors: 0 }
  if (rows.length === 0) return sum
  const obs = await deps.data.observations()
  const byTs = new Map(obs.data.points.map((p) => [Date.parse(p.ts), p.ci_actual]))
  for (const row of rows) {
    const r = realize(row, byTs, nowMs)
    try {
      if (r.kind === 'realized') {
        await deps.ledger.setRealized(row.userId, row.id, r.grams, null, nowMs)
        sum.realized++
      } else if (r.kind === 'unavailable') {
        await deps.ledger.setRealized(row.userId, row.id, null, NO_ACTUALS_NOTE, nowMs)
        sum.unavailable++
      } else sum.pending++
    } catch {
      sum.errors++
    }
  }
  return sum
}
