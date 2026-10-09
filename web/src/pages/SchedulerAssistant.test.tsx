import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import type { PanelState, PlanUpdate, SseEvent } from '../../agent/harness/events'
import { CONV_ID, EMPTY_TRACE, sseResponse } from '../assistant/testing'
import { TraceDrawer } from '../assistant/TraceDrawer'
import { FIXTURES, FIXTURE_NOW } from '../test/fixtures'
import { HOUR_MS, formatDateTime, toIso, toLocalInput } from '../lib/time'
import { recommend } from '../scheduler/optimizer'
import { Scheduler } from './Scheduler'

interface Fc { series: { model: string; points: { ts: string; q10: number | null; q50: number; q90: number | null }[] }[] }
const fc = FIXTURES['latest_forecast.json'] as Fc

const START = Math.ceil(FIXTURE_NOW / HOUR_MS) * HOUR_MS
const MODEL = 'chronos2_cov'

function bestFor(model: string, mode: 'expected' | 'cautious'): string {
  const hours = fc.series
    .find((s) => s.model === model)!
    .points.flatMap((p) => (p.q10 !== null && p.q90 !== null ? [{ ts: p.ts, q10: p.q10, q50: p.q50, q90: p.q90 }] : []))
  return recommend(hours, { durationH: 4, powerKw: 3, earliestStart: toIso(START), deadline: toIso(START + 14 * HOUR_MS) }, mode).bestStart
}

function update(over: Partial<PlanUpdate> = {}): PlanUpdate {
  return {
    duration_h: 4,
    power_kw: 3,
    earliest_utc: toIso(START),
    deadline_utc: toIso(START + 14 * HOUR_MS),
    mode: 'cautious',
    model: MODEL,
    best_start_utc: bestFor(MODEL, 'cautious'),
    run_id: 'r1',
    ...over,
  }
}

function stubAll(chat: SseEvent[] | (() => Response), bodies: unknown[] = []) {
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url.includes('/api/chat')) {
      bodies.push(JSON.parse(init?.body as string))
      return typeof chat === 'function' ? chat() : sseResponse(chat)
    }
    const name = url.split('/').pop() ?? ''
    return name in FIXTURES ? new Response(JSON.stringify(FIXTURES[name]), { status: 200 }) : new Response('nf', { status: 404 })
  })
}

function turn(u: PlanUpdate): SseEvent[] {
  return [
    { type: 'turn_start', data: { turn_id: 't1', conversation_id: CONV_ID, messages_left: 9 } },
    { type: 'plan_update', data: u },
    { type: 'answer', data: { text: 'Start later tonight.' } },
    { type: 'done', data: { turn_id: 't1', stop_reason: 'final', trace: EMPTY_TRACE } },
  ]
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Scheduler now={FIXTURE_NOW} assistantEnabled />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

async function send(text: string) {
  await userEvent.type(await screen.findByLabelText('Message to the assistant'), `${text}{Enter}`)
}

afterEach(() => vi.unstubAllGlobals())

describe('Scheduler with the assistant', () => {
  it('renders the chat and the plan panel as separate regions with a View plan button', async () => {
    stubAll([])
    mount()
    expect(await screen.findByRole('region', { name: 'Assistant' })).toBeInTheDocument()
    const panel = screen.getByRole('region', { name: 'Plan panel' })
    expect(within(panel).getByLabelText('Duration (hours)')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'View plan' })).toBeInTheDocument()
  })

  it('a plan_update fills the panel, recomputes, and agrees with the server best start', async () => {
    const u = update()
    stubAll(turn(u))
    mount()
    await send('plan it')
    await waitFor(() => expect(screen.getByLabelText('Duration (hours)')).toHaveValue(4))
    expect(screen.getByLabelText('Power draw (kW)')).toHaveValue(3)
    expect(screen.getByLabelText('Earliest start (UK time)')).toHaveValue(toLocalInput(START))
    expect(screen.getByLabelText('Must finish by (UK time)')).toHaveValue(toLocalInput(START + 14 * HOUR_MS))
    expect(screen.getByRole('radio', { name: /Cautious/ })).toBeChecked()
    expect(screen.getByLabelText('Forecast model')).toHaveValue(MODEL)
    expect(screen.getByText('Updated by the assistant')).toBeInTheDocument()
    const card = screen.getByRole('region', { name: 'Plan panel' })
    const best = formatDateTime(u.best_start_utc)
    expect(card).toHaveTextContent(new RegExp(`(Best start|Recommendation)`))
    // the panel's own optimizer result matches the assistant's (same model, same fixture data)
    const changed = u.best_start_utc !== toIso(START)
    if (changed) expect(within(card).getAllByText(best).length).toBeGreaterThan(0)
  })

  it('user edits set edited_by_user; a plan_update clears it', async () => {
    const bodies: { panel_state: PanelState | null }[] = []
    stubAll(() => sseResponse(turn(update())), bodies)
    mount()
    await screen.findByLabelText('Duration (hours)')

    await send('first')
    await screen.findByText('Start later tonight.')
    expect(bodies[0]!.panel_state).toMatchObject({ edited_by_user: false, mode: 'expected', model: MODEL })

    // after the plan_update, the next request still reports an unedited panel
    await send('second')
    await waitFor(() => expect(bodies).toHaveLength(2))
    expect(bodies[1]!.panel_state).toEqual({
      duration_h: 4,
      power_kw: 3,
      earliest_utc: toIso(START),
      deadline_utc: toIso(START + 14 * HOUR_MS),
      mode: 'cautious',
      model: MODEL,
      edited_by_user: false,
    })

    const power = screen.getByLabelText('Power draw (kW)')
    await userEvent.clear(power)
    await userEvent.type(power, '5')
    expect(screen.queryByText('Updated by the assistant')).toBeNull()
    await send('third')
    await waitFor(() => expect(bodies).toHaveLength(3))
    expect(bodies[2]!.panel_state).toMatchObject({ power_kw: 5, edited_by_user: true })
  })

  it('keeps the panel usable when the assistant is paused and says why', async () => {
    stubAll(() => sseResponse([{ type: 'limit', data: { kind: 'budget_paused', message: 'Back tomorrow.', sign_in: false } }]))
    mount()
    await send('hi')
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Assistant paused for now')
    expect(alert).toHaveTextContent('Back tomorrow.')
    const duration = screen.getByLabelText('Duration (hours)')
    await userEvent.clear(duration)
    await userEvent.type(duration, '2')
    expect(duration).toHaveValue(2)
    expect(screen.getByText(/Best start|Recommendation/)).toBeInTheDocument()
  })

  it('shows a trace drawer under an assistant answer', async () => {
    stubAll(turn(update()))
    mount()
    await send('go')
    expect(await screen.findByText('How I got this')).toBeInTheDocument()
  })
})

