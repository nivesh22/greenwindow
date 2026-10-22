import { useEffect, useState } from 'react'
import { conversationListSchema, type ConversationList } from '../../agent/harness/api_schemas'
import { formatDateTime } from '../lib/time'
import { apiFetch } from './auth'

type Item = ConversationList['conversations'][number]

interface Props {
  currentId: string | null
  onPick: (id: string) => void
}

/** Signed-in chat history: past conversations, newest first. Picking one opens it in the chat. */
export function ChatHistory({ currentId, onPick }: Props) {
  const [items, setItems] = useState<Item[] | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const res = await apiFetch('/api/conversations')
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const parsed = conversationListSchema.parse(await res.json())
        if (live) setItems(parsed.conversations)
      } catch (e) {
        if (live) setErr(e instanceof Error ? e.message : 'error')
      }
    })()
    return () => {
      live = false
    }
  }, [])

  return (
    <nav aria-label="Chat history" className="space-y-2">
      <h3 className="text-sm font-medium text-ink-2">Previous chats</h3>
      {err && <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">Could not load your chats ({err}).</p>}
      {items === null && !err && <p role="status" className="text-sm text-ink-3">Loading…</p>}
      {items !== null && items.length === 0 && <p className="text-sm text-ink-3">No previous chats yet.</p>}
      <ul className="space-y-1">
        {items?.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              onClick={() => onPick(c.id)}
              aria-current={c.id === currentId ? 'true' : undefined}
              className={`block w-full cursor-pointer rounded-xl border px-3.5 py-2.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-accent ${
                c.id === currentId ? 'border-accent/50 bg-accent-soft' : 'border-line hover:bg-surface-2'
              }`}
            >
              <span className="block truncate text-sm text-ink">{c.title ?? 'Untitled chat'}</span>
              <span className="block text-xs text-ink-3">{formatDateTime(c.updated_at_utc)}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  )
}
