import type { ModelInfo } from '../data/schemas'

interface Props {
  id: string
  label: string
  models: ModelInfo[]
  value: string
  onChange: (v: string) => void
  allowNone?: boolean
}

const FAMILY_LABEL: Record<ModelInfo['family'], string> = {
  benchmark: 'Benchmarks',
  classical: 'Classical',
  foundation: 'Foundation model',
  ensemble: 'Blend',
}

export function ModelPicker({ id, label, models, value, onChange, allowNone }: Props) {
  const families = (['ensemble', 'foundation', 'classical', 'benchmark'] as const).filter((f) => models.some((m) => m.family === f))
  return (
    <label htmlFor={id} className="flex flex-col gap-1 text-sm">
      <span className="font-medium text-stone-700 dark:text-stone-300">{label}</span>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-lg border border-stone-300 bg-white px-3 py-2 text-stone-900 focus-visible:outline-2 focus-visible:outline-brand-600 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100"
      >
        {allowNone && <option value="">None</option>}
        {families.map((f) => (
          <optgroup key={f} label={FAMILY_LABEL[f]}>
            {models
              .filter((m) => m.family === f)
              .map((m) => (
                <option key={m.name} value={m.name}>
                  {m.label}
                </option>
              ))}
          </optgroup>
        ))}
      </select>
    </label>
  )
}
