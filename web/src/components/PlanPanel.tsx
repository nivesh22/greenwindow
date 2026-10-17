import type { ModelInfo } from '../data/schemas'
import type { Mode } from '../scheduler/optimizer'
import { ModelPicker } from './ModelPicker'

export interface FormState { duration: string; power: string; earliest: string; deadline: string; mode: Mode }
export type FormErrors = Partial<Record<keyof FormState, string>>

interface Props {
  state: FormState
  errors: FormErrors
  models: ModelInfo[]
  model: string
  onField: (k: keyof FormState, v: string) => void
  onModel: (m: string) => void
  /** Shown when the assistant filled the panel and the user has not edited it since. */
  note?: string | null
}

const inputCls = 'field aria-[invalid=true]:border-red-600'

/** The controlled job form. All state lives in the Scheduler page so the assistant can set it. */
export function PlanPanel({ state, errors, models, model, onField, onModel, note }: Props) {
  const set = (k: keyof FormState) => (v: string) => onField(k, v)
  return (
    <form
      noValidate
      onSubmit={(e) => e.preventDefault()}
      className="card @container p-4 sm:p-5"
      aria-label="Job details"
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-lg font-semibold">Job details</h2>
        {note && (
          <p role="status" className="rounded-full bg-accent-soft px-3 py-1 text-xs font-medium text-accent-ink">
            {note}
          </p>
        )}
      </div>
      <div className="grid gap-4 @md:grid-cols-2">
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
      <fieldset className="@md:col-span-2">
        <legend className="text-sm font-medium text-ink">Plan for</legend>
        <div className="mt-1 grid grid-cols-2 gap-2">
          {(['expected', 'cautious'] as const).map((m) => (
            <label key={m} className={`cursor-pointer rounded-lg border px-3 py-2.5 text-sm transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent ${
              state.mode === m ? 'border-accent bg-accent-soft ring-1 ring-accent' : 'border-line-strong hover:bg-surface-2'}`}>
              <input type="radio" name="mode" value={m} checked={state.mode === m} onChange={() => set('mode')(m)} className="sr-only" />
              <span className="font-medium">{m === 'expected' ? 'Expected' : 'Cautious'}</span>
              <span className="block text-xs text-ink-3">{m === 'expected' ? 'Median forecast' : 'Plan for a bad case (P90)'}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="@md:col-span-2">
        <ModelPicker id="sched-model" label="Forecast model" models={models} value={model} onChange={onModel} />
      </div>
      </div>
    </form>
  )
}

function Field({ id, label, hint, error, children }: { id: string; label: string; hint?: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-ink">{label}</label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-xs text-red-700 dark:text-red-400">{error}</p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-ink-3">{hint}</p>
      ) : null}
    </div>
  )
}
