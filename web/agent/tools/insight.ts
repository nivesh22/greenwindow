// Insight tools (design §7.3, PRD FR-4.6): live leaderboard, backtest and model comparison. Read-only, from the
// published JSON via ctx.data. The seasonal-naive benchmark rows are always included (CLAUDE.md), negative results
// are reported as they are. Numbers are rounded here so the grounding check can match them in answers:
// gCO2/kWh 1 decimal, MASE and WQL 3 decimals, percentages 0 decimals.
import { z } from 'zod'
import type { BacktestSummary, Leaderboard, Meta } from '../../src/data/schemas.js'
import { STALE_AFTER_MS } from './forecast_hours.js'
import { defineTool, ToolUserError, type ToolCtx } from './registry.js'

export const BENCHMARK_MODELS: readonly string[] = ['snaive_24', 'snaive_168']
export const EARLY_N_SCORED = 20

const bucket = z.enum(['1-6', '7-24', '25-48'])
const BUCKET_ORDER = ['all', '1-6', '7-24', '25-48']

const round = (x: number, d: number): number => Math.round(x * 10 ** d) / 10 ** d
const g = (x: number): number => round(x, 1)
const pct = (x: number | null): number | null => (x === null ? null : round(x * 100, 0))
const q = (x: number | null): number | null => (x === null ? null : round(x, 3))
const isBench = (m: string): boolean => BENCHMARK_MODELS.includes(m)

const UNITS = 'MAE and RMSE are in gCO2/kWh (lower is better). '
const REPORTING =
  'When reporting accuracy ALWAYS mention the seasonal-naive benchmark (snaive_24 "yesterday" / snaive_168 "last week") ' +
  'and the number of scored forecasts (n); if a model does not beat the benchmark, say so plainly. '

function labelOf(meta: Meta, model: string): string {
  return meta.models.find((m) => m.name === model)?.label ?? model
}

function validNames(meta: Meta, lb: Leaderboard, bt: BacktestSummary): string[] {
  const s = new Set<string>([...meta.models.map((m) => m.name), ...lb.rows.map((r) => r.model), ...bt.rows.map((r) => r.model)])
  return [...s].sort()
}

function checkModel(model: string | undefined, names: string[]): void {
  if (model !== undefined && !names.includes(model)) {
    throw new ToolUserError('unknown_model', `Unknown model "${model}". Valid models: ${names.join(', ')}.`)
  }
}

function isStale(ctx: ToolCtx, generatedAtUtc: string, fetchedStale: boolean): boolean {
  return fetchedStale || ctx.nowMs - Date.parse(generatedAtUtc) > STALE_AFTER_MS
}

const bucketIdx = (b: string): number => BUCKET_ORDER.indexOf(b)

const liveRow = z.object({
  model: z.string(),
  label: z.string(),
  is_benchmark: z.boolean(),
  horizon_bucket: bucket,
  n_scored: z.number(),
  mae: z.number(),
  rmse: z.number(),
  wql: z.number().nullable(),
  coverage80_pct: z.number().nullable(),
})

function toLiveRow(meta: Meta, r: Leaderboard['rows'][number]): z.infer<typeof liveRow> {
  return {
    model: r.model,
    label: labelOf(meta, r.model),
    is_benchmark: isBench(r.model),
    horizon_bucket: r.horizon_bucket,
    n_scored: r.n_scored,
    mae: g(r.mae),
    rmse: g(r.rmse),
    wql: q(r.wql),
    coverage80_pct: pct(r.coverage80),
  }
}