describe('TraceDrawer', () => {
  it('renders gates, tools, model calls, totals and prompt version', () => {
    render(
      <TraceDrawer
        trace={{
          gates: [{ gate: 'intent', choice: 'plan_job', confidence: 0.9, source: 'jev', latency_ms: 4 }],
          tools: [
            { name: 'recommend_start', args: { duration_h: 3 }, ok: true, ms: 12, summary: 'best 23:00' },
            { name: 'get_forecast', args: {}, ok: false, ms: 3, summary: 'boom' },
          ],
          llm_calls: [
            { model: 'gemini-x', provider: 'google', ok: true, error: null, failover: true, failover_reason: 'timeout', finish_reason: 'stop', tokens_in: 100, tokens_out: 20, cost_usd: 0.00123456, ms: 800 },
          ],
          totals: { steps: 2, tokens_in: 100, tokens_out: 20, cost_usd: 0.00123456, ms: 900 },
          prompt_version: 'v7',
        }}
      />,
    )
    expect(screen.getByText('How I got this').closest('details')).not.toHaveAttribute('open')
    expect(screen.getByText('intent: plan_job')).toBeInTheDocument()
    expect(screen.getByRole('meter', { name: 'intent confidence' })).toHaveAttribute('aria-valuenow', '0.9')
    expect(screen.getByText('jev')).toBeInTheDocument()
    expect(screen.getByText('recommend_start')).toBeInTheDocument()
    expect(screen.getByText('ok')).toBeInTheDocument()
    expect(screen.getByText('error')).toBeInTheDocument()
    expect(screen.getByLabelText('Arguments for recommend_start')).toHaveTextContent('"duration_h": 3')
    expect(screen.getByText('failover: timeout')).toBeInTheDocument()
    expect(screen.getByText('finish: stop')).toBeInTheDocument()
    expect(screen.getByText('100 in / 20 out')).toBeInTheDocument()
    expect(screen.getAllByText('$0.0012').length).toBeGreaterThan(0)
    expect(screen.getByText(/prompt v7/)).toBeInTheDocument()
  })

  it('says "none yet" with no gates and caps long args', () => {
    render(
      <TraceDrawer
        trace={{
          ...EMPTY_TRACE,
          tools: [{ name: 'big', args: { s: 'x'.repeat(5000) }, ok: true, ms: 1, summary: '' }],
        }}
      />,
    )
    expect(screen.getByText('none yet')).toBeInTheDocument()
    expect(screen.getByLabelText('Arguments for big').textContent!.length).toBeLessThan(1400)
  })
})

describe('Scheduler plan actions', () => {
  it('shows Add to calendar for a feasible plan (no Remind me for guests) and hides it when there is no plan', async () => {
    stubAll([])
    mount()
    const panel = await screen.findByRole('region', { name: 'Plan panel' })
    expect(await within(panel).findByText('Add to calendar')).toBeInTheDocument()
    expect(within(panel).getByRole('button', { name: 'Download .ics' })).toBeInTheDocument()
    expect(within(panel).getByRole('link', { name: 'Add to Google Calendar' })).toHaveAttribute('rel', expect.stringContaining('noopener'))
    expect(within(panel).queryByRole('button', { name: 'Remind me' })).toBeNull()
    // an empty deadline is invalid: no plan, so no calendar actions
    await userEvent.clear(within(panel).getByLabelText('Must finish by (UK time)'))
    await waitFor(() => expect(within(panel).queryByText('Add to calendar')).toBeNull())
  })
})
