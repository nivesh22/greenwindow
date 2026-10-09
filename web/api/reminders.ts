// POST /api/reminders: the plan panel's "Remind me" button (J6). send_at = start - lead_min. Signed-in only.
// 409 push_needed without a push subscription; 400 for starts in the past or more than 48 h ahead.
// A reminder that would already be due (start closer than lead_min) is sent at the next cron tick.
import { reminderRequestSchema, reminderResponseSchema } from '../agent/harness/api_schemas.js'
import { HOUR_MS, formatHour, toIso } from '../src/lib/time.js'
import { readBody } from './_lib/deps.js'
import { errorBody, json } from './_lib/http.js'
import { lazyP4, methodNotAllowed, requireSignedIn, storeUnavailable, type P4Deps } from './_lib/p4.js'

export const maxDuration = 15

export const MAX_AHEAD_MS = 48 * HOUR_MS

export function createRemindersHandler(deps: P4Deps): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== 'POST') return methodNotAllowed('POST')
    const auth = await requireSignedIn(request, deps)
    if (auth instanceof Response) return auth
    const body = await readBody(request, reminderRequestSchema)
    if (body instanceof Response) return body
    const nowMs = deps.now()
    const startMs = Date.parse(body.start_utc)
    if (!Number.isFinite(startMs) || startMs <= nowMs) return json(400, errorBody('start_in_past', 'That start time has already passed.'))
    if (startMs > nowMs + MAX_AHEAD_MS) {
      return json(400, errorBody('start_too_far', 'Reminders can be set up to 48 hours ahead, which is as far as the forecast reaches.'))
    }
    try {
      const subs = await deps.plans.listPushSubscriptions(auth.userId)
      if (subs.length === 0) return json(409, errorBody('push_needed', 'Turn on notifications on this device first.'))
      const sendAtUtc = toIso(Math.max(startMs - body.lead_min * 60_000, nowMs))
      const startUtc = toIso(startMs)
      // A repeated click with the same time and label returns the reminder that already exists.
      const dup = (await deps.plans.listReminders(auth.userId, { pendingOnly: true })).find(
        (r) => r.planId === null && r.sendAtUtc === sendAtUtc && r.payload.startUtc === startUtc,
      )
      const reminder =
        dup ??
        (await deps.plans.addReminder({
          userId: auth.userId,
          planId: null,
          sendAtUtc,
          payload: { title: 'Time to run your job', body: `${body.label}: the best window starts at ${formatHour(startUtc)}.`, url: '/scheduler', startUtc },
        }))
      return json(200, reminderResponseSchema.parse({ ok: true, reminder_id: reminder.id, send_at_utc: reminder.sendAtUtc }))
    } catch {
      return storeUnavailable()
    }
  }
}

export default lazyP4(createRemindersHandler)
