import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { Privacy } from '../pages/Privacy'
import { Settings } from '../pages/Settings'
import { ANON_TOKEN_KEY, HELD_KEY, resetAuthClient } from './auth'
import { ChatPanel } from './ChatPanel'
import { CONV_ID, sseResponse, turnEvents } from './testing'
import { useChat } from './useChat'

interface FakeSession {
  access_token: string
  user: { is_anonymous: boolean; email: string | null }
}
const fake = vi.hoisted(() => {
  const state = { session: null as FakeSession | null }
  const auth = {
    getSession: vi.fn(() => Promise.resolve({ data: { session: state.session } })),
    signInAnonymously: vi.fn(() => {
      state.session = { access_token: 'anon-token', user: { is_anonymous: true, email: null } }
      return Promise.resolve({ error: null })
    }),
    linkIdentity: vi.fn((): Promise<{ error: { code?: string; message: string } | null }> => Promise.resolve({ error: null })),
    signInWithOAuth: vi.fn(() => Promise.resolve({ error: null })),
    signOut: vi.fn(() => {
      state.session = null
      return Promise.resolve({ error: null })
    }),
    onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
  }
  return { state, auth }
})
vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn(() => ({ auth: fake.auth })) }))

const ANON: FakeSession = { access_token: 'anon-token', user: { is_anonymous: true, email: null } }
const USER: FakeSession = { access_token: 'user-token', user: { is_anonymous: false, email: 'ada@example.com' } }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

type Handler = (init: RequestInit) => Response | Promise<Response>
function route(handlers: Record<string, Handler>) {
  const mock = vi.fn((url: string, init: RequestInit = {}) => {
    const h = handlers[url]
    return Promise.resolve(h ? h(init) : json({ error: { code: 'nf', message: 'nf' } }, 404))
  })
  vi.stubGlobal('fetch', mock)
  return mock
}
const calls = (m: ReturnType<typeof route>, url: string) => m.mock.calls.filter((c) => c[0] === url)
const authHeader = (init: RequestInit | undefined) => (init?.headers as Record<string, string> | undefined)?.authorization

beforeEach(() => {
  vi.stubEnv('VITE_SUPABASE_URL', 'https://x.supabase.co')
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon')
  vi.stubEnv('VITE_TURNSTILE_SITEKEY', 'site')
  fake.state.session = null
  resetAuthClient()
  sessionStorage.clear()
  ;(window as unknown as { turnstile: unknown }).turnstile = {
    render: vi.fn((_el: HTMLElement, o: { callback: (t: string) => void }) => {
      o.callback('ts-token')
      return 'w1'
    }),
  }
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  delete (window as unknown as { turnstile?: unknown }).turnstile
})

