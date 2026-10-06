import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ForecastChart } from '../components/ForecastChart'
import { ModelPicker } from '../components/ModelPicker'
import { ErrorPanel, Loading } from '../components/Status'
import { useDataFile } from '../data/hooks'
import type { LatestForecast, Meta, ModelInfo } from '../data/schemas'
import { fmtIntensity } from '../lib/format'
import { formatDateTime } from '../lib/time'

export const DEFAULT_MODEL = 'chronos2_cov'

/** Models that have a series in this run and publish quantiles (NESO is shown separately). */
export function forecastModels(meta: Meta, fc: LatestForecast): ModelInfo[] {
  const inRun = new Set(fc.series.map((s) => s.model))
  return meta.models.filter((m) => m.name !== 'neso' && inRun.has(m.name))
}

export function pickDefault(models: ModelInfo[]): string {
  return (models.find((m) => m.name === DEFAULT_MODEL) ?? models[0])?.name ?? ''
}

export function Home({ now = Date.now() }: { now?: number }) {
  const meta = useDataFile('meta')
  const fc = useDataFile('latestForecast')
  const obs = useDataFile('recentObservations')
  const [model, setModel] = useState<string | null>(null)
  const [compare, setCompare] = useState('')

  const error = meta.error ?? fc.error ?? obs.error
  if (error && !(meta.data && fc.data && obs.data)) {
    return <ErrorPanel error={error} onRetry={() => void Promise.all([meta.refetch(), fc.refetch(), obs.refetch()])} />
  }
  if (!meta.data || !fc.data || !obs.data) return <Loading label="Loading forecast" />

  const models = forecastModels(meta.data, fc.data)
  if (models.length === 0) return <p>No model forecasts in the latest run.</p>
  const selected = models.some((m) => m.name === model) ? model! : pickDefault(models)
  const seriesFor = (name: string) => fc.data.series.find((s) => s.model === name)
  const labelFor = (name: string) => meta.data.models.find((m) => m.name === name)?.label ?? name
  const main = seriesFor(selected)!
  const cmp = compare && compare !== selected ? seriesFor(compare) : undefined
  const neso = seriesFor('neso')

  const latest = [...obs.data.points].reverse().find((p) => p.ci_actual !== null)
  const actuals = obs.data.points.filter((p) => Date.parse(p.ts) >= now - 36 * 3_600_000)
  const future = main.points.filter((p) => Date.parse(p.ts) >= now - 3_600_000)
  const lowest = future.reduce<(typeof future)[number] | undefined>((lo, p) => (!lo || p.q50 < lo.q50 ? p : lo), undefined)

  return (
    <div className="space-y-6">
      <section>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">When is Great Britain's grid cleanest in the next 48 hours?</h1>
        <p className="mt-2 max-w-2xl text-stone-600 dark:text-stone-300">
          Hourly forecasts of grid carbon intensity with an honest 80% uncertainty band, from classical time-series models
          and the Chronos-2 foundation model, scored live against what actually happened.
        </p>
      </section>

      <section className="grid gap-3 sm:grid-cols-3">
        <Stat label="Latest measured intensity" value={latest ? `${fmtIntensity(latest.ci_actual)}` : '–'} unit="gCO₂/kWh"
          note={latest ? formatDateTime(latest.ts) : undefined} />
        <Stat label="Lowest expected hour ahead" value={lowest ? fmtIntensity(lowest.q50) : '–'} unit="gCO₂/kWh"
          note={lowest ? formatDateTime(lowest.ts) : undefined} />
        <div className="flex flex-col justify-center rounded-xl border border-brand-100 bg-brand-50 p-4 dark:border-brand-900 dark:bg-brand-900/40">
          <p className="text-sm text-brand-900 dark:text-brand-50">Have a flexible job, like EV charging or a batch run?</p>
          <Link to="/scheduler" className="mt-2 inline-flex w-fit rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600">
            Find the cleanest start time →
          </Link>
        </div>
      </section>

      <section className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm sm:p-6 dark:border-stone-800 dark:bg-stone-900">
        <div className="mb-4 grid gap-3 sm:grid-cols-2">
          <ModelPicker id="model" label="Forecast model" models={models} value={selected} onChange={setModel} />
          <ModelPicker id="compare" label="Compare with (optional)" models={models.filter((m) => m.name !== selected)} value={compare}
            onChange={setCompare} allowNone />
        </div>
        <ForecastChart
          actuals={actuals}
          main={{ label: labelFor(selected), points: main.points }}
          compare={cmp ? { label: labelFor(cmp.model), points: cmp.points } : undefined}
          neso={neso ? { label: 'NESO', points: neso.points } : undefined}
          now={now}
        />
        <p className="mt-3 text-xs text-stone-500 dark:text-stone-400">
          Forecast issued {formatDateTime(fc.data.issued_at_utc)}. Times shown in UK time. Units: gCO₂/kWh (grams of CO₂
          per kilowatt-hour). The shaded band is where the model expects the actual value 80% of the time; check the{' '}
          <Link className="underline" to="/leaderboard">leaderboard</Link> for how often that holds.
        </p>
      </section>
    </div>
  )
}

function Stat({ label, value, unit, note }: { label: string; value: string; unit: string; note?: string }) {
  return (
    <div className="rounded-xl border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
      <p className="text-sm text-stone-500 dark:text-stone-400">{label}</p>
      <p className="mt-1 text-3xl font-bold tabular-nums">
        {value} <span className="text-sm font-normal text-stone-500 dark:text-stone-400">{unit}</span>
      </p>
      {note && <p className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">{note}</p>}
    </div>
  )
}
