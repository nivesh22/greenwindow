import { useId, useState, type KeyboardEvent } from 'react'
import type { PanelState, PlanUpdate } from '../../agent/harness/events'
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
}

export function ChatPanel({ getPanelState = () => null, onPlanUpdate }: Props) {
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
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit(draft)
    }
  }

  return (
    <section aria-label="Assistant" className="rounded-2xl border border-stone-200 bg-white p-4 sm:p-5 dark:border-stone-800 dark:bg-stone-900">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-lg font-semibold">Ask the assistant</h2>
        <AccountMenu auth={auth} messagesLeft={chat.messagesLeft} />
      </div>

      <div aria-live="polite" role="log" aria-label="Conversation" className="mt-3 space-y-3">
        {chat.messages.length === 0 && (
          <div className="flex flex-wrap gap-2">
            {STARTERS.map((s) => (
              <button
                key={s}
                type="button"
                disabled={chat.busy || blocked}
                onClick={() => submit(s)}
                className="rounded-full border border-stone-300 px-3 py-1.5 text-left text-sm hover:bg-stone-100 focus-visible:outline-2 focus-visible:outline-brand-600 disabled:opacity-50 dark:border-stone-700 dark:hover:bg-stone-800"
              >
                {s}
              </button>
            ))}
          </div>
        )}
        {chat.messages.map((m) => (
          <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : 'flex flex-col items-start'}>
            <div
              className={`max-w-[92%] rounded-2xl px-3 py-2 text-sm break-words ${
                m.role === 'user' ? 'bg-brand-600 text-white' : 'bg-stone-100 text-stone-900 dark:bg-stone-800 dark:text-stone-100'
              }`}
            >
              <span className="sr-only">{m.role === 'user' ? 'You: ' : 'Assistant: '}</span>
              <FormattedText text={m.text} />
            </div>
            {m.role === 'assistant' && m.trace && <TraceDrawer trace={m.trace} />}
            {m.role === 'assistant' && m.turnId && <Feedback turnId={m.turnId} />}
          </div>
        ))}
        {chat.checking && (
          <p role="status" className="text-sm text-stone-600 dark:text-stone-300">Checking you&apos;re human…</p>
        )}
        {chat.busy && !chat.checking && (
          <p role="status" className="flex items-center gap-2 text-sm text-stone-600 dark:text-stone-300">
            <span aria-hidden="true" className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-stone-300 border-t-brand-600" />
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
            className="w-full rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-brand-600"
          >
            Continue with Google
          </button>
          <p className="text-xs text-stone-500 dark:text-stone-400">
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
        className="mt-3 space-y-2"
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
          className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm dark:border-stone-700 dark:bg-stone-950"
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-stone-500 dark:text-stone-400" aria-label="Characters used">
            {draft.length}/{MAX_CHARS}
          </span>
          <div className="flex gap-2">
            {chat.busy && (
              <button
                type="button"
                onClick={chat.stop}
                className="rounded-lg border border-stone-300 px-3 py-1.5 text-sm font-medium hover:bg-stone-100 dark:border-stone-700 dark:hover:bg-stone-800"
              >
                Stop
              </button>
            )}
            <button
              type="submit"
              disabled={chat.busy || blocked || !draft.trim()}
              className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
            >
              Send
            </button>
          </div>
        </div>
      </form>
      )}
      <p className="mt-2 text-xs text-stone-500 dark:text-stone-400">
        GB national grid only · 48-hour forecast · estimates, not guarantees ·{' '}
        <a className="underline" href="/privacy" target="_blank" rel="noreferrer">Privacy</a>
      </p>
    </section>
  )
}
