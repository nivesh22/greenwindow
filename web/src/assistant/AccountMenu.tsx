import { signOut } from './auth'
import type { AuthState } from './useAuth'

/** Small account line for the chat header: guest (with messages left) or signed in (email, Sign out, Settings). */
export function AccountMenu({ auth, messagesLeft }: { auth: AuthState; messagesLeft: number | null }) {
  if (!auth.enabled || !auth.ready || !auth.info) return null
  const link = 'underline hover:text-stone-900 dark:hover:text-stone-100'
  if (auth.info.isAnonymous) {
    return (
      <p className="text-xs text-stone-600 dark:text-stone-300" aria-label="Account">
        Guest{messagesLeft !== null ? ` — ${messagesLeft} free messages left` : ''}
      </p>
    )
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-stone-600 dark:text-stone-300" aria-label="Account">
      <span className="break-all">{auth.info.email ?? 'Signed in'}</span>
      <a className={link} href="/settings">Settings</a>
      <button type="button" className={link} onClick={() => void signOut()}>Sign out</button>
    </div>
  )
}