export const getLeaderboard = defineTool({
  name: 'get_leaderboard',
  description:
    'Returns the LIVE leaderboard: how each forecasting model has actually scored against observed carbon intensity over the recent window, ' +
    'per horizon bucket (1-6 h, 7-24 h, 25-48 h ahead): n_scored, MAE, RMSE, weighted quantile loss and 80% interval coverage (percent). ' +
    UNITS +
    'The seasonal-naive benchmark rows are always included. ' +
    REPORTING +
    'Check "stale" and "note" (early results can be noisy).',
  input: z.strictObject({
    model: z.string().optional().describe('Model name to focus on; omit for all models.'),
    horizon_bucket: bucket.optional().describe('Only this horizon bucket (hours ahead).'),
  }),
  output: z.object({
    window_days: z.number(),
    n_runs: z.number(),
    generated_at_utc: z.string(),
    stale: z.boolean(),
    unit: z.string(),
    rows: z.array(liveRow),
    note: z.string().optional(),
  }),
  auth: 'anon',
  sideEffect: false,
  phase: 'P2',
  intents: ['model_accuracy', 'explain_forecast'],
  statusText: 'Checking the live scores…',
  async handler(ctx, input) {
    const [meta, lb, bt] = await Promise.all([ctx.data.meta(), ctx.data.leaderboard(), ctx.data.backtest()])
    checkModel(input.model, validNames(meta.data, lb.data, bt.data))
    const rows = lb.data.rows
      .filter((r) => input.horizon_bucket === undefined || r.horizon_bucket === input.horizon_bucket)
      .filter((r) => input.model === undefined || r.model === input.model || isBench(r.model))
      .map((r) => toLiveRow(meta.data, r))
      .sort((a, b) => bucketIdx(a.horizon_bucket) - bucketIdx(b.horizon_bucket) || a.mae - b.mae)
    const notes: string[] = []
    if (rows.length === 0) {
      notes.push('No scored live forecasts match yet: results are early. Do not invent numbers; the backtest may help.')
    } else if (rows.some((r) => r.n_scored < EARLY_N_SCORED)) {
      notes.push(`Some rows have fewer than ${EARLY_N_SCORED} scored forecasts (n_scored): results are early and noisy.`)
    }
    return {
      window_days: lb.data.window_days,
      n_runs: lb.data.n_runs,
      generated_at_utc: lb.data.generated_at_utc,
      stale: isStale(ctx, lb.data.generated_at_utc, lb.stale),
      unit: 'gCO2/kWh',
      rows,
      ...(notes.length ? { note: notes.join(' ') } : {}),
    }
  },
})

const btRow = z.object({
  model: z.string(),
  label: z.string(),
  is_benchmark: z.boolean(),
  horizon_bucket: z.enum(['all', '1-6', '7-24', '25-48']),
  mase: z.number(),
  mae: z.number(),
  wql: z.number().nullable(),
  coverage80_pct: z.number().nullable(),
})

export const getBacktest = defineTool({
  name: 'get_backtest',
  description:
    'Returns the BACKTEST results: each model replayed over past forecast origins, per horizon bucket (and "all"): MASE (lower is better; ' +
    'below 1 beats the in-sample seasonal-naive scale), MAE (gCO2/kWh), weighted quantile loss and 80% coverage (percent), plus the origins ' +
    'range and the file\'s caveat. Backtest weather is optimistic, so the live leaderboard is the unbiased check; quote the caveat when comparing. ' +
    UNITS +
    'The seasonal-naive benchmark rows are always included. ' +
    REPORTING,
  input: z.strictObject({ model: z.string().optional().describe('Model name to focus on; omit for all models.') }),
  output: z.object({
    generated_at_utc: z.string(),
    stale: z.boolean(),
    origins: z.object({ start: z.string(), end: z.string(), count: z.number() }),
    caveat: z.string(),
    unit: z.string(),
    rows: z.array(btRow),
  }),
  auth: 'anon',
  sideEffect: false,
  phase: 'P2',
  intents: ['model_accuracy', 'explain_forecast'],
  statusText: 'Checking the backtest…',
  async handler(ctx, input) {
    const [meta, lb, bt] = await Promise.all([ctx.data.meta(), ctx.data.leaderboard(), ctx.data.backtest()])
    checkModel(input.model, validNames(meta.data, lb.data, bt.data))
    const rows = bt.data.rows
      .filter((r) => input.model === undefined || r.model === input.model || isBench(r.model))
      .map((r) => ({
        model: r.model,
        label: labelOf(meta.data, r.model),
        is_benchmark: isBench(r.model),
        horizon_bucket: r.horizon_bucket,
        mase: round(r.mase, 3),
        mae: g(r.mae),
        wql: q(r.wql),
        coverage80_pct: pct(r.coverage80),
      }))
      .sort((a, b) => bucketIdx(a.horizon_bucket) - bucketIdx(b.horizon_bucket) || a.mase - b.mase)
    return {
      generated_at_utc: bt.data.generated_at_utc,
      stale: isStale(ctx, bt.data.generated_at_utc, bt.stale),
      origins: bt.data.origins,
      caveat: bt.data.caveat,
      unit: 'gCO2/kWh',
      rows,
    }
  },
})

