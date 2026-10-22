import { useState } from 'react'
import { Link } from 'react-router-dom'
import { signInWithGoogle } from './auth'

/** Shown on signed-in-only pages (Settings, Devices & schedule) to visitors and guests. */
export function SignInPrompt({ title, reason, enabled }: { title: string; reason: string; enabled: boolean }) {
  const [err, setErr] = useState<string | null>(null)
  return (
    <section className="max-w-xl space-y-3">
      <h1 className="page-title">{title}</h1>
      <p className="text-ink-2">{reason}</p>
      {enabled ? (
        <button
          type="button"
          className="btn-primary"
          onClick={() => signInWithGoogle().catch((e: unknown) => setErr(e instanceof Error ? e.message : 'Sign-in failed'))}
        >
          Continue with Google
        </button>
      ) : (
        <p className="text-sm">Sign-in is not enabled on this deployment.</p>
      )}
      {err && <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">Sign-in failed ({err}).</p>}
      <p className="text-xs text-ink-3">
        We only read your email and name. See the <Link className="underline" to="/privacy">privacy notice</Link>.
      </p>
    </section>
  )
}
