// Shared contract fixtures written by the Python exporter (tests/app_data, spec 10.4).
import backtestSummary from '../../../tests/app_data/backtest_summary.json'
import latestForecast from '../../../tests/app_data/latest_forecast.json'
import leaderboard from '../../../tests/app_data/leaderboard.json'
import meta from '../../../tests/app_data/meta.json'
import recentObservations from '../../../tests/app_data/recent_observations.json'

export const FIXTURES: Record<string, unknown> = {
  'meta.json': meta,
  'latest_forecast.json': latestForecast,
  'recent_observations.json': recentObservations,
  'leaderboard.json': leaderboard,
  'backtest_summary.json': backtestSummary,
}

export const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T

/** Stub global fetch to serve fixtures by file name, with optional per-file overrides. */
export function stubFetch(overrides: Record<string, unknown> = {}): void {
  const files = { ...FIXTURES, ...overrides }
  vi.stubGlobal('fetch', async (url: string) => {
    const name = url.split('/').pop() ?? ''
    if (!(name in files)) return new Response('not found', { status: 404 })
    return new Response(JSON.stringify(files[name]), { status: 200 })
  })
}

/** One hour after the fixture run was issued. */
export const FIXTURE_NOW = Date.parse((latestForecast as { issued_at_utc: string }).issued_at_utc) + 3_600_000
