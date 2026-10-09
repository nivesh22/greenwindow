// Saved plans (design §7.4, PRD FR-4.8, J5): save_recurring_plan, list_plans, cancel_plan. Signed-in users only.
// A recurring plan stores the rule; a slot is promised only when that day's window lies inside the current forecast.
// Beyond it, the daily cron computes the next start once the forecast covers the day (next_start_utc stays null).
import { z } from 'zod'
import { MODES } from '../harness/events.js'
import { HOUR_MS, formatDateTime, fromLocalInput, toIso, toLocalInput, toMs } from '../../src/lib/time.js'
import type { Mode } from '../../src/scheduler/optimizer.js'
import { WEEKDAYS, type PlanStore, type Plan, type Weekday } from '../store/plan_types.js'
import { ceilHour, floorHour, loadForecast, type LoadedForecast } from './forecast_hours.js'
import { runOptimizer } from './job_window.js'
import { ToolUserError, defineTool, type ToolCtx } from './registry.js'

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm, 24-hour, UK local time')

export function needPlans(ctx: ToolCtx): { plans: PlanStore; userId: string } {
  if (!ctx.userId || ctx.isAnonymous) throw new ToolUserError('sign_in_required', 'Sign in to save plans and set reminders.')
  if (!ctx.plans) throw new ToolUserError('not_available', 'Saved plans are not available right now.')
  return { plans: ctx.plans, userId: ctx.userId }
}

const minutes = (hm: string): number => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3))

/** London weekday of a London calendar date 'YYYY-MM-DD'. */
function weekdayOf(date: string): Weekday {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay() // 0 = Sunday
  return WEEKDAYS[(dow + 6) % 7]!
}

interface NextStart {
  startUtc: string | null
  runId: string | null
  note: string | null
}

/**
 * The next matching day's best start, only if that day's whole window lies inside the forecast. Never extrapolates.
 * Window ends are rounded to whole hours (inwards), since the optimizer works on hourly slots.
 */
export function computeNextStart(
  f: LoadedForecast,
  nowMs: number,
  rule: { days: readonly Weekday[]; from: string; to: string },
  job: { durationH: number; powerKw: number },
  mode: Mode,
): NextStart {
  const lastHour = f.hours[f.hours.length - 1]
  const firstHour = f.hours[0]
  const later = 'It is computed each morning once the forecast covers that day.'
  if (!lastHour || !firstHour) return { startUtc: null, runId: null, note: `No forecast is available yet. ${later}` }
  const firstMs = Math.max(toMs(firstHour.ts), ceilHour(nowMs))
  const endMs = toMs(lastHour.ts) + HOUR_MS
  const base = toLocalInput(nowMs).slice(0, 10)
  for (let i = 0; i <= 7; i++) {
    const date = new Date(Date.parse(`${base}T00:00:00Z`) + i * 24 * HOUR_MS).toISOString().slice(0, 10)
    if (!rule.days.includes(weekdayOf(date))) continue
    const wFrom = fromLocalInput(`${date}T${rule.from}`)
    const wTo = fromLocalInput(`${date}T${rule.to}`)
    if (wFrom === null || wTo === null) continue
    const earliest = Math.max(ceilHour(wFrom), firstMs)
    const deadline = floorHour(wTo)
    if (deadline - earliest < job.durationH * HOUR_MS) continue // today's window is already too late
    if (deadline > endMs) {
      return { startUtc: null, runId: null, note: `The next matching day (${formatDateTime(toIso(earliest))}) is beyond the current forecast. ${later}` }
    }
    const rec = runOptimizer(f, { ...job, earliestStart: toIso(earliest), deadline: toIso(deadline) }, mode)
    return { startUtc: rec.bestStart, runId: f.runId, note: null }
  }
  return { startUtc: null, runId: null, note: `No matching day falls inside the next week. ${later}` }
}

const planOut = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(['once', 'recurring']),
  days: z.array(z.enum(WEEKDAYS)),
  window_local: z.string().nullable(),
  duration_h: z.number(),
  power_kw: z.number(),
  mode: z.enum(MODES),
  remind: z.boolean(),
  next_start_utc: z.string().nullable(),
  next_start_london: z.string().nullable(),
})

function describePlan(p: Plan): z.infer<typeof planOut> {
  return {
    id: p.id,
    label: p.label,
    kind: p.kind,
    days: p.rule?.days ?? [],
    window_local: p.rule ? `${p.rule.windowLocal.from}-${p.rule.windowLocal.to}` : null,
    duration_h: p.job.durationH,
    power_kw: p.job.powerKw,
    mode: p.job.mode,
    remind: p.rule?.remind ?? false,
    next_start_utc: p.nextStartUtc,
    next_start_london: p.nextStartUtc ? formatDateTime(p.nextStartUtc) : null,
  }
}

const saveOut = z.object({
  plan: planOut,
  next_start_utc: z.string().nullable(),
  next_start_london: z.string().nullable(),
  next_note: z.string().nullable(),
  push_needed: z.boolean(),
  note: z.string(),
})
export type SaveRecurringOutput = z.infer<typeof saveOut>

