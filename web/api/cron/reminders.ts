// POST /api/cron/reminders: sends due push reminders. Called every minute by pg_cron (migration 0005) only when
// something is due. Auth: header x-cron-secret == env CRON_SECRET (constant-time compare); 503 if unset, 401 if wrong.
// Push payload (JSON string, read by sw.js): {title, body, url, startUtc} = ReminderPayload.
// Delivery rules: a subscription answering 404/410 is deleted; a reminder whose start has already passed is cancelled
// instead of sent; a reminder with no working subscription is marked failed (no retries: reminders are time-critical).
import type { Reminder } from '../../agent/store/plan_types.js'
import { checkCronSecret } from '../_lib/cron.js'
import { errorBody, json } from '../_lib/http.js'
import { lazyP4, methodNotAllowed, storeUnavailable, type P4Deps } from '../_lib/p4.js'
import { statusOf, type PushSender } from '../_lib/push.js'

export const maxDuration = 60

export const DUE_LIMIT = 100
/** Stop starting new sends after this long; what is left is still pending and goes out on the next minute. */
export const BUDGET_MS = 45_000

export interface ReminderSummary {
  due: number
  sent: number
  failed: number
  cancelled: number
  subscriptionsRemoved: number
  deferred: number
}

export async function processReminders(deps: Pick<P4Deps, 'plans' | 'now'>, send: PushSender): Promise<ReminderSummary> {
  const t0 = deps.now()
  const due: Reminder[] = await deps.plans.dueReminders(t0, DUE_LIMIT)
  const sum: ReminderSummary = { due: due.length, sent: 0, failed: 0, cancelled: 0, subscriptionsRemoved: 0, deferred: 0 }
  for (const r of due) {
    const nowMs = deps.now()
    if (nowMs - t0 > BUDGET_MS) {
      sum.deferred++
      continue
    }
    if (Date.parse(r.payload.startUtc) <= nowMs) {
      await deps.plans.markReminder(r.id, 'cancelled', nowMs)
      sum.cancelled++
      continue
    }
    const subs = await deps.plans.listPushSubscriptions(r.userId)
    const payload = JSON.stringify({ title: r.payload.title, body: r.payload.body, url: r.payload.url, startUtc: r.payload.startUtc })
    let delivered = false
    for (const s of subs) {
      try {
        await send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload)
        delivered = true
      } catch (err) {
        const status = statusOf(err)
        if (status === 404 || status === 410) {
          await deps.plans.deletePushSubscriptionByEndpoint(s.endpoint)
          sum.subscriptionsRemoved++
        }
      }
    }
    await deps.plans.markReminder(r.id, delivered ? 'sent' : 'failed', deps.now())
    if (delivered) sum.sent++
    else sum.failed++
  }
  return sum
}

export function createRemindersCronHandler(deps: P4Deps): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== 'POST') return methodNotAllowed('POST')
    const denied = await checkCronSecret(request, deps.env.CRON_SECRET)
    if (denied) return denied
    if (!deps.push) return json(503, errorBody('not_configured', 'Web Push (VAPID) is not configured.'))
    try {
      return json(200, { ok: true, ...(await processReminders(deps, deps.push)) })
    } catch {
      return storeUnavailable()
    }
  }
}

export default lazyP4(createRemindersCronHandler)
