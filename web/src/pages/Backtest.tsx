import { useState } from 'react'
import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from 'recharts'
import { ErrorPanel, Loading } from '../components/Status'
import { useDataFile } from '../data/hooks'
import type { BacktestSummary } from '../data/schemas'
import { fmtNum, fmtPct } from '../lib/format'
import { formatDateTime } from '../lib/time'

const BUCKETS = [
  { key: 'all', label: 'All horizons' },
  { key: '1-6', label: '1–6 h' },
  { key: '7-24', label: '7–24 h' },
  { key: '25-48', label: '25–48 h' },
] as const
type Bucket = (typeof BUCKETS)[number]['key']

const EXTRA_LABELS: Record<string, string> = {
  neso_published: 'NESO as published*',
  blend_wx: 'Chronos-2 + Prophet blend', // until meta.json lists it
}
const BENCHMARKS = new Set(['snaive_24', 'snaive_168'])

export function Backtest() {
  const bt = useDataFile('backtestSummary')
  const meta = useDataFile('meta')
  const [bucket, setBucket] = useState<Bucket>('all')
  if (bt.error && !bt.data) return <ErrorPanel error={bt.error} onRetry={() => void bt.refetch()} />
  if (!bt.data) return <Loading label="Loading backtest" />

  const labels: Record<string, string> = {
    ...Object.fromEntries((meta.data?.models ?? []).map((m) => [m.name, m.label])),
    ...EXTRA_LABELS,
  }
  const label = (n: string) => labels[n] ?? n
  const rows = bt.data.rows.filter((r) => r.horizon_bucket === bucket).sort((a, b) => a.mase - b.mase)

  return (
    <div className="space-y-6">
      <section>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Backtest</h1>
        <p className="mt-2 max-w-2xl text-stone-600 dark:text-stone-300">
          Every model forecast the next 48 hours from {bt.data.origins.count} past start times (daily at 00:00 UTC,{' '}
          {formatDateTime(bt.data.origins.start)} to {formatDateTime(bt.data.origins.end)}), using only data available
          at the time, and was scored against what happened.
        </p>
      </section>

      <p role="note" className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
        <span className="font-semibold">Read with care: </span>
        {bt.data.caveat}
      </p>

      <div role="radiogroup" aria-label="Forecast horizon" className="flex flex-wrap gap-2">
        {BUCKETS.map((b) => (
          <button
            key={b.key}
            type="button"
            role="radio"
            aria-checked={bucket === b.key}
            onClick={() => setBucket(b.key)}
            className={`rounded-lg border px-3 py-1.5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-brand-600 ${
              bucket === b.key ? 'border-brand-600 bg-brand-50 text-brand-900 dark:bg-brand-900/40 dark:text-brand-50' : 'border-stone-300 dark:border-stone-700'
            }`}
          >
            {b.label}
          </button>
        ))}
      </div>

      <section className="rounded-2xl border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
        <h2 className="text-sm font-semibold">MASE by model (lower is better; below 1 beats yesterday's values)</h2>
        <MaseChart rows={rows} label={label} />
      </section>

      <section className="rounded-2xl border border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[32rem] text-sm">
            <caption className="sr-only">Backtest metrics, {BUCKETS.find((b) => b.key === bucket)?.label}</caption>
            <thead className="text-left text-xs text-stone-500 dark:text-stone-400">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">Model</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">MASE</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">MAE (gCO₂/kWh)</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">WQL</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">80% band coverage</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.model} className="border-t border-stone-100 dark:border-stone-800">
                  <th scope="row" className="px-4 py-2 text-left font-medium">
                    {label(r.model)}
                    {BENCHMARKS.has(r.model) && <span className="ml-2 rounded bg-stone-100 px-1.5 py-0.5 text-xs font-normal text-stone-600 dark:bg-stone-800 dark:text-stone-300">benchmark</span>}
                  </th>
                  <td className="px-4 py-2 text-right tabular-nums">{fmtNum(r.mase, 3)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{fmtNum(r.mae)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{fmtNum(r.wql, 3)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{fmtPct(r.coverage80)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="border-t border-stone-100 px-4 py-3 text-xs text-stone-500 dark:border-stone-800 dark:text-stone-400">
          * NESO's past forecasts are returned with an unknown lead time, possibly much shorter than ours, so its row is
          context, not a fair comparison. NESO publishes no quantiles, so it has no WQL or coverage.
        </p>
      </section>

      <Sensitivity data={bt.data} label={label} />
    </div>
  )
}

function MaseChart({ rows, label }: { rows: BacktestSummary['rows']; label: (n: string) => string }) {
  const data = rows.map((r) => ({ name: label(r.model), mase: r.mase, benchmark: BENCHMARKS.has(r.model) }))
  return (
    <div style={{ height: 40 + data.length * 34 }} className="mt-3 text-stone-500 dark:text-stone-400" aria-hidden>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
          <CartesianGrid strokeDasharray="2 4" stroke="currentColor" strokeOpacity={0.25} horizontal={false} />
          <XAxis type="number" stroke="currentColor" fontSize={11} domain={[0, 'auto']} />
          <YAxis type="category" dataKey="name" stroke="currentColor" fontSize={11} width={150} />
          <ReferenceLine x={1} stroke="currentColor" strokeDasharray="4 3" />
          <Bar dataKey="mase" radius={[0, 4, 4, 0]} isAnimationActive={false}>
            {data.map((d) => (
              <Cell key={d.name} fill={d.benchmark ? 'var(--color-stone-400)' : 'var(--color-brand-600)'} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

function Sensitivity({ data, label }: { data: BacktestSummary; label: (n: string) => string }) {
  const settings = [...new Set(data.sensitivity.map((s) => s.setting))]
  if (settings.length === 0) return null
  const title: Record<string, string> = {
    classical_window_days: 'Classical models: training window (days)',
    chronos_context_days: 'Chronos-2: context length (days)',
  }
  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">Sensitivity checks (MASE, every third start time)</h2>
      {settings.map((setting) => {
        const items = data.sensitivity.filter((s) => s.setting === setting)
        const values = [...new Set(items.map((s) => s.value))].sort((a, b) => a - b)
        const models = [...new Set(items.map((s) => s.model))]
        return (
          <div key={setting} className="rounded-2xl border border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900">
            <h3 className="border-b border-stone-200 px-4 py-3 text-sm font-semibold dark:border-stone-800">{title[setting] ?? setting}</h3>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[24rem] text-sm">
                <thead className="text-left text-xs text-stone-500 dark:text-stone-400">
                  <tr>
                    <th scope="col" className="px-4 py-2 font-medium">Model</th>
                    {values.map((v) => <th key={v} scope="col" className="px-4 py-2 text-right font-medium">{v} days</th>)}
                  </tr>
                </thead>
                <tbody>
                  {models.map((m) => (
                    <tr key={m} className="border-t border-stone-100 dark:border-stone-800">
                      <th scope="row" className="px-4 py-2 text-left font-medium">{label(m)}</th>
                      {values.map((v) => (
                        <td key={v} className="px-4 py-2 text-right tabular-nums">
                          {fmtNum(items.find((s) => s.model === m && s.value === v)?.mase, 3)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      })}
    </section>
  )
}
