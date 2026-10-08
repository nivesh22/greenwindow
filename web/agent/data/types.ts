// Contract (orchestrator-owned): read access to the published JSON files (spec 7.6). Design §7.6.
import type { BacktestSummary, LatestForecast, Leaderboard, Meta, RecentObservations } from '../../src/data/schemas.js'

export interface Fetched<T> {
  data: T
  stale: boolean // true when served from the last good copy after a failed fetch
  fetchedAtMs: number
}

export interface ForecastSource {
  meta(): Promise<Fetched<Meta>>
  latest(): Promise<Fetched<LatestForecast>>
  observations(): Promise<Fetched<RecentObservations>>
  leaderboard(): Promise<Fetched<Leaderboard>>
  backtest(): Promise<Fetched<BacktestSummary>>
}

/** Frozen clock for fixture-based tests and evals: the fixture's issue time + 30 min. */
export const FIXTURE_NOW_UTC = '2026-10-06T00:30:00Z'
