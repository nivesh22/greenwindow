import { useEffect, useState } from 'react'
import { authEnabled, getAuthInfo, getClient, mergeAnonymousIfPending, type AuthInfo } from './auth'

export interface AuthState {
  enabled: boolean
  ready: boolean
  info: AuthInfo | null
}

/** Current auth state; loads the Supabase client lazily and follows sign-in/out. */
export function useAuth(): AuthState {
  const enabled = authEnabled()
  const [state, setState] = useState<AuthState>({ enabled, ready: !enabled, info: null })
  useEffect(() => {
    if (!enabled) return
    let live = true
    let unsub: (() => void) | undefined
    const refresh = () =>
      getAuthInfo()
        .catch(() => null)
        .then((info) => {
          if (live) setState({ enabled: true, ready: true, info })
        })
    void (async () => {
      const client = await getClient()
      if (!client || !live) return
      await mergeAnonymousIfPending().catch(() => undefined)
      await refresh()
      if (!live) return
      const { data } = client.auth.onAuthStateChange(() => {
        void refresh()
      })
      unsub = () => data.subscription.unsubscribe()
    })()
    return () => {
      live = false
      unsub?.()
    }
  }, [enabled])
  return state
}
