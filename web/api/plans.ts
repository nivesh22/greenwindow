// GET /api/plans (all of the caller's plans, newest first; ?active=true for active only) and
// DELETE /api/plans?id=<uuid> (cancels the plan and its pending reminders; the row stays as history).
// Signed-in (non-anonymous) users only.
import { z } from 'zod'
import { plansResponseSchema, type PlansResponse } from '../agent/harness/api_schemas.js'
import type { Plan } from '../agent/store/plan_types.js'
import { errorBody, json } from './_lib/http.js'
import { lazyP4, methodNotAllowed, requireSignedIn, storeUnavailable, type P4Deps } from './_lib/p4.js'

export const maxDuration = 15

export function toApiPlan(p: Plan): PlansResponse['plans'][number] {
  return {
    id: p.id,
    label: p.label,
    kind: p.kind,
    job: {
      duration_h: p.job.durationH,
      power_kw: p.job.powerKw,
      mode: p.job.mode,
      earliest_utc: p.job.earliestUtc ?? null,
      deadline_utc: p.job.deadlineUtc ?? null,
    },
    rule: p.rule ? { days: p.rule.days, window_local: p.rule.windowLocal, remind: p.rule.remind } : null,
    next_start_utc: p.nextStartUtc,
    active: p.active,
    created_at_utc: p.createdAtUtc,
  }
}

export function createPlansHandler(deps: P4Deps): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== 'GET' && request.method !== 'DELETE') return methodNotAllowed('GET, DELETE')
    const auth = await requireSignedIn(request, deps)
    if (auth instanceof Response) return auth
    const params = new URL(request.url).searchParams
    try {
      if (request.method === 'GET') {
        const plans = await deps.plans.listPlans(auth.userId, { activeOnly: params.get('active') === 'true' })
        return json(200, plansResponseSchema.parse({ plans: plans.map(toApiPlan) }))
      }
      const id = z.string().uuid().safeParse(params.get('id'))
      if (!id.success) return json(400, errorBody('bad_request', 'Query parameter id must be a plan id.'))
      if (!(await deps.plans.cancelPlan(auth.userId, id.data))) return json(404, errorBody('not_found', 'No such plan.'))
      return json(200, { ok: true })
    } catch {
      return storeUnavailable()
    }
  }
}

export default lazyP4(createPlansHandler)
