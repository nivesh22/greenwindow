export const fmtIntensity = (v: number | null | undefined): string =>
  v === null || v === undefined ? '–' : `${Math.round(v)}`

export const fmtNum = (v: number | null | undefined, digits = 1): string =>
  v === null || v === undefined ? '–' : v.toFixed(digits)

export const fmtPct = (v: number | null | undefined, digits = 0): string =>
  v === null || v === undefined ? '–' : `${(v * 100).toFixed(digits)}%`

/** grams -> "1.2 kg" or "850 g" */
export function fmtMass(grams: number): string {
  return Math.abs(grams) >= 1000 ? `${(grams / 1000).toFixed(1)} kg` : `${Math.round(grams)} g`
}
