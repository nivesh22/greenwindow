import { useCallback, useEffect, useState } from 'react'
import { plansResponseSchema, type PlansResponse } from '../../agent/harness/api_schemas'
import { formatDateTime } from '../lib/time'
import { apiFetch } from './auth'
import { actionBtn } from './CalendarButtons'
import { disablePush, enablePush, getPushStatus, UNSUPPORTED_MESSAGE, type PushStatus } from './push'

/** Notifications on/off (Web Push). */
export function NotificationsSection() {
  const [status, setStatus] = useState<PushStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void getPushStatus().then((s) => {
      if (live) setStatus(s)
    })
    return () => {
      live = false
    }
  }, [])

  const toggle = async (on: boolean) => {
    setBusy(true)
    setMsg(null)
    const r = on ? await enablePush() : await disablePush()
    if (!r.ok) setMsg(r.message)
    setStatus(await getPushStatus())
    setBusy(false)
  }

  return (
    <section aria-labelledby="notif-h" className="space-y-2">
      <h2 id="notif-h" className="text-lg font-semibold">Notifications</h2>
      {status === null && <p role="status" className="text-sm">Loading…</p>}
      {status === 'unsupported' && <p className="text-sm text-stone-600 dark:text-stone-300">{UNSUPPORTED_MESSAGE}</p>}
      {status === 'denied' && (
        <p className="text-sm text-stone-600 dark:text-stone-300">Notifications are blocked for this site. Allow them in your browser settings to turn them on.</p>
      )}
      {(status === 'on' || status === 'off') && (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            role="switch"
            checked={status === 'on'}
            disabled={busy}
            onChange={(e) => void toggle(e.target.checked)}
            className="h-4 w-4 accent-brand-600"
          />
          Reminders and plan alerts on this device
        </label>
      )}
      {msg && <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">{msg}</p>}
    </section>
  )
}

type Plan = PlansResponse['plans'][number]

/** Saved one-off and recurring plans, with cancel. */
export function PlansSection() {
  const [plans, setPlans] = useState<Plan[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/plans')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setPlans(plansResponseSchema.parse(await res.json()).plans)
      setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'error')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const cancel = async (p: Plan) => {
    setCancelling(p.id)
    try {
      const res = await apiFetch(`/api/plans?id=${encodeURIComponent(p.id)}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      await load()
    } catch (e) {
      setErr(`Could not cancel (${e instanceof Error ? e.message : 'error'})`)
    } finally {
      setCancelling(null)
    }
  }

  const active = (plans ?? []).filter((p) => p.active)
  return (
    <section aria-labelledby="plans-h" className="space-y-2">
      <h2 id="plans-h" className="text-lg font-semibold">Your plans</h2>
      {err && <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">Could not load or change your plans ({err}).</p>}
      {plans === null && !err && <p role="status" className="text-sm">Loading…</p>}
      {plans !== null && active.length === 0 && <p className="text-sm text-stone-600 dark:text-stone-300">No saved plans.</p>}
      <ul className="space-y-2">
        {active.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-stone-200 p-3 text-sm dark:border-stone-800">
            <div className="min-w-0">
              <p className="font-medium break-words">{p.label}</p>
              <p className="text-xs text-stone-600 dark:text-stone-300">
                {p.kind === 'recurring' ? 'Recurring' : 'One-off'} · Next start: {p.next_start_utc ? formatDateTime(p.next_start_utc) : 'none planned'}
              </p>
            </div>
            <button
              type="button"
              className={actionBtn}
              disabled={cancelling === p.id}
              aria-label={`Cancel plan ${p.label}`}
              onClick={() => void cancel(p)}
            >
              Cancel
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
