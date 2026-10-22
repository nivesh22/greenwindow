import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ForecastChart } from '../components/ForecastChart'
import { IntensityStrip } from '../components/IntensityStrip'
import { AssistantPromo } from '../assistant/AssistantPromo'
import { ASSISTANT_ENABLED } from '../assistant/flag'
import { ModelPicker } from '../components/ModelPicker'
import { ErrorPanel, Loading } from '../components/Status'
import { useDataFile } from '../data/hooks'
import { forecastModels, pickDefault } from '../data/models'
import { fmtIntensity } from '../lib/format'
import { HOUR_MS, formatDateTime, toMs } from '../lib/time'

export function Home({ now = Date.now(), assistantEnabled = ASSISTANT_ENABLED }: { now?: number; assistantEnabled?: boolean }) {
  const meta = useDataFile('meta')
  const fc = useDataFile('latestForecast')
  const obs = useDataFile('recentObservations')
  const [model, setModel] = useState<string | null>(null)
  const [compare, setCompare] = useState('')

  const error = meta.error ?? fc.error ?? obs.error
  if (error && !(meta.data && fc.data && obs.data)) {
    return <ErrorPanel error={error} onRetry={() => void Promise.all([meta.refetch(), fc.refetch(), obs.refetch()])} />
  }
  if (!meta.data || !fc.data || !obs.data) {
    return (
      <div className="space-y-8">
        <HomeIntro />
        <Loading label="Loading forecast" />
      </div>
    )
  }

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

  const highest = future.reduce<(typeof future)[number] | undefined>((hi, p) => (!hi || p.q50 > hi.q50 ? p : hi), undefined)

  return (
    <div className="space-y-8">
      <section className="grid items-end gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <HomeIntro />
        {lowest && (
          <div className="card relative overflow-hidden p-5 sm:p-6">
            <div aria-hidden className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-brand-500 via-brand-600 to-brand-700" />
            <p className="eyebrow">Lowest expected hour ahead</p>
            <p className="mt-2 font-display text-3xl font-semibold tracking-tight">{formatDateTime(lowest.ts)}</p>
            <p className="mt-1 text-ink-2">
              <span className="text-2xl font-semibold text-accent tabular-nums">{fmtIntensity(lowest.q50)}</span>{' '}
              <span className="text-sm">gCO₂/kWh forecast (P50)</span>
            </p>
            <Link to="/scheduler" className="btn-primary mt-5 w-full sm:w-auto">
              {assistantEnabled ? 'Plan a job with the AI assistant' : 'Find the cleanest start time for a job'} <span aria-hidden>→</span>
            </Link>
          </div>
        )}
      </section>

      {assistantEnabled && <AssistantPromo />}

      <section aria-label="Summary" className="grid gap-3 sm:grid-cols-3">
        <Stat label="Latest measured intensity" value={latest ? fmtIntensity(latest.ci_actual) : '–'} unit="gCO₂/kWh"
          note={latest ? formatDateTime(latest.ts) : undefined} />
        <Stat label="Time until the lowest hour" value={lowest ? String(Math.max(0, Math.round((toMs(lowest.ts) - now) / HOUR_MS))) : '–'}
          unit="hours" note={lowest ? `${fmtIntensity(lowest.q50)} gCO₂/kWh forecast` : undefined} accent />
        <Stat label="Highest expected hour ahead" value={highest ? fmtIntensity(highest.q50) : '–'} unit="gCO₂/kWh"
          note={highest ? formatDateTime(highest.ts) : undefined} />
      </section>

      <section className="card p-4 sm:p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-display text-xl font-semibold">The next {future.length} hours at a glance</h2>
          <p className="text-xs text-ink-3">{labelFor(selected)}, median forecast · outlined cell = lowest hour</p>
        </div>
        <div className="mt-4">
          <IntensityStrip points={future} bestTs={lowest?.ts} />
        </div>
      </section>

      <section className="card p-4 sm:p-6">
        <div className="mb-5 grid gap-4 lg:grid-cols-[1fr_minmax(0,34rem)] lg:items-end">
          <div>
            <h2 className="font-display text-xl font-semibold">Forecast vs. what happened</h2>
            <p className="mt-1 text-sm text-ink-3">Last 36 hours measured, next 48 hours forecast.</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <ModelPicker id="model" label="Forecast model" models={models} value={selected} onChange={setModel} />
            <ModelPicker id="compare" label="Compare with (optional)" models={models.filter((m) => m.name !== selected)} value={compare}
              onChange={setCompare} allowNone />
          </div>
        </div>
        <ForecastChart
          actuals={actuals}
          main={{ label: labelFor(selected), points: main.points }}
          compare={cmp ? { label: labelFor(cmp.model), points: cmp.points } : undefined}
          neso={neso ? { label: 'NESO', points: neso.points } : undefined}
          now={now}
          highlight={lowest ? { start: toMs(lowest.ts), end: toMs(lowest.ts) + HOUR_MS, label: 'Lowest hour' } : undefined}
          height={340}
        />
        <p className="mt-4 border-t border-line pt-3 text-xs leading-relaxed text-ink-3">
          Forecast issued {formatDateTime(fc.data.issued_at_utc)}. Times shown in UK time. Units: gCO₂/kWh (grams of CO₂
          per kilowatt-hour). The shaded band is where the model expects the actual value 80% of the time; check the{' '}
          <Link className="underline underline-offset-2 hover:text-ink" to="/leaderboard">leaderboard</Link> for how often that holds.
        </p>
      </section>

      <section aria-label="More" className="grid gap-3 sm:grid-cols-3">
        <NextLink to="/scheduler" title={assistantEnabled ? 'Plan a job with the AI assistant' : 'Plan a job'} body="Describe the job or fill in the form; get the start time with the lowest forecast intensity, and whether it is robust." />
        <NextLink to="/leaderboard" title="Live leaderboard" body="Every forecast is stored and scored against what happened, next to the seasonal-naive benchmark." />
        <NextLink to="/backtest" title="Backtest" body="How each model did on 90 past start times, including the negative results." />
      </section>
    </div>
  )
}

