import { useId, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { MAX_CHARS, STARTERS } from './flag'

/** Path that opens the planner and sends `text` to the assistant once (read by the Scheduler page). */
const askPath = (text: string): string => `/scheduler?ask=${encodeURIComponent(text.slice(0, MAX_CHARS))}`

/** Home-page entry to the assistant: a real prompt box, so visitors see the agent rather than read about it. */
export function AssistantPromo() {
  const navigate = useNavigate()
  const [draft, setDraft] = useState('')
  const inputId = useId()
  const ask = (text: string) => {
    if (text.trim()) void navigate(askPath(text.trim()))
  }

  return (
    <section aria-labelledby={`${inputId}-title`} className="card relative overflow-hidden">
      <div aria-hidden className="pointer-events-none absolute -top-24 -right-24 h-64 w-64 rounded-full bg-accent/10 blur-3xl" />
      <div className="relative grid gap-6 p-5 sm:p-7 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:items-center">
        <div>
          <p className="inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-1 text-xs font-semibold text-accent-ink">
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true" fill="currentColor">
              <path d="M8 1.5l1.4 3.6 3.6 1.4-3.6 1.4L8 11.5 6.6 7.9 3 6.5l3.6-1.4zM12.5 10.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z" />
            </svg>
            AI assistant
          </p>
          <h2 id={`${inputId}-title`} className="mt-3 font-display text-2xl font-semibold tracking-tight sm:text-3xl">
            Just say what you need to run.
          </h2>
          <p className="mt-2 leading-relaxed text-ink-2">
            Describe a job in plain words, like charging an EV by 7am or a 6-hour GPU run. The GreenWindow Assistant reads
            the live forecast, plans the cleanest start time, and shows how sure it is. Every number comes from the
            forecast tools, not from the language model.
          </p>
        </div>
        <div>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              ask(draft)
            }}
            className="flex flex-col gap-2 sm:flex-row"
          >
            <label htmlFor={inputId} className="sr-only">Ask the assistant</label>
            <input
              id={inputId}
              value={draft}
              maxLength={MAX_CHARS}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="e.g. 2-hour wash, done by 6pm"
              className="field min-w-0 flex-1 py-2.5"
            />
            <button type="submit" disabled={!draft.trim()} className="btn-primary py-2.5">
              Ask the assistant
            </button>
          </form>
          <p className="mt-4 text-xs font-medium text-ink-3">Or try one:</p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {STARTERS.map((s) => (
              <li key={s}>
                <button
                  type="button"
                  onClick={() => ask(s)}
                  className="cursor-pointer rounded-full border border-line-strong bg-surface px-3 py-1.5 text-left text-sm text-ink-2 transition-colors hover:border-accent/50 hover:bg-accent-soft hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
                >
                  {s}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  )
}
