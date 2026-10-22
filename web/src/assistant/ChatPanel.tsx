import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { PanelState, PlanUpdate } from '../../agent/harness/events'
import { Mascot } from '../components/Mascot'
import { AccountMenu } from './AccountMenu'
import { ChatActions } from './ChatActions'
import { ChatHistory } from './ChatHistory'
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

/** Within this many pixels of the bottom counts as "reading the latest", so new messages scroll into view. */
const STICK_PX = 80
/** The character counter appears once a message gets this long. */
const COUNTER_FROM = Math.floor(MAX_CHARS * 0.8)
const COMPOSER_MAX_PX = 160

const iconBtn =
  'grid h-8 w-8 cursor-pointer place-items-center rounded-lg text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40'

export function ChatPanel({ getPanelState = () => null, onPlanUpdate, initialMessage }: Props) {
  const chat = useChat({ getPanelState, onPlanUpdate })
  const auth = useAuth()
  const [draft, setDraft] = useState('')
  const [showHistory, setShowHistory] = useState(false)
  const [unseen, setUnseen] = useState(false)
  const inputId = useId()
  const logRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const stickRef = useRef(true)
  const unavailable = chat.limit ?? chat.error
  const blocked = chat.limit !== null
  const signedIn = auth.info !== null && !auth.info.isAnonymous
  const firstName = signedIn ? auth.info?.name?.split(/\s+/)[0] : undefined

  const submit = (text: string) => {
    if (!text.trim() || chat.busy || blocked) return
    setDraft('')
    stickRef.current = true // your own message always brings you to the bottom
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

  const scrollToEnd = useCallback((smooth: boolean) => {
    const el = logRef.current
    if (!el) return
    if (typeof el.scrollTo === 'function') el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
    else el.scrollTop = el.scrollHeight
    stickRef.current = true
    setUnseen(false)
  }, [])

  // New content: follow it when the reader is at the bottom, otherwise offer a "New message" pill.
  const last = chat.messages.at(-1)
  const contentKey = `${chat.messages.length}:${last?.text.length ?? 0}:${chat.busy}:${chat.status ?? ''}`
  useLayoutEffect(() => {
    if (chat.messages.length === 0) return
    if (stickRef.current) scrollToEnd(false)
    else setUnseen(true)
  }, [contentKey, chat.messages.length, scrollToEnd])

  // Opening another conversation starts at its end.
  useEffect(() => {
    stickRef.current = true
  }, [chat.conversationId])

  const onScroll = () => {
    const el = logRef.current
    if (!el) return
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX
    stickRef.current = atEnd
    if (atEnd) setUnseen(false)
  }

  // The composer grows with its text up to a few lines, then scrolls.
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_PX)}px`
  }, [draft])

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit(draft)
    }
  }

  const newChat = () => {
    chat.newChat()
    setShowHistory(false)
    setDraft('')
    inputRef.current?.focus()
  }
  const lastAssistant = chat.messages.findLastIndex((m) => m.role === 'assistant')

  return (
    <section
      aria-label="Assistant"
      className="card flex h-[min(44rem,calc(100dvh-9rem))] flex-col overflow-hidden lg:h-[min(40rem,calc(100dvh-8rem))]"
    >
      <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <Mascot className="h-9 w-9 shrink-0" />
          <div className="min-w-0">
            <h2 className="font-display text-base leading-tight font-semibold">Ask the assistant</h2>
            <AccountMenu auth={auth} messagesLeft={chat.messagesLeft} />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            className={iconBtn}
            aria-label="New chat"
            title="New chat"
            disabled={chat.busy || (chat.messages.length === 0 && !showHistory)}
            onClick={newChat}
          >
            <svg aria-hidden="true" viewBox="0 0 20 20" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 4H5.5A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16h9a1.5 1.5 0 0 0 1.5-1.5V10" />
              <path d="M14.2 3.3a1.4 1.4 0 0 1 2 2L10 11.5 7.5 12.5l1-2.5z" />
            </svg>
          </button>
          {signedIn && (
            <button
              type="button"
              className={`${iconBtn} ${showHistory ? 'bg-accent-soft text-accent' : ''}`}
              aria-label="History"
              title="Previous chats"
              aria-expanded={showHistory}
              onClick={() => setShowHistory((s) => !s)}
            >
              <svg aria-hidden="true" viewBox="0 0 20 20" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3.5 10a6.5 6.5 0 1 0 1.9-4.6" />
                <path d="M3.5 3.5v3h3" />
                <path d="M10 6.5V10l2.5 1.5" />
              </svg>
            </button>
          )}
        </div>
      </header>

      <div className="relative min-h-0 flex-1">
        <div
          ref={logRef}
          onScroll={onScroll}
          aria-live="polite"
          role="log"
          aria-label="Conversation"
          className="h-full space-y-4 overflow-y-auto overscroll-contain px-4 py-4"
        >
          {chat.messages.length === 0 && (
            <div className="flex h-full flex-col justify-end gap-3 pb-1">
              <div className="flex items-end gap-3">
                <Mascot className="h-14 w-14 shrink-0" />
                <p className="font-display text-lg font-semibold">{firstName ? `Hi ${firstName}.` : 'Hi there.'}</p>
              </div>
              <div>
                <p className="text-sm text-ink-2">
                  Tell me about a job and when it must be done. I&apos;ll find the hours with the lowest forecast grid
                  intensity.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {STARTERS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    disabled={chat.busy || blocked}
                    onClick={() => submit(s)}
                    className="cursor-pointer rounded-full border border-line bg-surface px-3 py-1.5 text-left text-xs text-ink-2 transition-colors hover:border-accent/50 hover:bg-accent-soft hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {chat.messages.map((m, i) =>
            m.role === 'user' ? (
              <div key={m.id} className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl rounded-br-md bg-brand-600 px-3.5 py-2 text-sm leading-relaxed break-words text-white">
                  <span className="sr-only">You: </span>
                  <FormattedText text={m.text} />
                </div>
              </div>
            ) : (
              <div key={m.id} className="group flex items-start gap-2">
                <Mascot className="h-8 w-8 shrink-0" />
                <div className="flex min-w-0 flex-1 flex-col items-start">
                  <div className="max-w-[95%] rounded-2xl rounded-tl-md bg-surface-2 px-3.5 py-2.5 text-sm leading-relaxed break-words text-ink">
                    <span className="sr-only">Assistant: </span>
                    <FormattedText text={m.text} />
                  </div>
                  {m.actions && <ChatActions actions={m.actions} />}
                  {(m.turnId || m.trace) && (
                    <div
                      className={`mt-1 flex w-full flex-wrap items-center gap-x-1 transition-opacity ${
                        i === lastAssistant ? '' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100'
                      }`}
                    >
                      {m.turnId && <Feedback turnId={m.turnId} />}
                      {m.trace && <TraceDrawer trace={m.trace} />}
                    </div>
                  )}
                </div>
              </div>
            ),
          )}
          {chat.checking && (
            <p role="status" className="text-xs text-ink-3">Checking you&apos;re human…</p>
          )}
          {chat.busy && !chat.checking && (
            <div role="status" className="flex items-start gap-2">
              <Mascot className="h-8 w-8 shrink-0" />
              <div className="flex flex-col items-start gap-1">
                <span className="rounded-2xl rounded-tl-md bg-surface-2 px-3.5 py-3" aria-hidden="true">
                  <span className="flex gap-1">
                    {[0, 150, 300].map((d) => (
                      <span key={d} className="h-1.5 w-1.5 animate-bounce rounded-full bg-ink-3" style={{ animationDelay: `${d}ms` }} />
                    ))}
                  </span>
                </span>
                <span className="text-xs text-ink-3">{chat.status ?? 'Thinking...'}</span>
              </div>
            </div>
          )}
        </div>

        {unseen && !showHistory && (
          <button
            type="button"
            onClick={() => scrollToEnd(true)}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 cursor-pointer rounded-full bg-ink px-3 py-1 text-xs font-medium text-canvas shadow-lg focus-visible:outline-2 focus-visible:outline-accent"
          >
            New message ↓
          </button>
        )}

        {showHistory && (
          <div className="absolute inset-0 overflow-y-auto bg-surface px-4 py-4">
            <ChatHistory
              currentId={chat.conversationId}
              onPick={(id) => {
                void chat.openConversation(id).then((ok) => {
                  if (ok) setShowHistory(false)
                })
              }}
            />
          </div>
        )}
      </div>

      {unavailable && (
        <div role="alert" className="mx-3 mb-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
          <p className="font-medium">
            {chat.limit?.kind === 'budget_paused'
              ? 'Assistant paused for now — the plan panel still works.'
              : 'Assistant unavailable — the plan panel still works.'}
          </p>
          <p className="mt-0.5 text-xs">{unavailable.message}</p>
        </div>
      )}

      {chat.limit?.signIn ? (
        <div className="space-y-2 border-t border-line p-3">
          <button type="button" onClick={() => void chat.signIn()} className="btn-primary w-full">
            Continue with Google
          </button>
          <p className="text-xs text-ink-3">
            We only read your email and name. See the{' '}
            <a className="underline" href="/privacy" target="_blank" rel="noreferrer">privacy notice</a>.
          </p>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            submit(draft)
          }}
          className="border-t border-line p-3"
        >
          <div className="flex items-end gap-2 rounded-2xl border border-line-strong bg-surface py-1.5 pr-1.5 pl-3.5 transition-colors focus-within:border-accent">
            <label htmlFor={inputId} className="sr-only">Message to the assistant</label>
            <textarea
              id={inputId}
              ref={inputRef}
              value={draft}
              maxLength={MAX_CHARS}
              rows={1}
              disabled={blocked}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKey}
              placeholder="Describe a job and its deadline"
              className="max-h-40 min-h-[2.25rem] flex-1 resize-none bg-transparent py-1.5 text-sm leading-relaxed outline-none placeholder:text-ink-3 disabled:opacity-50"
            />
            {chat.busy ? (
              <button type="button" onClick={chat.stop} aria-label="Stop" title="Stop" className="grid h-9 w-9 shrink-0 cursor-pointer place-items-center rounded-full border border-line-strong text-ink hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent">
                <svg aria-hidden="true" viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="currentColor"><rect x="5" y="5" width="10" height="10" rx="2" /></svg>
              </button>
            ) : (
              <button
                type="submit"
                aria-label="Send"
                title="Send (Enter)"
                disabled={blocked || !draft.trim()}
                className="grid h-9 w-9 shrink-0 cursor-pointer place-items-center rounded-full bg-brand-600 text-white transition-colors hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-ink-3"
              >
                <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10 16V4M5 9l5-5 5 5" />
                </svg>
              </button>
            )}
          </div>
          <div className="mt-1.5 flex items-center justify-between gap-2 px-1 text-[11px] text-ink-3">
            <span>
              GB national grid only · estimates, not guarantees ·{' '}
              <a className="underline" href="/privacy" target="_blank" rel="noreferrer">Privacy</a>
            </span>
            {draft.length >= COUNTER_FROM && (
              <span aria-label="Characters used" className={draft.length >= MAX_CHARS ? 'text-amber-700 dark:text-amber-300' : ''}>
                {draft.length}/{MAX_CHARS}
              </span>
            )}
          </div>
        </form>
      )}
    </section>
  )
}
