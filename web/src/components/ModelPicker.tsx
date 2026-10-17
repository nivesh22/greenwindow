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
    <label htmlFor={id} className="flex flex-col gap-1.5 text-sm">
      <span className="font-medium text-ink">{label}</span>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="field cursor-pointer"
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
