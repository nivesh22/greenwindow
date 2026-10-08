import { useMemo, useState } from 'react'
import { ForecastChart } from '../components/ForecastChart'
import { ModelPicker } from '../components/ModelPicker'
import { ErrorPanel, Loading } from '../components/Status'
import { useDataFile } from '../data/hooks'
import { fmtMass } from '../lib/format'
import { HOUR_MS, formatDateTime, fromLocalInput, toIso, toLocalInput, toMs } from '../lib/time'
import { InfeasibleJobError, InvalidJobError, recommend, type HourForecast, type Mode, type Recommendation } from '../scheduler/optimizer'
import { forecastModels, pickDefault } from '../data/models'

interface FormState { duration: string; power: string; earliest: string; deadline: string; mode: Mode }

export function validateForm(f: FormState, firstMs: number, endMs: number): Partial<Record<keyof FormState, string>> {
  const errors: Partial<Record<keyof FormState, string>> = {}
  const d = Number(f.duration)
  if (!Number.isInteger(d) || d < 1 || d > 12) errors.duration = 'Enter whole hours from 1 to 12.'
  const p = Number(f.power)
  if (!(p > 0) || p > 10_000) errors.power = 'Enter a power above 0 kW.'
  const e = fromLocalInput(f.earliest)
  const dl = fromLocalInput(f.deadline)
  if (e === null) errors.earliest = 'Enter a start time.'
  else if (e < firstMs) errors.earliest = `The forecast starts ${formatDateTime(toIso(firstMs))}.`
  if (dl === null) errors.deadline = 'Enter a deadline.'
  else if (dl > endMs) errors.deadline = `The forecast ends ${formatDateTime(toIso(endMs))}.`
  else if (e !== null && dl <= e) errors.deadline = 'The deadline must be after the earliest start.'
  return errors
}

export function Scheduler({ now = Date.now() }: { now?: number }) {
  const meta = useDataFile('meta')
  const fc = useDataFile('latestForecast')
  const [model, setModel] = useState<string | null>(null)
  const [form, setForm] = useState<FormState | null>(null)

  const ready = meta.data && fc.data
  const models = ready ? forecastModels(meta.data!, fc.data!) : []
  const selected = models.some((m) => m.name === model) ? model! : pickDefault(models)
  const series = fc.data?.series.find((s) => s.model === selected)
  const hours: HourForecast[] = useMemo(
    () =>
      (series?.points ?? []).flatMap((p) =>
        p.q10 !== null && p.q90 !== null ? [{ ts: p.ts, q10: p.q10, q50: p.q50, q90: p.q90 }] : [],
      ),
    [series],
  )
  const firstMs = hours.length ? Math.max(toMs(hours[0]!.ts), Math.ceil(now / HOUR_MS) * HOUR_MS) : 0
  const endMs = hours.length ? toMs(hours[hours.length - 1]!.ts) + HOUR_MS : 0
  const state: FormState = form ?? {
    duration: '3',
    power: '7',
    earliest: toLocalInput(firstMs),
    deadline: toLocalInput(Math.min(firstMs + 24 * HOUR_MS, endMs)),
    mode: 'expected',
  }
  const errors = ready ? validateForm(state, firstMs, endMs) : {}

  let result: Recommendation | null = null
  let problem: string | null = null
  if (ready && hours.length && Object.keys(errors).length === 0) {
    try {
      result = recommend(
        hours,
        {
          durationH: Number(state.duration),
          powerKw: Number(state.power),
          earliestStart: toIso(fromLocalInput(state.earliest)!),
          deadline: toIso(fromLocalInput(state.deadline)!),
        },
        state.mode,
      )
    } catch (e) {
      if (e instanceof InfeasibleJobError || e instanceof InvalidJobError) problem = e.message
      else throw e
    }
  }

  const error = meta.error ?? fc.error
  if (error && !ready) return <ErrorPanel error={error} onRetry={() => void Promise.all([meta.refetch(), fc.refetch()])} />
  if (!ready) return <Loading label="Loading forecast" />
  if (!series || hours.length === 0) return <p>No forecast with uncertainty bands is available right now.</p>

  const set = (k: keyof FormState) => (v: string) => setForm({ ...state, [k]: v })
  const label = meta.data!.models.find((m) => m.name === selected)?.label ?? selected

  return (
    <div className="space-y-6">
      <section>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Plan a flexible job</h1>
        <p className="mt-2 max-w-2xl text-stone-600 dark:text-stone-300">
          Tell us how long the job runs and when it must finish. We find the start time with the lowest forecast average
          grid intensity, and say whether that choice still holds if the forecast is off.
        </p>
      </section>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,20rem)_1fr]">
        <form
          noValidate
          onSubmit={(e) => e.preventDefault()}
          className="space-y-4 rounded-2xl border border-stone-200 bg-white p-4 sm:p-5 dark:border-stone-800 dark:bg-stone-900"
          aria-label="Job details"
        >
          <Field id="duration" label="Duration (hours)" error={errors.duration}>
            <input id="duration" type="number" min={1} max={12} step={1} inputMode="numeric" value={state.duration}
              onChange={(e) => set('duration')(e.target.value)} className={inputCls} aria-invalid={!!errors.duration}
              aria-describedby={errors.duration ? 'duration-error' : undefined} />
          </Field>
          <Field id="power" label="Power draw (kW)" hint="A home EV charger is about 7 kW." error={errors.power}>
            <input id="power" type="number" min={0.1} step={0.1} inputMode="decimal" value={state.power}
              onChange={(e) => set('power')(e.target.value)} className={inputCls} aria-invalid={!!errors.power}
              aria-describedby={errors.power ? 'power-error' : 'power-hint'} />
          </Field>
          <Field id="earliest" label="Earliest start (UK time)" error={errors.earliest}>
            <input id="earliest" type="datetime-local" step={3600} value={state.earliest}
              onChange={(e) => set('earliest')(e.target.value)} className={inputCls} aria-invalid={!!errors.earliest}
              aria-describedby={errors.earliest ? 'earliest-error' : undefined} />
          </Field>
          <Field id="deadline" label="Must finish by (UK time)" error={errors.deadline}>
            <input id="deadline" type="datetime-local" step={3600} value={state.deadline}
              onChange={(e) => set('deadline')(e.target.value)} className={inputCls} aria-invalid={!!errors.deadline}
              aria-describedby={errors.deadline ? 'deadline-error' : undefined} />
          </Field>
          <fieldset>
            <legend className="text-sm font-medium text-stone-700 dark:text-stone-300">Plan for</legend>
            <div className="mt-1 grid grid-cols-2 gap-2">
              {(['expected', 'cautious'] as const).map((m) => (
                <label key={m} className={`cursor-pointer rounded-lg border px-3 py-2 text-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-brand-600 ${
                  state.mode === m ? 'border-brand-600 bg-brand-50 dark:bg-brand-900/40' : 'border-stone-300 dark:border-stone-700'}`}>
                  <input type="radio" name="mode" value={m} checked={state.mode === m} onChange={() => set('mode')(m)} className="sr-only" />
                  <span className="font-medium">{m === 'expected' ? 'Expected' : 'Cautious'}</span>
                  <span className="block text-xs text-stone-500 dark:text-stone-400">{m === 'expected' ? 'Median forecast' : 'Plan for a bad case (P90)'}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <ModelPicker id="sched-model" label="Forecast model" models={models} value={selected} onChange={setModel} />
        </form>

        <div className="space-y-4">
          {problem && (
            <div role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
              {problem}
            </div>
          )}
          {result && <RecommendationCard r={result} durationH={Number(state.duration)} />}
          <div className="rounded-2xl border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
            <ForecastChart
              actuals={[]}
              main={{ label, points: series.points }}
              now={now}
              highlight={result ? { start: toMs(result.bestStart), end: toMs(result.bestStart) + Number(state.duration) * HOUR_MS } : undefined}
              height={260}
            />
          </div>
          <p className="text-xs leading-relaxed text-stone-500 dark:text-stone-400">
            How to read this: the figures are an estimated difference in the grid's <em>average</em> carbon intensity for
            your job window. Shifting a job does not necessarily change the grid's <em>marginal</em> emissions by the same
            amount. "Robust" means the chosen window's pessimistic (P90) average is below the run-now window's optimistic
            (P10) average. Averaging quantiles across hours treats forecast errors as perfectly correlated, which makes this
            test conservative.
          </p>
        </div>
      </div>
    </div>
  )
}

const inputCls =
  'w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-stone-900 focus-visible:outline-2 focus-visible:outline-brand-600 aria-[invalid=true]:border-red-600 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100'

function Field({ id, label, hint, error, children }: { id: string; label: string; hint?: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-stone-700 dark:text-stone-300">{label}</label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-xs text-red-700 dark:text-red-400">{error}</p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-stone-500 dark:text-stone-400">{hint}</p>
      ) : null}
    </div>
  )
}

