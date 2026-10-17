import { useId, useState } from 'react'
import { apiFetch } from './auth'

type Phase = 'idle' | 'comment' | 'sending' | 'done' | 'error'

/** Thumbs up/down under an assistant answer, with an optional short comment (FR-9.4). */
export function Feedback({ turnId }: { turnId: string }) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [rating, setRating] = useState<1 | -1 | null>(null)
  const [comment, setComment] = useState('')
  const id = useId()

  const submit = async (r: 1 | -1, text: string) => {
    setPhase('sending')
    try {
      const res = await apiFetch('/api/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ turn_id: turnId, rating: r, comment: text.trim() || null }),
      })
      setPhase(res.ok ? 'done' : 'error')
    } catch {
      setPhase('error')
    }
  }

  if (phase === 'done') return <p className="mt-1 text-xs text-ink-3">Thanks for the feedback.</p>

  const btn =
    'rounded-md border border-line-strong px-2 py-0.5 text-xs hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50'
  return (
    <div className="mt-1 text-xs">
      <div className="flex items-center gap-2">
        <span className="text-ink-3">Was this helpful?</span>
        <button type="button" className={btn} aria-label="Helpful" disabled={phase === 'sending'} onClick={() => { setRating(1); setPhase('comment') }}>
          <span aria-hidden="true">👍</span>
        </button>
        <button type="button" className={btn} aria-label="Not helpful" disabled={phase === 'sending'} onClick={() => { setRating(-1); setPhase('comment') }}>
          <span aria-hidden="true">👎</span>
        </button>
      </div>
      {(phase === 'comment' || phase === 'error' || phase === 'sending') && rating !== null && (
        <form
          className="mt-1 flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void submit(rating, comment)
          }}
        >
          <label htmlFor={id} className="sr-only">Optional comment</label>
          <input
            id={id}
            value={comment}
            maxLength={300}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Optional comment"
            className="min-w-0 flex-1 rounded-md border border-line-strong bg-surface px-2 py-1"
          />
          <button type="submit" disabled={phase === 'sending'} className={btn}>Send feedback</button>
          {phase === 'error' && <span role="alert" className="text-amber-700 dark:text-amber-300">Could not send. Try again.</span>}
        </form>
      )}
    </div>
  )
}
