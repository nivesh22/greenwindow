import { z } from 'zod'
import { MODES, type PlanUpdate } from '../harness/events'
import { HOUR_MS, formatDateTime, fromLocalInput, toIso, toMs } from '../../src/lib/time'
import { InfeasibleJobError, InvalidJobError, recommend } from '../../src/scheduler/optimizer'
import { ceilHour, floorHour, loadForecast } from './forecast_hours'
import { ToolUserError, defineTool } from './registry'

const localTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Use YYYY-MM-DDTHH:mm in UK local time')

const outputSchema = z.object({
  best_start_utc: z.string(),
  best_start_london: z.string(),
  run_now_start_utc: z.string(),
  avg_best: z.number(),
  avg_now: z.number(),
  reduction_pct: z.number(),
  energy_kwh: z.number(),
  robust: z.boolean(),
  model: z.string(),
  run_id: z.string(),
  earliest_utc: z.string(),
  deadline_utc: z.string(),
  mode: z.enum(MODES),
  duration_h: z.number().int(),
  power_kw: z.number(),
})
export type RecommendWindowOutput = z.infer<typeof outputSchema>

export const recommendWindow = defineTool({
  name: 'recommend_window',
  description:
    'Finds the start time with the lowest forecast average grid carbon intensity for a flexible job that must finish by a deadline. ' +
    'Times are UK local (Europe/London) as YYYY-MM-DDTHH:mm. Returns the best start, the run-now start, average intensities (gCO2/kWh), ' +
    'the percentage difference, the energy (kWh) and whether the choice is robust to forecast error. Call this before estimate_co2.',
  input: z.strictObject({
    duration_h: z.number().int().min(1).max(12),
    power_kw: z.number().positive().max(10_000),
    earliest_local: localTime.optional().describe('Earliest start; defaults to the next whole hour.'),
    deadline_local: localTime.describe('The job must finish by this time.'),
    mode: z.enum(MODES).optional().describe('expected = median forecast, cautious = plan for a bad case (P90). Omit to use the conversation default.'),
    model: z.string().optional(),
    label: z.string().max(80).optional().describe('Optional name for the job, e.g. "EV charge".'),
  }),
  output: outputSchema,
  auth: 'anon',
  sideEffect: false,
  emitsPlan: true,
  phase: 'P1',
  intents: ['plan_job', 'plan_batch', 'recurring'],
  statusText: 'Finding the best window…',
  async handler(ctx, input) {
    const f = await loadForecast(ctx, input.model)
    const first = f.hours[0]
    const lastHour = f.hours[f.hours.length - 1]
    if (!first || !lastHour) throw new ToolUserError('no_forecast', 'No forecast with uncertainty bands is available right now.')

    // Same rule as Scheduler.tsx: the forecast start, or the next whole hour if that is later.
    const firstMs = Math.max(toMs(first.ts), ceilHour(ctx.nowMs))
    const endMs = toMs(lastHour.ts) + HOUR_MS

    let earliestMs = firstMs
    if (input.earliest_local !== undefined) {
      const e = fromLocalInput(input.earliest_local)
      if (e === null) throw new ToolUserError('bad_time', 'earliest_local is not a valid time.')
      // A start inside the current hour means "now": move it to the next whole hour.
      earliestMs = e >= floorHour(ctx.nowMs) && e < firstMs ? firstMs : e
      if (earliestMs < firstMs) {
        throw new ToolUserError('earliest_in_past', `The earliest start must be ${formatDateTime(toIso(firstMs))} or later.`)
      }
    }
    const d = fromLocalInput(input.deadline_local)
    if (d === null) throw new ToolUserError('bad_time', 'deadline_local is not a valid time.')
    if (d <= earliestMs) throw new ToolUserError('bad_deadline', 'The deadline must be after the earliest start.')
    if (d > endMs) throw new ToolUserError('deadline_too_late', `The forecast ends ${formatDateTime(toIso(endMs))}; pick an earlier deadline.`)

    const mode = input.mode ?? ctx.riskMode
    const job = { durationH: input.duration_h, powerKw: input.power_kw, earliestStart: toIso(earliestMs), deadline: toIso(d) }
    let rec
    try {
      rec = recommend(f.hours, job, mode)
    } catch (e) {
      if (e instanceof InfeasibleJobError || e instanceof InvalidJobError) throw new ToolUserError('infeasible', e.message)
      throw e
    }

    ctx.turn.lastRecommendation = {
      rec,
      job: { durationH: job.durationH, powerKw: job.powerKw, earliestUtc: job.earliestStart, deadlineUtc: job.deadline, mode },
      model: f.model,
      runId: f.runId,
      hours: f.hours,
    }
    return {
      best_start_utc: rec.bestStart,
      best_start_london: formatDateTime(rec.bestStart),
      run_now_start_utc: rec.runNowStart,
      avg_best: rec.avgIntensityBest,
      avg_now: rec.avgIntensityNow,
      reduction_pct: rec.intensityReductionPct,
      energy_kwh: rec.energyKwh,
      robust: rec.robust,
      model: f.model,
      run_id: f.runId,
      earliest_utc: job.earliestStart,
      deadline_utc: job.deadline,
      mode,
      duration_h: job.durationH,
      power_kw: job.powerKw,
    }
  },
})

/** What the loop emits as the `plan_update` SSE event after a successful recommend_window. */
export function toPlanUpdate(o: RecommendWindowOutput): PlanUpdate {
  return {
    duration_h: o.duration_h,
    power_kw: o.power_kw,
    earliest_utc: o.earliest_utc,
    deadline_utc: o.deadline_utc,
    mode: o.mode,
    model: o.model,
    best_start_utc: o.best_start_utc,
    run_id: o.run_id,
  }
}
