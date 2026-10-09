import { useState } from 'react'
import { enablePush, isPushSupported, UNSUPPORTED_MESSAGE } from './push'

/** "Turn on notifications" button with its own status line. Calls onEnabled after a successful opt-in. */
export function PushOptIn({ onEnabled }: { onEnabled?: () => void }) {
  const [busy, setBusy] = useState(false)
  const supported = isPushSupported()
  const [msg, setMsg] = useState<string | null>(supported ? null : UNSUPPORTED_MESSAGE)
  const [done, setDone] = useState(false)
  const run = async () => {
    setBusy(true)
    setMsg(null)
    const r = await enablePush()
    setBusy(false)
    if (r.ok) {
      setDone(true)
      onEnabled?.()
    } else setMsg(r.message)
  }
  if (done) return <p role="status" className="text-xs text-stone-600 dark:text-stone-300">Notifications are on.</p>
  return (
    <div className="space-y-1">
      {supported && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void run()}
          className="rounded-md border border-stone-300 px-2 py-1 text-xs font-medium hover:bg-stone-100 focus-visible:outline-2 focus-visible:outline-brand-600 disabled:opacity-50 dark:border-stone-700 dark:hover:bg-stone-800"
        >
          Turn on notifications
        </button>
      )}
      {msg && <p role="status" className="text-xs text-stone-600 dark:text-stone-300">{msg}</p>}
    </div>
  )
}
