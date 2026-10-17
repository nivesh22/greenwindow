import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import type { PanelState, PlanUpdate } from '../../agent/harness/events'
import { ChatActions } from './ChatActions'
import { AccountMenu } from './AccountMenu'
import { Feedback } from './Feedback'
import { FormattedText } from './FormattedText'
import { MAX_CHARS, STARTERS } from './flag'
import { TraceDrawer } from './TraceDrawer'
import { useAuth } from './useAuth'
import { useChat } from './useChat'

interface Props {
  getPanelState?: () => PanelState | null
  onPlanUpdate?: (u: PlanUpdate) => void
  /** Sent once on mount, e.g. a question typed on the home page. */
  initialMessage?: string | null
}

export function ChatPanel({ getPanelState = () => null, onPlanUpdate, initialMessage }: Props) {
  const chat = useChat({ getPanelState, onPlanUpdate })
  const auth = useAuth()
  const [draft, setDraft] = useState('')
  const inputId = useId()
  const unavailable = chat.limit ?? chat.error
  const blocked = chat.limit !== null

  const submit = (text: string) => {
    if (!text.trim() || chat.busy || blocked) return
    setDraft('')
    void chat.send(text).then((ok) => {
      if (!ok) setDraft((d) => d || text)
    })
  }
  const initialSent = useRef(false)
  const submitRef = useRef(submit)
  useEffect(() => {
    submitRef.current = submit
  })
  useEffect(() => {
    if (!initialMessage || initialSent.current) return
    initialSent.current = true // a ref, so StrictMode's second effect run does not send twice
    submitRef.current(initialMessage)
  }, [initialMessage])
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit(draft)
    }
  }

  return (
    <section aria-label="Assistant" className="card p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="flex items-center gap-2.5">
          <span aria-hidden="true" className="grid h-8 w-8 place-items-center rounded-full bg-accent-soft text-accent">
            <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 5.5h12v7H9l-3.5 3v-3H4z" />
            </svg>
          </span>
          <h2 className="font-display text-lg font-semibold">Ask the assistant</h2>
        </div>
        <AccountMenu auth={auth} messagesLeft={chat.messagesLeft} />
      </div>

      <div aria-live="polite" role="log" aria-label="Conversation" className="mt-4 space-y-3 lg:max-h-[min(60vh,40rem)] lg:overflow-y-auto lg:pr-1">
        {chat.messages.length === 0 && (
          <div className="space-y-2">
            <p className="text-sm text-ink-3">Describe a job in plain words, or try one of these:</p>
            {STARTERS.map((s) => (
              <button
                key={s}
                type="button"
                disabled={chat.busy || blocked}
                onClick={() => submit(s)}
                className="group flex w-full cursor-pointer items-center justify-between gap-3 rounded-xl border border-line px-3.5 py-2.5 text-left text-sm text-ink-2 transition-colors hover:border-accent/50 hover:bg-accent-soft hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"
              >
                {s}
                <svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4 shrink-0 text-ink-3 group-hover:text-accent" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 8h10M9 4l4 4-4 4" /></svg>
              </button>
            ))}
          </div>
        )}
        {chat.messages.map((m) => (
          <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : 'flex flex-col items-start'}>
            <div
              className={`max-w-[92%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed break-words ${
                m.role === 'user' ? 'rounded-br-md bg-brand-600 text-white' : 'rounded-bl-md bg-surface-2 text-ink'
              }`}
            >
              <span className="sr-only">{m.role === 'user' ? 'You: ' : 'Assistant: '}</span>
              <FormattedText text={m.text} />
            </div>
            {m.role === 'assistant' && m.actions && <ChatActions actions={m.actions} />}
            {m.role === 'assistant' && m.trace && <TraceDrawer trace={m.trace} />}
            {m.role === 'assistant' && m.turnId && <Feedback turnId={m.turnId} />}
          </div>
        ))}
        {chat.checking && (
          <p role="status" className="text-sm text-ink-2">Checking you&apos;re human…</p>
        )}
        {chat.busy && !chat.checking && (
          <p role="status" className="flex items-center gap-2 text-sm text-ink-2">
            <span aria-hidden="true" className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-line-strong border-t-accent" />
            <span>{chat.status ?? 'Thinking...'}</span>
          </p>
        )}
      </div>

      {unavailable && (
        <div role="alert" className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
          <p className="font-medium">
            {chat.limit?.kind === 'budget_paused'
              ? 'Assistant paused for now — the plan panel still works.'
              : 'Assistant unavailable — the plan panel still works.'}
          </p>
          <p className="mt-1">{unavailable.message}</p>
        </div>
      )}

      {chat.limit?.signIn && (
        <div className="mt-3 space-y-2">
          <button
            type="button"
            onClick={() => void chat.signIn()}
            className="btn-primary w-full"
          >
            Continue with Google
          </button>
          <p className="text-xs text-ink-3">
            We only read your email and name. See the{' '}
            <a className="underline" href="/privacy" target="_blank" rel="noreferrer">privacy notice</a>.
          </p>
        </div>
      )}

      {!chat.limit?.signIn && (
      <form
        onSubmit={(e) => {
          e.preventDefault()
          submit(draft)
        }}
        className="mt-4 space-y-2"
      >
        <label htmlFor={inputId} className="sr-only">Message to the assistant</label>
        <textarea
          id={inputId}
          value={draft}
          maxLength={MAX_CHARS}
          rows={2}
          disabled={blocked}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          placeholder="Describe the job and when it must be done"
          className="field resize-none text-sm"
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-ink-3" aria-label="Characters used">
            {draft.length}/{MAX_CHARS}
          </span>
          <div className="flex gap-2">
            {chat.busy && (
              <button
                type="button"
                onClick={chat.stop}
                className="btn-secondary py-1.5"
              >
                Stop
              </button>
            )}
            <button
              type="submit"
              disabled={chat.busy || blocked || !draft.trim()}
              className="btn-primary py-1.5"
            >
              Send
            </button>
          </div>
        </div>
      </form>
      )}
      <p className="mt-3 border-t border-line pt-3 text-xs text-ink-3">
        GB national grid only · 48-hour forecast · estimates, not guarantees ·{' '}
        <a className="underline" href="/privacy" target="_blank" rel="noreferrer">Privacy</a>
      </p>
    </section>
  )
}
