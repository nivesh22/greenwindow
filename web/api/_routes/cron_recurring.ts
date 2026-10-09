// POST /api/cron/recurring: recomputes the next start of every active recurring plan from the newest forecast and
// queues "start - 10 min" reminders for plans with remind=true. Daily 06:45 UTC (after the 06:17 pipeline run).
// Auth: header x-cron-secret == env CRON_SECRET (constant-time); 503 if unset, 401 if wrong.
import { checkCronSecret } from '../_lib/cron.js'
import { errorBody, json } from '../_lib/http.js'
import { lazyP4, methodNotAllowed, type P4Deps } from '../_lib/p4.js'
import { runRecurring } from '../_lib/recurring.js'

export const maxDuration = 60

export function createRecurringCronHandler(deps: P4Deps): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== 'POST') return methodNotAllowed('POST')
    const denied = await checkCronSecret(request, deps.env.CRON_SECRET)
    if (denied) return denied
    try {
      return json(200, { ok: true, ...(await runRecurring(deps)) })
    } catch {
      // Forecast files or the store were unreachable; the next daily run (or a manual call) tries again.
      return json(503, errorBody('upstream_unavailable', 'Could not compute recurring plans right now.'))
    }
  }
}

export default lazyP4(createRecurringCronHandler)
