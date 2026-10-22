import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { PanelState, PlanUpdate } from '../../agent/harness/events'
import { ChatPanel } from '../assistant/ChatPanel'
import { ASSISTANT_ENABLED } from '../assistant/flag'
import { PlanActions } from '../assistant/PlanActions'
import { useAuth } from '../assistant/useAuth'
import { ForecastChart } from '../components/ForecastChart'
import { PlanPanel, type FormState } from '../components/PlanPanel'
import { ErrorPanel, Loading } from '../components/Status'
import { useDataFile } from '../data/hooks'
import { fmtMass } from '../lib/format'
import { HOUR_MS, formatDateTime, fromLocalInput, toIso, toLocalInput, toMs } from '../lib/time'
import { InfeasibleJobError, InvalidJobError, recommend, type HourForecast, type Recommendation } from '../scheduler/optimizer'
import { forecastModels, pickDefault } from '../data/models'

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

export function Scheduler({ now = Date.now(), assistantEnabled = ASSISTANT_ENABLED }: { now?: number; assistantEnabled?: boolean }) {
  const auth = useAuth()
  const [params, setParams] = useSearchParams()
  // A question asked on the home page arrives as ?ask=. Keep it for the chat, then drop it from the URL so a reload
  // does not send it again.
  const [initialAsk] = useState(() => params.get('ask'))
  useEffect(() => {
    if (params.has('ask')) setParams({}, { replace: true })
  }, [params, setParams])
  const meta = useDataFile('meta')
  const fc = useDataFile('latestForecast')
  const [model, setModel] = useState<string | null>(null)
  const [form, setForm] = useState<FormState | null>(null)
  const [assistantNote, setAssistantNote] = useState(false)
  const editedRef = useRef(false)
  const liveRef = useRef<PanelState | null>(null)
  const planRef = useRef<HTMLDivElement>(null)

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
  useEffect(() => {
    const e = fromLocalInput(state.earliest)
    const dl = fromLocalInput(state.deadline)
    const d = Number(state.duration)
    const p = Number(state.power)
    liveRef.current = {
      duration_h: Number.isInteger(d) && d >= 1 && d <= 12 ? d : null,
      power_kw: p > 0 && Number.isFinite(p) ? p : null,
      earliest_utc: e === null ? null : toIso(e),
      deadline_utc: dl === null ? null : toIso(dl),
      mode: state.mode,
      model: selected || null,
      edited_by_user: editedRef.current,
    }
  })
  const getPanelState = useCallback((): PanelState | null => liveRef.current, [])
  const onPlanUpdate = useCallback((u: PlanUpdate) => {
    editedRef.current = false
    setAssistantNote(true)
    setModel(u.model)
    setForm({
      duration: String(u.duration_h),
      power: String(u.power_kw),
      earliest: toLocalInput(toMs(u.earliest_utc)),
      deadline: toLocalInput(toMs(u.deadline_utc)),
      mode: u.mode,
    })
  }, [])
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
  if (!ready) {
    return (
      <div className="space-y-8">
        <SchedulerIntro />
        <Loading label="Loading forecast" />
      </div>
    )
  }
  if (!series || hours.length === 0) return <p>No forecast with uncertainty bands is available right now.</p>

  const onField = (k: keyof FormState, v: string) => {
    editedRef.current = true
    setAssistantNote(false)
    setForm({ ...state, [k]: v })
  }
  const onModel = (m: string) => {
    editedRef.current = true
    setAssistantNote(false)
    setModel(m)
  }
  const viewPlan = () => {
    const el = planRef.current
    el?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
    el?.focus({ preventScroll: true })
  }
  const label = meta.data!.models.find((m) => m.name === selected)?.label ?? selected

  const panel = (
    <PlanPanel
      state={state}
      errors={errors}
      models={models}
      model={selected}
      onField={onField}
      onModel={onModel}
      note={assistantNote ? 'Updated by the assistant' : null}
    />
  )
  const answer = (
    <>
      {problem && (
        <div role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
          {problem}
        </div>
      )}
      {result && <RecommendationCard r={result} durationH={Number(state.duration)} />}
      {result && (
        <PlanActions
          startUtc={result.bestStart}
          endUtc={toIso(toMs(result.bestStart) + Number(state.duration) * HOUR_MS)}
          label={`GreenWindow: run ${state.duration} h job (${state.power} kW)`}
          description="Start time with the lowest forecast average grid intensity in your range (an estimate, not a guarantee). Forecast by GreenWindow."
          signedIn={Boolean(auth.info && !auth.info.isAnonymous)}
        />
      )}
    </>
  )
  const chart = (
    <>
      <div className="card p-4 sm:p-5">
        <h2 className="mb-3 font-display text-lg font-semibold">Forecast for your range</h2>
        <ForecastChart
          actuals={[]}
          main={{ label, points: series.points }}
          now={now}
          highlight={result ? { start: toMs(result.bestStart), end: toMs(result.bestStart) + Number(state.duration) * HOUR_MS, label: 'Your job' } : undefined}
          height={260}
        />
      </div>
      <p className="text-xs leading-relaxed text-ink-3">
        How to read this: the figures are an estimated difference in the grid's <em>average</em> carbon intensity for
        your job window. Shifting a job does not necessarily change the grid's <em>marginal</em> emissions by the same
        amount. "Robust" means the chosen window's pessimistic (P90) average is below the run-now window's optimistic
        (P10) average. Averaging quantiles across hours treats forecast errors as perfectly correlated, which makes this
        test conservative.
      </p>
    </>
  )

  return (
    <div className="space-y-8">
      <SchedulerIntro />

      {assistantEnabled ? (
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
          <div className="min-w-0 space-y-3 lg:sticky lg:top-24">
            <ChatPanel getPanelState={getPanelState} onPlanUpdate={onPlanUpdate} initialMessage={initialAsk} />
            <button type="button" onClick={viewPlan} className="btn-secondary w-full lg:hidden">
              View plan
            </button>
          </div>
          <div ref={planRef} tabIndex={-1} id="plan-panel" role="region" aria-label="Plan panel" className="min-w-0 scroll-mt-24 space-y-4 outline-none">
            {answer}
            {panel}
            {chart}
          </div>
        </div>
      ) : (
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
          {panel}
          <div className="min-w-0 space-y-4">
            {answer}
            {chart}
          </div>
        </div>
      )}
    </div>
  )
}

