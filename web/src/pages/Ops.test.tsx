import { render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { AdminTraceResponse, OpsResponse } from '../../agent/harness/api_schemas'
import { Ops } from './Ops'
import { OpsTrace } from './OpsTrace'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const OPS: OpsResponse = {
  generated_at_utc: '2026-10-09T12:00:00Z',
  days: 14,
  budget: { month: '2026-10', spent_usd: 4.2, eval_spent_usd: 0.3, limit_usd: 5, paused: false },
  daily: [
    { day: '2026-10-08', turns: 12, cost_usd: 0.31, by_intent: { plan: 8, chat: 4 }, llm_requests: 20, free_tier_requests: 18 },
    { day: '2026-10-09', turns: 5, cost_usd: 0.12, by_intent: { plan: 5 }, llm_requests: 9, free_tier_requests: 9 },
  ],
  free_tier_rpd_estimate: 250,
  latency: [{ kind: 'llm', name: 'gemini', n: 29, p50_ms: 850, p95_ms: 2400 }],
  failover: { llm_calls: 29, failovers: 2, reasons: [{ reason: 'rate_limit', n: 2 }] },
  gates: [{ gate: 'input', n: 17, by_source: { jev: 10, rules: 7 }, by_choice: { allow: 16, block: 1 }, confidence_hist: [0, 0, 0, 0, 0, 0, 0, 1, 4, 12] }],
  tools: [{ tool: 'recommend_start', calls: 20, errors: 1 }],
  stop_reasons: [{ reason: 'final', n: 16 }, { reason: 'max_steps', n: 1 }],
  evals: [{ created_at_utc: '2026-10-09T08:00:00Z', git_sha: 'abc1234', mode: 'replay', pass_rate: 1, window_correctness: 1, banned_claims: 0, cost_usd: 0 }],
  thumbs_down: [{ turn_id: 'turn-1', created_at_utc: '2026-10-09T09:00:00Z', comment: 'wrong time' }],
  prices_checked: '2026-10-01',
}

const TRACE: AdminTraceResponse = {
  turn: {
    id: 'turn-1', conversation_id: 'c1', user_id: null, intent: 'plan', stop_reason: 'final', prompt_version: 'v3',
    model_final: 'gemini', tokens_in: 100, tokens_out: 20, cost_usd: 0.0012, latency_ms: 1500, created_at_utc: '2026-10-09T09:00:00Z',
  },
  spans: [
    { id: 's2', parent_id: 's1', kind: 'tool', name: 'recommend_start', started_at_utc: '2026-10-09T09:00:01Z', duration_ms: 40, status: 'error', attrs: { reason: 'infeasible' }, tokens_in: 0, tokens_out: 0, cost_usd: 0 },
    { id: 's1', parent_id: null, kind: 'stage', name: 'agent_loop', started_at_utc: '2026-10-09T09:00:00Z', duration_ms: 1400, status: 'ok', attrs: {}, tokens_in: 0, tokens_out: 0, cost_usd: 0 },
  ],
  user_message: 'charge my car',
  answer: 'Start at 23:00.',
  feedback: [{ rating: -1, comment: 'wrong time' }],
  langfuse_url: 'https://cloud.langfuse.com/trace/x',
}

afterEach(() => vi.unstubAllGlobals())
const stub = (res: Response) => {
  const m = vi.fn(() => Promise.resolve(res))
  vi.stubGlobal('fetch', m)
  return m
}

describe('Ops page', () => {
  it('fetches /api/admin/ops?days=14 and renders every panel', async () => {
    const m = stub(json(OPS))
    render(<MemoryRouter><Ops /></MemoryRouter>)
    expect(await screen.findByRole('heading', { name: 'Cost per day' })).toBeInTheDocument()
    expect((m.mock.calls[0] as unknown as [string])[0]).toBe('/api/admin/ops?days=14')
    for (const name of ['Turns per day by intent', 'Free-tier requests per day', 'Eval pass rate', 'Latency (p50 / p95)', 'Failover', 'Gates', 'Tool error rates', 'Stop reasons', 'Thumbs-down']) {
      expect(screen.getByRole('heading', { name })).toBeInTheDocument()
    }
    expect(screen.getByText(/\$4\.20 of \$5\.00 \(84%\)/)).toBeInTheDocument()
    expect(screen.getByText(/84% of the 2026-10 budget/)).toBeInTheDocument() // 80% warning
    const lat = screen.getByRole('table', { name: 'Latency by kind and name' })
    expect(within(lat).getByText('850 ms')).toBeInTheDocument()
    expect(within(lat).getByText('2.40 s')).toBeInTheDocument()
    expect(screen.getByText(/2 of 29 LLM calls \(6\.9%\)/)).toBeInTheDocument()
    expect(within(screen.getByRole('table', { name: 'Tool calls and errors' })).getByText('5.0%')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Fri 9 Oct/ })).toHaveAttribute('href', '/ops/trace/turn-1')
  })

  it('shows the paused banner', async () => {
    stub(json({ ...OPS, budget: { ...OPS.budget, spent_usd: 5, paused: true } }))
    render(<MemoryRouter><Ops /></MemoryRouter>)
    expect(await screen.findByText(/Paused: the monthly budget/)).toBeInTheDocument()
  })

  it('403 says Admins only; a malformed body is an error, not a crash', async () => {
    stub(json({ error: { code: 'forbidden', message: 'no' } }, 403))
    const { unmount } = render(<MemoryRouter><Ops /></MemoryRouter>)
    expect(await screen.findByText('Admins only.')).toBeInTheDocument()
    unmount()
    stub(json({ nope: true }))
    render(<MemoryRouter><Ops /></MemoryRouter>)
    expect(await screen.findByText(/Could not load/)).toBeInTheDocument()
  })
})

describe('OpsTrace page', () => {
  const mount = () =>
    render(
      <MemoryRouter initialEntries={['/ops/trace/turn-1']}>
        <Routes><Route path="/ops/trace/:turnId" element={<OpsTrace />} /></Routes>
      </MemoryRouter>,
    )

  it('renders the turn, messages, spans (children after parents), attrs, feedback and Langfuse link', async () => {
    const m = stub(json(TRACE))
    mount()
    expect(await screen.findByText('charge my car')).toBeInTheDocument()
    expect((m.mock.calls[0] as unknown as [string])[0]).toBe('/api/admin/trace?turn_id=turn-1')
    expect(screen.getByText('Start at 23:00.')).toBeInTheDocument()
    expect(screen.getByText('Thumbs down: wrong time')).toBeInTheDocument()
    const items = within(screen.getByRole('region', { name: 'Spans' })).getAllByRole('listitem')
    expect(items[0]).toHaveTextContent('agent_loop')
    expect(items[1]).toHaveTextContent('recommend_start')
    expect(items[1]).toHaveTextContent('error')
    expect(items[1]).toHaveTextContent('40 ms')
    expect(items[1]!.querySelector('pre')?.textContent).toContain('infeasible')
    expect(screen.getByRole('link', { name: 'Open in Langfuse' })).toHaveAttribute('rel', expect.stringContaining('noopener'))
  })

  it('403 says Admins only', async () => {
    stub(json({}, 403))
    mount()
    expect(await screen.findByText('Admins only.')).toBeInTheDocument()
  })
})
