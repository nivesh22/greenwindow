// Model selection helpers, pure so the agent server can share them with the pages.
import type { LatestForecast, Meta, ModelInfo } from './schemas.js'

export const DEFAULT_MODEL = 'chronos2_cov'

/** Models that have a series in this run and publish quantiles (NESO is shown separately). */
export function forecastModels(meta: Meta, fc: LatestForecast): ModelInfo[] {
  const inRun = new Set(fc.series.map((s) => s.model))
  return meta.models.filter((m) => m.name !== 'neso' && inRun.has(m.name))
}

export function pickDefault(models: ModelInfo[]): string {
  return (models.find((m) => m.name === DEFAULT_MODEL) ?? models[0])?.name ?? ''
}