const cmpRow = z.object({
  rank: z.number(),
  model: z.string(),
  label: z.string(),
  is_benchmark: z.boolean(),
  n_scored: z.number(),
  live_mae: z.number(),
  backtest_mase: z.number().nullable(),
})

export const compareModels = defineTool({
  name: 'compare_models',
  description:
    'Ranks models by their LIVE MAE (gCO2/kWh, lower is better) in one horizon bucket, with n_scored and, where available, the backtest MASE ' +
    'for the same bucket. Benchmark rows (seasonal naive) are marked is_benchmark and always included. best_vs_benchmark_pct is how much ' +
    'lower the best non-benchmark model\'s MAE is than the better seasonal-naive row; NEGATIVE means it is worse than the benchmark: report ' +
    'that plainly. ' +
    REPORTING,
  input: z.strictObject({ horizon_bucket: bucket }),
  output: z.object({
    horizon_bucket: bucket,
    window_days: z.number(),
    generated_at_utc: z.string(),
    stale: z.boolean(),
    unit: z.string(),
    ranking: z.array(cmpRow),
    best_model: z.string().nullable(),
    best_benchmark: z.string().nullable(),
    best_vs_benchmark_pct: z.number().nullable(),
    note: z.string().optional(),
  }),
  auth: 'anon',
  sideEffect: false,
  phase: 'P2',
  intents: ['model_accuracy', 'explain_forecast'],
  statusText: 'Comparing the models…',
  async handler(ctx, input) {
    const [meta, lb, bt] = await Promise.all([ctx.data.meta(), ctx.data.leaderboard(), ctx.data.backtest()])
    const inBucket = lb.data.rows.filter((r) => r.horizon_bucket === input.horizon_bucket).sort((a, b) => a.mae - b.mae)
    const ranking = inBucket.map((r, i) => ({
      rank: i + 1,
      model: r.model,
      label: labelOf(meta.data, r.model),
      is_benchmark: isBench(r.model),
      n_scored: r.n_scored,
      live_mae: g(r.mae),
      backtest_mase: q(bt.data.rows.find((b) => b.model === r.model && b.horizon_bucket === input.horizon_bucket)?.mase ?? null),
    }))
    const best = inBucket.find((r) => !isBench(r.model))
    const bench = inBucket.find((r) => isBench(r.model)) // sorted by MAE, so the better benchmark
    const notes: string[] = []
    if (inBucket.length === 0) notes.push('No scored live forecasts in this bucket yet: results are early. Do not invent numbers.')
    else if (!bench) notes.push('No seasonal-naive benchmark row is available in this bucket; say that the comparison lacks a benchmark.')
    if (inBucket.some((r) => r.n_scored < EARLY_N_SCORED)) {
      notes.push(`Some rows have fewer than ${EARLY_N_SCORED} scored forecasts (n_scored): results are early and noisy.`)
    }
    return {
      horizon_bucket: input.horizon_bucket,
      window_days: lb.data.window_days,
      generated_at_utc: lb.data.generated_at_utc,
      stale: isStale(ctx, lb.data.generated_at_utc, lb.stale),
      unit: 'gCO2/kWh',
      ranking,
      best_model: best?.model ?? null,
      best_benchmark: bench?.model ?? null,
      best_vs_benchmark_pct: best && bench && bench.mae > 0 ? round(((bench.mae - best.mae) / bench.mae) * 100, 0) : null,
      ...(notes.length ? { note: notes.join(' ') } : {}),
    }
  },
})
