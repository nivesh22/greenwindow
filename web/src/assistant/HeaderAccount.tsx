import { useState } from 'react'
import { NavLink } from 'react-router-dom'
import { signInWithGoogle, signOut } from './auth'
import { ASSISTANT_ENABLED } from './flag'
import { useAuth } from './useAuth'

/**
 * Top-right account control on every page: "Sign in" (Google) for visitors and guests, or the signed-in email with
 * Settings and Sign out. A guest's chat history carries over on sign-in (linkIdentity, or the S6 merge fallback).
 * Renders nothing when the assistant or Supabase auth is not configured.
 */
export function HeaderAccount() {
  if (!ASSISTANT_ENABLED) return null
  return <AccountControls />
}

/** The control itself (exported for tests; HeaderAccount adds the assistant flag). */
export function AccountControls() {
  const auth = useAuth()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!auth.enabled || !auth.ready) return null

  const signedIn = auth.info !== null && !auth.info.isAnonymous
  const link = 'rounded-lg px-2 py-1 hover:bg-stone-100 hover:text-stone-900 dark:hover:bg-stone-800 dark:hover:text-stone-100'

  if (signedIn) {
    return (
      <div className="flex items-center gap-1 text-sm text-stone-600 dark:text-stone-300" aria-label="Account">
        <span className="max-w-[12rem] truncate px-1 text-xs" title={auth.info?.email ?? undefined}>
          {auth.info?.email ?? 'Signed in'}
        </span>
        <NavLink className={link} to="/settings">
          Settings
        </NavLink>
        <button type="button" className={link} onClick={() => void signOut()}>
          Sign out
        </button>
      </div>
    )
  }

  const onSignIn = async () => {
    setBusy(true)
    setError(null)
    try {
      await signInWithGoogle() // redirects to Google
    } catch {
      setError('Sign-in failed. Please try again.')
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center gap-2" aria-label="Account">
      {error && (
        <span role="alert" className="text-xs text-red-700 dark:text-red-300">
          {error}
        </span>
      )}
      <button
        type="button"
        onClick={() => void onSignIn()}
        disabled={busy}
        className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-brand-600 disabled:opacity-60"
      >
        {busy ? 'Opening Google…' : 'Sign in'}
      </button>
    </div>
  )
}
