// Shared by get_forecast and recommend_window: the selected model's hourly forecast, built the same way
// web/src/pages/Scheduler.tsx builds its HourForecast[] (points with a null q10 or q90 are dropped).
import { forecastModels, pickDefault } from '../../src/data/models'
import { HOUR_MS } from '../../src/lib/time'
import type { HourForecast } from '../../src/scheduler/optimizer'
import { ToolUserError, type ToolCtx } from './registry'

export const STALE_AFTER_MS = 12 * HOUR_MS

export interface LoadedForecast {
  model: string
  runId: string
  issuedAtUtc: string
  stale: boolean
  /** Hours with all three quantiles, in order. NOT filtered to the future: recommend() gets the whole series. */
  hours: HourForecast[]
  neso: { ts: string; q50: number }[] | null
}

export async function loadForecast(ctx: ToolCtx, requestedModel: string | undefined): Promise<LoadedForecast> {
  const [meta, latest] = await Promise.all([ctx.data.meta(), ctx.data.latest()])
  const models = forecastModels(meta.data, latest.data)
  const available = models.map((m) => m.name)
  const model = requestedModel ?? pickDefault(models)
  if (!available.includes(model)) {
    throw new ToolUserError('unknown_model', `Unknown model "${model}". Available models: ${available.join(', ') || 'none'}.`)
  }
  const series = latest.data.series.find((s) => s.model === model)
  const hours: HourForecast[] = (series?.points ?? []).flatMap((p) =>
    p.q10 !== null && p.q90 !== null ? [{ ts: p.ts, q10: p.q10, q50: p.q50, q90: p.q90 }] : [],
  )
  const nesoSeries = latest.data.series.find((s) => s.model === 'neso')
  const generatedMs = Date.parse(meta.data.generated_at_utc)
  return {
    model,
    runId: latest.data.run_id,
    issuedAtUtc: latest.data.issued_at_utc,
    stale: meta.stale || latest.stale || ctx.nowMs - generatedMs > STALE_AFTER_MS,
    hours,
    neso: nesoSeries ? nesoSeries.points.map((p) => ({ ts: p.ts, q50: p.q50 })) : null,
  }
}

/** The current hour start (UTC ms). */
export const floorHour = (ms: number): number => Math.floor(ms / HOUR_MS) * HOUR_MS
/** The next whole hour at or after `ms` (Scheduler.tsx's default earliest start). */
export const ceilHour = (ms: number): number => Math.ceil(ms / HOUR_MS) * HOUR_MS