function Stat({ label, value, unit, note, accent }: { label: string; value: string; unit: string; note?: string; accent?: boolean }) {
  return (
    <div className="card p-4 sm:p-5">
      <p className="text-sm text-ink-3">{label}</p>
      <p className={`mt-1.5 text-4xl font-semibold tracking-tight tabular-nums ${accent ? 'text-accent' : ''}`}>
        {value} <span className="text-sm font-normal tracking-normal text-ink-3">{unit}</span>
      </p>
      {note && <p className="mt-1 text-xs text-ink-3">{note}</p>}
    </div>
  )
}

function NextLink({ to, title, body }: { to: string; title: string; body: string }) {
  return (
    <Link to={to} className="group card block p-5 transition-colors hover:border-accent/50 focus-visible:outline-2 focus-visible:outline-accent">
      <p className="flex items-center justify-between font-semibold">
        {title}
        <span aria-hidden className="text-ink-3 transition-transform group-hover:translate-x-0.5 group-hover:text-accent">→</span>
      </p>
      <p className="mt-1.5 text-sm leading-relaxed text-ink-3">{body}</p>
    </Link>
  )
}

/** Heading and intro; also shown (and prerendered) while the forecast loads. */
function HomeIntro() {
  return (
    <div>
      <p className="eyebrow">Great Britain · next 48 hours</p>
      <h1 className="page-title mt-2 sm:text-5xl">When is Great Britain's grid cleanest in the next 48 hours?</h1>
      <p className="lede">
        Hourly forecasts of grid carbon intensity with an honest 80% uncertainty band, from classical time-series models
        and the Chronos-2 foundation model, scored live against what actually happened.
      </p>
    </div>
  )
}