function RecommendationCard({ r, durationH }: { r: Recommendation; durationH: number }) {
  const changed = r.bestStart !== r.runNowStart
  const endIso = toIso(toMs(r.bestStart) + durationH * HOUR_MS)
  return (
    <section aria-live="polite" className="rounded-2xl border border-brand-100 bg-brand-50 p-5 dark:border-brand-900 dark:bg-brand-900/30">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm text-brand-900 dark:text-brand-100">{changed ? 'Best start' : 'Recommendation'}</p>
          <p className="text-2xl font-bold">{changed ? formatDateTime(r.bestStart) : 'Run it now'}</p>
          {changed && <p className="text-sm text-stone-600 dark:text-stone-300">finishes {formatDateTime(endIso)}</p>}
        </div>
        {changed && (
          <span className={`rounded-full px-3 py-1 text-xs font-semibold ${r.robust
            ? 'bg-brand-600 text-white' : 'border border-stone-400 bg-white text-stone-700 dark:bg-stone-900 dark:text-stone-200'}`}>
            {r.robust ? '✓ Robust' : '~ Not robust'}
          </span>
        )}
      </div>
      {changed ? (
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
          <Metric term="Estimated difference in average grid intensity" value={`${r.intensityReductionPct.toFixed(0)}% lower`} />
          <Metric term="Average intensity: best vs. now" value={`${Math.round(r.avgIntensityBest)} vs ${Math.round(r.avgIntensityNow)} gCO₂/kWh`} />
          <Metric term={`For ${r.energyKwh.toFixed(1)} kWh, that intensity difference equals`} value={`≈ ${fmtMass(r.gramsDifference)} CO₂`} />
        </dl>
      ) : (
        <p className="mt-2 text-sm text-stone-700 dark:text-stone-300">
          No later window in your range has a lower forecast, so there is no reason to wait.
        </p>
      )}
      {changed && !r.robust && (
        <p className="mt-3 text-xs text-stone-600 dark:text-stone-300">
          Not robust: the forecast ranges overlap, so the better window is likely but not certain.
        </p>
      )}
    </section>
  )
}

function Metric({ term, value }: { term: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-stone-600 dark:text-stone-400">{term}</dt>
      <dd className="font-semibold tabular-nums">{value}</dd>
    </div>
  )
}
