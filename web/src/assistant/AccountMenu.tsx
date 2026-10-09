import type { AuthState } from './useAuth'

/**
 * Account line in the chat header: a guest's free messages left. Signing in, the email, Settings and Sign out live in
 * the site header (HeaderAccount), on every page.
 */
export function AccountMenu({ auth, messagesLeft }: { auth: AuthState; messagesLeft: number | null }) {
  if (!auth.enabled || !auth.ready || !auth.info || !auth.info.isAnonymous) return null
  return (
    <p className="text-xs text-stone-600 dark:text-stone-300" aria-label="Account">
      Guest{messagesLeft !== null ? ` — ${messagesLeft} free messages left` : ''}. Sign in (top right) to keep your plans.
    </p>
  )
}
