// Minimal PostgREST client shared by the P4 stores (same header and error rules as supabase.ts / supabase_users.ts).
// Never logs keys, headers or bodies.
import { z } from 'zod'
import { authHeaders, StoreError } from './supabase.js'

export interface PostgrestOptions {
  url: string
  key: string
  fetch?: typeof fetch
  timeoutMs?: number
}

export const q = encodeURIComponent
export const isoFull = (ms: number): string => new Date(ms).toISOString()

/** PostgREST on Supabase caps a response at 1000 rows (db-max-rows); pages are requested at this size. */
export const PAGE_SIZE = 1000

export class PostgrestClient {
  readonly url: string
  private readonly base: string
  private readonly key: string
  private readonly doFetch: typeof fetch
  private readonly timeoutMs: number

  constructor(opts: PostgrestOptions) {
    this.url = opts.url.replace(/\/+$/, '')
    this.base = this.url + '/rest/v1'
    this.key = opts.key
    this.doFetch = opts.fetch ?? ((input, init) => fetch(input, init))
    this.timeoutMs = opts.timeoutMs ?? 8000
  }

  /** Raw request to any path under the project URL (REST, RPC or auth admin). */
  async send(fullUrl: string, method: string, body?: unknown, prefer?: string): Promise<{ status: number; data: unknown }> {
    const headers: Record<string, string> = { ...authHeaders(this.key), accept: 'application/json' }
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (prefer) headers.prefer = prefer
    const label = fullUrl.replace(this.url, '').split('?')[0]
    let res: Response
    try {
      res = await this.doFetch(fullUrl, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs) })
    } catch (e) {
      throw new StoreError('network', `Supabase request failed: ${e instanceof Error ? e.name : 'error'}`)
    }
    if (!res.ok) {
      let detail = ''
      try {
        detail = (await res.text()).slice(0, 200)
      } catch {
        // ignore
      }
      throw new StoreError('http', `Supabase ${method} ${label} returned ${res.status} ${detail}`.trim(), res.status)
    }
    const text = await res.text()
    if (text === '') return { status: res.status, data: null }
    try {
      return { status: res.status, data: JSON.parse(text) }
    } catch {
      throw new StoreError('parse', `Supabase ${label} returned invalid JSON`, res.status)
    }
  }

  async rest(path: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', body?: unknown, prefer?: string): Promise<unknown> {
    return (await this.send(this.base + path, method, body, prefer)).data
  }

  parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
    const r = schema.safeParse(value)
    if (!r.success) throw new StoreError('parse', `Unexpected ${what} response shape`)
    return r.data
  }

  async rows<T>(schema: z.ZodType<T>, path: string, what: string): Promise<T[]> {
    return this.parse(z.array(schema), await this.rest(path, 'GET'), what)
  }

  /** GETs `path` page by page (limit/offset; `path` must carry a deterministic order) up to `maxRows` rows. */
  async pages<T>(schema: z.ZodType<T>, path: string, maxRows: number, what: string): Promise<T[]> {
    const out: T[] = []
    while (out.length < maxRows) {
      const limit = Math.min(PAGE_SIZE, maxRows - out.length)
      const page = await this.rows(schema, `${path}${path.includes('?') ? '&' : '?'}limit=${limit}&offset=${out.length}`, what)
      out.push(...page)
      if (page.length < limit) break
    }
    return out
  }
}
