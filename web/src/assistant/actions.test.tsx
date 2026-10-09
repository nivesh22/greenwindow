import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { SseEvent } from '../../agent/harness/events'
import { ChatPanel } from './ChatPanel'
import { PlanActions } from './PlanActions'
import { NotificationsSection, PlansSection } from './SettingsSections'
import { EMPTY_TRACE, sseResponse } from './testing'

const push = vi.hoisted(() => ({
  isPushSupported: vi.fn(() => true),
  enablePush: vi.fn(() => Promise.resolve({ ok: true as const })),
  disablePush: vi.fn(() => Promise.resolve({ ok: true as const })),
  getPushStatus: vi.fn(() => Promise.resolve('off' as 'off' | 'on' | 'unsupported' | 'denied')),
}))
vi.mock('./push', async (orig) => ({ ...(await orig<typeof import('./push')>()), ...push }))

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const ICS = 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n'

function turnWith(actions: Extract<SseEvent, { type: 'action' }>['data'][], actionsBeforeAnswer = false): SseEvent[] {
  const act = actions.map((data): SseEvent => ({ type: 'action', data }))
  const answer: SseEvent = { type: 'answer', data: { text: 'All set.' } }
  return [
    { type: 'turn_start', data: { turn_id: 't1', conversation_id: '11111111-1111-4111-8111-111111111111', messages_left: 9 } },
    ...(actionsBeforeAnswer ? [...act, answer] : [answer, ...act]),
    { type: 'done', data: { turn_id: 't1', stop_reason: 'final', trace: EMPTY_TRACE } },
  ]
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('chat actions', () => {
  async function run(events: SseEvent[]) {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(sseResponse(events))))
    render(<ChatPanel />)
    await userEvent.type(screen.getByLabelText('Message to the assistant'), 'go{Enter}')
    await screen.findByText('All set.')
  }

  it('calendar: downloads a .ics named by the London date and links to Google Calendar safely', async () => {
    const blobs: Blob[] = []
    URL.createObjectURL = vi.fn((b: Blob | MediaSource) => {
      blobs.push(b as Blob)
      return 'blob:x'
    })
    URL.revokeObjectURL = vi.fn()
    const names: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download)
    })
    await run(
      turnWith([
        {
          kind: 'calendar',
          title: 'Dishwasher',
          start_utc: '2026-10-09T23:30:00Z', // 00:30 BST on the 10th
          end_utc: '2026-10-10T01:30:00Z',
          ics: ICS,
          google_url: 'https://calendar.google.com/calendar/render?action=TEMPLATE&text=Dishwasher',
        },
      ]),
    )
    const link = screen.getByRole('link', { name: 'Add to Google Calendar' })
    expect(link).toHaveAttribute('href', expect.stringContaining('calendar.google.com'))
    expect(link).toHaveAttribute('target', '_blank')
    expect(link.getAttribute('rel')).toMatch(/noopener/)
    await userEvent.click(screen.getByRole('button', { name: 'Download .ics' }))
    expect(names).toEqual(['greenwindow-2026-10-10.ics'])
    expect(await blobs[0]!.text()).toBe(ICS)
    vi.restoreAllMocks()
  })

  it('reminder_set shows the London time, plan_saved links to Settings (actions may precede the answer)', async () => {
    await run(
      turnWith(
        [
          { kind: 'reminder_set', reminder_id: 'r1', send_at_utc: '2026-10-09T23:20:00Z', start_utc: '2026-10-09T23:30:00Z' },
          { kind: 'plan_saved', plan_id: 'p1', label: 'Weekly wash', recurring: true },
        ],
        true,
      ),
    )
    expect(screen.getByText('Reminder set for 00:20')).toBeInTheDocument()
    expect(screen.getByText(/Saved: Weekly wash/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings')
  })

  it('push_needed offers Turn on notifications and runs the opt-in', async () => {
    await run(turnWith([{ kind: 'push_needed' }]))
    await userEvent.click(screen.getByRole('button', { name: 'Turn on notifications' }))
    expect(push.enablePush).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('Notifications are on.')).toBeInTheDocument()
  })

  it('push_needed on an unsupported browser explains instead of offering a dead button', async () => {
    push.isPushSupported.mockReturnValue(false)
    await run(turnWith([{ kind: 'push_needed' }]))
    expect(screen.queryByRole('button', { name: 'Turn on notifications' })).toBeNull()
    expect(screen.getByText(/Home Screen/)).toBeInTheDocument()
    push.isPushSupported.mockReturnValue(true)
  })
})

