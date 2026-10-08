import { z } from 'zod'
import { forecastModels } from '../../src/data/models.js'
import { HOUR_MS, formatDateTime, toMs } from '../../src/lib/time.js'
import { ToolUserError, defineTool } from './registry.js'

const outputSchema = z.object({
  robust: z.boolean(),
  band_width_best: z.number(),
  band_width_now: z.number(),
  model_spread_best: z.number().nullable(),
  neso_avg_best: z.number().nullable(),
  best_start_london: z.string(),
  plain: z.array(z.string()),
})

const round1 = (x: number): number => Math.round(x * 10) / 10

/** Mean q50 over `n` consecutive hours from `startMs`, or null unless every hour is present. */
function windowMean(points: { ts: string; q50: number }[], startMs: number, n: number): number | null {
  const byTs = new Map(points.map((p) => [toMs(p.ts), p.q50]))
  let sum = 0
  for (let i = 0; i < n; i++) {
    const v = byTs.get(startMs + i * HOUR_MS)
    if (v === undefined) return null
    sum += v
  }
  return sum / n
}

export const explainUncertainty = defineTool({
  name: 'explain_uncertainty',
  description:
    'Explains how certain the forecast is for the last recommend_window result: whether the recommendation is robust, the width of the 10-90% forecast band ' +
    'in the recommended window versus running now (gCO2/kWh), how much the forecast models disagree in that window, and what NESO\'s own forecast says. ' +
    'Call it after recommend_window when the user asks how sure we are, or when the recommendation is not robust. Takes no arguments. ' +
    'Quote only the numbers returned (or the "plain" sentences).',
  input: z.strictObject({}), // no arguments: it always uses this turn's last recommend_window result
  output: outputSchema,
  auth: 'anon',
  sideEffect: false,
  phase: 'P1',
  intents: ['plan_job', 'plan_batch', 'recurring', 'explain_forecast'],
  statusText: 'Checking how certain the forecast is…',
  async handler(ctx) {
    const last = ctx.turn.lastRecommendation
    if (!last) throw new ToolUserError('no_recommendation', 'No recommendation yet. Call recommend_window first.')
    const { rec, job } = last
    const best = rec.candidates.find((c) => c.start === rec.bestStart)
    const now = rec.candidates.find((c) => c.start === rec.runNowStart)
    if (!best || !now) throw new ToolUserError('no_recommendation', 'The last recommendation has no matching candidate windows.')

    const bandBest = round1(best.avgQ90 - best.avgQ10)
    const bandNow = round1(now.avgQ90 - now.avgQ10)
    const startMs = toMs(rec.bestStart)
    const n = job.durationH

    const [meta, latest] = await Promise.all([ctx.data.meta(), ctx.data.latest()])
    const means: number[] = []
    for (const m of forecastModels(meta.data, latest.data)) {
      const series = latest.data.series.find((s) => s.model === m.name)
      // Same rule as forecast_hours.ts: points with a null q10 or q90 are dropped.
      const pts = (series?.points ?? []).filter((p) => p.q10 !== null && p.q90 !== null)
      const mean = windowMean(pts, startMs, n)
      if (mean !== null) means.push(mean)
    }
    const spread = means.length >= 2 ? round1(Math.max(...means) - Math.min(...means)) : null

    const neso = latest.data.series.find((s) => s.model === 'neso')
    const nesoMean = neso ? windowMean(neso.points, startMs, n) : null
    const nesoAvg = nesoMean === null ? null : round1(nesoMean)

    const plain = [
      `The 80% forecast band is about ${bandBest} gCO2/kWh wide in the recommended window versus ${bandNow} now.`,
      rec.robust
        ? 'The recommended window stays cleaner than running now even at the pessimistic end of the band.'
        : 'The bands overlap, so the recommended window is not clearly cleaner than running now.',
    ]
    if (spread !== null) plain.push(`Models disagree by about ${spread} gCO2/kWh in that window.`)
    if (nesoAvg !== null) plain.push(`NESO's own forecast for that window averages ${nesoAvg} gCO2/kWh.`)

    return {
      robust: rec.robust,
      band_width_best: bandBest,
      band_width_now: bandNow,
      model_spread_best: spread,
      neso_avg_best: nesoAvg,
      best_start_london: formatDateTime(rec.bestStart),
      plain,
    }
  },
})
