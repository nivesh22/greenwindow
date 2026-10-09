import { useEffect, useId, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { profileResponseSchema, type ProfileUpdate } from '../../agent/harness/api_schemas'
import { MODES } from '../../agent/harness/events'
import { apiFetch, signInWithGoogle, signOut } from '../assistant/auth'
import { NotificationsSection, PlansSection } from '../assistant/SettingsSections'
import { useAuth } from '../assistant/useAuth'

interface DeviceRow {
  key: string
  id?: string
  name: string
  kw: string
  hours: string
}

let rowSeq = 0
const blankRow = (): DeviceRow => ({ key: `n${++rowSeq}`, name: '', kw: '', hours: '' })

const inputCls = 'w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm dark:border-stone-700 dark:bg-stone-950'
const btnCls =
  'rounded-lg border border-stone-300 px-3 py-1.5 text-sm font-medium hover:bg-stone-100 focus-visible:outline-2 focus-visible:outline-brand-600 disabled:opacity-50 dark:border-stone-700 dark:hover:bg-stone-800'

export function Settings() {
  const auth = useAuth()
  if (!auth.ready) return <p role="status">Loading…</p>
  if (!auth.enabled || !auth.info || auth.info.isAnonymous) return <SignInPrompt enabled={auth.enabled} />
  return <SettingsForm email={auth.info.email} />
}

function SignInPrompt({ enabled }: { enabled: boolean }) {
  const [err, setErr] = useState<string | null>(null)
  return (
    <section className="max-w-xl space-y-3">
      <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
      <p className="text-stone-600 dark:text-stone-300">Sign in to save your profile and devices.</p>
      {enabled ? (
        <button
          type="button"
          className="rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700"
          onClick={() => signInWithGoogle().catch((e: unknown) => setErr(e instanceof Error ? e.message : 'Sign-in failed'))}
        >
          Continue with Google
        </button>
      ) : (
        <p className="text-sm">Sign-in is not enabled on this deployment.</p>
      )}
      {err && <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">Sign-in failed ({err}).</p>}
      <p className="text-xs text-stone-500 dark:text-stone-400">
        We only read your email and name. See the <Link className="underline" to="/privacy">privacy notice</Link>.
      </p>
    </section>
  )
}

function SettingsForm({ email }: { email: string | null }) {
  const ids = { name: useId(), risk: useId(), from: useId(), to: useId(), confirm: useId() }
  const [loaded, setLoaded] = useState(false)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [risk, setRisk] = useState<(typeof MODES)[number]>('expected')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [rows, setRows] = useState<DeviceRow[]>([])
  const [removed, setRemoved] = useState<string[]>([])
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [typed, setTyped] = useState('')
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const res = await apiFetch('/api/profile')
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const parsed = profileResponseSchema.parse(await res.json())
        if (!live) return
        apply(parsed)
        setLoaded(true)
      } catch (e) {
        if (live) setLoadErr(e instanceof Error ? e.message : 'Could not load')
      }
    })()
    return () => {
      live = false
    }
  }, [])

  function apply(p: ReturnType<typeof profileResponseSchema.parse>) {
    setName(p.profile.display_name ?? '')
    setRisk(p.profile.risk_default)
    setFrom(p.profile.quiet_from ?? '')
    setTo(p.profile.quiet_to ?? '')
    setRows(p.devices.map((d) => ({ key: d.id, id: d.id, name: d.name, kw: String(d.kw), hours: d.typical_hours === null ? '' : String(d.typical_hours) })))
    setRemoved([])
  }

  const setRow = (key: string, patch: Partial<DeviceRow>) => setRows((r) => r.map((x) => (x.key === key ? { ...x, ...patch } : x)))

  async function save(e: FormEvent) {
    e.preventDefault()
    setMsg(null)
    const devices: NonNullable<ProfileUpdate['upsert_devices']> = []
    for (const r of rows) {
      const kw = Number(r.kw)
      const hours = r.hours.trim() === '' ? null : Number(r.hours)
      if (!r.name.trim() || !(kw > 0) || kw > 10000 || (hours !== null && (!Number.isInteger(hours) || hours < 1 || hours > 12))) {
        setMsg({ ok: false, text: 'Each device needs a name, a power above 0 kW, and typical hours of 1 to 12 (or blank).' })
        return
      }
      devices.push({ ...(r.id ? { id: r.id } : {}), name: r.name.trim(), kw, typical_hours: hours })
    }
    const body: ProfileUpdate = {
      profile: { display_name: name.trim() || null, risk_default: risk, quiet_from: from || null, quiet_to: to || null },
      upsert_devices: devices,
      delete_device_ids: removed,
    }
    setSaving(true)
    try {
      const res = await apiFetch('/api/profile', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      apply(profileResponseSchema.parse(await res.json()))
      setMsg({ ok: true, text: 'Saved.' })
    } catch (err) {
      setMsg({ ok: false, text: `Could not save (${err instanceof Error ? err.message : 'error'}).` })
    } finally {
      setSaving(false)
    }
  }

  async function deleteAll() {
    setDeleting(true)
    try {
      const res = await apiFetch('/api/me/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: 'DELETE' }) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      await signOut()
      setConfirming(false)
      setMsg({ ok: true, text: 'Your data has been deleted and you are signed out.' })
    } catch (err) {
      setMsg({ ok: false, text: `Could not delete (${err instanceof Error ? err.message : 'error'}).` })
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="max-w-2xl space-y-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-sm text-stone-600 dark:text-stone-300">
          Signed in as {email ?? 'your account'}. <button type="button" className="underline" onClick={() => void signOut()}>Sign out</button>
        </p>
      </header>
      {loadErr && <p role="alert" className="text-amber-700 dark:text-amber-300">Could not load your settings ({loadErr}).</p>}
      {!loaded && !loadErr && <p role="status">Loading…</p>}
      {loaded && (
        <form onSubmit={(e) => void save(e)} className="space-y-6">
          <fieldset className="space-y-3">
            <legend className="text-lg font-semibold">Profile</legend>
            <div>
              <label htmlFor={ids.name} className="text-sm font-medium">Display name</label>
              <input id={ids.name} className={inputCls} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
            </div>
            <div>
              <label htmlFor={ids.risk} className="text-sm font-medium">Default risk mode</label>
              <select id={ids.risk} className={inputCls} value={risk} onChange={(e) => setRisk(e.target.value as (typeof MODES)[number])}>
                {MODES.map((m) => (
                  <option key={m} value={m}>{m === 'expected' ? 'Expected' : 'Cautious'}</option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor={ids.from} className="text-sm font-medium">Quiet hours from</label>
                <input id={ids.from} type="time" className={inputCls} value={from} onChange={(e) => setFrom(e.target.value)} />
              </div>
              <div>
                <label htmlFor={ids.to} className="text-sm font-medium">Quiet hours to</label>
                <input id={ids.to} type="time" className={inputCls} value={to} onChange={(e) => setTo(e.target.value)} />
              </div>
            </div>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-lg font-semibold">Saved devices</legend>
            {rows.length === 0 && <p className="text-sm text-stone-600 dark:text-stone-300">No devices yet.</p>}
            {rows.map((r, i) => (
              <div key={r.key} className="grid grid-cols-2 gap-2 rounded-xl border border-stone-200 p-3 sm:grid-cols-[1fr_6rem_6rem_auto] dark:border-stone-800">
                <div className="col-span-2 sm:col-span-1">
                  <label className="text-xs font-medium" htmlFor={`${r.key}-n`}>Device {i + 1} name</label>
                  <input id={`${r.key}-n`} className={inputCls} value={r.name} maxLength={60} onChange={(e) => setRow(r.key, { name: e.target.value })} />
                </div>
                <div>
                  <label className="text-xs font-medium" htmlFor={`${r.key}-k`}>Device {i + 1} power (kW)</label>
                  <input id={`${r.key}-k`} inputMode="decimal" className={inputCls} value={r.kw} onChange={(e) => setRow(r.key, { kw: e.target.value })} />
                </div>
                <div>
                  <label className="text-xs font-medium" htmlFor={`${r.key}-h`}>Device {i + 1} typical hours</label>
                  <input id={`${r.key}-h`} inputMode="numeric" className={inputCls} value={r.hours} onChange={(e) => setRow(r.key, { hours: e.target.value })} />
                </div>
                <div className="col-span-2 flex items-end sm:col-span-1">
                  <button
                    type="button"
                    className={btnCls}
                    aria-label={`Delete device ${i + 1}`}
                    onClick={() => {
                      if (r.id) setRemoved((x) => [...x, r.id as string])
                      setRows((x) => x.filter((y) => y.key !== r.key))
                    }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
            <button type="button" className={btnCls} disabled={rows.length >= 25} onClick={() => setRows((r) => [...r, blankRow()])}>
              Add device
            </button>
          </fieldset>

          <div className="flex items-center gap-3">
            <button type="submit" disabled={saving} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      )}
      {msg && (
        <p role={msg.ok ? 'status' : 'alert'} className={`text-sm ${msg.ok ? '' : 'text-amber-700 dark:text-amber-300'}`}>
          {msg.text}
        </p>
      )}

      <NotificationsSection />
      <PlansSection />

      <section className="space-y-3 rounded-2xl border border-red-300 p-4 dark:border-red-800">
        <h2 className="text-lg font-semibold">Delete my data</h2>
        <p className="text-sm text-stone-600 dark:text-stone-300">
          Permanently deletes your account, conversations, profile, devices, plans and feedback. See the{' '}
          <Link className="underline" to="/privacy">privacy notice</Link>.
        </p>
        {!confirming ? (
          <button type="button" className={btnCls} onClick={() => setConfirming(true)}>Delete my data…</button>
        ) : (
          <div role="dialog" aria-modal="true" aria-labelledby={`${ids.confirm}-t`} className="space-y-2">
            <p id={`${ids.confirm}-t`} className="text-sm font-medium">Type DELETE to confirm. This cannot be undone.</p>
            <label htmlFor={ids.confirm} className="sr-only">Type DELETE to confirm</label>
            <input id={ids.confirm} className={inputCls} value={typed} autoComplete="off" onChange={(e) => setTyped(e.target.value)} />
            <div className="flex gap-2">
              <button
                type="button"
                disabled={typed !== 'DELETE' || deleting}
                className="rounded-lg bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-800 disabled:opacity-50"
                onClick={() => void deleteAll()}
              >
                Permanently delete
              </button>
              <button type="button" className={btnCls} onClick={() => { setConfirming(false); setTyped('') }}>Cancel</button>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
