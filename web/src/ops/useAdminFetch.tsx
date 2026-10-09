import { useEffect, useState } from 'react'
import type { z } from 'zod'
import { apiFetch } from '../assistant/auth'

export type AdminState<T> =
  | { status: 'loading' }
  | { status: 'forbidden' }
  | { status: 'signin' }
  | { status: 'error'; message: string }
  | { status: 'ok'; data: T }

/** GET an admin endpoint with the user's bearer token and validate the body with zod. 403 -> forbidden, 401 -> signin. */
export function useAdminFetch<S extends z.ZodTypeAny>(url: string, schema: S): AdminState<z.infer<S>> {
  const [state, setState] = useState<AdminState<z.infer<S>>>({ status: 'loading' })
  useEffect(() => {
    let live = true
    setState({ status: 'loading' })
    void (async () => {
      try {
        const res = await apiFetch(url)
        if (!live) return
        if (res.status === 403) return setState({ status: 'forbidden' })
        if (res.status === 401) return setState({ status: 'signin' })
        if (!res.ok) return setState({ status: 'error', message: `HTTP ${res.status}` })
        const parsed = schema.safeParse(await res.json())
        if (!live) return
        if (!parsed.success) return setState({ status: 'error', message: 'The response did not match the expected format.' })
        setState({ status: 'ok', data: parsed.data as z.infer<S> })
      } catch (e) {
        if (live) setState({ status: 'error', message: e instanceof Error ? e.message : 'error' })
      }
    })()
    return () => {
      live = false
    }
  }, [url, schema])
  return state
}

export function AdminGate({ state }: { state: Exclude<AdminState<unknown>, { status: 'ok' }> }) {
  if (state.status === 'loading') return <p role="status">Loading…</p>
  if (state.status === 'forbidden') return <p role="alert" className="font-medium">Admins only.</p>
  if (state.status === 'signin') return <p role="alert">Sign in with an admin account to view this page.</p>
  return <p role="alert" className="text-amber-700 dark:text-amber-300">Could not load ({state.message}).</p>
}
