// Shared helpers for Vercel Web-standard handlers.
import { encodeSse, type SseEvent } from '../../agent/harness/events.js'

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  })
}

export const errorBody = (code: string, message: string) => ({ error: { code, message } })

/** sha256 hex of (first x-forwarded-for hop + salt). Raw IPs are never stored or logged. */
export async function ipHash(request: Request, salt: string): Promise<string> {
  const ip = (request.headers.get('x-forwarded-for') ?? '').split(',')[0]?.trim() ?? ''
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip + salt))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

export const HEARTBEAT_MS = 10_000

/**
 * Stream SSE events produced by `run`. Heartbeat comment every 10 s; the stream closes when `run` settles
 * (a rejection emits an `error` event first) or when the client aborts `signal` (which also aborts the signal
 * passed to `run`).
 */
export function sseResponse(
  run: (emit: (ev: SseEvent) => void, signal: AbortSignal) => Promise<void>,
  signal?: AbortSignal,
): Response {
  const enc = new TextEncoder()
  const ctl = new AbortController()
  let closed = false
  let timer: ReturnType<typeof setInterval> | undefined
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined

  const cleanup = () => {
    closed = true
    if (timer) clearInterval(timer)
    signal?.removeEventListener('abort', onAbort)
  }
  const close = () => {
    if (closed) return
    cleanup()
    try {
      controller?.close()
    } catch {
      // already closed
    }
  }
  function onAbort() {
    ctl.abort()
    close()
  }
  const write = (s: string) => {
    if (closed) return
    try {
      controller?.enqueue(enc.encode(s))
    } catch {
      close()
    }
  }
  const emit = (ev: SseEvent) => write(encodeSse(ev))

  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
      if (signal?.aborted) {
        onAbort()
        return
      }
      signal?.addEventListener('abort', onAbort)
      timer = setInterval(() => write(': heartbeat\n\n'), HEARTBEAT_MS)
      void run(emit, ctl.signal)
        .catch((e: unknown) => {
          emit({ type: 'error', data: { code: 'internal', message: e instanceof Error ? e.message : 'Unexpected error' } })
        })
        .finally(close)
    },
    cancel() {
      ctl.abort()
      cleanup()
    },
  })

  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' },
  })
}