describe('anonymous first use', () => {
  it('verifies Turnstile, posts /api/session, signs in anonymously, then sends with a Bearer token', async () => {
    const order: string[] = []
    fake.auth.signInAnonymously.mockImplementationOnce(() => {
      order.push('anon')
      fake.state.session = ANON
      return Promise.resolve({ error: null })
    })
    const m = route({
      '/api/session': () => {
        order.push('session')
        return json({ ok: true })
      },
      '/api/conversations/latest': () => json({ conversation: null, messages_left: 10, is_anonymous: true }),
      '/api/chat': () => sseResponse(turnEvents('hi')),
    })
    const { result } = renderHook(() => useChat())
    await act(() => result.current.send('charge my EV'))

    expect(order).toEqual(['session', 'anon'])
    expect(JSON.parse(calls(m, '/api/session')[0]?.[1]?.body as string)).toEqual({ turnstile_token: 'ts-token' })
    expect(authHeader(calls(m, '/api/chat')[0]?.[1])).toBe('Bearer anon-token')
    expect(result.current.messagesLeft).toBe(9)
    expect(result.current.error).toBeNull()
  })

  it('skips Turnstile when no sitekey is configured', async () => {
    vi.stubEnv('VITE_TURNSTILE_SITEKEY', '')
    const m = route({ '/api/chat': () => sseResponse(turnEvents('hi')) })
    const { result } = renderHook(() => useChat())
    await act(() => result.current.send('hello'))
    expect(calls(m, '/api/session')).toHaveLength(0)
    expect(fake.auth.signInAnonymously).toHaveBeenCalledTimes(1)
  })

  it('shows a retry message and stays usable when verification fails', async () => {
    const m = route({ '/api/session': () => json({ error: { code: 'turnstile', message: 'no' } }, 403) })
    const { result } = renderHook(() => useChat())
    let ok = true
    await act(async () => {
      ok = await result.current.send('hello')
    })
    expect(ok).toBe(false)
    expect(result.current.error?.code).toBe('auth_failed')
    expect(result.current.error?.message).toMatch(/try again/i)
    expect(result.current.busy).toBe(false)
    expect(calls(m, '/api/chat')).toHaveLength(0)
  })

  it('works as before (no auth header, no session call) when Supabase is not configured', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', '')
    const m = route({ '/api/chat': () => sseResponse(turnEvents('hi')) })
    const { result } = renderHook(() => useChat())
    await act(() => result.current.send('hello'))
    expect(calls(m, '/api/session')).toHaveLength(0)
    expect(authHeader(calls(m, '/api/chat')[0]?.[1])).toBeUndefined()
  })
})

describe('restore and account line', () => {
  it('restores the latest conversation and shows messages left for guests', async () => {
    fake.state.session = ANON
    route({
      '/api/conversations/latest': () =>
        json({
          conversation: {
            id: CONV_ID,
            messages: [
              { role: 'user', content: 'earlier question', turn_id: null, created_at_utc: '2026-10-08T10:00:00Z' },
              { role: 'assistant', content: 'earlier answer', turn_id: '22222222-2222-4222-8222-222222222222', created_at_utc: '2026-10-08T10:00:05Z' },
            ],
          },
          messages_left: 7,
          is_anonymous: true,
        }),
    })
    render(<ChatPanel />)
    expect(await screen.findByText('earlier answer')).toBeInTheDocument()
    expect(screen.getByText('earlier question')).toBeInTheDocument()
    expect(await screen.findByText(/Guest — 7 free messages left/)).toBeInTheDocument()
  })

  it('shows email, Settings and Sign out for a signed-in user', async () => {
    fake.state.session = USER
    route({ '/api/conversations/latest': () => json({ conversation: null, messages_left: null, is_anonymous: false }) })
    render(<ChatPanel />)
    expect(await screen.findByText('ada@example.com')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings')
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(fake.auth.signOut).toHaveBeenCalled()
  })
})

describe('limit -> Continue with Google', () => {
  const limit = () =>
    sseResponse([
      { type: 'turn_start', data: { turn_id: 't1', conversation_id: CONV_ID, messages_left: 0 } },
      { type: 'limit', data: { kind: 'anon_limit', message: 'Free messages used up.', sign_in: true } },
    ])

  async function hitLimit() {
    fake.state.session = ANON
    route({
      '/api/conversations/latest': () => json({ conversation: null, messages_left: 1, is_anonymous: true }),
      '/api/chat': limit,
    })
    render(<ChatPanel />)
    await userEvent.type(await screen.findByLabelText('Message to the assistant'), 'plan my wash{Enter}')
    return screen.findByRole('button', { name: 'Continue with Google' })
  }

  it('replaces the input and links the Google identity, holding the message', async () => {
    const btn = await hitLimit()
    expect(screen.queryByLabelText('Message to the assistant')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'privacy notice' })).toHaveAttribute('href', '/privacy')
    await userEvent.click(btn)
    expect(fake.auth.linkIdentity).toHaveBeenCalledWith({ provider: 'google', options: { redirectTo: window.location.href } })
    expect(sessionStorage.getItem(HELD_KEY)).toBe('plan my wash')
  })

  it('falls back to a plain Google sign-in and keeps the anonymous token when the identity exists (S6)', async () => {
    fake.auth.linkIdentity.mockResolvedValueOnce({ error: { code: 'identity_already_exists', message: 'Identity is already linked' } })
    const btn = await hitLimit()
    await userEvent.click(btn)
    expect(fake.auth.signInWithOAuth).toHaveBeenCalledWith({ provider: 'google', options: { redirectTo: window.location.href } })
    expect(sessionStorage.getItem(ANON_TOKEN_KEY)).toBe('anon-token')
  })

  it('after returning: merges the anonymous account, clears the token and resends the held message once', async () => {
    fake.state.session = USER
    sessionStorage.setItem(ANON_TOKEN_KEY, 'old-anon')
    sessionStorage.setItem(HELD_KEY, 'plan my wash')
    const m = route({
      '/api/session/merge': () => json({ ok: true, moved_conversations: 1 }),
      '/api/conversations/latest': () => json({ conversation: null, messages_left: null, is_anonymous: false }),
      '/api/chat': () => sseResponse(turnEvents('done')),
    })
    const { result } = renderHook(() => useChat())
    await waitFor(() => expect(calls(m, '/api/chat')).toHaveLength(1))
    expect(JSON.parse(calls(m, '/api/session/merge')[0]?.[1]?.body as string)).toEqual({ anon_access_token: 'old-anon' })
    expect(authHeader(calls(m, '/api/session/merge')[0]?.[1])).toBe('Bearer user-token')
    expect(sessionStorage.getItem(ANON_TOKEN_KEY)).toBeNull()
    expect(JSON.parse(calls(m, '/api/chat')[0]?.[1]?.body as string).message).toBe('plan my wash')
    await waitFor(() => expect(result.current.messages.at(-1)?.text).toBe('done'))
    expect(calls(m, '/api/chat')).toHaveLength(1)
  })
})

