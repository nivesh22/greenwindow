import { act, renderHook, waitFor } from '@testing-library/react'
import type { PlanUpdate } from '../../agent/harness/events'
import { CONV_ID, sseResponse, streamOf, turnEvents } from './testing'
import { useChat } from './useChat'

afterEach(() => vi.unstubAllGlobals())

function stub(fn: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const mock = vi.fn((url: string, init: RequestInit) => Promise.resolve(fn(url, init)))
  vi.stubGlobal('fetch', mock)
  return mock
}

describe('useChat', () => {
  it('runs a full turn and posts a well-formed request', async () => {
    const mock = stub(() => sseResponse(turnEvents('Start at **midnight**.')))
    const updates: PlanUpdate[] = []
    const { result } = renderHook(() => useChat({ onPlanUpdate: (u) => updates.push(u), getPanelState: () => null }))
    await act(() => result.current.send('  charge my EV  '))

    const [url, init] = mock.mock.calls[0]!
    if (!init) throw new Error('no init')
    expect(url).toBe('/api/chat')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'content-type': 'application/json' })
    const body = JSON.parse(init.body as string)
    expect(body).toMatchObject({ conversation_id: null, message: 'charge my EV', panel_state: null })
    expect(body.client_now_utc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)

    expect(result.current.messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'charge my EV'],
      ['assistant', 'Start at **midnight**.'],
    ])
    expect(result.current.messages[1]?.stopReason).toBe('final')
    expect(result.current.messages[1]?.trace?.prompt_version).toBe('test')
    expect(result.current.conversationId).toBe(CONV_ID)
    expect(result.current.status).toBeNull()
    expect(result.current.busy).toBe(false)
    expect(result.current.error).toBeNull()
    expect(updates).toHaveLength(1)
    expect(updates[0]?.best_start_utc).toBe('2026-10-08T23:00:00Z')

    const mock2 = stub(() => sseResponse(turnEvents('again')))
    await act(() => result.current.send('and again'))
    const second = JSON.parse((mock2.mock.calls[0]?.[1].body as string) ?? '{}')
    expect(second.conversation_id).toBe(CONV_ID)
  })

  it('shows the tool status while a call is running', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const evs = turnEvents('ok')
    const head = evs.slice(0, 2)
    const tail = evs.slice(2)
    const { encodeSse } = await import('../../agent/harness/events')
    const enc = new TextEncoder()
    let step = 0
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        if (step === 0) c.enqueue(enc.encode(head.map(encodeSse).join('')))
        else if (step === 1) {
          await gate
          c.enqueue(enc.encode(tail.map(encodeSse).join('')))
        } else c.close()
        step++
      },
    })
    stub(() => new Response(body))
    const { result } = renderHook(() => useChat())
    let p!: Promise<unknown>
    act(() => {
      p = result.current.send('hi')
    })
    await waitFor(() => expect(result.current.status).toBe('Checking the forecast...'))
    expect(result.current.busy).toBe(true)
    release()
    await act(() => p)
    expect(result.current.status).toBeNull()
  })

  it('records a limit event', async () => {
    stub(() => sseResponse([{ type: 'limit', data: { kind: 'daily_cap', message: 'Daily limit reached.', sign_in: true } }]))
    const { result } = renderHook(() => useChat())
    await act(() => result.current.send('hi'))
    expect(result.current.limit).toEqual({ kind: 'daily_cap', message: 'Daily limit reached.', signIn: true })
    expect(result.current.error).toBeNull()
  })

  it('records an error event', async () => {
    stub(() => sseResponse([{ type: 'error', data: { code: 'provider_down', message: 'Model unavailable.' } }]))
    const { result } = renderHook(() => useChat())
    await act(() => result.current.send('hi'))
    expect(result.current.error).toEqual({ code: 'provider_down', message: 'Model unavailable.' })
  })

  it('shows the message of a non-2xx JSON error body', async () => {
    stub(() => new Response(JSON.stringify({ error: { code: 'internal', message: 'Something broke.' } }), { status: 500 }))
    const { result } = renderHook(() => useChat())
    await act(() => result.current.send('hi'))
    expect(result.current.error).toEqual({ code: 'internal', message: 'Something broke.' })
    expect(result.current.busy).toBe(false)
  })

  it('falls back to a generic message for a non-JSON error body and for network failure', async () => {
    stub(() => new Response('<html>', { status: 502 }))
    const { result } = renderHook(() => useChat())
    await act(() => result.current.send('hi'))
    expect(result.current.error?.message).toMatch(/HTTP 502/)
    stub(() => Promise.reject(new TypeError('Failed to fetch')) as unknown as Response)
    await act(() => result.current.send('again'))
    expect(result.current.error?.code).toBe('network')
  })

  it('stop() aborts the request without an error', async () => {
    let signal!: AbortSignal
    stub((_u, init) => {
      signal = init.signal as AbortSignal
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          signal.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')))
        },
      })
      return new Response(body)
    })
    const { result } = renderHook(() => useChat())
    let p!: Promise<unknown>
    act(() => {
      p = result.current.send('hi')
    })
    await waitFor(() => expect(result.current.busy).toBe(true))
    await waitFor(() => expect(signal).toBeDefined())
    act(() => result.current.stop())
    await act(() => p)
    expect(signal.aborted).toBe(true)
    expect(result.current.busy).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('reports an unreadable event as an error', async () => {
    stub(() => new Response(streamOf(['event: answer\ndata: nope\n\n'])))
    const { result } = renderHook(() => useChat())
    await act(() => result.current.send('hi'))
    expect(result.current.error?.code).toBe('bad_event')
  })
})
