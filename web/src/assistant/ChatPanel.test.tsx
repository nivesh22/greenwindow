import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChatPanel } from './ChatPanel'
import { FormattedText } from './FormattedText'
import { STARTERS } from './flag'
import { sseResponse, turnEvents } from './testing'

afterEach(() => vi.unstubAllGlobals())

function stubOk(answer = 'Start at **23:00**.\n\n- Cheap\n- Windy') {
  const mock = vi.fn(() => Promise.resolve(sseResponse(turnEvents(answer))))
  vi.stubGlobal('fetch', mock)
  return mock
}

describe('FormattedText', () => {
  it('renders paragraphs, bullets and bold without raw HTML', () => {
    const { container } = render(<FormattedText text={'Hi **there**\n\n- a\n- b **c**\n\n<img src=x onerror=alert(1)>'} />)
    expect(container.querySelectorAll('p')).toHaveLength(2)
    expect(container.querySelectorAll('li')).toHaveLength(2)
    expect(container.querySelector('strong')?.textContent).toBe('there')
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('<img src=x')
  })
})

describe('ChatPanel', () => {
  it('shows starter chips and the scope note, and a chip sends its text', async () => {
    const mock = stubOk()
    render(<ChatPanel />)
    expect(screen.getByText(/GB national grid only/)).toBeInTheDocument()
    expect(screen.getAllByRole('button').filter((b) => STARTERS.includes(b.textContent ?? ''))).toHaveLength(4)
    await userEvent.click(screen.getByRole('button', { name: STARTERS[1]! }))
    expect(await screen.findByText('Cheap')).toBeInTheDocument()
    const first = mock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(first[1].body as string).message).toBe(STARTERS[1])
    expect(screen.queryByRole('button', { name: STARTERS[0]! })).toBeNull()
  })

  it('Enter sends, Shift+Enter inserts a newline, and the counter updates', async () => {
    const mock = stubOk('Done.')
    render(<ChatPanel />)
    const box = screen.getByLabelText('Message to the assistant')
    await userEvent.type(box, 'line one{Shift>}{Enter}{/Shift}line two')
    expect(box).toHaveValue('line one\nline two')
    expect(screen.getByLabelText('Characters used')).toHaveTextContent('17/2000')
    expect(mock).not.toHaveBeenCalled()
    await userEvent.type(box, '{Enter}')
    expect(await screen.findByText('Done.')).toBeInTheDocument()
    expect(box).toHaveValue('')
    const call = mock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(call[1].body as string).message).toBe('line one\nline two')
  })

  it('renders bold and lists in the answer', async () => {
    stubOk()
    render(<ChatPanel />)
    await userEvent.type(screen.getByLabelText('Message to the assistant'), 'go{Enter}')
    expect((await screen.findByText('23:00')).tagName).toBe('STRONG')
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
  })

  it('shows the status line while busy and Stop aborts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_u: string, init: RequestInit) => {
        const enc = new TextEncoder()
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(enc.encode('event: tool_start\ndata: {"call_id":"c","tool":"t","status_text":"Reading the forecast..."}\n\n'))
            init.signal?.addEventListener('abort', () => c.error(new DOMException('x', 'AbortError')))
          },
        })
        return Promise.resolve(new Response(body))
      }),
    )
    render(<ChatPanel />)
    await userEvent.type(screen.getByLabelText('Message to the assistant'), 'hello{Enter}')
    expect(await screen.findByText('Reading the forecast...')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(screen.queryByText('Reading the forecast...')).toBeNull())
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows the unavailable notice on HTTP error and on a limit event', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ error: { code: 'x', message: 'Down for now.' } }), { status: 503 }))))
    const { unmount } = render(<ChatPanel />)
    await userEvent.type(screen.getByLabelText('Message to the assistant'), 'hi{Enter}')
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Assistant unavailable — the plan panel still works.')
    expect(alert).toHaveTextContent('Down for now.')
    unmount()

    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(sseResponse([{ type: 'limit', data: { kind: 'rate', message: 'Slow down.', sign_in: false } }]))))
    render(<ChatPanel />)
    await userEvent.type(screen.getByLabelText('Message to the assistant'), 'hi{Enter}')
    expect(await screen.findByRole('alert')).toHaveTextContent('Slow down.')
    expect(screen.getByLabelText('Message to the assistant')).toBeDisabled()
  })
})
