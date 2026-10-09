// Follow-through tools (design §7.4, PRD FR-4.9/4.10, J6): calendar event and push reminder for the last recommendation.
// Neither takes free times or numbers (rule 14): both read ctx.turn.lastRecommendation.
import { z } from 'zod'
import { buildIcs, googleCalendarUrl, type CalendarEvent } from '../../src/lib/calendar.js'
import { fmtMass } from '../../src/lib/format.js'
import { HOUR_MS, formatDateTime, toIso, toMs } from '../../src/lib/time.js'
import { co2Range } from './estimate_co2.js'
import { needPlans } from './plans.js'
import { ToolUserError, defineTool, type ToolCtx } from './registry.js'

function lastRec(ctx: ToolCtx) {
  const last = ctx.turn.lastRecommendation
  if (!last) throw new ToolUserError('no_recommendation', 'No recommendation yet. Call recommend_window first.')
  const startMs = toMs(last.rec.bestStart)
  return { last, startMs, endMs: startMs + last.job.durationH * HOUR_MS }
}

const calendarOut = z.object({
  title: z.string(),
  start_utc: z.string(),
  end_utc: z.string(),
  start_london: z.string(),
  end_london: z.string(),
  ics: z.string(),
  google_url: z.string(),
})
export type CalendarOutput = z.infer<typeof calendarOut>

export const makeCalendarEvent = defineTool({
  name: 'make_calendar_event',
  description:
    'Creates a calendar event (.ics file and Google Calendar link) for the window from the last recommend_window result. Takes no times: ' +
    'pass from "last_recommendation" and optionally a label. Call recommend_window first. The chat shows download/open buttons; just say the event is ready.',
  input: z.strictObject({ from: z.literal('last_recommendation'), label: z.string().trim().min(1).max(80).optional() }),
  output: calendarOut,
  auth: 'anon',
  sideEffect: false,
  emitsAction: true,
  phase: 'P4',
  intents: ['plan_job', 'plan_batch', 'recurring'],
  statusText: 'Preparing the calendar event…',
  async handler(ctx, input) {
    const { last, endMs } = lastRec(ctx)
    const startUtc = last.rec.bestStart
    const endUtc = toIso(endMs)
    const r = co2Range(last.rec)
    const diff = r
      ? r.point === 0
        ? 'Running now is the recommended window, so there is no estimated emissions difference. '
        : `Estimated emissions difference vs running at ${formatDateTime(last.rec.runNowStart)}: about ${fmtMass(r.point)} (range ${fmtMass(r.low)} to ${fmtMass(r.high)}). `
      : ''
    const description =
      `Suggested low-carbon window from GreenWindow (${last.job.durationH} h at ${last.job.powerKw} kW, forecast ${last.model}). ${diff}` +
      'The figure is an estimate using average (not marginal) grid carbon intensity and a forecast, so the actual difference may vary.'
    const ev: CalendarEvent = {
      uid: `${last.runId}-${startUtc}`.replace(/[^A-Za-z0-9-]/g, ''),
      title: (input.label ?? 'Run job (low-carbon window)').slice(0, 120),
      startUtc,
      endUtc,
      description,
    }
    return {
      title: ev.title,
      start_utc: startUtc,
      end_utc: endUtc,
      start_london: formatDateTime(startUtc),
      end_london: formatDateTime(endUtc),
      ics: buildIcs(ev, toIso(ctx.nowMs)),
      google_url: googleCalendarUrl(ev),
    }
  },
})

const reminderOut = z.object({
  status: z.enum(['set', 'push_needed']),
  reminder_id: z.string().nullable(),
  send_at_utc: z.string().nullable(),
  send_at_london: z.string().nullable(),
  start_utc: z.string().nullable(),
  start_london: z.string().nullable(),
  lead_min: z.number().int().nullable(),
  note: z.string(),
})
export type ReminderOutput = z.infer<typeof reminderOut>

export const scheduleReminder = defineTool({
  name: 'schedule_reminder',
  description:
    'Schedules a push notification shortly before the window from the last recommend_window result. Takes no times: pass from "last_recommendation" and optionally ' +
    'lead_min (0-120 minutes before the start, default 10). Needs notifications turned on in the browser: if status is "push_needed", tell the user to turn them on and ask again. ' +
    'Refuses a window that has already started. Only call it when the user asked for a reminder.',
  input: z.strictObject({ from: z.literal('last_recommendation'), lead_min: z.number().int().min(0).max(120).default(10) }),
  output: reminderOut,
  auth: 'user',
  sideEffect: true,
  emitsAction: true,
  phase: 'P4',
  intents: ['plan_job', 'recurring'],
  statusText: 'Setting the reminder…',
  async handler(ctx, input) {
    const { plans, userId } = needPlans(ctx)
    const { last, startMs } = lastRec(ctx)
    if (startMs <= ctx.nowMs) throw new ToolUserError('start_in_past', 'The recommended window has already started, so a reminder is not possible.')
    const subs = await plans.listPushSubscriptions(userId)
    if (subs.length === 0) {
      return {
        status: 'push_needed' as const,
        reminder_id: null,
        send_at_utc: null,
        send_at_london: null,
        start_utc: last.rec.bestStart,
        start_london: formatDateTime(last.rec.bestStart),
        lead_min: null,
        note: 'Notifications are not turned on yet. Ask the user to turn them on, then set the reminder.',
      }
    }
    const sendAtMs = Math.max(startMs - input.lead_min * 60_000, ctx.nowMs)
    const sendAtUtc = toIso(sendAtMs)
    const startLondon = formatDateTime(last.rec.bestStart)
    const rem = await plans.addReminder({
      userId,
      planId: null,
      sendAtUtc,
      payload: {
        title: 'Time to start your job',
        body: `The low-carbon window starts at ${startLondon}.`,
        url: '/scheduler',
        startUtc: last.rec.bestStart,
      },
    })
    return {
      status: 'set' as const,
      reminder_id: rem.id,
      send_at_utc: rem.sendAtUtc,
      send_at_london: formatDateTime(rem.sendAtUtc),
      start_utc: last.rec.bestStart,
      start_london: startLondon,
      lead_min: input.lead_min,
      note: 'The reminder is set. It is sent as a push notification to this browser.',
    }
  },
})
