import { ErrorPanel, Loading } from '../components/Status'
import { useDataFile } from '../data/hooks'
import type { Leaderboard as LB } from '../data/schemas'
import { fmtNum, fmtPct } from '../lib/format'

const BUCKETS = ['1-6', '7-24', '25-48'] as const
const MIN_DAYS_FOR_CLAIMS = 7

export function Leaderboard() {
  const lb = useDataFile('leaderboard')
  const meta = useDataFile('meta')
  if (lb.error && !lb.data) return <ErrorPanel error={lb.error} onRetry={() => void lb.refetch()} />
  if (!lb.data || !meta.data) return <Loading label="Loading leaderboard" />
  const label = (name: string) => meta.data.models.find((m) => m.name === name)?.label ?? name
  const models = [...new Set(lb.data.rows.map((r) => r.model))]
  const cell = (model: string, bucket: string) => lb.data.rows.find((r) => r.model === model && r.horizon_bucket === bucket)

  return (
    <div className="space-y-6">
      <section>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Live leaderboard</h1>
        <p className="mt-2 max-w-2xl text-stone-600 dark:text-stone-300">
          Every forecast is stored when issued and scored once the actual value arrives. Rolling {lb.data.window_days}-day
          window, {lb.data.n_runs} scored runs. Lower error is better. The seasonal-naive rows are the benchmark a useful
          model has to beat.
        </p>
      </section>
      {models.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          {lb.data.n_runs < MIN_DAYS_FOR_CLAIMS * 4 && (
            <p role="note" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
              Fewer than {MIN_DAYS_FOR_CLAIMS} days of scored runs so far. Treat rankings as provisional.
            </p>
          )}
          <MetricTable title="Mean absolute error (gCO₂/kWh)" models={models} label={label} lb={lb.data}
            value={(m, b) => { const c = cell(m, b); return c ? [fmtNum(c.mae), c.n_scored] : null }} />
          <MetricTable title="Weighted quantile loss (lower is better; NESO publishes no quantiles)" models={models} label={label} lb={lb.data}
            value={(m, b) => { const c = cell(m, b); return c ? [c.wql === null ? '–' : fmtNum(c.wql, 3), c.n_scored] : null }} />
          <MetricTable title="80% band coverage (target 80%)" models={models} label={label} lb={lb.data}
            value={(m, b) => { const c = cell(m, b); return c ? [fmtPct(c.coverage80), c.n_scored] : null }} />
        </>
      )}
    </div>
  )
}

function MetricTable({ title, models, label, value }: {
  title: string; models: string[]; label: (n: string) => string; lb: LB
  value: (model: string, bucket: string) => [string, number] | null
}) {
  return (
    <section className="rounded-2xl border border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900">
      <h2 className="border-b border-stone-200 px-4 py-3 text-sm font-semibold dark:border-stone-800">{title}</h2>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[28rem] text-sm">
          <thead className="text-left text-xs text-stone-500 dark:text-stone-400">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">Model</th>
              {BUCKETS.map((b) => <th key={b} scope="col" className="px-4 py-2 text-right font-medium">{b} h ahead</th>)}
            </tr>
          </thead>
          <tbody>
            {models.map((m) => (
              <tr key={m} className="border-t border-stone-100 dark:border-stone-800">
                <th scope="row" className="px-4 py-2 text-left font-medium">{label(m)}</th>
                {BUCKETS.map((b) => {
                  const v = value(m, b)
                  return (
                    <td key={b} className="px-4 py-2 text-right tabular-nums">
                      {v ? <>{v[0]} <span className="text-xs text-stone-400">n={v[1]}</span></> : '–'}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function EmptyState() {
  return (
    <div className="rounded-2xl border border-dashed border-stone-300 p-8 text-center text-stone-600 dark:border-stone-700 dark:text-stone-300">
      <p className="font-semibold">No scored forecasts yet</p>
      <p className="mt-1 text-sm">
        Scores appear once the hours a forecast covers have actual values, a few hours after each run. Rankings need at
        least {MIN_DAYS_FOR_CLAIMS} days of live data before they mean much.
      </p>
    </div>
  )
}
