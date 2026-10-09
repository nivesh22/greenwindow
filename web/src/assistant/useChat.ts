import { useCallback, useEffect, useRef, useState } from 'react'
import { HISTORY_MAX, type ActionEvent, type ChatRequest, type PanelState, type PlanUpdate, type StopReason, type TraceSummary } from '../../agent/harness/events'
import { conversationResponseSchema } from '../../agent/harness/api_schemas'
import { apiFetch, authEnabled, ensureSession, getAuthInfo, getClient, mergeAnonymousIfPending, signInWithGoogle, storeHeldMessage, takeHeldMessage } from './auth'
import { parseSse } from './sse'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  turnId?: string
  trace?: TraceSummary
  stopReason?: StopReason
  actions?: ActionEvent[]
}
export interface LimitState { kind: string; message: string; signIn: boolean }
export interface ChatError { code: string; message: string }

export interface UseChatOptions {
  getPanelState?: () => PanelState | null
  onPlanUpdate?: (u: PlanUpdate) => void
  endpoint?: string
}

const nowUtc = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

async function httpError(res: Response): Promise<ChatError> {
  try {
    const body: unknown = await res.json()
    if (typeof body === 'object' && body !== null && 'error' in body) {
      const e = (body as { error: unknown }).error
      if (typeof e === 'object' && e !== null) {
        const { code, message } = e as { code?: unknown; message?: unknown }
        if (typeof message === 'string') return { code: typeof code === 'string' ? code : `http_${res.status}`, message }
      }
    }
  } catch {
    // fall through to the generic message
  }
  return { code: `http_${res.status}`, message: `The assistant returned an error (HTTP ${res.status}).` }
}

