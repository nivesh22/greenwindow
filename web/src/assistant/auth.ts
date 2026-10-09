// Optional Supabase auth (design §10). The supabase-js client and the Turnstile script load lazily, only when
// the assistant is used, so neither is in the initial bundle. Without VITE_SUPABASE_* the chat stays IP-only.
import type { SupabaseClient } from '@supabase/supabase-js'
import { sessionResponseSchema } from '../../agent/harness/api_schemas'

const env = (): Record<string, string | undefined> => import.meta.env as Record<string, string | undefined>
export const authEnabled = (): boolean => Boolean(env().VITE_SUPABASE_URL && env().VITE_SUPABASE_ANON_KEY)

export const HELD_KEY = 'gw_held_message'
export const ANON_TOKEN_KEY = 'gw_anon_token'

export interface AuthInfo {
  token: string
  isAnonymous: boolean
  email: string | null
}

let clientPromise: Promise<SupabaseClient | null> | null = null

export function getClient(): Promise<SupabaseClient | null> {
  if (!authEnabled()) return Promise.resolve(null)
  clientPromise ??= import('@supabase/supabase-js').then(({ createClient }) =>
    createClient(env().VITE_SUPABASE_URL as string, env().VITE_SUPABASE_ANON_KEY as string),
  )
  return clientPromise
}

/** Test hook: forget the cached client. */
export function resetAuthClient(): void {
  clientPromise = null
}

export async function getAuthInfo(): Promise<AuthInfo | null> {
  const client = await getClient()
  if (!client) return null
  const { data } = await client.auth.getSession()
  const s = data.session
  if (!s) return null
  return { token: s.access_token, isAnonymous: s.user.is_anonymous === true, email: s.user.email ?? null }
}

/** fetch() with the Bearer token when a session exists. */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const info = await getAuthInfo().catch(() => null)
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) }
  if (info) headers.authorization = `Bearer ${info.token}`
  return fetch(path, { ...init, headers })
}

// ---- Turnstile ----
interface TurnstileApi {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string
}
const TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'

function turnstileApi(): TurnstileApi | undefined {
  return (window as unknown as { turnstile?: TurnstileApi }).turnstile
}

function loadTurnstile(): Promise<TurnstileApi> {
  const ready = turnstileApi()
  if (ready) return Promise.resolve(ready)
  return new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = TURNSTILE_SRC
    s.async = true
    s.onload = () => {
      const api = turnstileApi()
      if (api) resolve(api)
      else reject(new Error('Turnstile did not initialise'))
    }
    s.onerror = () => reject(new Error('Could not load the verification widget'))
    document.head.appendChild(s)
  })
}

async function getTurnstileToken(sitekey: string): Promise<string> {
  const api = await loadTurnstile()
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;bottom:1rem;left:50%;transform:translateX(-50%);z-index:50'
  document.body.appendChild(host)
  try {
    return await new Promise<string>((resolve, reject) => {
      api.render(host, {
        sitekey,
        appearance: 'interaction-only',
        callback: (t: string) => resolve(t),
        'error-callback': () => reject(new Error('Verification failed')),
        'timeout-callback': () => reject(new Error('Verification timed out')),
      })
    })
  } finally {
    host.remove()
  }
}

let ensuring: Promise<AuthInfo | null> | null = null

/** No session yet: verify Turnstile (if configured), POST /api/session, then sign in anonymously. */
export function ensureSession(): Promise<AuthInfo | null> {
  ensuring ??= doEnsure().finally(() => {
    ensuring = null
  })
  return ensuring
}

async function doEnsure(): Promise<AuthInfo | null> {
  const client = await getClient()
  if (!client) return null
  const existing = await getAuthInfo()
  if (existing) return existing
  const sitekey = env().VITE_TURNSTILE_SITEKEY
  if (sitekey) {
    const turnstile_token = await getTurnstileToken(sitekey)
    const res = await fetch('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ turnstile_token }),
    })
    if (!res.ok) throw new Error(`Verification was rejected (HTTP ${res.status})`)
    sessionResponseSchema.parse(await res.json())
  }
  const { error } = await client.auth.signInAnonymously()
  if (error) throw new Error(error.message)
  const info = await getAuthInfo()
  if (!info) throw new Error('Could not start a session')
  return info
}

// ---- Google sign-in (FR-6.2) ----
const alreadyLinked = (e: { code?: string; message: string }): boolean =>
  e.code === 'identity_already_exists' || /already (linked|exists|been linked)|identity.*already/i.test(e.message)

export function storeHeldMessage(text: string): void {
  try {
    sessionStorage.setItem(HELD_KEY, text)
  } catch {
    // storage unavailable: the user just retypes the message
  }
}

export function takeHeldMessage(): string | null {
  try {
    const v = sessionStorage.getItem(HELD_KEY)
    if (v !== null) sessionStorage.removeItem(HELD_KEY)
    return v
  } catch {
    return null
  }
}

export async function signInWithGoogle(): Promise<void> {
  const client = await getClient()
  if (!client) throw new Error('Sign-in is not available')
  const redirectTo = window.location.href
  const info = await getAuthInfo()
  if (info?.isAnonymous) {
    const { error } = await client.auth.linkIdentity({ provider: 'google', options: { redirectTo } })
    if (!error) return
    if (!alreadyLinked(error)) throw new Error(error.message)
    // S6: that Google account already exists. Keep the anonymous token so its data can be merged after return.
    try {
      sessionStorage.setItem(ANON_TOKEN_KEY, info.token)
    } catch {
      // without storage the merge is skipped
    }
  }
  const { error } = await client.auth.signInWithOAuth({ provider: 'google', options: { redirectTo } })
  if (error) throw new Error(error.message)
}

let merging: Promise<void> | null = null

/** After returning from the S6 fallback: move the anonymous user's data, then forget the token. */
export function mergeAnonymousIfPending(): Promise<void> {
  merging ??= doMerge().finally(() => {
    merging = null
  })
  return merging
}

async function doMerge(): Promise<void> {
  let anon: string | null = null
  try {
    anon = sessionStorage.getItem(ANON_TOKEN_KEY)
  } catch {
    return
  }
  if (!anon) return
  const info = await getAuthInfo()
  if (!info || info.isAnonymous) return
  const res = await apiFetch('/api/session/merge', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ anon_access_token: anon }),
  })
  if (res.ok) {
    try {
      sessionStorage.removeItem(ANON_TOKEN_KEY)
    } catch {
      // ignore
    }
  }
}

export async function signOut(): Promise<void> {
  const client = await getClient()
  await client?.auth.signOut()
}
