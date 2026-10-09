import { beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../../agent/config.js'
import type { SseEvent } from '../../agent/harness/events.js'
import { MemoryStore } from '../../agent/store/types.js'
import { MemoryUserStore } from '../../agent/store/user_types.js'
import { createChatHandler } from '../chat.js'
import { clearAuthCache } from '../_lib/auth.js'
import type { ApiDeps } from '../_lib/deps.js'
import { createFeedbackHandler } from '../feedback.js'
import { createLatestHandler } from '../conversations/latest.js'
import { createDeleteMeHandler } from '../me/delete.js'
import { createProfileHandler } from '../profile.js'
import { createSessionHandler, TURNSTILE_URL } from '../session.js'
import { createMergeHandler } from '../session/merge.js'
import type { TurnRunner } from '../_lib/turn_runner.js'

const ANON = '33333333-3333-4333-8333-333333333333'
const USER = '44444444-4444-4444-8444-444444444444'
const TURN = '55555555-5555-4555-8555-555555555555'
const ENV = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_x', IP_SALT: 'salt-salt-salt-salt', ANON_MESSAGE_CAP: '3', IP_HOURLY_CAP: '1000', GLOBAL_DAILY_CAP: '1000' }
const NOW = Date.UTC(2026, 9, 8, 10)

const authUsers: Record<string, unknown> = {
  anon: { id: ANON, is_anonymous: true, email: null },
  google: { id: USER, is_anonymous: false, email: 'a@b.c' },
}

function setup(turnstileOk = true) {
  const turnstileForms: URLSearchParams[] = []
  const sessions = new Map<string, number>()
  const users = new MemoryUserStore()
  const reassigned: [string, string][] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url === TURNSTILE_URL) {
      turnstileForms.push(init!.body as URLSearchParams)
      return new Response(JSON.stringify({ success: turnstileOk }), { status: 200 })
    }
    const token = String((init?.headers as Record<string, string>)?.authorization ?? '').replace('Bearer ', '')
    const u = authUsers[token]
    return u ? new Response(JSON.stringify(u)) : new Response('{"msg":"bad"}', { status: 401 })
  }) as typeof fetch
  const used = { [ANON]: 1 } as Record<string, number>
  const deps: ApiDeps = {
    users: Object.assign(users, {
      reassignCounted: async (from: string, to: string) => {
        reassigned.push([from, to])
        await users.reassign(from, to)
        return 2
      },
    }),
    usage: {
      consumeSession: async (h, cap) => {
        const n = sessions.get(h) ?? 0
        if (n >= cap) return false
        sessions.set(h, n + 1)
        return true
      },
      anonMessagesUsed: async (id) => used[id] ?? 0,
    },
    config: loadConfig(ENV),
    env: { TURNSTILE_SECRET: '1x0000000000000000000000000000000AA' },
    fetch: fetchImpl,
    now: () => NOW,
  }
  return { deps, users, turnstileForms, reassigned }
}