export function useChat(opts: UseChatOptions = {}) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  // Messages before the one being sent, for the request's `history` (no server-side history until P3).
  const historyRef = useRef<ChatMessage[]>([])
  useEffect(() => {
    historyRef.current = messages
  }, [messages])
  const [status, setStatus] = useState<string | null>(null)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [limit, setLimit] = useState<LimitState | null>(null)
  const [error, setError] = useState<ChatError | null>(null)
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(false)
  const [messagesLeft, setMessagesLeft] = useState<number | null>(null)
  const lastUserRef = useRef('')

  const optsRef = useRef(opts)
  useEffect(() => {
    optsRef.current = opts
  })
  const convRef = useRef<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const busyRef = useRef(false)
  const seq = useRef(0)

  useEffect(() => () => abortRef.current?.abort(), [])

  const stop = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const send = useCallback(async (raw: string): Promise<boolean> => {
    const message = raw.trim()
    if (!message || message.length > 2000 || busyRef.current) return false
    busyRef.current = true
    setBusy(true)
    setError(null)
    setStatus(null)
    if (authEnabled()) {
      setChecking(true)
      try {
        await ensureSession()
      } catch (e) {
        setError({
          code: 'auth_failed',
          message: `Could not verify your session${e instanceof Error ? ` (${e.message})` : ''}. Please try again.`,
        })
        busyRef.current = false
        setBusy(false)
        return false
      } finally {
        setChecking(false)
      }
    }
    lastUserRef.current = message
    setMessages((m) => [...m, { id: `m${++seq.current}`, role: 'user', text: message }])
    const ctrl = new AbortController()
    abortRef.current = ctrl
    const body: ChatRequest = {
      conversation_id: convRef.current,
      message,
      history: historyRef.current
        .filter((m) => m.text.length > 0)
        .slice(-HISTORY_MAX)
        .map((m) => ({ role: m.role, content: m.text.slice(0, 4000) })),
      panel_state: optsRef.current.getPanelState?.() ?? null,
      client_now_utc: nowUtc(),
    }
    let finished = false
    let pending: ActionEvent[] = [] // actions that arrive before the answer
    let answered = false
    try {
      const res = await apiFetch(optsRef.current.endpoint ?? '/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })
      if (!res.ok) {
        setError(await httpError(res))
        return false
      }
      if (!res.body) {
        setError({ code: 'no_body', message: 'The assistant sent an empty response.' })
        return false
      }
      for await (const item of parseSse(res.body)) {
        if (!item.ok) {
          finished = true
          setError({ code: 'bad_event', message: 'The assistant sent a response this page could not read.' })
          continue
        }
        const ev = item.event
        switch (ev.type) {
          case 'turn_start':
            convRef.current = ev.data.conversation_id
            setConversationId(ev.data.conversation_id)
            setMessagesLeft(ev.data.messages_left)
            break
          case 'tool_start':
            setStatus(ev.data.status_text)
            break
          case 'tool_end':
            setStatus(null)
            break
          case 'plan_update':
            optsRef.current.onPlanUpdate?.(ev.data)
            break
          case 'answer': {
            setStatus(null)
            const text = ev.data.text
            const actions = pending
            pending = []
            answered = true
            setMessages((m) => [...m, { id: `m${++seq.current}`, role: 'assistant', text, ...(actions.length ? { actions } : {}) }])
            break
          }
          case 'action': {
            const act = ev.data
            if (!answered) pending.push(act)
            else
              setMessages((m) => {
                const last = m[m.length - 1]
                if (!last || last.role !== 'assistant') return m
                return [...m.slice(0, -1), { ...last, actions: [...(last.actions ?? []), act] }]
              })
            break
          }
          case 'limit':
            finished = true
            setLimit({ kind: ev.data.kind, message: ev.data.message, signIn: ev.data.sign_in })
            break
          case 'error':
            finished = true
            setError({ code: ev.data.code, message: ev.data.message })
            break
          case 'done': {
            finished = true
            const { trace, stop_reason, turn_id } = ev.data
            setMessages((m) => {
              const last = m[m.length - 1]
              if (!last || last.role !== 'assistant') return m
              return [...m.slice(0, -1), { ...last, trace, stopReason: stop_reason, turnId: turn_id }]
            })
            break
          }
          case 'gate':
            break
        }
      }
      if (!finished && !ctrl.signal.aborted) {
        setError({ code: 'stream_ended', message: 'The connection ended before the answer finished.' })
      }
    } catch (e) {
      if (!ctrl.signal.aborted) {
        setError({ code: 'network', message: e instanceof Error ? `Could not reach the assistant (${e.message}).` : 'Could not reach the assistant.' })
      }
    } finally {
      abortRef.current = null
      busyRef.current = false
      setStatus(null)
      setBusy(false)
    }
    return true
  }, [])

  const sendRef = useRef(send)
  useEffect(() => {
    sendRef.current = send
  })

  // On load: finish a pending account merge, restore the latest conversation, resend a held message once.
  useEffect(() => {
    if (!authEnabled()) return
    let live = true
    void (async () => {
      try {
        if (!(await getClient()) || !live) return
        await mergeAnonymousIfPending().catch(() => undefined)
        const info = await getAuthInfo()
        if (!info || !live) return
        const res = await apiFetch('/api/conversations/latest')
        if (res.ok) {
          const parsed = conversationResponseSchema.safeParse(await res.json())
          if (parsed.success && live) {
            const { conversation, messages_left } = parsed.data
            setMessagesLeft(messages_left)
            if (conversation && convRef.current === null) {
              convRef.current = conversation.id
              setConversationId(conversation.id)
              setMessages(
                conversation.messages.map((m) => ({
                  id: `m${++seq.current}`,
                  role: m.role,
                  text: m.content,
                  ...(m.turn_id ? { turnId: m.turn_id } : {}),
                })),
              )
            }
          }
        }
        if (!info.isAnonymous && live) {
          const held = takeHeldMessage()
          if (held) void sendRef.current(held)
        }
      } catch {
        // restoring is best-effort; the chat still works
      }
    })()
    return () => {
      live = false
    }
  }, [])

  /** Limit -> sign in (FR-6.2): hold the last message, then link Google (or fall back to sign-in). */
  const signIn = useCallback(async () => {
    storeHeldMessage(lastUserRef.current)
    try {
      await signInWithGoogle()
    } catch (e) {
      setError({ code: 'sign_in_failed', message: e instanceof Error ? `Sign-in failed (${e.message}).` : 'Sign-in failed.' })
    }
  }, [])

  return { messages, status, conversationId, limit, error, busy, checking, messagesLeft, send, stop, signIn }
}
