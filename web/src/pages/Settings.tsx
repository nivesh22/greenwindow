import { useEffect, useId, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { profileResponseSchema, type ProfileUpdate } from '../../agent/harness/api_schemas'
import { MODES } from '../../agent/harness/events'
import { apiFetch, signOut } from '../assistant/auth'
import { NotificationsSection } from '../assistant/SettingsSections'
import { SignInPrompt } from '../assistant/SignInPrompt'
import { useAuth } from '../assistant/useAuth'

const inputCls = 'w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm'
const btnCls =
  'rounded-lg border border-line-strong px-3 py-1.5 text-sm font-medium hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50'

export function Settings() {
  const auth = useAuth()
  if (!auth.ready) return <p role="status">Loading…</p>
  if (!auth.enabled || !auth.info || auth.info.isAnonymous) {
    return <SignInPrompt title="Settings" reason="Sign in to save your profile and preferences." enabled={auth.enabled} />
  }
  return <SettingsForm email={auth.info.email} />
}

function SettingsForm({ email }: { email: string | null }) {
  const ids = { name: useId(), risk: useId(), from: useId(), to: useId(), confirm: useId() }
  const [loaded, setLoaded] = useState(false)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [risk, setRisk] = useState<(typeof MODES)[number]>('expected')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
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
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    setMsg(null)
    const body: ProfileUpdate = {
      profile: { display_name: name.trim() || null, risk_default: risk, quiet_from: from || null, quiet_to: to || null },
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
        <h1 className="page-title">Settings</h1>
        <p className="text-sm text-ink-2">
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

          <div className="flex items-center gap-3">
            <button type="submit" disabled={saving} className="btn-primary">
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

      <p className="text-sm text-ink-2">
        Your saved devices and scheduled jobs are on <Link className="underline" to="/account">Devices &amp; schedule</Link>.
      </p>

      <NotificationsSection />

      <section className="space-y-3 rounded-2xl border border-red-300 p-4 dark:border-red-800">
        <h2 className="font-display text-xl font-semibold">Delete my data</h2>
        <p className="text-sm text-ink-2">
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
