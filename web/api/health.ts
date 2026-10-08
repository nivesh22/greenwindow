// GET /api/health -> {ok:true}. ?db=1 also reads the cost ledger (Supabase keepalive).
// Handler form: Web-standard `export default { fetch(request) }` (docs/spikes.md S2,
// https://vercel.com/docs/functions/runtimes/node-js).
import { loadConfig } from '../agent/config'
import { SupabaseStore } from '../agent/store/supabase'
import { json } from './_lib/http'

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'GET') return json(405, { error: { code: 'method_not_allowed', message: 'GET only' } })
    if (new URL(request.url).searchParams.get('db') !== '1') return json(200, { ok: true })
    try {
      const cfg = loadConfig()
      if (!cfg.SUPABASE_URL || !cfg.SUPABASE_SERVICE_ROLE_KEY) return json(200, { ok: false, db: 'error' })
      await new SupabaseStore({ url: cfg.SUPABASE_URL, key: cfg.SUPABASE_SERVICE_ROLE_KEY }).budget(Date.now())
      return json(200, { ok: true, db: 'ok' })
    } catch {
      return json(200, { ok: false, db: 'error' })
    }
  },
}
