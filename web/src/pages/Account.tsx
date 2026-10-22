import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { profileResponseSchema, type ProfileUpdate } from '../../agent/harness/api_schemas'
import { apiFetch } from '../assistant/auth'
import { PlansSection } from '../assistant/SettingsSections'
import { SignInPrompt } from '../assistant/SignInPrompt'
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

const inputCls = 'w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm'
const btnCls =
  'rounded-lg border border-line-strong px-3 py-1.5 text-sm font-medium hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50'

/** Signed-in home for what the assistant remembers: saved devices and scheduled plans. */
export function Account() {
  const auth = useAuth()
  if (!auth.ready) return <p role="status">Loading…</p>
  if (!auth.enabled || !auth.info || auth.info.isAnonymous) {
    return <SignInPrompt title="Devices & schedule" reason="Sign in to save your devices and see your scheduled jobs." enabled={auth.enabled} />
  }
  return (
    <div className="max-w-2xl space-y-8">
      <header className="space-y-1">
        <h1 className="page-title">Devices &amp; schedule</h1>
        <p className="text-sm text-ink-2">
          The assistant uses your saved devices when you mention them, and plans you save appear in your schedule. Ask for a
          plan on <Link className="underline" to="/scheduler">Plan a job</Link>.
        </p>
      </header>
      <section className="card space-y-3 p-4 sm:p-5">
        <DevicesEditor />
      </section>
      <section className="card p-4 sm:p-5">
        <PlansSection />
      </section>
    </div>
  )
}

function DevicesEditor() {
  const [rows, setRows] = useState<DeviceRow[] | null>(null)
  const [removed, setRemoved] = useState<string[]>([])
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [saving, setSaving] = useState(false)

  const apply = (p: ReturnType<typeof profileResponseSchema.parse>) => {
    setRows(p.devices.map((d) => ({ key: d.id, id: d.id, name: d.name, kw: String(d.kw), hours: d.typical_hours === null ? '' : String(d.typical_hours) })))
    setRemoved([])
  }

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const res = await apiFetch('/api/profile')
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const parsed = profileResponseSchema.parse(await res.json())
        if (live) apply(parsed)
      } catch (e) {
        if (live) setLoadErr(e instanceof Error ? e.message : 'Could not load')
      }
    })()
    return () => {
      live = false
    }
  }, [])

  const setRow = (key: string, patch: Partial<DeviceRow>) => setRows((r) => (r ?? []).map((x) => (x.key === key ? { ...x, ...patch } : x)))

  async function save(e: FormEvent) {
    e.preventDefault()
    setMsg(null)
    const devices: NonNullable<ProfileUpdate['upsert_devices']> = []
    for (const r of rows ?? []) {
      const kw = Number(r.kw)
      const hours = r.hours.trim() === '' ? null : Number(r.hours)
      if (!r.name.trim() || !(kw > 0) || kw > 10000 || (hours !== null && (!Number.isInteger(hours) || hours < 1 || hours > 12))) {
        setMsg({ ok: false, text: 'Each device needs a name, a power above 0 kW, and typical hours of 1 to 12 (or blank).' })
        return
      }
      devices.push({ ...(r.id ? { id: r.id } : {}), name: r.name.trim(), kw, typical_hours: hours })
    }
    const body: ProfileUpdate = { upsert_devices: devices, delete_device_ids: removed }
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

  return (
    <form onSubmit={(e) => void save(e)} className="space-y-3" aria-labelledby="devices-h">
      <h2 id="devices-h" className="text-lg font-semibold">Your devices</h2>
      {loadErr && <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">Could not load your devices ({loadErr}).</p>}
      {rows === null && !loadErr && <p role="status" className="text-sm">Loading…</p>}
      {rows !== null && (
        <>
          {rows.length === 0 && <p className="text-sm text-ink-2">No devices yet. Add one, or tell the assistant about it.</p>}
          {rows.map((r, i) => (
            <div key={r.key} className="grid grid-cols-2 gap-2 rounded-xl border border-line p-3 sm:grid-cols-[1fr_6rem_6rem_auto]">
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
                    setRows((x) => (x ?? []).filter((y) => y.key !== r.key))
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <button type="button" className={btnCls} disabled={rows.length >= 25} onClick={() => setRows((r) => [...(r ?? []), blankRow()])}>
              Add device
            </button>
            <button type="submit" disabled={saving} className="btn-primary py-1.5">
              {saving ? 'Saving…' : 'Save devices'}
            </button>
          </div>
        </>
      )}
      {msg && (
        <p role={msg.ok ? 'status' : 'alert'} className={`text-sm ${msg.ok ? '' : 'text-amber-700 dark:text-amber-300'}`}>
          {msg.text}
        </p>
      )}
    </form>
  )
}
