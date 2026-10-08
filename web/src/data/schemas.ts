// zod schemas for the public JSON contract (spec 7.6). Must change together with
// src/greenwindow/export/app_json.py and tests/app_data fixtures (AGENTS.md rule 12).
import { z } from 'zod'

export const SUPPORTED_SCHEMA_VERSION = 1

const hourTs = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/, 'hour-beginning UTC timestamp')
const utcTs = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'UTC timestamp')
const num = z.number().finite()
const base = { schema_version: z.number().int(), generated_at_utc: utcTs }

export const modelInfoSchema = z.object({
  name: z.string().min(1),
  label: z.string().min(1),
  family: z.enum(['benchmark', 'classical', 'foundation', 'ensemble']),
  uses_covariates: z.boolean(),
})

export const metaSchema = z.object({
  ...base,
  latest_run_id: z.string(),
  latest_actual_ts_utc: hourTs.nullable(),
  models: z.array(modelInfoSchema),
  attribution: z.array(z.string()),
})

export const forecastPointSchema = z.object({
  ts: hourTs,
  mean: num.nullable(),
  q10: num.nullable(),
  q50: num,
  q90: num.nullable(),
})

export const latestForecastSchema = z
  .object({
    ...base,
    run_id: z.string(),
    issued_at_utc: hourTs,
    horizon: z.number().int().positive(),
    series: z.array(z.object({ model: z.string(), points: z.array(forecastPointSchema) })),
  })
  .refine((d) => d.series.every((s) => s.points.length === d.horizon), {
    message: 'each series must have exactly `horizon` points',
  })

export const recentObservationsSchema = z.object({
  ...base,
  points: z.array(
    z.object({
      ts: hourTs,
      ci_actual: num.nullable(),
      temp_c: num.nullable(),
      wind100: num.nullable(),
      solar_wm2: num.nullable(),
    }),
  ),
})

export const leaderboardSchema = z.object({
  ...base,
  window_days: z.number().int().positive(),
  n_runs: z.number().int().nonnegative(),
  rows: z.array(
    z.object({
      model: z.string(),
      horizon_bucket: z.enum(['1-6', '7-24', '25-48']),
      n_scored: z.number().int().nonnegative(),
      mae: num,
      rmse: num,
      wql: num.nullable(),
      coverage80: num.nullable(),
    }),
  ),
})

export const backtestSummarySchema = z.object({
  ...base,
  origins: z.object({ start: hourTs, end: hourTs, count: z.number().int().positive() }),
  caveat: z.string().min(1),
  rows: z.array(
    z.object({
      model: z.string(),
      horizon_bucket: z.enum(['all', '1-6', '7-24', '25-48']),
      mase: num,
      mae: num,
      wql: num.nullable(),
      coverage80: num.nullable(),
    }),
  ),
  sensitivity: z.array(z.object({ setting: z.string(), value: z.number().int(), model: z.string(), mase: num })),
})

export const FILES = {
  meta: { file: 'meta.json', schema: metaSchema },
  latestForecast: { file: 'latest_forecast.json', schema: latestForecastSchema },
  recentObservations: { file: 'recent_observations.json', schema: recentObservationsSchema },
  leaderboard: { file: 'leaderboard.json', schema: leaderboardSchema },
  // Produced by `make backtest`, committed in web/public and served with the site (spec 7.6).
  backtestSummary: { file: 'backtest_summary.json', schema: backtestSummarySchema, sameOrigin: true },
} as const

export type FileKey = keyof typeof FILES
export type Meta = z.infer<typeof metaSchema>
export type ModelInfo = z.infer<typeof modelInfoSchema>
export type LatestForecast = z.infer<typeof latestForecastSchema>
export type ForecastPoint = z.infer<typeof forecastPointSchema>
export type RecentObservations = z.infer<typeof recentObservationsSchema>
export type Leaderboard = z.infer<typeof leaderboardSchema>
export type BacktestSummary = z.infer<typeof backtestSummarySchema>
export type FileData = { [K in FileKey]: z.infer<(typeof FILES)[K]['schema']> }
