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

  if (phase === 'done') return <p className="px-1 text-xs text-ink-3">Thanks for the feedback.</p>

  const btn =
    'rounded-md border border-line-strong px-2 py-0.5 text-xs hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50'
  const thumb = (on: boolean) =>
    `grid h-7 w-7 cursor-pointer place-items-center rounded-md transition-colors hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50 ${
      on ? 'text-accent' : 'text-ink-3'
    }`
  const icon = (down: boolean) => (
    <svg aria-hidden="true" viewBox="0 0 20 20" className={`h-4 w-4 ${down ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6.5 9v7H4V9zM6.5 9l3-5.5a1.6 1.6 0 0 1 2.9 1.2L11.6 8h3.6a1.5 1.5 0 0 1 1.5 1.8l-1.2 5A1.5 1.5 0 0 1 14 16H6.5" />
    </svg>
  )
  return (
    <div className="text-xs">
      <div className="flex items-center">
        <span className="sr-only">Was this helpful?</span>
        <button type="button" className={thumb(rating === 1)} aria-label="Helpful" title="Helpful" disabled={phase === 'sending'} onClick={() => { setRating(1); setPhase('comment') }}>
          {icon(false)}
        </button>
        <button type="button" className={thumb(rating === -1)} aria-label="Not helpful" title="Not helpful" disabled={phase === 'sending'} onClick={() => { setRating(-1); setPhase('comment') }}>
          {icon(true)}
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
