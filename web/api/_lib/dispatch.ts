// Vercel Hobby allows 12 Functions per deployment when there is no framework: every file in api/ is one Function,
// test files included (https://vercel.com/docs/functions/runtimes#functions-created-per-deployment, checked
// 2026-10-09). The P4 endpoints therefore share three plain dispatcher Functions — api/user.ts, api/cron.ts,
// api/admin.ts — and the handlers live in api/_routes/ (underscore folders are not deployed). Public URLs are
// unchanged: vercel.json rewrites /api/plans, /api/push/subscribe, /api/reminders, /api/cron/:job and
// /api/admin/:view to /api/<group>?route=<name>. (Rewriting to dynamic [param] files fell through to the SPA
// rewrite on the preview, so the dispatchers are plain files.)

export type Handler = { fetch: (request: Request) => Promise<Response> }

/**
 * The route name for a request, from either the public URL or the rewritten one (Vercel may hand the Function
 * either): '/api/push/subscribe' and '/api/user/push-subscribe' both give 'push-subscribe'.
 */
export function routeName(url: string, group: 'user' | 'cron' | 'admin'): string | null {
  const u0 = new URL(url)
  // Rewritten form: /api/<group>?route=<name> (vercel.json). Vercel may also pass the public path; both work.
  const q = u0.searchParams.get('route')
  if (u0.pathname.replace(/\/+$/, '') === `/api/${group}` && q !== null) return /^[a-z-]+$/.test(q) ? q : null
  const path = u0.pathname.replace(/\/+$/, '')
  const m = path.match(/^\/api\/(.+)$/)
  if (!m) return null
  const rest = m[1]!
  if (group === 'user') {
    const PUBLIC: Record<string, string> = { plans: 'plans', 'push/subscribe': 'push-subscribe', reminders: 'reminders' }
    if (rest in PUBLIC) return PUBLIC[rest]!
    const u = rest.match(/^user\/([a-z-]+)$/)
    return u ? u[1]! : null
  }
  const g = rest.match(new RegExp(`^${group}/([a-z-]+)$`))
  return g ? g[1]! : null
}

/** A Function that forwards to one of `routes` by name; unknown names get a JSON 404. */
export function dispatcher(group: 'user' | 'cron' | 'admin', routes: Record<string, Handler>): Handler {
  return {
    async fetch(request) {
      const name = routeName(request.url, group)
      const h = name !== null && Object.prototype.hasOwnProperty.call(routes, name) ? routes[name] : undefined
      if (!h) {
        return new Response(JSON.stringify({ error: { code: 'not_found', message: 'No such endpoint.' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        })
      }
      return h.fetch(request)
    },
  }
}
