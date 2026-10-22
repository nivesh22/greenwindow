import { useEffect, useId, useRef, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { signInWithGoogle, signOut } from './auth'
import { ASSISTANT_ENABLED } from './flag'
import { initials } from './initials'
import { useAuth } from './useAuth'

/** Round profile button; opens a panel with the name, email, Settings, Privacy and Sign out. */
function ProfileMenu({ name, email }: { name: string | null; email: string | null }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const panelId = useId()

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const item = 'block w-full rounded-lg px-3 py-2 text-left text-sm text-ink-2 hover:bg-surface-2 hover:text-ink'
  return (
    <div ref={box} className="relative" aria-label="Account">
      <button
        type="button"
        aria-label="Profile"
        aria-expanded={open}
        aria-controls={panelId}
        title={name ?? email ?? undefined}
        onClick={() => setOpen((o) => !o)}
        className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full bg-brand-500 text-sm font-semibold text-white hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        {initials(name, email)}
      </button>
      {open && (
        <div id={panelId} className="card absolute right-0 z-20 mt-2 w-64 p-1.5 shadow-lg">
          <div className="border-b border-line px-3 pt-1.5 pb-2.5">
            {name && <p className="truncate text-sm font-medium text-ink">{name}</p>}
            <p className="truncate text-xs text-ink-3">{email ?? 'Signed in'}</p>
          </div>
          <div className="pt-1.5">
            <NavLink className={item} to="/settings" onClick={() => setOpen(false)}>
              Settings
            </NavLink>
            <NavLink className={item} to="/privacy" onClick={() => setOpen(false)}>
              Privacy
            </NavLink>
            <button type="button" className={item} onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Top-right account control on every page: "Sign in" (Google) for visitors and guests, or a profile button with
 * Settings and Sign out for signed-in users. A guest's chat history carries over on sign-in (linkIdentity, or the S6 merge fallback).
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

  if (signedIn) return <ProfileMenu name={auth.info?.name ?? null} email={auth.info?.email ?? null} />

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
        className="btn-primary py-1.5"
      >
        {busy ? 'Opening Google…' : 'Sign in'}
      </button>
    </div>
  )
}
