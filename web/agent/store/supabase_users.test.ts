import { describe, expect, it } from 'vitest'
import { SupabaseUserStore } from './supabase_users.js'

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

function mk(respond: (c: Call) => { status?: number; body?: unknown }) {
  const calls: Call[] = []
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const c: Call = { url: String(input), method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : undefined }
    calls.push(c)
    const r = respond(c)
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status ?? 200 })
  }) as typeof fetch
  const store = new SupabaseUserStore({ url: 'https://x.supabase.co/', key: 'sb_secret_k', fetch: f, newId: () => 'new-id' })
  return { store, calls }
}

const U = '11111111-1111-4111-8111-111111111111'

describe('SupabaseUserStore', () => {
  it('sends apikey only for sb_secret keys and always filters by user_id', async () => {
    const { store, calls } = mk(() => ({ body: [] }))
    expect(await store.getProfile(U)).toBeNull()
    expect(await store.listDevices(U)).toEqual([])
    expect(await store.latestConversation(U)).toBeNull()
    expect(await store.listImpact(U, 5)).toEqual([])
    for (const c of calls) {
      expect(c.url).toContain(`user_id=eq.${U}`)
      expect(c.headers.apikey).toBe('sb_secret_k')
      expect(c.headers.Authorization).toBeUndefined()
    }
  })

  it('maps profile rows (time -> HH:mm) and upserts with merge-duplicates', async () => {
    const row = { user_id: U, display_name: 'N', risk_default: 'cautious', quiet_from: '22:00:00', quiet_to: '07:30:00' }
    const { store, calls } = mk(() => ({ body: [row] }))
    expect(await store.getProfile(U)).toEqual({ userId: U, displayName: 'N', riskDefault: 'cautious', quietFrom: '22:00', quietTo: '07:30' })
    const p = await store.upsertProfile({ userId: U, displayName: 'N', riskDefault: 'cautious', quietFrom: '22:00', quietTo: '07:30' })
    expect(p.quietTo).toBe('07:30')
    const post = calls.at(-1)!
    expect(post.method).toBe('POST')
    expect(post.url).toContain('on_conflict=user_id')
    expect(post.headers.prefer).toContain('merge-duplicates')
    expect(post.body).toMatchObject({ user_id: U, risk_default: 'cautious' })
  })

  it('parse errors surface as StoreError', async () => {
    const { store } = mk(() => ({ body: [{ nope: 1 }] }))
    await expect(store.getProfile(U)).rejects.toMatchObject({ code: 'parse' })
  })

  it('devices: numeric kw as string is coerced; delete is scoped by user and id', async () => {
    const dev = { id: 'd1', user_id: U, name: 'Dishwasher', kw: '1.200', typical_hours: 2, source_device_id: null }
    const { store, calls } = mk(() => ({ body: [dev] }))
    expect((await store.listDevices(U))[0]).toMatchObject({ kw: 1.2, typicalHours: 2 })
    await store.deleteDevice(U, 'd1')
    const del = calls.at(-1)!
    expect(del.method).toBe('DELETE')
    expect(del.url).toContain('id=eq.d1')
    expect(del.url).toContain(`user_id=eq.${U}`)
  })

  it('saveDevice with id patches first, then falls back to upsert by name', async () => {
    const dev = { id: 'd1', user_id: U, name: 'Oven', kw: 2, typical_hours: null, source_device_id: null }
    const { store, calls } = mk((c) => ({ body: c.method === 'PATCH' ? [] : [dev] }))
    const d = await store.saveDevice({ id: 'zzz', userId: U, name: 'Oven', kw: 2, typicalHours: null, sourceDeviceId: null })
    expect(d.id).toBe('d1')
    expect(calls.map((c) => c.method)).toEqual(['PATCH', 'POST'])
    expect(calls[1]!.url).toContain('on_conflict=user_id,name')
  })

  it('ensureConversation never reuses another user\'s id', async () => {
    const other = { id: 'c1', user_id: 'someone-else', title: null, created_at: '2026-10-08T10:00:00+00:00', updated_at: '2026-10-08T10:00:00+00:00' }
    const { store, calls } = mk((c) =>
      c.method === 'GET' ? { body: [other] } : { body: [{ ...other, id: (c.body as { id: string }).id, user_id: U }] },
    )
    const c = await store.ensureConversation(U, 'c1', Date.UTC(2026, 9, 8, 10))
    expect(c.id).toBe('new-id')
    expect(c.userId).toBe(U)
    expect((calls[1]!.body as { user_id: string }).user_id).toBe(U)
  })

  it('loadConversation returns messages oldest first and null for foreign conversations', async () => {
    const conv = { id: 'c1', user_id: U, title: null, created_at: '2026-10-08T10:00:00+00:00', updated_at: '2026-10-08T10:00:00+00:00' }
    const m = (id: string, role: string, t: string) => ({ id, conversation_id: 'c1', role, content: id, turn_id: null, created_at: t })
    const { store } = mk((c) => {
      if (c.url.includes('/conversations')) return { body: [conv] }
      if (c.url.includes('/messages')) return { body: [m('b', 'assistant', '2026-10-08T10:00:00.001+00:00'), m('a', 'user', '2026-10-08T10:00:00+00:00')] }
      return { body: [{ summary: 's', upto_message_id: null }] }
    })
    const ctx = await store.loadConversation(U, 'c1', 30)
    expect(ctx?.messages.map((x) => x.id)).toEqual(['a', 'b'])
    expect(ctx?.messages[0]!.createdAtUtc).toBe('2026-10-08T10:00:00Z')
    expect(ctx?.summary).toEqual({ text: 's', uptoMessageId: null })
    const none = mk(() => ({ body: [] }))
    expect(await none.store.loadConversation(U, 'c1', 30)).toBeNull()
  })

  it('appendMessages rejects a conversation the user does not own and orders messages 1 ms apart', async () => {
    const none = mk(() => ({ body: [] }))
    await expect(none.store.appendMessages(U, 'c1', [], 0)).rejects.toThrow('not found')
    const { store, calls } = mk((c) => ({ body: c.method === 'GET' ? [{ id: 'c1' }] : null }))
    await store.appendMessages(U, 'c1', [{ role: 'user', content: 'q', turnId: null }, { role: 'assistant', content: 'a', turnId: 't' }], Date.UTC(2026, 9, 8, 10))
    const post = calls.find((c) => c.method === 'POST')!
    const rows = post.body as { created_at: string; user_id: string }[]
    expect(rows.map((r) => r.created_at)).toEqual(['2026-10-08T10:00:00.000Z', '2026-10-08T10:00:00.001Z'])
    expect(rows.every((r) => r.user_id === U)).toBe(true)
  })

  it('addImpact maps both ways', async () => {
    const row = {
      id: 'i1', user_id: U, conversation_id: null, turn_id: null, window_start_utc: '2026-10-09T02:00:00+00:00', run_now_start_utc: '2026-10-08T18:00:00+00:00',
      duration_h: 2, energy_kwh: '1.500', run_id: 'r', model: 'blend_wx', est_point_g: '120.0', est_low_g: 50, est_high_g: 200, realized_g: null, realized_at: null, realized_note: null,
      created_at: '2026-10-08T10:00:00+00:00',
    }
    const { store, calls } = mk(() => ({ body: [row] }))
    const r = await store.addImpact({ userId: U, conversationId: null, turnId: null, windowStartUtc: row.window_start_utc, runNowStartUtc: row.run_now_start_utc, durationH: 2, energyKwh: 1.5, runId: 'r', model: 'blend_wx', estPointG: 120, estLowG: 50, estHighG: 200 })
    expect(r).toMatchObject({ id: 'i1', energyKwh: 1.5, estPointG: 120, windowStartUtc: '2026-10-09T02:00:00Z', realizedG: null })
    expect(calls[0]!.body).toMatchObject({ user_id: U, est_point_g: 120 })
  })

  it('saveFeedback upserts on (turn_id,user_id)', async () => {
    const { store, calls } = mk(() => ({}))
    await store.saveFeedback({ turnId: 't', userId: U, rating: -1, comment: 'c' })
    expect(calls[0]!.url).toContain('on_conflict=turn_id,user_id')
    expect(calls[0]!.body).toEqual({ turn_id: 't', user_id: U, rating: -1, comment: 'c' })
  })

  it('deleteUserData calls the auth admin API; 404 is fine, other errors throw', async () => {
    const ok = mk(() => ({ status: 200, body: {} }))
    await ok.store.deleteUserData(U)
    expect(ok.calls[0]).toMatchObject({ method: 'DELETE', url: `https://x.supabase.co/auth/v1/admin/users/${U}` })
    await mk(() => ({ status: 404, body: { msg: 'gone' } })).store.deleteUserData(U)
    await expect(mk(() => ({ status: 500 })).store.deleteUserData(U)).rejects.toMatchObject({ code: 'http', status: 500 })
  })

  it('isAdmin, reassign (RPC), consumeSession and anonMessagesUsed', async () => {
    expect(await mk(() => ({ body: [{ user_id: U }] })).store.isAdmin(U)).toBe(true)
    expect(await mk(() => ({ body: [] })).store.isAdmin(U)).toBe(false)
    const r = mk(() => ({ body: 3 }))
    expect(await r.store.reassignCounted('a', 'b')).toBe(3)
    await r.store.reassign('a', 'b')
    expect(r.calls[0]).toMatchObject({ method: 'POST', body: { p_from: 'a', p_to: 'b' } })
    expect(r.calls[0]!.url).toContain('/rpc/reassign_user_data')
    expect(await mk(() => ({ body: false })).store.consumeSession('h', 5)).toBe(false)
    expect(await mk(() => ({ body: 2 })).store.anonMessagesUsed(U)).toBe(2)
  })

  it('network failures become StoreError(network) without leaking the key', async () => {
    const store = new SupabaseUserStore({ url: 'https://x.supabase.co', key: 'sb_secret_k', fetch: (() => Promise.reject(new Error('boom sb_secret_k'))) as typeof fetch })
    const e = await store.getProfile(U).catch((x: unknown) => x)
    expect(e).toMatchObject({ code: 'network' })
    expect(String((e as Error).message)).not.toContain('sb_secret_k')
  })
})
