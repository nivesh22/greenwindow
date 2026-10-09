// Shared by recommend_window and plan_batch: turns UK-local earliest/deadline strings into a validated UTC window
// inside the forecast, and runs the unchanged optimizer. One copy means a batch job is planned exactly like a single one.
import { HOUR_MS, formatDateTime, fromLocalInput, toIso, toMs } from '../../src/lib/time.js'
import { InfeasibleJobError, InvalidJobError, recommend, type Mode, type Recommendation } from '../../src/scheduler/optimizer.js'
import { ceilHour, floorHour, type LoadedForecast } from './forecast_hours.js'
import { ToolUserError } from './registry.js'

export function resolveWindow(
  f: LoadedForecast,
  nowMs: number,
  earliestLocal: string | undefined,
  deadlineLocal: string,
): { earliestMs: number; deadlineMs: number } {
  const first = f.hours[0]
  const lastHour = f.hours[f.hours.length - 1]
  if (!first || !lastHour) throw new ToolUserError('no_forecast', 'No forecast with uncertainty bands is available right now.')

  // Same rule as Scheduler.tsx: the forecast start, or the next whole hour if that is later.
  const firstMs = Math.max(toMs(first.ts), ceilHour(nowMs))
  const endMs = toMs(lastHour.ts) + HOUR_MS

  let earliestMs = firstMs
  if (earliestLocal !== undefined) {
    const e = fromLocalInput(earliestLocal)
    if (e === null) throw new ToolUserError('bad_time', 'earliest_local is not a valid time.')
    // A start inside the current hour means "now": move it to the next whole hour.
    earliestMs = e >= floorHour(nowMs) && e < firstMs ? firstMs : e
    if (earliestMs < firstMs) {
      throw new ToolUserError('earliest_in_past', `The earliest start must be ${formatDateTime(toIso(firstMs))} or later.`)
    }
  }
  const d = fromLocalInput(deadlineLocal)
  if (d === null) throw new ToolUserError('bad_time', 'deadline_local is not a valid time.')
  if (d <= earliestMs) throw new ToolUserError('bad_deadline', 'The deadline must be after the earliest start.')
  if (d > endMs) throw new ToolUserError('deadline_too_late', `The forecast ends ${formatDateTime(toIso(endMs))}; pick an earlier deadline.`)
  return { earliestMs, deadlineMs: d }
}

export function runOptimizer(
  f: LoadedForecast,
  job: { durationH: number; powerKw: number; earliestStart: string; deadline: string },
  mode: Mode,
): Recommendation {
  try {
    return recommend(f.hours, job, mode)
  } catch (e) {
    if (e instanceof InfeasibleJobError || e instanceof InvalidJobError) throw new ToolUserError('infeasible', e.message)
    throw e
  }
}
