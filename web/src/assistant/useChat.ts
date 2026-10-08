import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatRequest, PanelState, PlanUpdate, StopReason, TraceSummary } from '../../agent/harness/events'
import { parseSse } from './sse'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  trace?: TraceSummary
  stopReason?: StopReason
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
  const [status, setStatus] = useState<string | null>(null)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [limit, setLimit] = useState<LimitState | null>(null)
  const [error, setError] = useState<ChatError | null>(null)
  const [busy, setBusy] = useState(false)

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

  const send = useCallback(async (raw: string) => {
    const message = raw.trim()
    if (!message || message.length > 2000 || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    setStatus(null)
    setMessages((m) => [...m, { id: `m${++seq.current}`, role: 'user', text: message }])
    const ctrl = new AbortController()
    abortRef.current = ctrl
    const body: ChatRequest = {
      conversation_id: convRef.current,
      message,
      panel_state: optsRef.current.getPanelState?.() ?? null,
      client_now_utc: nowUtc(),
    }
    let finished = false
    try {
      const res = await fetch(optsRef.current.endpoint ?? '/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })
      if (!res.ok) {
        setError(await httpError(res))
        return
      }
      if (!res.body) {
        setError({ code: 'no_body', message: 'The assistant sent an empty response.' })
        return
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
            setMessages((m) => [...m, { id: `m${++seq.current}`, role: 'assistant', text }])
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
            const { trace, stop_reason } = ev.data
            setMessages((m) => {
              const last = m[m.length - 1]
              if (!last || last.role !== 'assistant') return m
              return [...m.slice(0, -1), { ...last, trace, stopReason: stop_reason }]
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
  }, [])

  return { messages, status, conversationId, limit, error, busy, send, stop }
}