/** Heading and intro; also shown (and prerendered) while the forecast loads. */
function SchedulerIntro() {
  return (
    <section>
      <p className="eyebrow">Carbon-aware scheduling</p>
      <h1 className="page-title mt-2">Plan a flexible job</h1>
      <p className="lede">
        Tell us how long the job runs and when it must finish. We find the start time with the lowest forecast average grid
        intensity, and say whether that choice still holds if the forecast is off.
      </p>
    </section>
  )
}

function RecommendationCard({ r, durationH }: { r: Recommendation; durationH: number }) {
  const changed = r.bestStart !== r.runNowStart
  const endIso = toIso(toMs(r.bestStart) + durationH * HOUR_MS)
  return (
    <section aria-live="polite" className="card relative overflow-hidden">
      <div aria-hidden className="absolute inset-y-0 left-0 w-1 bg-accent" />
      <div className="p-5 pl-6 sm:p-6 sm:pl-7">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="eyebrow">{changed ? 'Best start' : 'Recommendation'}</p>
            <p className="mt-1.5 font-display text-3xl font-semibold tracking-tight sm:text-4xl">
              {changed ? formatDateTime(r.bestStart) : 'Run it now'}
            </p>
            {changed && <p className="mt-1 text-sm text-ink-2">finishes {formatDateTime(endIso)}</p>}
          </div>
          {changed && <RobustBadge robust={r.robust} />}
        </div>
        {changed ? (
          <dl className="mt-5 grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-3">
            <Metric term="Estimated difference in average grid intensity" value={`${r.intensityReductionPct.toFixed(0)}% lower`} />
            <Metric term="Average intensity: best vs. now" value={`${Math.round(r.avgIntensityBest)} vs ${Math.round(r.avgIntensityNow)}`} unit="gCO₂/kWh" />
            <Metric term={`For ${r.energyKwh.toFixed(1)} kWh, that intensity difference equals`} value={`≈ ${fmtMass(r.gramsDifference)}`} unit="CO₂" />
          </dl>
        ) : (
          <p className="mt-3 text-sm text-ink-2">
            No later window in your range has a lower forecast, so there is no reason to wait.
          </p>
        )}
        {changed && !r.robust && (
          <p className="mt-3 text-xs text-ink-2">
            Not robust: the forecast ranges overlap, so the better window is likely but not certain.
          </p>
        )}
      </div>
    </section>
  )
}

function RobustBadge({ robust }: { robust: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${
      robust ? 'bg-accent-soft text-accent-ink ring-1 ring-accent/40' : 'bg-surface-2 text-ink-2 ring-1 ring-line-strong'}`}>
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {robust ? <path d="M3.5 8.5l3 3 6-7" /> : <path d="M3 9c1.5-2 3-2 5 0s3.5 2 5 0" />}
      </svg>
      {robust ? 'Robust' : 'Not robust'}
    </span>
  )
}

function Metric({ term, value, unit }: { term: string; value: string; unit?: string }) {
  return (
    <div className="flex flex-col-reverse justify-end gap-1 bg-surface p-3.5">
      <dt className="text-xs leading-snug text-ink-3">{term}</dt>
      <dd className="text-lg font-semibold tabular-nums">
        {value} {unit && <span className="text-xs font-normal text-ink-3">{unit}</span>}
      </dd>
    </div>
  )
}