describe('feedback', () => {
  it('posts the rating and comment with the turn id, then thanks the user', async () => {
    fake.state.session = ANON
    const turn = '33333333-3333-4333-8333-333333333333'
    const m = route({
      '/api/conversations/latest': () =>
        json({
          conversation: { id: CONV_ID, messages: [{ role: 'assistant', content: 'an answer', turn_id: turn, created_at_utc: '2026-10-08T10:00:00Z' }] },
          messages_left: 5,
          is_anonymous: true,
        }),
      '/api/feedback': () => json({ ok: true }),
    })
    render(<ChatPanel />)
    await userEvent.click(await screen.findByRole('button', { name: 'Not helpful' }))
    await userEvent.type(screen.getByLabelText('Optional comment'), 'too vague')
    await userEvent.click(screen.getByRole('button', { name: 'Send feedback' }))
    expect(await screen.findByText(/Thanks for the feedback/)).toBeInTheDocument()
    const call = calls(m, '/api/feedback')[0]
    expect(JSON.parse(call?.[1]?.body as string)).toEqual({ turn_id: turn, rating: -1, comment: 'too vague' })
    expect(authHeader(call?.[1])).toBe('Bearer anon-token')
  })
})

describe('Settings', () => {
  const profile = {
    profile: { display_name: 'Ada', risk_default: 'expected', quiet_from: '22:00', quiet_to: '07:00' },
    devices: [{ id: 'd1', name: 'EV', kw: 7, typical_hours: 4 }],
  }
  const page = () => render(<MemoryRouter><Settings /></MemoryRouter>)

  it('asks anonymous users to sign in', async () => {
    fake.state.session = ANON
    route({})
    page()
    expect(await screen.findByRole('button', { name: 'Continue with Google' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'privacy notice' })).toBeInTheDocument()
  })

  it('loads, edits and saves the profile and devices', async () => {
    fake.state.session = USER
    const m = route({
      '/api/profile': (init) => {
        if (init.method === 'PUT') {
          const body = JSON.parse(init.body as string)
          return json({ profile: body.profile, devices: [{ id: 'd1', name: 'EV', kw: 7, typical_hours: 4 }, { id: 'd2', name: 'Dishwasher', kw: 1.2, typical_hours: 2 }] })
        }
        return json(profile)
      },
    })
    page()
    const name = await screen.findByLabelText('Display name')
    expect(name).toHaveValue('Ada')
    expect(screen.getByLabelText('Device 1 name')).toHaveValue('EV')
    await userEvent.clear(name)
    await userEvent.type(name, 'Ada L')
    await userEvent.selectOptions(screen.getByLabelText('Default risk mode'), 'cautious')
    await userEvent.click(screen.getByRole('button', { name: 'Add device' }))
    await userEvent.type(screen.getByLabelText('Device 2 name'), 'Dishwasher')
    await userEvent.type(screen.getByLabelText('Device 2 power (kW)'), '1.2')
    await userEvent.type(screen.getByLabelText('Device 2 typical hours'), '2')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Saved.')).toBeInTheDocument()
    const put = calls(m, '/api/profile').find((c) => c[1]?.method === 'PUT')
    expect(authHeader(put?.[1])).toBe('Bearer user-token')
    expect(JSON.parse(put?.[1]?.body as string)).toEqual({
      profile: { display_name: 'Ada L', risk_default: 'cautious', quiet_from: '22:00', quiet_to: '07:00' },
      upsert_devices: [
        { id: 'd1', name: 'EV', kw: 7, typical_hours: 4 },
        { name: 'Dishwasher', kw: 1.2, typical_hours: 2 },
      ],
      delete_device_ids: [],
    })
  })

  it('sends deleted device ids', async () => {
    fake.state.session = USER
    const m = route({ '/api/profile': (init) => (init.method === 'PUT' ? json({ ...profile, devices: [] }) : json(profile)) })
    page()
    await userEvent.click(await screen.findByRole('button', { name: 'Delete device 1' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText('Saved.')
    const put = calls(m, '/api/profile').find((c) => c[1]?.method === 'PUT')
    expect(JSON.parse(put?.[1]?.body as string).delete_device_ids).toEqual(['d1'])
  })

  it('deletes all data only after typing DELETE, then signs out', async () => {
    fake.state.session = USER
    const m = route({ '/api/profile': () => json(profile), '/api/me/delete': () => json({ ok: true }) })
    page()
    await userEvent.click(await screen.findByRole('button', { name: 'Delete my data…' }))
    const confirm = screen.getByRole('button', { name: 'Permanently delete' })
    expect(confirm).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Type DELETE to confirm'), 'DELETE')
    await userEvent.click(confirm)
    await waitFor(() => expect(fake.auth.signOut).toHaveBeenCalled())
    expect(JSON.parse(calls(m, '/api/me/delete')[0]?.[1]?.body as string)).toEqual({ confirm: 'DELETE' })
  })
})

describe('Privacy', () => {
  it('covers storage, retention, processors, scopes, deletion and contact', () => {
    render(<Privacy />)
    for (const h of ['What is stored', 'How long', 'Who processes it', 'Google sign-in', 'Deleting your data', 'Contact']) {
      expect(screen.getByRole('heading', { name: h })).toBeInTheDocument()
    }
    expect(screen.getByText(/90 days/)).toBeInTheDocument()
    expect(screen.getByText(/Supabase \(EU, Ireland\)/)).toBeInTheDocument()
    expect(screen.getByText(/Google Gemini API/)).toBeInTheDocument()
    expect(screen.getByText(/Cloudflare Turnstile/)).toBeInTheDocument()
    expect(screen.getByText(/email and profile scopes only/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'GitHub repository' })).toBeInTheDocument()
  })
})