export const saveRecurringPlan = defineTool({
  name: 'save_recurring_plan',
  description:
    'Saves a recurring plan for the signed-in user, e.g. "run the dishwasher every Mon-Fri between 09:00 and 17:00". Windows cannot cross midnight. ' +
    'Input: label, days (mon..sun), window_from and window_to (HH:mm UK local, window_to after window_from, wide enough for duration_h), duration_h, power_kw, optional mode, ' +
    'remind (a push reminder before each run) and confirm. Only set confirm=true after the user explicitly agreed to this exact plan. ' +
    'Returns the saved plan and, only when the next matching day lies inside the current forecast, its next best start; otherwise next_start_utc is null and ' +
    'next_note explains it is computed each morning. Never promise a start time beyond the forecast. If push_needed is true, tell the user to turn on notifications.',
  input: z.strictObject({
    label: z.string().trim().min(1).max(80),
    days: z.array(z.enum(WEEKDAYS)).min(1).max(7),
    window_from: hhmm,
    window_to: hhmm,
    duration_h: z.number().int().min(1).max(12),
    power_kw: z.number().positive().max(10_000),
    mode: z.enum(MODES).optional(),
    remind: z.boolean(),
    confirm: z.boolean(),
  }),
  output: saveOut,
  auth: 'user',
  sideEffect: true,
  emitsAction: true,
  phase: 'P4',
  intents: ['recurring'],
  statusText: 'Saving your plan…',
  async handler(ctx, input) {
    const { plans, userId } = needPlans(ctx)
    if (input.confirm !== true) throw new ToolUserError('confirmation_required', 'Ask the user to confirm this plan first.')
    const span = minutes(input.window_to) - minutes(input.window_from)
    if (span <= 0) throw new ToolUserError('bad_window', 'window_to must be later than window_from on the same day; overnight windows are not supported yet.')
    if (span < input.duration_h * 60) throw new ToolUserError('window_too_short', `The window (${span / 60} h) is shorter than the job (${input.duration_h} h).`)
    const days = [...new Set(input.days)]
    const mode = input.mode ?? ctx.riskMode

    const f = await loadForecast(ctx, undefined)
    const next = computeNextStart(f, ctx.nowMs, { days, from: input.window_from, to: input.window_to }, { durationH: input.duration_h, powerKw: input.power_kw }, mode)
    const plan = await plans.createPlan({
      userId,
      label: input.label,
      kind: 'recurring',
      job: { durationH: input.duration_h, powerKw: input.power_kw, mode },
      rule: { days, windowLocal: { from: input.window_from, to: input.window_to }, remind: input.remind },
      nextStartUtc: next.startUtc,
      nextRunId: next.runId,
    })
    const pushNeeded = input.remind && (await plans.listPushSubscriptions(userId)).length === 0
    return {
      plan: describePlan(plan),
      next_start_utc: next.startUtc,
      next_start_london: next.startUtc ? formatDateTime(next.startUtc) : null,
      next_note: next.note,
      push_needed: pushNeeded,
      note: pushNeeded
        ? 'The plan is saved, but reminders need notifications turned on in this browser first.'
        : 'The plan is saved. Start times are re-computed from each new forecast, so they can change.',
    }
  },
})

const listOut = z.object({ count: z.number().int(), plans: z.array(planOut) })

export const listPlansTool = defineTool({
  name: 'list_plans',
  description: "Lists the signed-in user's active saved plans (recurring rules with their next start, if the forecast covers it). Use it before changing or cancelling a plan.",
  input: z.strictObject({}),
  output: listOut,
  auth: 'user',
  sideEffect: false,
  phase: 'P4',
  intents: ['recurring', 'plan_job'],
  statusText: 'Looking up your plans…',
  async handler(ctx) {
    const { plans, userId } = needPlans(ctx)
    const rows = await plans.listPlans(userId, { activeOnly: true })
    return { count: rows.length, plans: rows.map(describePlan) }
  },
})

const cancelOut = z.object({ cancelled: z.literal(true), plan_id: z.string(), note: z.string() })

export const cancelPlan = defineTool({
  name: 'cancel_plan',
  description:
    'Cancels one saved plan (and its pending reminders) by plan_id from list_plans. Only set confirm=true after the user explicitly agreed to cancel that plan.',
  input: z.strictObject({ plan_id: z.string().min(1).max(64), confirm: z.boolean() }),
  output: cancelOut,
  auth: 'user',
  sideEffect: true,
  phase: 'P4',
  intents: ['recurring'],
  statusText: 'Cancelling the plan…',
  async handler(ctx, input) {
    const { plans, userId } = needPlans(ctx)
    if (input.confirm !== true) throw new ToolUserError('confirmation_required', 'Ask the user to confirm cancelling this plan first.')
    const ok = await plans.cancelPlan(userId, input.plan_id)
    if (!ok) throw new ToolUserError('plan_not_found', 'No such plan. Call list_plans to see the saved plans.')
    return { cancelled: true as const, plan_id: input.plan_id, note: 'The plan and its pending reminders are cancelled.' }
  },
})
