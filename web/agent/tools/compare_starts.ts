// compare_starts: "how much difference if I run it now vs tomorrow?" — the estimated emissions difference between
// specific start times the user names (added 2026-10-09 after owner testing). Same range method and wording as
// estimate_co2: point = E x (avg q50 A - avg q50 B); low/high from the q10/q90 bands.
import { z } from 'zod'
import { fmtMass } from '../../src/lib/format.js'
import { HOUR_MS, formatDateTime, fromLocalInput, toIso } from '../../src/lib/time.js'
import { CO2_WORDING } from './estimate_co2.js'
import { ceilHour, loadForecast } from './forecast_hours.js'
import { ToolUserError, defineTool } from './registry.js'

const localTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'YYYY-MM-DDTHH:mm (Europe/London)')
const r1 = (v: number): number => Math.round(v * 10) / 10

const windowSchema = z.object({
  start_london: z.string(),
  end_london: z.string(),
  avg_q10: z.number(),
  avg_q50: z.number(),
  avg_q90: z.number(),
})

const outputSchema = z.object({
  model: z.string(),
  run_id: z.string(),
  energy_kwh: z.number(),
  baseline: windowSchema,
  others: z.array(
    windowSchema.extend({
      grams_point: z.number(),
      grams_low: z.number(),
      grams_high: z.number(),
      display: z.object({ point: z.string(), low: z.string(), high: z.string() }),
      lower_than_baseline: z.boolean(),
      robust: z.boolean(),
    }),
  ),
  caveat: z.string(),
})

export const compareStarts = defineTool({
  name: 'compare_starts',
  description:
    'Compares specific start times for one job (e.g. "now vs tomorrow 9am"): average forecast intensity of each window and the ' +
    'estimated difference in emissions of each later start versus the FIRST start (baseline), in grams with a low-to-high range. ' +
    'Positive grams = the other start is estimated lower than the baseline. Starts must be whole hours inside the 48-hour forecast. ' +
    'Describe results as an estimated difference with the caveat, never as saved or avoided emissions.',
  input: z.strictObject({
    duration_h: z.number().int().min(1).max(12),
    power_kw: z.number().positive().max(10000),
    starts_local: z.array(localTime).min(2).max(4).describe('Start times, Europe/London; the first is the baseline (use the next whole hour for "now").'),
    model: z.string().optional(),
  }),
  output: outputSchema,
  auth: 'anon',
  sideEffect: false,
  phase: 'P1',
  intents: ['plan_job', 'plan_batch', 'recurring', 'explain_forecast'],
  statusText: 'Comparing start times…',
  async handler(ctx, input) {
    const fc = await loadForecast(ctx, input.model)
    const byTs = new Map(fc.hours.map((h) => [Date.parse(h.ts), h]))
    const nowHour = ceilHour(ctx.nowMs) - HOUR_MS
    const windows = input.starts_local.map((s) => {
      const ms = fromLocalInput(s)
      if (ms === null || ms % HOUR_MS !== 0) throw new ToolUserError('bad_time', `"${s}" is not a whole-hour London time.`)
      if (ms < nowHour) throw new ToolUserError('start_in_past', `${formatDateTime(toIso(ms))} is in the past.`)
      const hours = Array.from({ length: input.duration_h }, (_, i) => byTs.get(ms + i * HOUR_MS))
      if (hours.some((h) => h === undefined)) {
        throw new ToolUserError('outside_forecast', `The window starting ${formatDateTime(toIso(ms))} is not fully inside the 48-hour forecast.`)
      }
      const avg = (k: 'q10' | 'q50' | 'q90') => hours.reduce((a, h) => a + h![k], 0) / hours.length
      return {
        start_london: formatDateTime(toIso(ms)),
        end_london: formatDateTime(toIso(ms + input.duration_h * HOUR_MS)),
        avg_q10: avg('q10'),
        avg_q50: avg('q50'),
        avg_q90: avg('q90'),
      }
    })
    const e = input.duration_h * input.power_kw
    const [base, ...rest] = windows as [(typeof windows)[number], ...typeof windows]
    const round = (w: (typeof windows)[number]) => ({ ...w, avg_q10: r1(w.avg_q10), avg_q50: r1(w.avg_q50), avg_q90: r1(w.avg_q90) })
    return {
      model: fc.model,
      run_id: fc.runId,
      energy_kwh: r1(e),
      baseline: round(base),
      others: rest.map((w) => {
        const point = Math.round(e * (base.avg_q50 - w.avg_q50))
        const low = Math.round(e * (base.avg_q10 - w.avg_q90))
        const high = Math.round(e * (base.avg_q90 - w.avg_q10))
        return {
          ...round(w),
          grams_point: point,
          grams_low: low,
          grams_high: high,
          display: { point: fmtMass(point), low: fmtMass(low), high: fmtMass(high) },
          lower_than_baseline: point > 0,
          robust: low > 0 || high < 0, // the whole range is on one side of zero
        }
      }),
      caveat: CO2_WORDING.caveat,
    }
  },
})
