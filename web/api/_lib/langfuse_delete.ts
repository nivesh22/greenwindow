// Best-effort removal of a user's Langfuse traces for POST /api/me/delete (FR-7.4, FR-8.4).
// Endpoints verified 2026-10-09 against the Langfuse OpenAPI spec (https://cloud.langfuse.com/generated/api/openapi.yml,
// the source of https://api.reference.langfuse.com), auth = HTTP Basic (public key : secret key):
//   List: GET /api/public/v2/observations?userId=<id>&isRootObservation=true&fromStartTime=<ISO>&toStartTime=<ISO>
//         &limit=<=1000&cursor=<opaque>  -> {data:[{id, traceId, ...}], meta:{cursor?}}
//         (the older GET /api/public/traces?userId= is marked deprecated, removal on Cloud 2026-11-16, so it is not used)
//   Delete: DELETE /api/public/traces  body {"traceIds": string[]}  -> 200 {message}
// Our traces carry userId because the exporter sets it with propagateAttributes (telemetry/langfuse.ts).
// Deletion in Langfuse is asynchronous. Failures are swallowed by the caller: the account deletion must not depend on this.
import { z } from 'zod'

export interface LangfuseDeleteEnv {
  LANGFUSE_PUBLIC_KEY?: string
  LANGFUSE_SECRET_KEY?: string
  LANGFUSE_BASE_URL?: string
}

const listSchema = z.object({
  data: z.array(z.object({ traceId: z.string().nullable() })),
  meta: z.object({ cursor: z.string().nullish() }).optional(),
})

const DAY_MS = 86_400_000
const PAGE = 1000
const MAX_PAGES = 5
const DELETE_CHUNK = 100
/** Look-back for the (required-in-practice) start-time bounds; Hobby retention is 30 days, so this is generous. */
const LOOKBACK_DAYS = 120

export interface LangfuseDeleteResult {
  skipped: boolean
  found: number
  deleted: number
}

export async function deleteLangfuseTraces(
  userId: string,
  env: LangfuseDeleteEnv,
  doFetch: typeof fetch,
  nowMs: number,
  timeoutMs = 4000,
): Promise<LangfuseDeleteResult> {
  if (!env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) return { skipped: true, found: 0, deleted: 0 }
  const base = (env.LANGFUSE_BASE_URL ?? 'https://cloud.langfuse.com').replace(/\/+$/, '')
  const authorization = 'Basic ' + btoa(`${env.LANGFUSE_PUBLIC_KEY}:${env.LANGFUSE_SECRET_KEY}`)
  const headers = { authorization, accept: 'application/json' }
  const from = new Date(nowMs - LOOKBACK_DAYS * DAY_MS).toISOString()
  const to = new Date(nowMs + DAY_MS).toISOString()

  const ids = new Set<string>()
  let cursor: string | null = null
  for (let page = 0; page < MAX_PAGES; page++) {
    const qs = new URLSearchParams({ userId, isRootObservation: 'true', fromStartTime: from, toStartTime: to, limit: String(PAGE) })
    if (cursor) qs.set('cursor', cursor)
    const res = await doFetch(`${base}/api/public/v2/observations?${qs}`, { method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) throw new Error(`langfuse list ${res.status}`)
    const parsed = listSchema.parse(await res.json())
    for (const o of parsed.data) if (o.traceId) ids.add(o.traceId)
    cursor = parsed.meta?.cursor ?? null
    if (!cursor) break
  }
  const all = [...ids]
  let deleted = 0
  for (let i = 0; i < all.length; i += DELETE_CHUNK) {
    const chunk = all.slice(i, i + DELETE_CHUNK)
    const res = await doFetch(`${base}/api/public/traces`, {
      method: 'DELETE',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ traceIds: chunk }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) throw new Error(`langfuse delete ${res.status}`)
    deleted += chunk.length
  }
  return { skipped: false, found: all.length, deleted }
}
