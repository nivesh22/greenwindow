import { beforeEach, describe, expect, it } from 'vitest'
import { AUTH_CACHE_MS, clearAuthCache, verifyAuth } from './auth.js'

const cfg = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_k' }
const ID = '22222222-2222-4222-8222-222222222222'
const req = (h?: string) => new Request('https://x.test/api/x', { headers: h ? { authorization: h } : {} })

function fakeFetch(status = 200, body: unknown = { id: ID, is_anonymous: true, email: '' }) {
  const calls: { url: string; headers: Record<string, string> }[] = []
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: init?.headers as Record<string, string> })
    return new Response(JSON.stringify(body), { status })
  }) as typeof fetch
  return { f, calls }
}

describe('verifyAuth', () => {
  beforeEach(() => clearAuthCache())

  it('returns null without a bearer token and does not call Supabase', async () => {
    const { f, calls } = fakeFetch()
    expect(await verifyAuth(req(), cfg, f, () => 0)).toBeNull()
    expect(await verifyAuth(req('Basic abc'), cfg, f, () => 0)).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('maps the user and uses the publishable key when given', async () => {
    const { f, calls } = fakeFetch()
    const u = await verifyAuth(req('Bearer tok'), cfg, f, () => 0, 'sb_publishable_p')
    expect(u).toEqual({ userId: ID, isAnonymous: true, email: null })
    expect(calls[0]!.url).toBe('https://x.supabase.co/auth/v1/user')
    expect(calls[0]!.headers).toMatchObject({ apikey: 'sb_publishable_p', authorization: 'Bearer tok' })
  })

  it('falls back to the service key and maps email / non-anonymous', async () => {
    const { f, calls } = fakeFetch(200, { id: ID, is_anonymous: false, email: 'a@b.c' })
    const u = await verifyAuth(req('bearer tok'), cfg, f, () => 0, '')
    expect(u).toEqual({ userId: ID, isAnonymous: false, email: 'a@b.c' })
    expect(calls[0]!.headers.apikey).toBe('sb_secret_k')
  })

  it('caches valid tokens for 60 s only', async () => {
    const { f, calls } = fakeFetch()
    await verifyAuth(req('Bearer tok'), cfg, f, () => 1000, 'p')
    await verifyAuth(req('Bearer tok'), cfg, f, () => 1000 + AUTH_CACHE_MS - 1, 'p')
    expect(calls).toHaveLength(1)
    await verifyAuth(req('Bearer tok'), cfg, f, () => 1000 + AUTH_CACHE_MS, 'p')
    expect(calls).toHaveLength(2)
  })

  it('invalid tokens, bad shapes and network errors give null and are not cached', async () => {
    const bad = fakeFetch(401, { msg: 'invalid' })
    expect(await verifyAuth(req('Bearer t1'), cfg, bad.f, () => 0, 'p')).toBeNull()
    expect(await verifyAuth(req('Bearer t1'), cfg, bad.f, () => 0, 'p')).toBeNull()
    expect(bad.calls).toHaveLength(2)
    expect(await verifyAuth(req('Bearer t2'), cfg, fakeFetch(200, { id: 'not-a-uuid' }).f, () => 0, 'p')).toBeNull()
    expect(await verifyAuth(req('Bearer t3'), cfg, (() => Promise.reject(new Error('x'))) as typeof fetch, () => 0, 'p')).toBeNull()
  })

  it('null when Supabase is not configured', async () => {
    expect(await verifyAuth(req('Bearer t'), {}, fakeFetch().f, () => 0, 'p')).toBeNull()
  })
})
