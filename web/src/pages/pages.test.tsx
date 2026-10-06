import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { StaleBanner } from '../components/Status'
import { FIXTURES, FIXTURE_NOW, clone, stubFetch } from '../test/fixtures'
import { Backtest } from './Backtest'
import { Home } from './Home'
import { Leaderboard } from './Leaderboard'
import { Scheduler } from './Scheduler'

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(() => vi.unstubAllGlobals())

describe('Home', () => {
  it('renders the chart for the default model and switches models', async () => {
    stubFetch()
    wrap(<Home now={FIXTURE_NOW} />)
    const picker = await screen.findByLabelText('Forecast model')
    expect(picker).toHaveValue('chronos2_cov')
    expect(screen.getByRole('figure', { name: /Chronos-2 \+ weather/ })).toBeInTheDocument()
    await userEvent.selectOptions(picker, 'sarimax_wx')
    expect(screen.getByRole('figure', { name: /SARIMAX \+ weather/ })).toBeInTheDocument()
  })

  it('shows an error panel naming the file when a fixture is corrupted', async () => {
    const bad = clone(FIXTURES['latest_forecast.json']) as Record<string, unknown>
    bad.horizon = 'forty-eight'
    stubFetch({ 'latest_forecast.json': bad })
    wrap(<Home now={FIXTURE_NOW} />)
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText("Couldn't read latest_forecast.json")).toBeInTheDocument()
  })

  it('shows "needs an update" on a schema_version mismatch', async () => {
    stubFetch({ 'meta.json': { ...(FIXTURES['meta.json'] as object), schema_version: 2 } })
    wrap(<Home now={FIXTURE_NOW} />)
    expect(await screen.findByText('This page needs an update')).toBeInTheDocument()
  })
})

describe('Scheduler', () => {
  it('gives a recommendation for the default job', async () => {
    stubFetch()
    wrap(<Scheduler now={FIXTURE_NOW} />)
    expect(await screen.findByText(/Best start|Recommendation/)).toBeInTheDocument()
    expect(screen.queryByText(/CO2 saved|CO₂ saved/i)).not.toBeInTheDocument()
  })

  it('explains an infeasible job', async () => {
    stubFetch()
    wrap(<Scheduler now={FIXTURE_NOW} />)
    const earliest = (await screen.findByLabelText('Earliest start (UK time)')) as HTMLInputElement
    const deadline = screen.getByLabelText('Must finish by (UK time)')
    const duration = screen.getByLabelText('Duration (hours)')
    // deadline 2 hours after the earliest start, job of 5 hours
    const [d, t] = earliest.value.split('T')
    const hour = Number(t!.slice(0, 2))
    await userEvent.clear(duration)
    await userEvent.type(duration, '5')
    await userEvent.clear(deadline)
    await userEvent.type(deadline, `${d}T${String(hour + 2).padStart(2, '0')}:00`)
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent("Job doesn't fit before your deadline"))
  })

  it('rejects invalid input with a field-level error', async () => {
    stubFetch()
    wrap(<Scheduler now={FIXTURE_NOW} />)
    const duration = await screen.findByLabelText('Duration (hours)')
    await userEvent.clear(duration)
    await userEvent.type(duration, '30')
    expect(await screen.findByText('Enter whole hours from 1 to 12.')).toBeInTheDocument()
  })
})

describe('Leaderboard', () => {
  it('shows the empty state before any scores exist', async () => {
    stubFetch({ 'leaderboard.json': { ...(FIXTURES['leaderboard.json'] as object), rows: [], n_runs: 0 } })
    wrap(<Leaderboard />)
    expect(await screen.findByText('No scored forecasts yet')).toBeInTheDocument()
  })

  it('shows n beside every number', async () => {
    const rows = [
      { model: 'snaive_24', horizon_bucket: '1-6', n_scored: 12, mae: 40.1, rmse: 50.2, wql: 0.21, coverage80: 0.75 },
      { model: 'neso', horizon_bucket: '1-6', n_scored: 12, mae: 9.5, rmse: 12.0, wql: null, coverage80: null },
    ]
    stubFetch({ 'leaderboard.json': { ...(FIXTURES['leaderboard.json'] as object), rows, n_runs: 2 } })
    wrap(<Leaderboard />)
    expect(await screen.findAllByText('n=12')).toHaveLength(6)
    expect(screen.getByText(/provisional/)).toBeInTheDocument()
  })
})

describe('StaleBanner', () => {
  const gen = '2026-10-06T00:00:00Z'
  it('is hidden when data is fresh', () => {
    const { container } = render(<StaleBanner generatedAt={gen} now={Date.parse(gen) + 11 * 3_600_000} />)
    expect(container).toBeEmptyDOMElement()
  })
  it('appears after 12 hours', () => {
    render(<StaleBanner generatedAt={gen} now={Date.parse(gen) + 13 * 3_600_000} />)
    expect(screen.getByRole('status')).toHaveTextContent('13 hours ago')
  })
})

describe('Backtest', () => {
  it('shows the optimism caveat next to the numbers and switches horizon', async () => {
    stubFetch()
    wrap(<Backtest />)
    expect(await screen.findByRole('note')).toHaveTextContent(/closer to reality/)
    expect(screen.getAllByText('benchmark').length).toBeGreaterThan(0)
    await userEvent.click(screen.getByRole('radio', { name: '25–48 h' }))
    expect(screen.getByRole('radio', { name: '25–48 h' })).toHaveAttribute('aria-checked', 'true')
  })

  it('requests the summary from the site itself, not the data branch', async () => {
    const spy = vi.fn(async (url: string) => new Response(JSON.stringify(FIXTURES[url.split('/').pop() ?? ''])))
    vi.stubGlobal('fetch', spy)
    wrap(<Backtest />)
    await screen.findByRole('note')
    expect(spy).toHaveBeenCalledWith('/backtest_summary.json')
  })
})
