// GET /api/health -> {ok:true}. ?db=1 also reads the cost ledger (Supabase keepalive) and returns
// {ok, db, budget:{month, paused}}. No amounts: this endpoint is public.
// Handler form: Web-standard `export default { fetch(request) }` (docs/spikes.md S2,
// https://vercel.com/docs/functions/runtimes/node-js).
import { loadConfig } from '../agent/config.js'
import { SupabaseStore } from '../agent/store/supabase.js'
import type { Store } from '../agent/store/types.js'
import { json } from './_lib/http.js'

export function createHealthHandler(
  getStore: () => Store | null,
  now: () => number = Date.now,
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== 'GET') return json(405, { error: { code: 'method_not_allowed', message: 'GET only' } })
    if (new URL(request.url).searchParams.get('db') !== '1') return json(200, { ok: true })
    try {
      const store = getStore()
      if (!store) return json(200, { ok: false, db: 'error' })
      const b = await store.budget(now())
      return json(200, { ok: true, db: 'ok', budget: { month: b.month, paused: b.paused } })
    } catch {
      return json(200, { ok: false, db: 'error' })
    }
  }
}

const handler = createHealthHandler(() => {
  const cfg = loadConfig()
  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_SERVICE_ROLE_KEY) return null
  return new SupabaseStore({ url: cfg.SUPABASE_URL, key: cfg.SUPABASE_SERVICE_ROLE_KEY })
})

export default { fetch: handler }