const req = (path: string, method: string, token?: string, body?: unknown) =>
  new Request(`https://x.test${path}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'x-forwarded-for': '9.9.9.9', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  })
const code = async (r: Response) => ((await r.json()) as { error: { code: string } }).error.code

beforeEach(() => clearAuthCache())

describe('POST /api/session', () => {
  it('verifies Turnstile with the form fields, then allows up to 5 sessions per IP', async () => {
    const { deps, turnstileForms } = setup()
    const h = createSessionHandler(deps)
    for (let i = 0; i < 5; i++) expect((await h(req('/api/session', 'POST', undefined, { turnstile_token: 'tok' }))).status).toBe(200)
    const sixth = await h(req('/api/session', 'POST', undefined, { turnstile_token: 'tok' }))
    expect(sixth.status).toBe(429)
    expect(await code(sixth)).toBe('session_limit')
    expect(turnstileForms[0]!.get('secret')).toBe('1x0000000000000000000000000000000AA')
    expect(turnstileForms[0]!.get('response')).toBe('tok')
    expect(turnstileForms[0]!.get('remoteip')).toBe('9.9.9.9')
  })

  it('403 when Turnstile fails, 400 on bad body, 503 without a secret, 405 on GET', async () => {
    const bad = createSessionHandler(setup(false).deps)
    const r = await bad(req('/api/session', 'POST', undefined, { turnstile_token: 't' }))
    expect(r.status).toBe(403)
    expect(await code(r)).toBe('turnstile_failed')
    const { deps } = setup()
    expect((await createSessionHandler(deps)(req('/api/session', 'POST', undefined, {}))).status).toBe(400)
    expect((await createSessionHandler({ ...deps, env: {} })(req('/api/session', 'POST', undefined, { turnstile_token: 't' }))).status).toBe(503)
    expect((await createSessionHandler(deps)(req('/api/session', 'GET'))).status).toBe(405)
  })
})

describe('POST /api/session/merge', () => {
  it('moves the anonymous data to the signed-in caller', async () => {
    const { deps, users, reassigned } = setup()
    await users.ensureConversation(ANON, null, NOW)
    const r = await createMergeHandler(deps)(req('/api/session/merge', 'POST', 'google', { anon_access_token: 'anon' }))
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true, moved_conversations: 2 })
    expect(reassigned).toEqual([[ANON, USER]])
    expect(users.conversations[0]!.userId).toBe(USER)
  })

  it('rejects: no token, anonymous caller, non-anonymous or invalid anon token', async () => {
    const { deps } = setup()
    const h = createMergeHandler(deps)
    expect((await h(req('/api/session/merge', 'POST', undefined, { anon_access_token: 'anon' }))).status).toBe(401)
    expect((await h(req('/api/session/merge', 'POST', 'anon', { anon_access_token: 'anon' }))).status).toBe(403)
    expect((await h(req('/api/session/merge', 'POST', 'google', { anon_access_token: 'google' }))).status).toBe(400)
    expect((await h(req('/api/session/merge', 'POST', 'google', { anon_access_token: 'junk' }))).status).toBe(400)
  })
})

describe('GET /api/conversations/latest', () => {
  it('returns the last messages and messages_left for anonymous users', async () => {
    const { deps, users } = setup()
    const c = await users.ensureConversation(ANON, null, NOW)
    await users.appendMessages(ANON, c.id, [{ role: 'user', content: 'hi', turnId: null }, { role: 'assistant', content: 'hello', turnId: TURN }], NOW)
    const r = await createLatestHandler(deps)(req('/api/conversations/latest', 'GET', 'anon'))
    const body = (await r.json()) as { conversation: { id: string; messages: { content: string }[] }; messages_left: number; is_anonymous: boolean }
    expect(body.is_anonymous).toBe(true)
    expect(body.messages_left).toBe(2)
    expect(body.conversation.messages.map((m) => m.content)).toEqual(['hi', 'hello'])
  })

  it('null conversation and null messages_left for signed-in users; 401 without a token', async () => {
    const { deps } = setup()
    const h = createLatestHandler(deps)
    expect(await (await h(req('/api/conversations/latest', 'GET', 'google'))).json()).toEqual({ conversation: null, messages_left: null, is_anonymous: false })
    expect((await h(req('/api/conversations/latest', 'GET'))).status).toBe(401)
  })
})

describe('/api/profile', () => {
  it('403 sign_in_required for anonymous, 401 without a token', async () => {
    const h = createProfileHandler(setup().deps)
    const r = await h(req('/api/profile', 'GET', 'anon'))
    expect(r.status).toBe(403)
    expect(await code(r)).toBe('sign_in_required')
    expect((await h(req('/api/profile', 'GET'))).status).toBe(401)
  })

  it('GET defaults, PUT saves profile and devices, delete removes them', async () => {
    const h = createProfileHandler(setup().deps)
    const def = await (await h(req('/api/profile', 'GET', 'google'))).json()
    expect(def).toEqual({ profile: { display_name: null, risk_default: 'expected', quiet_from: null, quiet_to: null }, devices: [] })
    const put = await h(
      req('/api/profile', 'PUT', 'google', {
        profile: { display_name: 'N', risk_default: 'cautious', quiet_from: '22:00', quiet_to: '07:00' },
        upsert_devices: [{ name: 'Dishwasher', kw: 1.2, typical_hours: 2 }],
      }),
    )
    const saved = (await put.json()) as { profile: { risk_default: string }; devices: { id: string; name: string }[] }
    expect(saved.profile.risk_default).toBe('cautious')
    expect(saved.devices[0]!.name).toBe('Dishwasher')
    const del = (await (await h(req('/api/profile', 'PUT', 'google', { delete_device_ids: [saved.devices[0]!.id] }))).json()) as { devices: unknown[] }
    expect(del.devices).toEqual([])
    expect((await h(req('/api/profile', 'PUT', 'google', { profile: { display_name: 'x' } }))).status).toBe(400)
  })
})

describe('POST /api/feedback', () => {
  it('stores feedback for anonymous users; 401 without a token; 400 on a bad body', async () => {
    const { deps, users } = setup()
    const h = createFeedbackHandler(deps)
    expect((await h(req('/api/feedback', 'POST', 'anon', { turn_id: TURN, rating: -1 }))).status).toBe(200)
    expect(users.feedback[0]).toMatchObject({ turnId: TURN, userId: ANON, rating: -1, comment: null })
    expect((await h(req('/api/feedback', 'POST', undefined, { turn_id: TURN, rating: 1 }))).status).toBe(401)
    expect((await h(req('/api/feedback', 'POST', 'anon', { turn_id: 'x', rating: 1 }))).status).toBe(400)
  })
})

describe('POST /api/me/delete', () => {
  it('requires the confirm word and deletes only the caller', async () => {
    const { deps, users } = setup()
    await users.upsertProfile({ userId: USER, displayName: 'N', riskDefault: 'expected', quietFrom: null, quietTo: null })
    await users.upsertProfile({ userId: ANON, displayName: 'A', riskDefault: 'expected', quietFrom: null, quietTo: null })
    const h = createDeleteMeHandler(deps)
    expect((await h(req('/api/me/delete', 'POST', 'google', { confirm: 'yes' }))).status).toBe(400)
    expect(users.profiles.has(USER)).toBe(true)
    expect((await h(req('/api/me/delete', 'POST', 'google', { confirm: 'DELETE' }))).status).toBe(200)
    expect(users.profiles.has(USER)).toBe(false)
    expect(users.profiles.has(ANON)).toBe(true)
    expect((await h(req('/api/me/delete', 'POST', undefined, { confirm: 'DELETE' }))).status).toBe(401)
  })
})

describe('POST /api/chat with auth', () => {
  const chatBody = { conversation_id: null, message: 'hi', panel_state: null, client_now_utc: '2026-10-08T10:00:00Z' }
  const post = (token?: string) =>
    new Request('https://x.test/api/chat', {
      method: 'POST',
      body: JSON.stringify(chatBody),
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '1.2.3.4', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    })
  const events = async (r: Response): Promise<SseEvent[]> =>
    (await r.text()).split('\n\n').filter((b) => b.startsWith('event:')).map((b) => {
      const [e, d] = b.split('\n')
      return { type: e!.slice(7), data: JSON.parse(d!.slice(6)) } as SseEvent
    })

  function mkChat(admin = false) {
    const { deps, users } = setup()
    if (admin) users.admins.add(USER)
    const store = new MemoryStore()
    const seen: Parameters<TurnRunner>[0][] = []
    const runTurn: TurnRunner = async (input, emit) => {
      seen.push(input)
      emit({ type: 'answer', data: { text: 'ok' } })
    }
    const handler = createChatHandler({ store, runTurn, config: deps.config, now: () => NOW, users, fetch: deps.fetch, publishableKey: 'pk' })
    return { handler, seen, store }
  }

  it('anonymous user: counts per user, passes auth and messagesLeft, then sign-in limit', async () => {
    const { handler, seen } = mkChat()
    for (let i = 0; i < 3; i++) await (await handler(post('anon'))).text()
    expect(seen).toHaveLength(3)
    expect(seen[0]!.auth).toEqual({ userId: ANON, isAnonymous: true, email: null })
    expect(seen.map((s) => s.messagesLeft)).toEqual([2, 1, 0])
    const ev = await events(await handler(post('anon')))
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({ type: 'limit', data: { kind: 'anon_limit', sign_in: true } })
    expect((ev[0] as { data: { message: string } }).data.message).toBe('You’ve used your 3 free messages. Continue with Google to keep going — your conversation carries over.')
    expect(seen).toHaveLength(3)
  })

  it('no token keeps IP-only behaviour; an invalid token is 401', async () => {
    const { handler, seen } = mkChat()
    await (await handler(post())).text()
    expect(seen[0]!.auth).toBeNull()
    const bad = await handler(post('junk'))
    expect(bad.status).toBe(401)
    expect(await code(bad)).toBe('unauthorized')
  })

  it('signed-in users use the daily cap (20); admins are exempt', async () => {
    const regular = mkChat()
    for (let i = 0; i < 20; i++) await (await regular.handler(post('google'))).text()
    const ev = await events(await regular.handler(post('google')))
    expect(ev[0]).toMatchObject({ type: 'limit', data: { kind: 'daily_cap', sign_in: false } })

    const admin = mkChat(true)
    for (let i = 0; i < 21; i++) await (await admin.handler(post('google'))).text()
    expect(admin.seen).toHaveLength(21)
  })
})