describe('PlanActions', () => {
  const props = {
    startUtc: '2026-10-09T23:00:00Z',
    endUtc: '2026-10-10T02:00:00Z',
    label: 'GreenWindow: run 3 h job (7 kW)',
    description: 'desc',
    now: () => '2026-10-09T12:00:00Z',
  }
  it('anonymous users get calendar buttons but no reminder button', () => {
    render(<PlanActions {...props} signedIn={false} />)
    expect(screen.getByText('Add to calendar')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Add to Google Calendar' }).getAttribute('href')).toContain('dates=20261009T230000Z%2F20261010T020000Z')
    expect(screen.queryByRole('button', { name: 'Remind me' })).toBeNull()
  })

  it('Remind me posts start_utc, label and lead_min 10, then shows the London time', async () => {
    const m = vi.fn(() => Promise.resolve(json({ ok: true, reminder_id: 'r1', send_at_utc: '2026-10-09T22:50:00Z' })))
    vi.stubGlobal('fetch', m)
    render(<PlanActions {...props} signedIn />)
    await userEvent.click(screen.getByRole('button', { name: 'Remind me' }))
    expect(await screen.findByText('Reminder set for 23:50')).toBeInTheDocument()
    const [url, init] = m.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/reminders')
    expect(JSON.parse(init.body as string)).toEqual({ start_utc: props.startUtc, label: props.label, lead_min: 10 })
  })

  it('409 push_needed shows the opt-in, and enabling it retries the reminder', async () => {
    let n = 0
    const m = vi.fn(() =>
      Promise.resolve(
        n++ === 0
          ? json({ error: { code: 'push_needed', message: 'no subscription' } }, 409)
          : json({ ok: true, reminder_id: 'r1', send_at_utc: '2026-10-09T22:50:00Z' }),
      ),
    )
    vi.stubGlobal('fetch', m)
    render(<PlanActions {...props} signedIn />)
    await userEvent.click(screen.getByRole('button', { name: 'Remind me' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Turn on notifications' }))
    expect(await screen.findByText('Reminder set for 23:50')).toBeInTheDocument()
    expect(m).toHaveBeenCalledTimes(2)
  })

  it('shows an error for other failures', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json({ error: { code: 'x', message: 'x' } }, 400))))
    render(<PlanActions {...props} signedIn />)
    await userEvent.click(screen.getByRole('button', { name: 'Remind me' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 400')
  })
})

describe('Settings sections', () => {
  it('Notifications toggles through push.ts', async () => {
    push.getPushStatus.mockResolvedValueOnce('off').mockResolvedValueOnce('on')
    render(<NotificationsSection />)
    const sw = await screen.findByRole('switch')
    expect(sw).not.toBeChecked()
    await userEvent.click(sw)
    expect(push.enablePush).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.getByRole('switch')).toBeChecked())
    push.getPushStatus.mockResolvedValueOnce('off')
    await userEvent.click(screen.getByRole('switch'))
    expect(push.disablePush).toHaveBeenCalledTimes(1)
  })

  it('Notifications explains an unsupported browser', async () => {
    push.getPushStatus.mockResolvedValueOnce('unsupported')
    render(<NotificationsSection />)
    expect(await screen.findByText(/Home Screen/)).toBeInTheDocument()
    expect(screen.queryByRole('switch')).toBeNull()
  })

  it('Your plans lists active plans in London time and cancels with DELETE', async () => {
    const plan = (id: string, label: string, active: boolean) => ({
      id,
      label,
      kind: 'once',
      job: { duration_h: 3, power_kw: 7, mode: 'expected', earliest_utc: null, deadline_utc: null },
      rule: null,
      next_start_utc: '2026-10-09T23:00:00Z',
      active,
      created_at_utc: '2026-10-09T10:00:00Z',
    })
    let plans = [plan('p1', 'Charge EV', true), plan('p2', 'Old one', false)]
    const m = vi.fn((url: string, init: RequestInit = {}) => {
      if (init.method === 'DELETE') {
        plans = plans.map((p) => (url.endsWith('id=p1') ? { ...p, active: false } : p))
        return Promise.resolve(json({ ok: true }))
      }
      return Promise.resolve(json({ plans }))
    })
    vi.stubGlobal('fetch', m)
    render(<PlansSection />)
    expect(await screen.findByText('Charge EV')).toBeInTheDocument()
    expect(screen.queryByText('Old one')).toBeNull()
    expect(screen.getByText(/Next start: Sat 10 Oct, 00:00 BST/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel plan Charge EV' }))
    await waitFor(() => expect(screen.getByText('No saved plans.')).toBeInTheDocument())
    expect(m.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === 'DELETE' && c[0] === '/api/plans?id=p1')).toBe(true)
  })
})
