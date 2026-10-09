// GET /api/admin/ops?days=14: every panel of the Ops page (FR-8.3). Admins only (rows in `admins`); others get 403.
import { z } from 'zod'
import { opsResponseSchema } from '../../agent/harness/api_schemas.js'
import { errorBody, json } from '../_lib/http.js'
import { aggregateOps } from '../_lib/ops_aggregate.js'
import { lazyP4, methodNotAllowed, requireAdmin, storeUnavailable, type P4Deps } from '../_lib/p4.js'

export const maxDuration = 30

const DAY_MS = 86_400_000
const daysParam = z.coerce.number().int().min(1).max(90)

export function createOpsHandler(deps: P4Deps): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== 'GET') return methodNotAllowed('GET')
    const auth = await requireAdmin(request, deps)
    if (auth instanceof Response) return auth
    const raw = new URL(request.url).searchParams.get('days')
    const days = daysParam.safeParse(raw ?? 14)
    if (!days.success) return json(400, errorBody('bad_request', 'days must be a whole number from 1 to 90.'))
    const nowMs = deps.now()
    try {
      // Whole UTC days: the first day of the window starts at 00:00 UTC.
      const startOfToday = Math.floor(nowMs / DAY_MS) * DAY_MS
      const rows = await deps.ops.opsRows(startOfToday - (days.data - 1) * DAY_MS)
      const body = aggregateOps(rows, { nowMs, days: days.data, budgetLimitUsd: deps.config.MONTHLY_BUDGET_USD })
      return json(200, opsResponseSchema.parse(body))
    } catch {
      return storeUnavailable()
    }
  }
}

export default lazyP4(createOpsHandler)
