import { estimateCo2 } from './estimate_co2.js'
import { explainUncertainty } from './explain_uncertainty.js'
import { getForecast } from './get_forecast.js'
import { compareModels, getBacktest, getLeaderboard } from './insight.js'
import { lookupDevice } from './lookup_device.js'
import { recommendWindow } from './recommend_window.js'
import { ToolRegistry, type ToolDef } from './registry.js'

/** All tools (P1 plus the P2 insight tools). */
export const TOOLS: readonly ToolDef[] = [
  getForecast as unknown as ToolDef,
  recommendWindow as unknown as ToolDef,
  estimateCo2 as unknown as ToolDef,
  explainUncertainty as unknown as ToolDef,
  lookupDevice as unknown as ToolDef,
  getLeaderboard as unknown as ToolDef,
  getBacktest as unknown as ToolDef,
  compareModels as unknown as ToolDef,
]

export function buildRegistry(): ToolRegistry {
  return new ToolRegistry(TOOLS)
}

export { toPlanUpdate } from './recommend_window.js'
