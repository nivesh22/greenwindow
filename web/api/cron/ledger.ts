// POST /api/cron/ledger: realizes impact_ledger rows whose window ended at least 2 h ago, using actual grid
// intensity; rows older than 7 days with no actuals get realized = null and a note. Daily 07:00 UTC.
// Auth: header x-cron-secret == env CRON_SECRET (constant-time); 503 if unset, 401 if wrong.
import { checkCronSecret } from '../_lib/cron.js'
import { errorBody, json } from '../_lib/http.js'
import { runLedger } from '../_lib/ledger.js'
import { lazyP4, methodNotAllowed, type P4Deps } from '../_lib/p4.js'

export const maxDuration = 60

export function createLedgerCronHandler(deps: P4Deps): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== 'POST') return methodNotAllowed('POST')
    const denied = await checkCronSecret(request, deps.env.CRON_SECRET)
    if (denied) return denied
    try {
      return json(200, { ok: true, ...(await runLedger(deps)) })
    } catch {
      return json(503, errorBody('upstream_unavailable', 'Could not realize the ledger right now.'))
    }
  }
}

export default lazyP4(createLedgerCronHandler)
