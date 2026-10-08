import { FixtureForecastSource } from '../data/forecast_source.js'
import type { Fetched, ForecastSource } from '../data/types.js'
import type { Leaderboard } from '../../src/data/schemas.js'
import { compareModels, getBacktest, getLeaderboard } from './insight.js'
import { ToolUserError } from './registry.js'
import { FIXTURE_DIR, makeCtx } from './testing.js'

type Row = Leaderboard['rows'][number]
const row = (model: string, horizon_bucket: Row['horizon_bucket'], mae: number, n_scored = 50): Row => ({
  model,
  horizon_bucket,
  n_scored,
  mae,
  rmse: mae * 1.3,
  wql: 0.04567,
  coverage80: 0.8149,
})

function ctxWithLeaderboard(rows: Row[], stale = false) {
  const inner = new FixtureForecastSource(FIXTURE_DIR)
  const data: ForecastSource = {
    meta: () => inner.meta(),
    latest: () => inner.latest(),
    observations: () => inner.observations(),
    backtest: () => inner.backtest(),
    leaderboard: async (): Promise<Fetched<Leaderboard>> => {
      const f = await inner.leaderboard()
      return { ...f, stale, data: { ...f.data, n_runs: 30, rows } }
    },
  }
  return makeCtx({ data })
}

const ROWS: Row[] = [
  row('snaive_24', '1-6', 20.04),
  row('snaive_168', '1-6', 30),
  row('chronos2_cov', '1-6', 10.06),
  row('sarimax_wx', '1-6', 12),
  row('chronos2_cov', '25-48', 25),
  row('snaive_24', '25-48', 30, 10),
]

describe('get_leaderboard', () => {
  it('handles the empty fixture leaderboard with an early-results note', async () => {
    const out = await getLeaderboard.handler(makeCtx(), {})
    getLeaderboard.output.parse(out)
    expect(out.rows).toEqual([])
    expect(out.note).toMatch(/early/)
  })

  it('filters but always includes benchmark rows, rounded, with labels', async () => {
    const out = await getLeaderboard.handler(ctxWithLeaderboard(ROWS), { model: 'chronos2_cov', horizon_bucket: '1-6' })
    getLeaderboard.output.parse(out)
    expect(out.rows.map((r) => r.model)).toEqual(['chronos2_cov', 'snaive_24', 'snaive_168'])
    expect(out.rows[0]).toMatchObject({ label: 'Chronos-2 + weather', mae: 10.1, wql: 0.046, coverage80_pct: 81, is_benchmark: false })
    expect(out.rows[1]).toMatchObject({ label: 'Seasonal naive (yesterday)', mae: 20, is_benchmark: true })
    expect(out.note).toBeUndefined()
    expect(out.stale).toBe(false)
    expect(out.n_runs).toBe(30)
  })

  it('flags small n_scored and stale data', async () => {
    const out = await getLeaderboard.handler(ctxWithLeaderboard(ROWS, true), { horizon_bucket: '25-48' })
    expect(out.note).toMatch(/fewer than 20/)
    expect(out.stale).toBe(true)
  })

  it('rejects unknown models listing valid ones, and bad input', async () => {
    const err = await getLeaderboard.handler(makeCtx(), { model: 'nope' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ToolUserError)
    expect((err as ToolUserError).message).toContain('chronos2_cov')
    expect(getLeaderboard.input.safeParse({ horizon_bucket: '1-3' }).success).toBe(false)
    expect(getLeaderboard.input.safeParse({ extra: 1 }).success).toBe(false)
  })
})

describe('get_backtest', () => {
  it('returns rows, origins, the verbatim caveat and benchmark rows', async () => {
    const out = await getBacktest.handler(makeCtx(), { model: 'ets' })
    getBacktest.output.parse(out)
    const bt = (await makeCtx().data.backtest()).data
    expect(out.caveat).toBe(bt.caveat)
    expect(out.origins).toEqual(bt.origins)
    expect(new Set(out.rows.map((r) => r.model))).toEqual(new Set(['ets', 'snaive_24', 'snaive_168']))
    expect(out.rows.some((r) => r.horizon_bucket === 'all')).toBe(true)
    expect(out.rows.find((r) => r.model === 'ets' && r.horizon_bucket === '1-6')).toMatchObject({ mase: 0.339, mae: 11.9, coverage80_pct: 79 })
  })

  it('rejects an unknown model', async () => {
    const err = await getBacktest.handler(makeCtx(), { model: 'x' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ToolUserError)
  })
})

describe('compare_models', () => {
  it('ranks by live MAE, marks benchmarks, adds backtest MASE and the gap to the better benchmark', async () => {
    const out = await compareModels.handler(ctxWithLeaderboard(ROWS), { horizon_bucket: '1-6' })
    compareModels.output.parse(out)
    expect(out.ranking.map((r) => r.model)).toEqual(['chronos2_cov', 'sarimax_wx', 'snaive_24', 'snaive_168'])
    expect(out.ranking.map((r) => r.is_benchmark)).toEqual([false, false, true, true])
    expect(out.ranking[0]).toMatchObject({ rank: 1, live_mae: 10.1, backtest_mase: 0.285 })
    expect(out.best_model).toBe('chronos2_cov')
    expect(out.best_benchmark).toBe('snaive_24')
    expect(out.best_vs_benchmark_pct).toBe(50) // (20.04 - 10.06) / 20.04
  })

  it('reports a negative gap when the best model loses to the benchmark', async () => {
    const rows = [row('snaive_24', '7-24', 10), row('chronos2_cov', '7-24', 15)]
    const out = await compareModels.handler(ctxWithLeaderboard(rows), { horizon_bucket: '7-24' })
    expect(out.best_vs_benchmark_pct).toBe(-50)
    expect(out.ranking[0]?.model).toBe('snaive_24')
  })

  it('handles an empty bucket without inventing numbers', async () => {
    const out = await compareModels.handler(makeCtx(), { horizon_bucket: '25-48' })
    expect(out.ranking).toEqual([])
    expect(out.best_vs_benchmark_pct).toBeNull()
    expect(out.note).toMatch(/early/)
  })

  it('needs a valid bucket', () => {
    expect(compareModels.input.safeParse({}).success).toBe(false)
  })

  it('tells the model to cite the benchmark and n, and the MAE unit', () => {
    for (const t of [getLeaderboard, getBacktest, compareModels]) {
      expect(t.description).toMatch(/benchmark/)
      expect(t.description).toMatch(/gCO2\/kWh/)
      expect(t.description).toMatch(/number of scored forecasts \(n\)/)
    }
  })
})
