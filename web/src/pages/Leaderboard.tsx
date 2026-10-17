import { useState } from 'react'
import { ErrorPanel, Loading } from '../components/Status'
import { useDataFile } from '../data/hooks'
import type { Leaderboard as LB, ModelInfo } from '../data/schemas'
import { fmtNum, fmtPct } from '../lib/format'

const BUCKETS = ['1-6', '7-24', '25-48'] as const
const MIN_DAYS_FOR_CLAIMS = 7

type Row = LB['rows'][number]
interface Metric {
  key: 'mae' | 'wql' | 'coverage80'
  tab: string
  title: string
  note: string
  format: (v: number) => string
  /** Lower score is better; coverage is scored by its distance from the 80% target. */
  score: (v: number) => number
}

const METRICS: Metric[] = [
  { key: 'mae', tab: 'Mean absolute error', title: 'Mean absolute error (gCO₂/kWh)', note: 'Lower is better.', format: (v) => fmtNum(v), score: (v) => v },
  { key: 'wql', tab: 'Quantile loss', title: 'Weighted quantile loss', note: 'Lower is better. Scores the whole band, not just the median. NESO publishes no quantiles.', format: (v) => fmtNum(v, 3), score: (v) => v },
  { key: 'coverage80', tab: 'Band coverage', title: '80% band coverage (target 80%)', note: 'Closest to 80% is best: above means the band is too wide, below means overconfident.', format: (v) => fmtPct(v), score: (v) => Math.abs(v - 0.8) },
]

export function Leaderboard() {
  const lb = useDataFile('leaderboard')
  const meta = useDataFile('meta')
  const [metricKey, setMetricKey] = useState<Metric['key']>('mae')
  if (lb.error && !lb.data) return <ErrorPanel error={lb.error} onRetry={() => void lb.refetch()} />
  if (!lb.data || !meta.data) return <Loading label="Loading leaderboard" />
  const info = (name: string): ModelInfo | undefined => meta.data.models.find((m) => m.name === name)
  const models = [...new Set(lb.data.rows.map((r) => r.model))]
  const metric = METRICS.find((m) => m.key === metricKey)!

  return (
    <div className="space-y-8">
      <section>
        <p className="eyebrow">Scored live · rolling {lb.data.window_days} days</p>
        <h1 className="page-title mt-2">Live leaderboard</h1>
        <p className="lede">
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
          <div role="radiogroup" aria-label="Metric" className="inline-flex flex-wrap gap-1 rounded-xl border border-line bg-surface p-1">
            {METRICS.map((m) => (
              <button
                key={m.key}
                type="button"
                role="radio"
                aria-checked={metricKey === m.key}
                onClick={() => setMetricKey(m.key)}
                className={`cursor-pointer rounded-lg px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-accent ${
                  metricKey === m.key ? 'bg-accent-soft text-accent-ink' : 'text-ink-2 hover:bg-surface-2 hover:text-ink'
                }`}
              >
                {m.tab}
              </button>
            ))}
          </div>
          <MetricTable metric={metric} models={models} info={info} rows={lb.data.rows} />
        </>
      )}
    </div>
  )
}

function MetricTable({ metric, models, info, rows }: {
  metric: Metric; models: string[]; info: (n: string) => ModelInfo | undefined; rows: Row[]
}) {
  const cell = (model: string, bucket: string) => rows.find((r) => r.model === model && r.horizon_bucket === bucket)
  const valueOf = (model: string, bucket: string): number | null => cell(model, bucket)?.[metric.key] ?? null
  const best = Object.fromEntries(
    BUCKETS.map((b) => {
      const scored = models.flatMap((m) => {
        const v = valueOf(m, b)
        return v === null ? [] : [metric.score(v)]
      })
      return [b, scored.length ? Math.min(...scored) : null]
    }),
  )
  const max = Math.max(1e-9, ...models.flatMap((m) => BUCKETS.map((b) => valueOf(m, b) ?? 0)))
  // Rank by the longest horizon the model has, then the next; models without a score sink to the bottom.
  const rank = (m: string) => [...BUCKETS].reverse().map((b) => { const v = valueOf(m, b); return v === null ? Infinity : metric.score(v) })
  const sorted = [...models].sort((a, b) => {
    const ra = rank(a)
    const rb = rank(b)
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i]! - rb[i]!
    return 0
  })

  return (
    <section className="card overflow-hidden">
      <div className="border-b border-line px-4 py-3.5 sm:px-5">
        <h2 className="font-display text-lg font-semibold">{metric.title}</h2>
        <p className="mt-0.5 text-xs text-ink-3">{metric.note} The best value per column is marked; n is the number of scored hours.</p>
      </div>
      <div className="overflow-x-auto">
        <table className="data-table w-full min-w-[36rem] text-sm">
          <thead className="text-left">
            <tr>
              <th scope="col" className="sm:pl-5">Model</th>
              {BUCKETS.map((b) => <th key={b} scope="col" className="text-right">{b} h ahead</th>)}
            </tr>
          </thead>
          <tbody>
            {sorted.map((m) => {
              const family = info(m)?.family
              const isBenchmark = family === 'benchmark' && m !== 'neso'
              return (
                <tr key={m} className={isBenchmark ? 'bg-surface-2/50' : undefined}>
                  <th scope="row" className="px-4 py-2.5 text-left font-medium sm:pl-5">
                    <span className="flex flex-wrap items-center gap-2">
                      {info(m)?.label ?? m}
                      {isBenchmark && <Tag>benchmark</Tag>}
                      {m === 'neso' && <Tag>operator</Tag>}
                    </span>
                  </th>
                  {BUCKETS.map((b) => {
                    const c = cell(m, b)
                    const v = c?.[metric.key] ?? null
                    const isBest = v !== null && best[b] !== null && metric.score(v) === best[b]
                    return (
                      <td key={b} className="px-4 py-2.5 text-right tabular-nums">
                        {c ? (
                          <span className="inline-flex flex-col items-end gap-1">
                            <span className={isBest ? 'font-semibold text-accent' : ''}>
                              {isBest && <span className="sr-only">Best: </span>}
                              {v === null ? '–' : metric.format(v)}{' '}
                              <span className="text-xs font-normal text-ink-3">n={c.n_scored}</span>
                            </span>
                            {v !== null && metric.key !== 'coverage80' && (
                              <span aria-hidden className="block h-1 w-20 overflow-hidden rounded-full bg-surface-2">
                                <span className={`block h-full rounded-full ${isBest ? 'bg-accent' : 'bg-ink-3/50'}`} style={{ width: `${(v / max) * 100}%` }} />
                              </span>
                            )}
                          </span>
                        ) : '–'}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function Tag({ children }: { children: string }) {
  return <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-ink-3 ring-1 ring-line">{children}</span>
}

function EmptyState() {
  return (
    <div className="rounded-2xl border border-dashed border-line-strong p-8 text-center text-ink-2">
      <p className="font-semibold">No scored forecasts yet</p>
      <p className="mt-1 text-sm">
        Scores appear once the hours a forecast covers have actual values, a few hours after each run. Rankings need at
        least {MIN_DAYS_FOR_CLAIMS} days of live data before they mean much.
      </p>
    </div>
  )
}
