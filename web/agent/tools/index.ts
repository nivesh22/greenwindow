import type { ActionEvent } from '../harness/events.js'
import { compareStarts } from './compare_starts.js'
import { estimateCo2 } from './estimate_co2.js'
import { explainUncertainty } from './explain_uncertainty.js'
import { makeCalendarEvent, scheduleReminder } from './follow_through.js'
import { getForecast } from './get_forecast.js'
import { compareModels, getBacktest, getLeaderboard } from './insight.js'
import { lookupDevice } from './lookup_device.js'
import { getImpact, getProfile, updateProfile } from './memory.js'
import { planBatch } from './plan_batch.js'
import { cancelPlan, listPlansTool, saveRecurringPlan } from './plans.js'
import { recommendWindow } from './recommend_window.js'
import { ToolRegistry, type ToolDef } from './registry.js'

/** All tools (P1, the P2 insight tools, P3 memory, P4 batch/recurring/follow-through). */
export const TOOLS: readonly ToolDef[] = [
  getForecast as unknown as ToolDef,
  recommendWindow as unknown as ToolDef,
  estimateCo2 as unknown as ToolDef,
  explainUncertainty as unknown as ToolDef,
  compareStarts as unknown as ToolDef,
  lookupDevice as unknown as ToolDef,
  getLeaderboard as unknown as ToolDef,
  getBacktest as unknown as ToolDef,
  compareModels as unknown as ToolDef,
  getProfile as unknown as ToolDef,
  updateProfile as unknown as ToolDef,
  getImpact as unknown as ToolDef,
  planBatch as unknown as ToolDef,
  saveRecurringPlan as unknown as ToolDef,
  listPlansTool as unknown as ToolDef,
  cancelPlan as unknown as ToolDef,
  makeCalendarEvent as unknown as ToolDef,
  scheduleReminder as unknown as ToolDef,
]

export function buildRegistry(): ToolRegistry {
  return new ToolRegistry(TOOLS)
}

export { toPlanUpdate } from './recommend_window.js'

/**
 * What the loop emits as the `action` SSE event after a successful tool call with emitsAction (null: nothing to emit).
 * push_needed from schedule_reminder becomes the push_needed action; save_recurring_plan always yields plan_saved
 * (its output carries push_needed for the model to explain).
 */
export function toAction(toolName: string, output: unknown): ActionEvent | null {
  switch (toolName) {
    case 'make_calendar_event': {
      const o = makeCalendarEvent.output.safeParse(output)
      if (!o.success) return null
      const v = o.data
      return { kind: 'calendar', title: v.title, start_utc: v.start_utc, end_utc: v.end_utc, ics: v.ics, google_url: v.google_url }
    }
    case 'schedule_reminder': {
      const o = scheduleReminder.output.safeParse(output)
      if (!o.success) return null
      const v = o.data
      if (v.status === 'push_needed') return { kind: 'push_needed' }
      if (v.reminder_id === null || v.send_at_utc === null || v.start_utc === null) return null
      return { kind: 'reminder_set', reminder_id: v.reminder_id, send_at_utc: v.send_at_utc, start_utc: v.start_utc }
    }
    case 'save_recurring_plan': {
      const o = saveRecurringPlan.output.safeParse(output)
      if (!o.success) return null
      return { kind: 'plan_saved', plan_id: o.data.plan.id, label: o.data.plan.label, recurring: true }
    }
    default:
      return null
  }
}
