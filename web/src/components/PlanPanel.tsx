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

const inputCls =
  'w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-stone-900 focus-visible:outline-2 focus-visible:outline-brand-600 aria-[invalid=true]:border-red-600 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100'

/** The controlled job form. All state lives in the Scheduler page so the assistant can set it. */
export function PlanPanel({ state, errors, models, model, onField, onModel, note }: Props) {
  const set = (k: keyof FormState) => (v: string) => onField(k, v)
  return (
    <form
      noValidate
      onSubmit={(e) => e.preventDefault()}
      className="space-y-4 rounded-2xl border border-stone-200 bg-white p-4 sm:p-5 dark:border-stone-800 dark:bg-stone-900"
      aria-label="Job details"
    >
      {note && (
        <p role="status" className="rounded-lg bg-brand-50 px-3 py-1.5 text-xs text-brand-900 dark:bg-brand-900/40 dark:text-brand-100">
          {note}
        </p>
      )}
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
      <ModelPicker id="sched-model" label="Forecast model" models={models} value={model} onChange={onModel} />
    </form>
  )
}

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
