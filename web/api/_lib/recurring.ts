// Recurring plans (design §7.4, §12): for today and tomorrow (Europe/London), on the plan's weekdays, find the best
// start inside the plan's window using the newest forecast. Never schedules a window that ends beyond the forecast.
import type { ForecastSource } from '../../agent/data/types.js'
import type { Plan, PlanStore, Weekday } from '../../agent/store/plan_types.js'
import { MemoryStore } from '../../agent/store/types.js'
import { ceilHour, loadForecast } from '../../agent/tools/forecast_hours.js'
import type { ToolCtx } from '../../agent/tools/registry.js'
import { fromLocalInput, formatHour, HOUR_MS, toIso, toLocalInput } from '../../src/lib/time.js'
import { recommend, type HourForecast } from '../../src/scheduler/optimizer.js'

export const REMINDER_LEAD_MS = 10 * 60_000

const WEEKDAY_BY_UTC_DAY: Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

/** London calendar date 'YYYY-MM-DD' of an instant. */
export const londonDate = (ms: number): string => toLocalInput(ms).slice(0, 10)

/** Calendar arithmetic on a 'YYYY-MM-DD' date (no time zone involved). */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

export function weekdayOf(date: string): Weekday {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  return WEEKDAY_BY_UTC_DAY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]!
}

/**
 * Best start per qualifying day, ascending. A day qualifies when it is one of the plan's weekdays, the window ends in
 * the future and inside the forecast, and the job fits between max(window start, next whole hour) and the window end.
 */
export function computeStarts(plan: Pick<Plan, 'job' | 'rule'>, hours: readonly HourForecast[], nowMs: number): string[] {
  const rule = plan.rule
  if (!rule || hours.length === 0) return []
  const times = hours.map((h) => Date.parse(h.ts))
  const forecastEnd = Math.max(...times) + HOUR_MS
  const today = londonDate(nowMs)
  const out: string[] = []
  for (const date of [today, addDays(today, 1)]) {
    if (!rule.days.includes(weekdayOf(date))) continue
    const fromMs = fromLocalInput(`${date}T${rule.windowLocal.from}`)
    const toMs = fromLocalInput(`${date}T${rule.windowLocal.to}`)
    if (fromMs === null || toMs === null || toMs <= fromMs) continue
    if (toMs <= nowMs || toMs > forecastEnd) continue // finished already, or reaches past the forecast horizon
    const earliest = Math.max(fromMs, ceilHour(nowMs))
    if (earliest + plan.job.durationH * HOUR_MS > toMs) continue
    try {
      const rec = recommend(hours.slice(), { durationH: plan.job.durationH, powerKw: plan.job.powerKw, earliestStart: toIso(earliest), deadline: toIso(toMs) }, plan.job.mode)
      out.push(rec.bestStart)
    } catch {
      // Infeasible or outside the forecast: no start for this day.
    }
  }
  return out.sort()
}

/** Minimal ToolCtx so loadForecast (shared with the chat tools) can be reused outside a turn. */
function forecastCtx(data: ForecastSource, nowMs: number): ToolCtx {
  return {
    userId: null,
    isAnonymous: true,
    nowMs,
    data,
    store: new MemoryStore(),
    riskMode: 'expected',
    turn: { lastRecommendation: null },
    signal: AbortSignal.timeout(30_000),
  }
}

export interface RecurringSummary {
  plans: number
  updated: number
  withStart: number
  remindersAdded: number
  errors: number
  forecastRun: string | null
}

export async function runRecurring(deps: { plans: PlanStore; data: ForecastSource; now: () => number }): Promise<RecurringSummary> {
  const nowMs = deps.now()
  const plans = await deps.plans.activeRecurringPlans()
  const sum: RecurringSummary = { plans: plans.length, updated: 0, withStart: 0, remindersAdded: 0, errors: 0, forecastRun: null }
  if (plans.length === 0) return sum
  const fwd = await loadForecast(forecastCtx(deps.data, nowMs), undefined)
  sum.forecastRun = fwd.runId
  const subsByUser = new Map<string, boolean>()
  for (const plan of plans) {
    try {
      const next = computeStarts(plan, fwd.hours, nowMs)[0] ?? null
      await deps.plans.setNextStart(plan.id, next, next ? fwd.runId : null)
      sum.updated++
      if (next) sum.withStart++
      const sendMs = next ? Date.parse(next) - REMINDER_LEAD_MS : 0
      if (!next || !plan.rule?.remind || fwd.stale || sendMs <= nowMs) continue
      let hasSub = subsByUser.get(plan.userId)
      if (hasSub === undefined) {
        hasSub = (await deps.plans.listPushSubscriptions(plan.userId)).length > 0
        subsByUser.set(plan.userId, hasSub)
      }
      if (!hasSub) continue
      // The forecast can move a day's best start between runs; keep one reminder per plan and London day.
      const pending = await deps.plans.listReminders(plan.userId, { pendingOnly: true })
      const day = londonDate(Date.parse(next))
      if (pending.some((r) => r.planId === plan.id && londonDate(Date.parse(r.payload.startUtc)) === day)) continue
      await deps.plans.addReminder({
        userId: plan.userId,
        planId: plan.id,
        sendAtUtc: toIso(sendMs),
        payload: { title: `Time to run: ${plan.label}`, body: `${plan.label}: the best window starts at ${formatHour(next)}.`, url: '/scheduler', startUtc: next },
      })
      sum.remindersAdded++
    } catch {
      sum.errors++
    }
  }
  return sum
}
